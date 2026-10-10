-- Optional hard expiry for API tokens (Forge judge tokens: 7 days by
-- default). NULL = never expires; findLiveToken treats a past
-- expires_at exactly like a revoked token.
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
