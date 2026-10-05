import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { allowedOrigin, credentials, documentCsp, hashSecret, integer, randomSecret, readJson, text } from './lib/http';
import { ShortenerWorkspace, ShortLink } from './workspace';
import { destination, shortCode } from './utils';
import { resolveRedirect } from './storage';
import { isFull, type AppEnv } from './types';
export { ShortenerWorkspace, ShortLink };

const app = new Hono<{ Bindings: AppEnv; Variables: { workspace: DurableObjectStub<ShortenerWorkspace>; workspaceId: string } }>();
app.use('*', async (c, next) => {
  c.header('x-content-type-options', 'nosniff'); c.header('referrer-policy', 'no-referrer'); c.header('cache-control', 'no-store'); c.header('content-security-policy', documentCsp);
  if (!allowedOrigin(c.req.raw)) throw new HTTPException(403, { message: 'Origin is not allowed.' });
  if (c.req.path !== '/health') { const { success } = await c.env.RATE_LIMITER.limit({ key: c.req.header('cf-connecting-ip') ?? 'local' }); if (!success) throw new HTTPException(429, { message: 'Too many requests. Try again shortly.' }); }
  await next();
});
app.get('/health', async c => {
  // A live script can precede Durable Object namespace propagation.
  await Promise.all([
    c.env.WORKSPACES.getByName('health-readiness').info(),
    c.env.SHORT_LINKS.getByName('health-readiness').snapshot('health-readiness'),
  ]);
  if (isFull(c.env)) await c.env.DB.prepare('SELECT COUNT(*) FROM links').first();
  return c.json({ status: 'ok', ready: true, profile: c.env.STORAGE_PROFILE, marker: 'SERVERLESS_BUILD_URL_SHORTENER_V1' });
});
app.get('/api/capabilities', c => c.json({ profile: c.env.STORAGE_PROFILE, storage: isFull(c.env) ? 'D1 + optional KV cache' : 'SQLite Durable Objects', maxLinks: 100, sessionTtlHours: Number(c.env.SESSION_TTL_HOURS), redirects: true, analytics: true }));
app.get('/api/openapi.json', c => c.json({ openapi: '3.1.0', info: { title: 'URL Shortener API', version: '2.0.0' }, security: [{ workspace: [] }], components: { securitySchemes: { workspace: { type: 'http', scheme: 'bearer' } } }, paths: {
  '/api/session': { post: { summary: 'Create private workspace', security: [], responses: { '201': { description: 'Bearer token and expiry' } } } },
  '/api/shorten': { post: { summary: 'Shorten a URL', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', maxLength: 2048 }, customCode: { type: 'string', pattern: '^[a-zA-Z0-9-]{3,20}$' } } } } } }, responses: { '201': { description: 'Created link' }, '409': { description: 'Code used or workspace full' } } } },
  '/api/urls': { get: { summary: 'List your links with limit and page', responses: { '200': { description: 'Private links and counts' } } } },
  '/api/stats/{code}': { get: { summary: 'Read owned link statistics', parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Link and most recent 100 clicks' }, '404': { description: 'Not owned or deleted' } } } },
  '/api/urls/{code}': { delete: { summary: 'Delete an owned link; code is never reused', parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } } },
} }));
app.post('/api/session', async c => {
  const workspaceId = crypto.randomUUID(), secret = randomSecret();
  const { expiresAt } = await c.env.WORKSPACES.getByName(workspaceId).bootstrap(await hashSecret(secret), workspaceId);
  return c.json({ workspaceId, token: `${workspaceId}.${secret}`, expiresAt }, 201);
});
app.use('/api/*', async (c, next) => {
  const credential = credentials(c.req.raw), workspace = c.env.WORKSPACES.getByName(credential.workspaceId);
  const browserOnly = c.req.path.startsWith('/api/tokens') || (c.req.path === '/api/session' && c.req.method === 'DELETE');
  if (!await workspace.authorize(await hashSecret(credential.token), browserOnly)) throw new HTTPException(401, { message: 'Workspace credential has expired or was revoked.' });
  if (isFull(c.env)) await workspace.ensureFullStorage();
  c.set('workspace', workspace); c.set('workspaceId', credential.workspaceId); await next();
});
app.get('/api/session', async c => c.json(await c.get('workspace').info()));
app.delete('/api/session', async c => { await c.get('workspace').retire(); return c.body(null, 204); });
app.post('/api/tokens', async c => {
  const body = await readJson(c.req.raw), token = await c.get('workspace').issueToken(text(body.name, 'name', 50));
  if (!token) throw new HTTPException(409, { message: 'Revoke an existing token before creating another.' });
  return c.json({ id: token.id, name: token.name, token: `${c.get('workspaceId')}.${token.secret}` }, 201);
});
app.delete('/api/tokens/:id', async c => { if (!await c.get('workspace').revokeToken(c.req.param('id'))) throw new HTTPException(404, { message: 'Token not found.' }); return c.body(null, 204); });
app.post('/api/shorten', async c => {
  const body = await readJson(c.req.raw);
  if (Object.keys(body).some(key => !['url', 'customCode'].includes(key))) throw new HTTPException(400, { message: 'Specify url and optional customCode only.' });
  const result = await c.get('workspace').create(destination(body.url, new URL(c.req.url).origin), body.customCode === undefined || body.customCode === '' ? undefined : shortCode(body.customCode));
  if ('error' in result) throw new HTTPException(result.error === 'expired' ? 401 : 409, { message: result.error === 'limit' ? 'This workspace supports up to 100 links.' : result.error === 'expired' ? 'Workspace expired.' : 'This code has already been used. Choose another.' });
  return c.json({ ...result.link, shortUrl: `${new URL(c.req.url).origin}/${result.link.code}` }, 201);
});
app.get('/api/urls', async c => { const limit = integer(c.req.query('limit'), 100, 100), page = integer(c.req.query('page'), 1, 100); return c.json(await c.get('workspace').list(limit, (page - 1) * limit)); });
app.get('/api/stats/:code', async c => { const result = await c.get('workspace').stats(shortCode(c.req.param('code'))); if (!result) throw new HTTPException(404, { message: 'Link not found in your workspace.' }); return c.json(result); });
app.delete('/api/urls/:code', async c => { if (!await c.get('workspace').remove(shortCode(c.req.param('code')))) throw new HTTPException(404, { message: 'Link not found in your workspace.' }); return c.body(null, 204); });
app.all('/api/*', c => c.json({ error: 'Endpoint not found.' }, 404));
app.get('/:code', async c => {
  const code = shortCode(c.req.param('code'));
  const url = await resolveRedirect(c.env, code, c.req.raw);
  if (!url) return c.text('This link was not found, was deleted, or has expired.', 404);
  c.header('cache-control', 'no-store, max-age=0'); return c.redirect(url, 302);
});
app.all('*', async c => { const response = await c.env.ASSETS.fetch(c.req.raw); const headers = new Headers(response.headers); headers.set('content-security-policy', documentCsp); headers.set('x-content-type-options', 'nosniff'); headers.set('referrer-policy', 'no-referrer'); return new Response(response.body, { status: response.status, headers }); });
app.onError((error, c) => { if (!(error instanceof HTTPException)) console.error(JSON.stringify({ event: 'request_error', kind: error.name })); return c.json({ error: error instanceof HTTPException ? error.message : 'Request failed. Please retry.' }, error instanceof HTTPException ? error.status : 500); });
export default app;
