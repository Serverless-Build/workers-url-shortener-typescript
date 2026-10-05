import { DurableObject } from 'cloudflare:workers';
import { SessionWorkspace } from './lib/session';
import { generateCode } from './utils';
import { cacheLink, clearCache, resolveFullRedirect } from './storage';
import { isFull, type AppEnv, type Click, type Link } from './types';

/** One actor per public code gives the claimable profile atomic uniqueness and counts. */
export class ShortLink extends DurableObject<AppEnv> {
  private promotion?: Promise<void>;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS link (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), code TEXT NOT NULL, workspaceId TEXT NOT NULL, url TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, clickCount INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, canonical INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, clickedAt INTEGER NOT NULL, userAgent TEXT NOT NULL, referrer TEXT NOT NULL);`);
  }
  async create(link: Link, pending = false): Promise<boolean> {
    const inserted = this.ctx.storage.sql.exec('INSERT INTO link VALUES (1, ?, ?, ?, ?, ?, 0, ?, 0) ON CONFLICT DO NOTHING RETURNING code', link.code, link.workspaceId, link.url, link.createdAt, link.expiresAt, pending ? 2 : 0).toArray().length > 0;
    if (inserted) await this.ctx.storage.setAlarm(link.expiresAt);
    return inserted;
  }
  publish(workspaceId: string): boolean {
    return this.ctx.storage.sql.exec('UPDATE link SET deleted = 0, canonical = 1 WHERE workspaceId = ? AND deleted = 2 RETURNING code', workspaceId).toArray().length > 0;
  }
  snapshot(workspaceId: string) {
    const link = this.ctx.storage.sql.exec<Link>('SELECT code, workspaceId, url, createdAt, expiresAt, clickCount, deleted FROM link WHERE workspaceId = ? AND deleted = 0 AND expiresAt > ?', workspaceId, Date.now()).toArray()[0];
    const recentClicks = link ? this.ctx.storage.sql.exec<Omit<Click, 'id'> & { id: number }>('SELECT * FROM clicks ORDER BY id DESC LIMIT 100').toArray().map(click => ({ ...click, id: `do:${link.code}:${click.id}` })) : [];
    return link ? { link, recentClicks } : null;
  }
  async promote(): Promise<void> {
    if (!isFull(this.env)) return;
    if (this.promotion) return this.promotion;
    const row = this.ctx.storage.sql.exec<Link & { canonical: number }>('SELECT * FROM link WHERE deleted = 0 AND expiresAt > ?', Date.now()).toArray()[0];
    if (!row || row.canonical) return;
    const env = this.env;
    this.promotion = (async () => {
      await env.DB.prepare('INSERT INTO links VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT DO NOTHING').bind(row.code, row.workspaceId, row.url, row.createdAt, row.expiresAt, row.clickCount).run();
      const snapshot = this.snapshot(row.workspaceId);
      if (!snapshot) { await env.DB.prepare("UPDATE links SET deleted = 1, url = '' WHERE code = ? AND workspaceId = ?").bind(row.code, row.workspaceId).run(); return; }
      const verified = await env.DB.prepare('SELECT * FROM links WHERE code = ?').bind(row.code).first<Link>();
      if (!verified || verified.workspaceId !== row.workspaceId || verified.url !== row.url || verified.clickCount < row.clickCount) throw new Error('Storage upgrade verification failed');
      if (snapshot.recentClicks.length) await env.DB.batch(snapshot.recentClicks.map(click => env.DB.prepare('INSERT INTO clicks VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(click.id, row.code, click.clickedAt, click.userAgent, click.referrer)));
      this.ctx.storage.sql.exec('UPDATE link SET canonical = 1');
    })().finally(() => { this.promotion = undefined; });
    return this.promotion;
  }
  async resolve(click: Omit<Click, 'id'>, code: string): Promise<string | null> {
    if (isFull(this.env)) { await this.promote(); return resolveFullRedirect(this.env, code, click); }
    const link = this.ctx.storage.sql.exec<Link>('SELECT * FROM link WHERE deleted = 0 AND expiresAt > ?', Date.now()).toArray()[0];
    if (!link) return null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE link SET clickCount = clickCount + 1');
      this.ctx.storage.sql.exec('INSERT INTO clicks (clickedAt, userAgent, referrer) VALUES (?, ?, ?)', click.clickedAt, click.userAgent, click.referrer);
      this.ctx.storage.sql.exec('DELETE FROM clicks WHERE id NOT IN (SELECT id FROM clicks ORDER BY id DESC LIMIT 100)');
    });
    return link.url;
  }
  async remove(workspaceId: string): Promise<boolean> {
    const changed = this.ctx.storage.sql.exec<{ code: string }>("UPDATE link SET deleted = 1, url = '' WHERE workspaceId = ? AND deleted <> 1 RETURNING code", workspaceId).toArray();
    if (changed.length && isFull(this.env)) await this.env.DB.prepare("UPDATE links SET deleted = 1, url = '' WHERE code = ? AND workspaceId = ?").bind(changed[0].code, workspaceId).run();
    if (changed.length) this.ctx.storage.sql.exec('DELETE FROM clicks');
    return changed.length > 0;
  }
  alarm() { this.ctx.storage.sql.exec("UPDATE link SET deleted = 1, url = '', workspaceId = ''"); this.ctx.storage.sql.exec('DELETE FROM clicks'); }
}

export class ShortenerWorkspace extends SessionWorkspace<AppEnv> {
  private migration?: Promise<void>;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS owned_links (code TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0)');
  }
  async bootstrap(hash: string, workspaceId: string) {
    const session = await super.bootstrap(hash, workspaceId);
    this.setMeta('profile', this.env.STORAGE_PROFILE);
    return session;
  }
  async ensureFullStorage(): Promise<void> {
    if (!isFull(this.env) || this.meta('profile') !== 'durable-objects') return;
    if (this.migration) return this.migration;
    this.migration = this.migrate().finally(() => { this.migration = undefined; });
    return this.migration;
  }
  private async migrate(): Promise<void> {
    const env = this.env; if (!isFull(env)) return;
    const owner = this.meta('workspaceId')!;
    for (const { code } of this.ctx.storage.sql.exec<{ code: string }>('SELECT code FROM owned_links WHERE ready = 1').toArray()) {
      await env.SHORT_LINKS.getByName(code).promote();
    }
    this.setMeta('profile', 'full');
  }
  async create(url: string, customCode?: string) {
    if (!this.isActive()) return { error: 'expired' as const };
    if (this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) count FROM owned_links').one().count >= 100) return { error: 'limit' as const };
    const owner = this.meta('workspaceId')!;
    for (let attempt = 0; attempt < (customCode ? 1 : 5); attempt++) {
      const code = customCode ?? generateCode();
      if (!this.ctx.storage.sql.exec('INSERT INTO owned_links (code) VALUES (?) ON CONFLICT DO NOTHING RETURNING code', code).toArray().length) { if (customCode) return { error: 'conflict' as const }; continue; }
      const link: Link = { code, workspaceId: owner, url, createdAt: Date.now(), expiresAt: Number(this.meta('expires')), clickCount: 0, deleted: 0 };
      try {
        let inserted = await this.env.SHORT_LINKS.getByName(code).create(link, isFull(this.env));
        if (inserted && isFull(this.env)) {
          inserted = (await this.env.DB.prepare('INSERT INTO links VALUES (?, ?, ?, ?, ?, 0, 0) ON CONFLICT DO NOTHING RETURNING code').bind(code, owner, url, link.createdAt, link.expiresAt).all()).results.length > 0;
          if (!inserted) await this.env.SHORT_LINKS.getByName(code).remove(owner);
          else if (!await this.env.SHORT_LINKS.getByName(code).publish(owner)) { await this.removeCanonical(code, owner); inserted = false; }
        }
        if (!inserted) { this.ctx.storage.sql.exec('DELETE FROM owned_links WHERE code = ?', code); continue; }
        if (!this.isActive()) { await this.removeCanonical(code, owner); this.ctx.storage.sql.exec('DELETE FROM owned_links WHERE code = ?', code); return { error: 'expired' as const }; }
        this.ctx.storage.sql.exec('UPDATE owned_links SET ready = 1 WHERE code = ?', code);
        if (isFull(this.env)) await cacheLink(this.env, link);
        return { link };
      } catch (error) {
        await this.env.SHORT_LINKS.getByName(code).remove(owner).catch(() => {});
        this.ctx.storage.sql.exec('DELETE FROM owned_links WHERE code = ?', code); throw error;
      }
    }
    return { error: 'conflict' as const };
  }
  async list(limit = 100, offset = 0) {
    const owner = this.meta('workspaceId')!;
    if (isFull(this.env)) {
      const [rows, count] = await this.env.DB.batch([
        this.env.DB.prepare('SELECT * FROM links WHERE workspaceId = ? AND deleted = 0 AND expiresAt > ? ORDER BY createdAt DESC, code LIMIT ? OFFSET ?').bind(owner, Date.now(), limit, offset),
        this.env.DB.prepare('SELECT COUNT(*) total FROM links WHERE workspaceId = ? AND deleted = 0 AND expiresAt > ?').bind(owner, Date.now()),
      ]);
      return { urls: rows.results as Link[], total: Number((count.results[0] as { total: number }).total), limit, offset };
    }
    const codes = this.ctx.storage.sql.exec<{ code: string }>('SELECT code FROM owned_links WHERE ready = 1 ORDER BY rowid DESC LIMIT ? OFFSET ?', limit, offset).toArray();
    const snapshots = await Promise.all(codes.map(({ code }) => this.env.SHORT_LINKS.getByName(code).snapshot(owner)));
    return { urls: snapshots.flatMap(item => item ? [item.link] : []), total: this.ctx.storage.sql.exec<{ total: number }>('SELECT COUNT(*) total FROM owned_links WHERE ready = 1').one().total, limit, offset };
  }
  async stats(code: string) {
    const owner = this.meta('workspaceId')!;
    if (!isFull(this.env)) return this.env.SHORT_LINKS.getByName(code).snapshot(owner);
    const link = await this.env.DB.prepare('SELECT * FROM links WHERE code = ? AND workspaceId = ? AND deleted = 0 AND expiresAt > ?').bind(code, owner, Date.now()).first<Link>();
    if (!link) return null;
    const clicks = await this.env.DB.prepare('SELECT id, clickedAt, userAgent, referrer FROM clicks WHERE code = ? ORDER BY clickedAt DESC, id DESC LIMIT 100').bind(code).all<Click>();
    return { link, recentClicks: clicks.results };
  }
  async remove(code: string): Promise<boolean> {
    if (!this.isActive() || !this.ctx.storage.sql.exec('SELECT code FROM owned_links WHERE code = ? AND ready = 1', code).toArray().length) return false;
    await this.removeCanonical(code, this.meta('workspaceId')!);
    this.ctx.storage.sql.exec('DELETE FROM owned_links WHERE code = ?', code);
    return true;
  }
  private async removeCanonical(code: string, owner: string) {
    if (isFull(this.env)) {
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE links SET deleted = 1, url = '' WHERE code = ? AND workspaceId = ?").bind(code, owner),
        this.env.DB.prepare('DELETE FROM clicks WHERE code = ? AND EXISTS (SELECT 1 FROM links WHERE code = ? AND workspaceId = ?)').bind(code, code, owner),
      ]);
      await clearCache(this.env, code);
    }
    await this.env.SHORT_LINKS.getByName(code).remove(owner);
  }
  protected async cleanup() {
    const owner = this.meta('workspaceId'); if (!owner) return;
    for (const { code } of this.ctx.storage.sql.exec<{ code: string }>('SELECT code FROM owned_links').toArray()) await this.removeCanonical(code, owner);
    this.ctx.storage.sql.exec('DELETE FROM owned_links');
  }
}
