import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@cloudflare/kumo/components/button';
import { Input } from '@cloudflare/kumo/components/input';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { AppShell, copyText, readResponse, useWorkspace } from './client';
import type { Click, Link } from '../types';
import './app.css';

function Shortener() {
  const { request } = useWorkspace();
  const [links, setLinks] = useState<Link[]>([]), [url, setUrl] = useState(''), [code, setCode] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [profile, setProfile] = useState('');
  const [stats, setStats] = useState<{ link: Link; recentClicks: Click[] } | null>(null);
  const [notice, setNotice] = useState('');
  const refresh = async () => setLinks((await readResponse<{ urls: Link[] }>(await request('/api/urls'))).urls);
  useEffect(() => { void Promise.all([refresh(), fetch('/api/capabilities').then(response => readResponse<{ storage: string }>(response)).then(value => setProfile(value.storage))]).catch(error => setError(error.message)); }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await request('/api/shorten', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, ...(code ? { customCode: code } : {}) }) }); setUrl(''); setCode(''); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not shorten URL.'); } finally { setBusy(false); }
  };
  const showStats = async (code: string) => { try { setStats(await readResponse(await request(`/api/stats/${code}`))); await refresh(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not load statistics.'); } };
  const remove = async (code: string) => { try { await request(`/api/urls/${code}`, { method: 'DELETE' }); if (stats?.link.code === code) setStats(null); await refresh(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not delete link.'); } };
  return <><p className="notice">Storage: {profile || 'Connecting…'} · Up to 100 links per private workspace. Public short links expire with the session. Deleted codes are never reused.</p>
    <LayerCard className="panel"><h2>Shorten a URL</h2><form onSubmit={event => void create(event)} className="stack"><label>Destination URL<Input aria-label="Destination URL" type="url" value={url} onChange={event => setUrl(event.target.value)} maxLength={2048} placeholder="https://example.com/a/path?with=query" required /></label><div className="form-row"><label className="grow">Custom code <span className="muted">(optional)</span><Input aria-label="Custom code" value={code} onChange={event => setCode(event.target.value)} maxLength={20} placeholder="my-link" /></label><Button type="submit" variant="primary" disabled={busy || !url}>{busy ? 'Shortening…' : 'Create short link'}</Button></div></form>{error && <p role="alert" className="notice error">{error}</p>}<p role="status">{notice}</p></LayerCard>
    <LayerCard className="panel"><div className="page-heading"><div><h2>Your links</h2><p>Open a short link to record a visit, then refresh its statistics.</p></div><Button onClick={() => void refresh().catch(error => setError(error.message))}>Refresh links</Button></div><ul className="resource-list">{links.map(link => <li key={link.code}><div className="grow"><a className="mono" href={`/${link.code}`} target="_blank" rel="noreferrer">{location.origin}/{link.code}</a><p className="muted break-all">{link.url}</p><span>{link.clickCount} clicks · Created {new Date(link.createdAt).toLocaleString()}</span></div><div className="button-row"><Button onClick={() => void copyText(`${location.origin}/${link.code}`).then(() => setNotice('Short link copied.')).catch(() => setError('Clipboard unavailable. Select and copy the short link.'))}>Copy link</Button><Button onClick={() => void showStats(link.code)}>Statistics</Button><Button onClick={() => void remove(link.code)}>Delete</Button></div></li>)}</ul>{!links.length && <p className="notice">No links yet. Create your first short link above.</p>}</LayerCard>
    {stats && <LayerCard className="panel"><h2>Link statistics</h2><p><code>{stats.link.code}</code> · {stats.link.clickCount} total clicks</p><ul className="resource-list">{stats.recentClicks.map(click => <li key={click.id}><div><time>{new Date(click.clickedAt).toLocaleString()}</time><p className="muted">{click.referrer} · {click.userAgent}</p></div></li>)}</ul>{!stats.recentClicks.length && <p>No visits recorded yet.</p>}<Button onClick={() => setStats(null)}>Close statistics</Button></LayerCard>}
  </>;
}
createRoot(document.getElementById('root')!).render(<AppShell title="URL Shortener" description="Create shareable short links, manage your private link collection, and see real click analytics." apiPath="/api/urls" apiBody={'{"url":"https://example.com/a/path?with=query"}'}><Shortener /></AppShell>);
