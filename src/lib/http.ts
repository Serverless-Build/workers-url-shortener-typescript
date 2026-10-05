import { HTTPException } from 'hono/http-exception';

/** Bounds the actual stream, including requests without Content-Length. */
export async function readBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('content-length')) > limit) throw new HTTPException(413, { message: 'Request is too large.' });
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HTTPException(413, { message: 'Request is too large.' }); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new HTTPException(415, { message: 'Use application/json.' });
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await readBytes(request, 16_384)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: 'Provide a JSON object.' });
  }
}

export function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HTTPException(400, { message: `${name} must contain 1–${max} characters.` });
  return value.trim();
}

export function integer(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new HTTPException(400, { message: `Use an integer between 1 and ${maximum}.` });
  return Number(value);
}

export function credentials(request: Request): { workspaceId: string; token: string } {
  const match = /^Bearer ([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '');
  if (!match || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(match[1])) throw new HTTPException(401, { message: 'A workspace bearer token is required.' });
  return { workspaceId: match[1], token: match[2] };
}

export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashSecret(secret: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const documentCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self' https://serverless.build https://www.serverless.build http://localhost:3000 http://127.0.0.1:3000 http://127.0.0.1:3034; base-uri 'self'; form-action 'self'";

export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
