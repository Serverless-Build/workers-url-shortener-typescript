import { HTTPException } from 'hono/http-exception';
import { text } from './lib/http';
const reserved = new Set(['api', 'health', 'assets', 'mcp', 'session', 'admin', 'cdn-cgi', 'robots', 'index']);
export function shortCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{3,20}$/.test(value) || reserved.has(value.toLowerCase())) throw new HTTPException(400, { message: 'Use 3–20 letters, numbers, or hyphens. Application route names are reserved.' });
  return value;
}
export function destination(value: unknown, appOrigin: string): string {
  const input = text(value, 'url', 2048);
  let url: URL;
  try { url = new URL(input); } catch { throw new HTTPException(400, { message: 'Provide an absolute HTTP or HTTPS URL.' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === appOrigin) throw new HTTPException(400, { message: 'Use an external HTTP or HTTPS URL without embedded credentials.' });
  // Keep destination paths, trailing slashes, queries, and fragments intact.
  return url.href;
}
export function generateCode(): string { return crypto.randomUUID().replaceAll('-', '').slice(0, 12); }
export function clickDetails(request: Request) {
  let referrer = 'direct';
  try { const value = new URL(request.headers.get('referer') ?? ''); if (['http:', 'https:'].includes(value.protocol)) referrer = value.origin; } catch { /* No valid referrer. */ }
  return { clickedAt: Date.now(), userAgent: (request.headers.get('user-agent') ?? 'unknown').slice(0, 200), referrer: referrer.slice(0, 300) };
}
