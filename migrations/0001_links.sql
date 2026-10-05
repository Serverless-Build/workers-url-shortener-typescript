CREATE TABLE IF NOT EXISTS links (
  code TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  url TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  clickCount INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1))
);
CREATE INDEX IF NOT EXISTS links_owner ON links(workspaceId, deleted, createdAt);
CREATE TABLE IF NOT EXISTS clicks (id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES links(code), clickedAt INTEGER NOT NULL, userAgent TEXT NOT NULL, referrer TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS clicks_link_time ON clicks(code, clickedAt);
