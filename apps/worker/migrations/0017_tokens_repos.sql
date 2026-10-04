-- Per-token repo scoping: comma-separated owner/name list; empty means
-- all repos (existing tokens keep full access).
ALTER TABLE api_tokens ADD COLUMN repos TEXT NOT NULL DEFAULT '';
