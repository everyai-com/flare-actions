-- Flare Forge: the authenticated principal (token id / OAuth client /
-- session actor) that claimed an intent. Owner-only verbs (heartbeat
-- token refresh, report_push, mark_ready, abandon, inbox drain) require
-- the same principal; `agent` stays a display label any caller can pick.
-- '' = unclaimed or claimed before this column existed (agent check only).
ALTER TABLE intents ADD COLUMN owner_principal TEXT NOT NULL DEFAULT '';
