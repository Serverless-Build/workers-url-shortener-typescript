# URL Shortener with Analytics

A Kumo link-management app with real redirects, custom codes, private click analytics, revocable API tokens, and separate full and native-claimable storage profiles.

## Capabilities

| Capability | Full deployment (`wrangler.jsonc`) | Native claimable (`wrangler.claimable.jsonc`) |
| --- | --- | --- |
| Create, list, copy, and delete owned links | Yes | Yes |
| Custom codes and collision handling | Yes | Yes |
| HTTP 302 redirects preserving paths, query, and fragment | Yes | Yes |
| Exact counted redirects and recent click history | D1 | SQLite Durable Objects |
| Canonical link storage | D1 | SQLite Durable Objects |
| Optional acceleration | KV cache, 60-second freshness bound | No KV binding |
| Session and code coordination | SQLite Durable Objects | SQLite Durable Objects |

The app reports its actual profile at `/api/capabilities`. Native temporary accounts currently use the Durable Object profile because the temporary provisioning path does not provision D1 or KV. It is a functioning shortener with analytics, and can be upgraded in place after claiming.

A workspace lasts 24 hours by default, holds up to 100 links, and supports five external tokens. Recent analytics are bounded to 100 events per code. The native limiter is configured for 60 requests per minute per client IP. Temporary account access lasts up to one hour unless claimed; it does not change the workspace's configured expiry.

## Run locally

Use Node.js 24.21 (see `.node-version`), or Node.js 22.18+ / 24.11+.

```sh
npm ci
npm run typecheck
# Fully local claimable profile:
npm run dev:claimable
```

Open `http://localhost:8787`. For the full storage profile instead:

```sh
npm run db:migrate:local
npm run dev
```

## Deploy the full app

```sh
npx wrangler login
# Set CLOUDFLARE_ACCOUNT_ID when your login has multiple accounts.
npm run deploy
```

Wrangler automatically provisions D1 and KV when resource IDs are omitted. The deploy script applies migrations using the `DB` binding after provisioning. The **Deploy to Cloudflare** button detects these same package build/deploy scripts. The `/health` route must report ready after deployment and migrations complete.

For the bounded profile, use `npm run deploy:claimable` instead.

## Upgrade a claimed deployment

1. Claim the temporary account before its one-hour deadline.
2. Download/clone this complete source repository and authenticate Wrangler to that claimed account.
3. Set the full configuration's Worker `name` to the existing claimed Worker's name. Preserve `ShortenerWorkspace`, `ShortLink`, both binding names, and the initial `v1` SQLite migration.
4. Run `npm ci` and `npm run deploy` in that account. Check `/health` and `/api/capabilities`.
5. Open the same deployed origin with the existing workspace credential.

Each workspace lazily promotes its live links into D1. A public redirect can promote its code before the owner opens the app, preserving link targets and existing counts. The promotion is idempotent; code reservation remains in the same Durable Object namespace, so existing custom codes cannot be reassigned. A new Worker name/namespace is a separate app and does not migrate existing workspace data. Expired workspaces are not revived by an upgrade.

## REST API

Create a session with `POST /api/session` and use the returned token, or issue an external token in **Session**. Every management/analytics request requires `Authorization: Bearer $WORKSPACE_TOKEN`. The app's **API** tab already uses the active workspace credential.

```sh
BASE=http://localhost:8787
curl --request POST "$BASE/api/session"
# Copy the returned token into WORKSPACE_TOKEN in your shell.
curl --request POST "$BASE/api/shorten" \
  --header "Authorization: Bearer $WORKSPACE_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://example.com/a/path/?q=kept#fragment","customCode":"my-demo"}'
curl --include "$BASE/my-demo"
curl "$BASE/api/stats/my-demo" --header "Authorization: Bearer $WORKSPACE_TOKEN"
curl --request DELETE "$BASE/api/urls/my-demo" --header "Authorization: Bearer $WORKSPACE_TOKEN"
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health`, `/api/capabilities`, `/api/openapi.json` | Readiness and actual API/storage capabilities |
| POST / GET / DELETE | `/api/session` | Create, inspect, or reset a workspace |
| POST / DELETE | `/api/tokens`, `/api/tokens/:id` | Issue/revoke scoped external credentials |
| POST | `/api/shorten` | Create `{url, customCode?}`; returns the link and `shortUrl` |
| GET | `/api/urls?page=1&limit=20` | List owned links and pagination counts |
| GET | `/api/stats/:code` | Owned link count and bounded recent click events |
| DELETE | `/api/urls/:code` | Delete an owned link; returns 204 |
| GET | `/:code` | Public, non-cacheable 302 redirect |

Custom codes contain 3–20 letters, numbers, or hyphens. Reserved routes and existing codes return errors. Destinations must be absolute HTTP(S) URLs without credentials or self-origin redirect loops. Deletion, retirement, and expiry invalidate redirects. Deleted codes remain reserved rather than redirecting old links to another visitor's new destination.

## Analytics and privacy

The redirect awaits its counted event before responding. Cache entries can speed up destination lookup but never authorize a deleted or expired D1 row. KV errors fall back to D1. Recent events store a bounded user-agent value and only a referrer's origin; client IPs and referrer path/query values are not stored.

Each visitor's list, statistics, and deletion controls are workspace-authenticated. Public short links intentionally reveal their destination when followed. Browser Origins are checked, JSON streams are limited to 16 KB, and session reset revokes all credentials before storage cleanup.

Run `npm run typecheck` for generated binding types and `npm run bundle:claimable` for a dry-run bundle. [ARCHITECTURE.md](./ARCHITECTURE.md) explains canonical storage, compensation, expiry, and profile promotion.

## Solution and live demo

- [Solution page](https://serverless.build/solutions/url-shortener)
- [Live deployment](https://workers-url-shortener-typescript.dwarven.workers.dev)
