import { type AppEnv, type Click, type Link } from './types';
import { clickDetails } from './utils';

export async function cacheLink(env: Env, link: Link): Promise<void> {
  try { await env.CACHE.put(`link:${link.code}`, JSON.stringify({ ...link, cachedAt: Date.now() }), { expirationTtl: 60 }); }
  catch { console.warn(JSON.stringify({ event: 'cache_unavailable', operation: 'write' })); }
}
export async function clearCache(env: Env, code: string): Promise<void> {
  try { await env.CACHE.delete(`link:${code}`); }
  catch { console.warn(JSON.stringify({ event: 'cache_unavailable', operation: 'delete' })); }
}

/** A redirect counts only when its canonical link is still active. KV is optional. */
export async function resolveRedirect(env: AppEnv, code: string, request: Request): Promise<string | null> {
  const click = clickDetails(request);
  return env.SHORT_LINKS.getByName(code).resolve(click, code);
}

export async function resolveFullRedirect(env: Env, code: string, click: Omit<Click, 'id'>): Promise<string | null> {
  let link: Link | null = null;
  try {
    const cached = await env.CACHE.get<Link & { cachedAt: number }>(`link:${code}`, 'json');
    if (cached && cached.code === code && cached.cachedAt > Date.now() - 60_000 && cached.expiresAt > Date.now() && !cached.deleted) link = cached;
  } catch { console.warn(JSON.stringify({ event: 'cache_unavailable', operation: 'read' })); }
  if (!link) {
    link = await env.DB.prepare('SELECT * FROM links WHERE code = ? AND deleted = 0 AND expiresAt > ?').bind(code, Date.now()).first<Link>();
    if (!link) return null;
    await cacheLink(env, link);
  }
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare('INSERT INTO clicks (id, code, clickedAt, userAgent, referrer) SELECT ?, code, ?, ?, ? FROM links WHERE code = ? AND deleted = 0 AND expiresAt > ?').bind(crypto.randomUUID(), click.clickedAt, click.userAgent, click.referrer, code, now),
    env.DB.prepare('UPDATE links SET clickCount = clickCount + 1 WHERE code = ? AND deleted = 0 AND expiresAt > ?').bind(code, now),
    env.DB.prepare('DELETE FROM clicks WHERE code = ? AND id NOT IN (SELECT id FROM clicks WHERE code = ? ORDER BY clickedAt DESC, id DESC LIMIT 100)').bind(code, code),
  ]);
  // This canonical transaction also prevents stale KV entries from redirecting deleted links.
  return result[1].meta.changes === 1 ? link.url : null;
}
