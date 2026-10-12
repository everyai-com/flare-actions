-- Forge <-> GitHub bridge (forge-github.ts, docs/FORGE-GITHUB.md): one
-- row per Forge trunk imported from (and synced with) a GitHub repo.
-- sync_mode decides how landed trunk work flows back to GitHub:
-- off | branch (force-update sync_branch) | pr (branch + one rolling
-- PR into default_branch) | direct (fast-forward default_branch only).
-- pull_upstream = 1 fast-forwards trunk main to GitHub's default branch
-- when trunk is an ancestor (human commits and merged sync PRs flow in).
-- Mirrored in schema.ts; update BOTH together.
CREATE TABLE IF NOT EXISTS forge_github_links (
  repo TEXT PRIMARY KEY,
  github_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  sync_mode TEXT NOT NULL DEFAULT 'pr' CHECK (sync_mode IN ('off', 'branch', 'pr', 'direct')),
  sync_branch TEXT NOT NULL DEFAULT 'flare/trunk',
  pull_upstream INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'importing' CHECK (status IN ('importing', 'ready', 'failed')),
  detail TEXT NOT NULL DEFAULT '',
  installation_id INTEGER,
  is_private INTEGER NOT NULL DEFAULT 0,
  last_pushed_sha TEXT NOT NULL DEFAULT '',
  last_pulled_sha TEXT NOT NULL DEFAULT '',
  pr_number INTEGER,
  last_sync_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forge_github_links_github ON forge_github_links(github_repo);
