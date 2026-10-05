import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Input, InputArea } from '@cloudflare/kumo/components/input';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';

export type Session = { workspaceId: string; token: string; expiresAt: number };
export async function readResponse<T>(response: Response): Promise<T> { return await response.json() as T; }
export async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
  await navigator.clipboard.writeText(value);
}
// SDK v2's legacy compatibility lane may use SSE even when modern responses are JSON.
async function readMcpResponse(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty MCP response.');
  const decoder = new TextDecoder(); let pending = ''; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('MCP response ended without a result.');
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new Error('MCP response is too large.');
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/); pending = events.pop() ?? '';
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data) as { result?: unknown; error?: unknown };
        if ('result' in message || 'error' in message) return message;
      }
    }
  } finally { await reader.cancel(); }
}
type WorkspaceContext = { session: Session; request: (path: string, init?: RequestInit) => Promise<Response>; reset: () => Promise<void> };
const Workspace = createContext<WorkspaceContext | null>(null);
const STORAGE_KEY = 'serverless-build-workspace-v1';
export function useWorkspace() { const value = useContext(Workspace); if (!value) throw new Error('Missing workspace'); return value; }

function save(session: Session) { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* Ephemeral browser context. */ } }
async function newSession(): Promise<Session> {
  const response = await fetch('/api/session', { method: 'POST' });
  if (!response.ok) throw new Error('Could not create a workspace. Please retry shortly.');
  return response.json();
}
export function AppShell({ title, description, children, apiPath, apiBody, mcp }: { title: string; description: string; children: ReactNode; apiPath: string; apiBody?: string; mcp?: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('app');
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      let existing: Session | null = null;
      try { existing = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { /* Start fresh. */ }
      if (existing?.expiresAt && existing.expiresAt > Date.now()) {
        const response = await fetch('/api/session', { headers: { authorization: `Bearer ${existing.token}` } });
        if (!response.ok) existing = null;
      } else existing = null;
      const next = existing ?? await newSession();
      if (active) { save(next); setSession(next); }
    })().catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not connect.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.mode = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  const request = async (path: string, init: RequestInit = {}) => {
    if (!session) throw new Error('Workspace is not ready.');
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020]/.test(path) || new URL(path, location.origin).origin !== location.origin) throw new Error('Use an app-relative path.');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${session.token}`);
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) {
      const value = await readResponse<{ error?: string }>(response).catch(() => ({ error: undefined }));
      throw new Error(value.error ?? `Request failed (${response.status}).`);
    }
    return response;
  };
  const reset = async () => {
    if (!session) return;
    const response = await fetch('/api/session', { method: 'DELETE', headers: { authorization: `Bearer ${session.token}` } });
    if (!response.ok && response.status !== 401) throw new Error('Could not reset this workspace. Try again shortly.');
    const next = await newSession(); save(next); setSession(next); setTab('app');
  };
  return <div className="app-shell">
    <header className="app-header"><a href="https://serverless.build" target="_blank" rel="noreferrer" className="brand">Serverless.Build <span> / reference apps</span></a><Button onClick={() => setDark(!dark)} aria-label="Toggle color theme">{dark ? 'Light' : 'Dark'} theme</Button></header>
    <main><div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><span className="pill">Cloudflare Workers</span></div>
      {error && <p role="alert" className="notice error">{error}</p>}
      {!session ? !error && <p role="status" className="notice">Opening your workspace…</p> : <Workspace.Provider value={{ session, request, reset }}>
        <nav aria-label="App sections" className="app-tabs">{[['app', 'Workspace'], ['api', 'API'], ...(mcp ? [['mcp', 'MCP']] : []), ['session', 'Session']].map(([id, label]) => <Button key={id} variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>{label}</Button>)}</nav>
        <div key={session.workspaceId}>{tab === 'app' ? children : tab === 'api' ? <ApiPlayground initialPath={apiPath} initialBody={apiBody} /> : tab === 'mcp' ? <McpPanel /> : <SessionPanel />}</div>
        <footer className="app-footer">Private session · expires {new Date(session.expiresAt).toLocaleString()} · <a href="https://serverless.build/solutions" target="_blank" rel="noreferrer">Deploy your own from the solutions library</a></footer>
      </Workspace.Provider>}
    </main>
  </div>;
}

export function SessionPanel() {
  const { session, request, reset } = useWorkspace();
  const [token, setToken] = useState('');
  const [tokens, setTokens] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState('');
  const refresh = async () => setTokens((await readResponse<{ tokens: Array<{ id: string; name: string }> }>(await request('/api/session'))).tokens);
  useEffect(() => { void refresh().catch(error => setError(error.message)); }, []);
  const issue = async () => {
    try { const value = await readResponse<{ token: string }>(await request('/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API and MCP' }) })); setToken(value.token); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not create token.'); }
  };
  return <LayerCard className="panel"><h2>Your session</h2><p>Each visitor has a separate workspace. Save a scoped token to use your data from an API or MCP client.</p><p className="mono">Workspace: {session.workspaceId}</p>
    <Button onClick={() => void issue()}>Create API token</Button>
    {token && <div className="stack"><label htmlFor="api-token">New token — shown once</label><InputArea id="api-token" readOnly value={token} /><Button onClick={() => void copyText(token).catch(() => setError('Clipboard unavailable. Select and copy the token above.'))}>Copy token</Button></div>}
    <ul className="resource-list">{tokens.map(item => <li key={item.id}><span>{item.name}</span><Button onClick={() => void request(`/api/tokens/${item.id}`, { method: 'DELETE' }).then(() => { setToken(''); return refresh(); }).catch(error => setError(error.message))}>Revoke token</Button></li>)}</ul>
    <p className="notice">Reset deletes this workspace and revokes all of its tokens.</p><Button onClick={() => void reset().catch(error => setError(error.message))}>Reset session</Button>{error && <p role="alert" className="error">{error}</p>}
  </LayerCard>;
}

function ApiPlayground({ initialPath, initialBody }: { initialPath: string; initialBody?: string }) {
  const { request } = useWorkspace();
  const [path, setPath] = useState(initialPath);
  const [method, setMethod] = useState('GET');
  const [body, setBody] = useState(initialBody ?? '{"title":"Created with the API"}');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (!path.startsWith('/api/') || path.includes('..') || /[\\\u0000-\u0020]/.test(path)) throw new Error('Use a relative /api/ endpoint.');
      const response = await request(path, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { headers: { 'content-type': 'application/json' }, body }) });
      setResult(`${response.status}\n${response.status === 204 ? 'Deleted' : JSON.stringify(await response.json(), null, 2)}`);
    } catch (error) { setResult(error instanceof Error ? error.message : 'Request failed.'); }
    finally { setBusy(false); }
  };
  return <LayerCard className="panel stack"><h2>API playground</h2><p>Requests operate on your active workspace. <a href="/api/openapi.json" target="_blank" rel="noreferrer">Open API documentation</a></p><div className="form-row"><label>Method<select aria-label="Request method" value={method} onChange={event => setMethod(event.target.value)}>{['GET', 'POST', 'PATCH', 'DELETE'].map(method => <option key={method}>{method}</option>)}</select></label><label className="grow">Endpoint<Input aria-label="API endpoint" value={path} onChange={event => setPath(event.target.value)} /></label></div>{method !== 'GET' && method !== 'DELETE' && <label>JSON body<InputArea aria-label="API request body" value={body} onChange={event => setBody(event.target.value)} /></label>}<Button variant="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Sending…' : 'Send request'}</Button><pre aria-live="polite" className="code-output">{result || 'Response will appear here.'}</pre><p>For an external client, create a token in Session and send <code>Authorization: Bearer $WORKSPACE_TOKEN</code>.</p></LayerCard>;
}

function McpPanel() {
  const { request } = useWorkspace();
  const [result, setResult] = useState('');
  const url = `${location.origin}/mcp`;
  const inspect = async () => {
    try {
      const response = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      setResult(JSON.stringify(await readMcpResponse(response), null, 2));
    } catch (error) { setResult(error instanceof Error ? error.message : 'MCP request failed.'); }
  };
  return <LayerCard className="panel stack"><h2>Connect an MCP client</h2><p>Your MCP tools use the same tasks as the browser and REST API.</p><label>Streamable HTTP endpoint<Input readOnly value={url} /></label><Button onClick={() => void copyText(url).catch(() => setResult('Clipboard unavailable. Select and copy the endpoint above.'))}>Copy MCP endpoint</Button><p>Create a token in Session, then configure MCP Inspector or your client with a bearer authorization header.</p><pre className="code-output">{`npx mcp-remote ${url} --header "Authorization: Bearer $WORKSPACE_TOKEN"`}</pre><p>The token belongs to this workspace and expires with it. Revoke it from Session.</p><Button variant="primary" onClick={() => void inspect()}>List MCP tools</Button><pre className="code-output" aria-live="polite">{result || 'Inspect the live tool list here.'}</pre></LayerCard>;
}
