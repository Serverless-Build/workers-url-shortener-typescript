# URL Shortener architecture

```text
Kumo browser / REST client                Public short-link visitor
       │ bearer credential                         │ GET /:code
       ▼                                           ▼
Worker: Hono validation, native rate limit, private API and 302 routing
       │                                           │
       ▼                                           ▼
ShortenerWorkspace                           ShortLink (one per code)
tokens, owned-code index, expiry              code reservation / tombstone
       │                                           │
       └──────── full profile: D1 links + clicks ────┘
                           │
                    optional KV cache
```

## Coordination and ownership

An opaque workspace ID selects a `ShortenerWorkspace`; hashed bearer credentials authorize its owned link list and analytics. One `ShortLink` actor per code serializes reservation and prevents reuse across visitor sessions. IDs or knowledge of a code do not authorize statistics or deletion.

Creating a link reserves the code, writes canonical data, and marks the workspace's owned-code entry ready. Failed external writes retire the reservation and compensate partial owned state. Retired codes are tombstones; an old short URL can never acquire another visitor's destination.

## Two explicit storage profiles

In the native claimable profile, `ShortLink` stores its mapping, exact count, and 100 recent events in SQLite. A redirect updates count and events synchronously in one transaction. The workspace's SQLite index lists only its own ready codes.

In the full profile, D1 stores canonical links and click events. `ShortLink` retains code reservation and routes redirect operations. KV optionally caches immutable link destinations for 60 seconds. A D1 batch conditionally inserts an event, increments only an active/unexpired row, and prunes old recent events. The Worker redirects only if that canonical mutation succeeded, so stale KV entries cannot revive a deleted link. Cache failures are logged without visitor data and fall back to canonical storage.

The Worker returns a non-cacheable 302; the visitor's browser follows `Location`. The Worker does not fetch arbitrary destination sites. Counted events represent successful GET redirects, not unique humans or a client-side analytics estimate.

## In-place promotion

Both profiles preserve the same initial Durable Object classes and namespaces. On first full-profile access, a former claimable `ShortLink` promotes its canonical mapping and count into D1. Bounded event IDs are deterministic for idempotent retries. Owner/target checks reject conflicting D1 rows. A redirect can trigger promotion before the owner revisits the workspace.

Workspace-level promotion visits each live owned code before switching its stored profile marker. Deleted or expired links stay invalid. A shared in-flight promotion promise prevents duplicate work while external I/O interleaves; SQLite remains the durable authority for the promotion marker and reservation state.

## Expiry and cleanup

Session retirement revokes token hashes first. Cleanup removes owned D1 events, tombstones D1 links, best-effort invalidates KV, and retires each `ShortLink`. Retryable expiry alarms handle external outages. Public resolution separately enforces the link's expiry even if cleanup is delayed. Tombstones retain code identity with cleared destination data.

Static Assets serves the React/Kumo app through Worker-first routing so document security headers and framing restrictions are preserved. API responses, image-free analytics, and redirects are non-cacheable. Prepared SQL, strict code/URL validation, bounded bodies, per-IP limiting, and revocable per-workspace credentials are present in both profiles.
