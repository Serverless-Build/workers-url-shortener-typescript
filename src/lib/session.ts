import { DurableObject } from 'cloudflare:workers';
import { hashSecret, randomSecret } from './http';

type Settings = { SESSION_TTL_HOURS: string };

/** One actor per visitor workspace. Application data and authorization survive eviction. */
export abstract class SessionWorkspace<E extends Settings> extends DurableObject<E> {
  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL);
    `);
  }

  protected meta(key: string): string | undefined {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM workspace_meta WHERE key = ?', key).toArray()[0]?.value;
  }

  protected setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec('INSERT INTO workspace_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  async bootstrap(hash: string, workspaceId: string): Promise<{ expiresAt: number }> {
    if (this.meta('expires')) throw new Error('Workspace already initialized');
    const hours = Math.min(720, Math.max(1, Number(this.env.SESSION_TTL_HOURS) || 24));
    const expiresAt = Date.now() + hours * 3_600_000;
    this.ctx.storage.transactionSync(() => {
      this.setMeta('expires', String(expiresAt));
      this.setMeta('workspaceId', workspaceId);
      this.ctx.storage.sql.exec("INSERT INTO workspace_tokens VALUES (?, ?, 'browser', 'Browser session')", crypto.randomUUID(), hash);
    });
    await this.ctx.storage.setAlarm(expiresAt);
    return { expiresAt };
  }

  authorize(hash: string, browserOnly = false): boolean {
    if (!this.isActive()) return false;
    return this.ctx.storage.sql.exec<{ kind: string }>('SELECT kind FROM workspace_tokens WHERE hash = ?', hash).toArray()
      .some(token => !browserOnly || token.kind === 'browser');
  }

  protected isActive(): boolean { return !this.meta('retired') && Number(this.meta('expires') ?? 0) > Date.now(); }

  info() { return { expiresAt: Number(this.meta('expires')), tokens: this.ctx.storage.sql.exec<{ id: string; name: string }>("SELECT id, name FROM workspace_tokens WHERE kind = 'api'").toArray() }; }

  async issueToken(name: string) {
    if (this.info().tokens.length >= 5) return null;
    const secret = randomSecret();
    const hash = await hashSecret(secret);
    const id = crypto.randomUUID();
    // Recheck after the hashing await, which can allow another issuance to interleave.
    if (this.info().tokens.length >= 5 || !this.isActive()) return null;
    this.ctx.storage.sql.exec("INSERT INTO workspace_tokens VALUES (?, ?, 'api', ?)", id, hash, name);
    return { id, secret, name };
  }

  revokeToken(id: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM workspace_tokens WHERE id = ? AND kind = 'api' RETURNING id", id).toArray().length > 0;
  }

  async retire(): Promise<void> {
    // Revoke first; cleanup may involve external storage and must never reopen access.
    this.ctx.storage.sql.exec('DELETE FROM workspace_tokens');
    this.setMeta('retired', '1');
    await this.cleanup();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    try { await this.retire(); }
    catch {
      console.warn(JSON.stringify({ event: 'workspace_cleanup_retry' }));
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
    }
  }
  protected abstract cleanup(): void | Promise<void>;
}
