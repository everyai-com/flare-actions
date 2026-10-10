// Demo fixtures for the Forge dashboard screens (docs/FORGE-UX.md §11:
// "build against fixture JSON first"). Two repos:
//
// - `flare/bookshelf` mirrors the designed demo trunk in
//   `examples/forge-demo` (seed/goals.json): 13 intents across 3 goals,
//   the clean overlap on src/index.ts, the textual conflict on
//   src/middleware/logging.ts, the semantic page-size pair that only the
//   train's combined-SHA CI catches, and the protected src/auth/** plan.
// - `sim/monorepo` is the scale shot: a compact spec the dashboard
//   expands deterministically into 10,000 simulated agents.
//
// The dashboard only renders these when `?demo=1` is set or a Forge
// endpoint is missing (404/501), and it always labels them as demo data.
// No number here is a measurement. Text must stay free of backticks and
// dollar-brace sequences (DASHBOARD_HTML embeds it; see dashboard.test.ts).

export interface FixtureRiskTerm {
  term: "protected_path" | "footprint_size" | "drift" | "llm_replay" | "weak_evidence" | "reviewer_disagrees";
  points: number;
  detail: string;
}

export interface FixtureAgent {
  id: string;
  label: string;
  client: string;
  intent: string | null;
  last_tool: string;
  last_ago_s: number;
  landed_today: number;
}

export interface FixtureIntent {
  id: string;
  goal_id: string;
  title: string;
  agent: string;
  state: string;
  risk: number;
  risk_terms: FixtureRiskTerm[];
  path: string;
  footprint: { declared: string[]; actual: string[]; drift: string[] };
  reasoning: string;
  accept: string;
  rejected: string[];
  plan: string[];
  train_id: string | null;
  landed_sha: string | null;
  lease_expires_in_s: number | null;
  route: "auto" | "audit" | "human" | null;
  escalation: string | null;
  evidence: { run_id: string; sha: string; status: string; tests: number; duration_s: number; reviewer: string; note?: string } | null;
  created_at: string;
}

const BOOKSHELF = "flare/bookshelf";
const HEAD = "9f2c1e0";

const agents: FixtureAgent[] = [
  { id: "a-01", label: "C1", client: "claude-code", intent: "i-77b4", last_tool: "report_push", last_ago_s: 12, landed_today: 1 },
  { id: "a-02", label: "C2", client: "claude-code", intent: "i-3b90", last_tool: "mark_ready", last_ago_s: 48, landed_today: 0 },
  { id: "a-03", label: "C3", client: "claude-code", intent: "i-9a01", last_tool: "declare_intent", last_ago_s: 94, landed_today: 2 },
  { id: "a-04", label: "C4", client: "claude-code", intent: "i-7f3a", last_tool: "heartbeat", last_ago_s: 4, landed_today: 1 },
  { id: "a-05", label: "CX", client: "codex", intent: "i-4c22", last_tool: "report_push", last_ago_s: 18, landed_today: 0 },
  { id: "a-06", label: "CR", client: "cursor", intent: "i-55e0", last_tool: "mark_ready", last_ago_s: 66, landed_today: 1 },
  { id: "a-07", label: "AI", client: "workers-ai", intent: null, last_tool: "resolve_conflict", last_ago_s: 140, landed_today: 0 },
  { id: "a-08", label: "C8", client: "claude-code", intent: "i-c310", last_tool: "mark_ready", last_ago_s: 210, landed_today: 0 },
  { id: "a-09", label: "C9", client: "claude-code", intent: "i-31c2", last_tool: "claim_conflict", last_ago_s: 31, landed_today: 0 },
];

const goals = [
  { id: "g-1", text: "Make every Bookshelf request observable: traceable ids, version info on /health, catalog metrics, and stable error codes." },
  { id: "g-2", text: "Make the catalog nicer to browse: author bibliographies, fewer round trips per page, forgiving search, and valid ISBNs." },
  { id: "g-3", text: "Harden the API for public launch: rotatable API keys, bounded pages, rate limiting, request latency in logs, and a CORS allowlist." },
];

function size(n: number, files: number): FixtureRiskTerm {
  return { term: "footprint_size", points: n, detail: files + " files" };
}

const intents: FixtureIntent[] = [
  {
    id: "i-1d4e", goal_id: "g-1", title: "Tag every request with an x-request-id and log it", agent: "a-01", state: "landed",
    risk: 3, risk_terms: [size(3, 2)], path: "src/middleware/logging.ts",
    footprint: { declared: ["src/middleware/logging.ts", "test/request-id.test.ts"], actual: ["src/middleware/logging.ts", "test/request-id.test.ts"], drift: [] },
    reasoning: "Support cannot join a customer's report to our logs. Reuse the caller's x-request-id (or cf-ray) when present so traces join across hops; otherwise mint a UUID. Echo it on the response and add it to the access-log line.",
    accept: "node --test test/request-id.test.ts", rejected: ["Generate ids in each route handler: misses 404s and middleware errors."],
    plan: ["Read the x-request-id or cf-ray header", "Mint a UUID when absent", "Echo it on the response", "Add requestId to formatLogLine"],
    train_id: "t-141", landed_sha: "4be17a2", lease_expires_in_s: null, route: "auto", escalation: null,
    evidence: { run_id: "r-871", sha: "4be17a2", status: "success", tests: 38, duration_s: 31, reviewer: "agrees" }, created_at: "2026-10-12T13:41:07Z",
  },
  {
    id: "i-2a71", goal_id: "g-1", title: "Report build version and uptime on /health", agent: "a-03", state: "landed",
    risk: 3, risk_terms: [size(3, 2)], path: "src/routes/health.ts",
    footprint: { declared: ["src/routes/health.ts", "test/health-version.test.ts"], actual: ["src/routes/health.ts", "test/health-version.test.ts"], drift: [] },
    reasoning: "After a deploy we cannot tell which build is serving. Expose a semver VERSION and uptimeSeconds; keep ok:true so existing probes stay green.",
    accept: "node --test test/health-version.test.ts", rejected: ["A separate /version route: probes already hit /health."],
    plan: ["Export VERSION", "Track isolate start time", "Return version and uptimeSeconds"],
    train_id: "t-142", landed_sha: HEAD, lease_expires_in_s: null, route: "auto", escalation: null,
    evidence: { run_id: "r-889", sha: HEAD, status: "success", tests: 41, duration_s: 38, reviewer: "agrees" }, created_at: "2026-10-12T13:44:52Z",
  },
  {
    id: "i-3b90", goal_id: "g-1", title: "Expose catalog gauges at GET /metrics", agent: "a-02", state: "in_train",
    risk: 4, risk_terms: [size(4, 3)], path: "src/routes/metrics.ts",
    footprint: { declared: ["src/routes/metrics.ts", "src/index.ts", "test/metrics.test.ts"], actual: ["src/routes/metrics.ts", "src/index.ts", "test/metrics.test.ts"], drift: [] },
    reasoning: "Dashboards need book and author counts without paging the API. Prometheus text format is what our scraper speaks. Registered in the route table only; no middleware change.",
    accept: "node --test test/metrics.test.ts", rejected: ["JSON metrics: the scraper only speaks the Prometheus text format."],
    plan: ["Add routes/metrics.ts with two gauges", "Register it in the route table after /health", "Test the text format"],
    train_id: "t-143", landed_sha: null, lease_expires_in_s: null, route: null, escalation: null,
    evidence: { run_id: "r-902", sha: "c71e04b", status: "success", tests: 40, duration_s: 29, reviewer: "agrees" }, created_at: "2026-10-12T13:47:30Z",
  },
  {
    id: "i-4c22", goal_id: "g-1", title: "Add stable machine-readable codes to error bodies", agent: "a-05", state: "working",
    risk: 3, risk_terms: [size(3, 2)], path: "src/lib/errors.ts",
    footprint: { declared: ["src/lib/errors.ts", "test/error-codes.test.ts"], actual: ["src/lib/errors.ts"], drift: [] },
    reasoning: "Clients string-match error messages, so every wording change breaks them. Add an additive code field derived from the status; keep error as the human message.",
    accept: "node --test test/error-codes.test.ts", rejected: ["Rename error to message: breaks every existing client."],
    plan: ["Map status to a stable code", "Add code next to error", "Test every status"],
    train_id: null, landed_sha: null, lease_expires_in_s: 248, route: null, escalation: null, evidence: null, created_at: "2026-10-12T14:01:12Z",
  },
  {
    id: "i-55e0", goal_id: "g-2", title: "List an author's books at GET /authors/:id/books", agent: "a-06", state: "in_train",
    risk: 3, risk_terms: [size(3, 2)], path: "src/routes/authors.ts",
    footprint: { declared: ["src/routes/authors.ts", "test/author-books.test.ts"], actual: ["src/routes/authors.ts", "test/author-books.test.ts"], drift: [] },
    reasoning: "The author page fetches all books and filters client-side. Serve it directly, paged, with its own page default so it does not couple to /books paging.",
    accept: "node --test test/author-books.test.ts", rejected: ["Add ?author= filtering to /books: it already exists and still returns every field."],
    plan: ["Add the nested route", "Page with its own default", "Test 404 for unknown authors"],
    train_id: "t-143", landed_sha: null, lease_expires_in_s: null, route: null, escalation: null,
    evidence: { run_id: "r-903", sha: "a1b2c3d", status: "success", tests: 43, duration_s: 30, reviewer: "agrees" }, created_at: "2026-10-12T13:52:40Z",
  },
  {
    id: "i-6d13", goal_id: "g-2", title: "Raise the /books default page size from 20 to 30", agent: "a-01", state: "landed",
    risk: 3, risk_terms: [size(3, 2)], path: "src/routes/books.ts",
    footprint: { declared: ["src/routes/books.ts", "test/default-page-size.test.ts"], actual: ["src/routes/books.ts", "test/default-page-size.test.ts"], drift: [] },
    reasoning: "The mobile list shows about 28 rows per screen, so a 20-item page forces a second request on first paint. 30 fills the screen in one round trip.",
    accept: "node --test test/default-page-size.test.ts", rejected: ["Client-side prefetch: doubles requests on desktop."],
    plan: ["Set DEFAULT_PAGE_SIZE to 30", "Test the default page"],
    train_id: "t-142", landed_sha: HEAD, lease_expires_in_s: null, route: "auto", escalation: null,
    evidence: { run_id: "r-889", sha: HEAD, status: "success", tests: 41, duration_s: 38, reviewer: "agrees" }, created_at: "2026-10-12T13:45:18Z",
  },
  {
    id: "i-77b4", goal_id: "g-2", title: "Make ?q= case-insensitive substring search", agent: "a-01", state: "working",
    risk: 18, risk_terms: [size(3, 2), { term: "drift", points: 15, detail: "1 undeclared file: src/routes/books.ts" }], path: "src/lib/store.ts",
    footprint: { declared: ["src/lib/store.ts", "test/fuzzy-search.test.ts"], actual: ["src/lib/store.ts", "src/routes/books.ts", "test/fuzzy-search.test.ts"], drift: ["src/routes/books.ts"] },
    reasoning: "Users type dune and get nothing because search is a case-sensitive prefix match. Match anywhere in the title, ignoring case.",
    accept: "node --test test/fuzzy-search.test.ts", rejected: ["Full-text index: overkill for a 10k-row catalog."],
    plan: ["Lower-case both sides", "Use includes instead of startsWith", "Test mixed case and mid-word matches"],
    train_id: null, landed_sha: null, lease_expires_in_s: 196, route: null, escalation: null,
    evidence: { run_id: "r-905", sha: "5e0d9aa", status: "running", tests: 0, duration_s: 0, reviewer: "pending" }, created_at: "2026-10-12T14:03:55Z",
  },
  {
    id: "i-8e05", goal_id: "g-2", title: "Reject ISBN-13s with a bad checksum", agent: "a-03", state: "landed",
    risk: 3, risk_terms: [size(3, 2)], path: "src/lib/validate.ts",
    footprint: { declared: ["src/lib/validate.ts", "test/isbn-validation.test.ts"], actual: ["src/lib/validate.ts", "test/isbn-validation.test.ts"], drift: [] },
    reasoning: "Typos in ISBNs break the cover-image lookup downstream. Validate the ISBN-13 checksum at write time; hyphens and spaces are allowed.",
    accept: "node --test test/isbn-validation.test.ts", rejected: ["Validate in the cover service: bad rows are already stored by then."],
    plan: ["Strip hyphens and spaces", "Check the mod-10 weighted sum", "Return 400 with a code"],
    train_id: "t-142", landed_sha: HEAD, lease_expires_in_s: null, route: "auto", escalation: null,
    evidence: { run_id: "r-889", sha: HEAD, status: "success", tests: 41, duration_s: 38, reviewer: "agrees" }, created_at: "2026-10-12T13:46:01Z",
  },
  {
    id: "i-9a01", goal_id: "g-3", title: "Accept a list of API keys so keys rotate without downtime", agent: "a-03", state: "awaiting_plan",
    risk: 43, risk_terms: [{ term: "protected_path", points: 40, detail: "touches src/auth/**" }, size(3, 2)], path: "src/auth/apiKey.ts",
    footprint: { declared: ["src/auth/apiKey.ts", "test/api-key-rotation.test.ts"], actual: [], drift: [] },
    reasoning: "Rotating the single API_KEY breaks every client at once. Accept a comma-separated list (new key first, old key until clients move); compare against every key so timing does not reveal the slot.",
    accept: "node --test test/api-key-rotation.test.ts", rejected: ["Two env vars API_KEY and API_KEY_OLD: a third rotation needs another deploy."],
    plan: ["Split API_KEY on commas and trim", "Compare against every key in constant time", "Keep the single-key form working", "Test old and new keys during rotation"],
    train_id: null, landed_sha: null, lease_expires_in_s: null, route: "human", escalation: "plan",
    evidence: null, created_at: "2026-10-12T14:04:10Z",
  },
  {
    id: "i-c310", goal_id: "g-3", title: "Cap list pages at 25 items", agent: "a-08", state: "ready",
    risk: 43, risk_terms: [size(3, 2), { term: "drift", points: 15, detail: "1 undeclared file: src/routes/books.ts" }, { term: "weak_evidence", points: 10, detail: "contract test red on t-142 combined SHA 7e91f00" }, { term: "reviewer_disagrees", points: 15, detail: "reviewer: 25 < DEFAULT_PAGE_SIZE 30 now on main" }],
    path: "src/lib/pagination.ts",
    footprint: { declared: ["src/lib/pagination.ts", "test/max-page-size.test.ts"], actual: ["src/lib/pagination.ts", "src/routes/books.ts", "test/max-page-size.test.ts"], drift: ["src/routes/books.ts"] },
    reasoning: "A 50-item page is the largest single response we serve and will be the largest D1 read after the migration. Bound payload size at 25.",
    accept: "node --test test/max-page-size.test.ts", rejected: ["Cap at 50 and stream: the D1 read is the cost, not the transfer."],
    plan: ["Set MAX_PAGE_SIZE to 25", "Clamp in parseLimit", "Test the cap"],
    train_id: null, landed_sha: null, lease_expires_in_s: null, route: "human", escalation: "Bisect culprit in t-142: with i-6d13 on main, DEFAULT_PAGE_SIZE 30 > MAX_PAGE_SIZE 25",
    evidence: { run_id: "r-887", sha: "88d1f42", status: "failure", tests: 41, duration_s: 29, reviewer: "disagrees", note: "contract: the default page size is servable" }, created_at: "2026-10-12T13:49:02Z",
  },
  {
    id: "i-7f3a", goal_id: "g-3", title: "Rate-limit clients per IP (429 past the limit)", agent: "a-04", state: "working",
    risk: 21, risk_terms: [size(6, 4), { term: "drift", points: 15, detail: "1 undeclared file: src/lib/ip.ts" }], path: "src/middleware/rateLimit.ts",
    footprint: { declared: ["src/middleware/rateLimit.ts", "src/index.ts", "test/rate-limit.test.ts", "wrangler.jsonc"], actual: ["src/middleware/rateLimit.ts", "src/index.ts", "src/lib/ip.ts", "test/rate-limit.test.ts"], drift: ["src/lib/ip.ts"] },
    reasoning: "One scraper can starve the isolate. A fixed-window per-IP limit (RATE_LIMIT per minute, default 600) sheds abuse; it sits inside CORS so browsers can read the 429. Wired into the middleware chain only; no route change. Registers after auth per the note from i-3b90.",
    accept: "node --test test/rate-limit.test.ts ; p95 < 5ms",
    rejected: ["KV counter: eventual consistency lets bursts through.", "Per-route limits: every new route would need wiring."],
    plan: ["Add middleware/rateLimit.ts with a fixed window", "Extract clientIp into lib/ip.ts", "Register inside CORS in src/index.ts", "Test 429 past the limit"],
    train_id: null, landed_sha: null, lease_expires_in_s: 42, route: null, escalation: null,
    evidence: { run_id: "r-904", sha: "e4a90c1", status: "success", tests: 12, duration_s: 31, reviewer: "agrees" }, created_at: "2026-10-12T14:02:11Z",
  },
  {
    id: "i-31c2", goal_id: "g-3", title: "Log request latency (durationMs) on every access-log line", agent: "a-09", state: "replaying",
    risk: 18, risk_terms: [size(3, 2), { term: "llm_replay", points: 15, detail: "replayed on trunk with i-1d4e in context" }], path: "src/middleware/logging.ts",
    footprint: { declared: ["src/middleware/logging.ts", "test/log-latency.test.ts"], actual: ["src/middleware/logging.ts", "test/log-latency.test.ts"], drift: [] },
    reasoning: "We cannot see slow endpoints before launch. Measure around next() with performance.now() and add durationMs to the access-log line.",
    accept: "node --test test/log-latency.test.ts", rejected: ["Log in each route: misses middleware time."],
    plan: ["Measure around next()", "Add durationMs to formatLogLine", "Keep requestId from i-1d4e"],
    train_id: null, landed_sha: null, lease_expires_in_s: 260, route: null, escalation: null,
    evidence: { run_id: "r-906", sha: "b81f3d0", status: "running", tests: 0, duration_s: 0, reviewer: "pending" }, created_at: "2026-10-12T13:42:44Z",
  },
  {
    id: "i-e0c7", goal_id: "g-3", title: "Restrict CORS to an origin allowlist when configured", agent: "a-06", state: "landed",
    risk: 18, risk_terms: [size(3, 2), { term: "reviewer_disagrees", points: 15, detail: "reviewer: preflight for unlisted origins returns 204 without headers" }], path: "src/middleware/cors.ts",
    footprint: { declared: ["src/middleware/cors.ts", "test/cors-allowlist.test.ts"], actual: ["src/middleware/cors.ts", "test/cors-allowlist.test.ts"], drift: [] },
    reasoning: "A wildcard origin lets any site call write endpoints from a logged-in browser. When CORS_ORIGINS is set, echo only listed origins (with Vary: Origin); unset keeps the wildcard so local dev is unchanged.",
    accept: "node --test test/cors-allowlist.test.ts", rejected: ["Always require an allowlist: breaks local dev."],
    plan: ["Parse CORS_ORIGINS", "Echo listed origins with Vary: Origin", "Keep the wildcard when unset"],
    train_id: "t-142", landed_sha: HEAD, lease_expires_in_s: null, route: "audit", escalation: null,
    evidence: { run_id: "r-889", sha: HEAD, status: "success", tests: 41, duration_s: 38, reviewer: "disagrees" }, created_at: "2026-10-12T13:47:58Z",
  },
];

const tree = [
  { path: "src/routes", files: 4 },
  { path: "src/middleware", files: 3 },
  { path: "src/lib", files: 6 },
  { path: "src/auth", files: 2 },
  { path: "src/index.ts", files: 1 },
  { path: "test", files: 14 },
  { path: "migrations", files: 1 },
  { path: ".flare", files: 1 },
  { path: "(root)", files: 6 },
];

const trains = [
  {
    id: "t-143", state: "verifying", base_sha: HEAD, head_sha: "d03b7e5", started_at: "2026-10-12T14:05:40Z", duration_s: 21,
    lanes: [
      { n: 1, paths: ["src/routes/metrics.ts", "src/index.ts"], intents: ["i-3b90"], stages: { merge: "done", push: "done", ci: { status: "running", run: "r-907", sha: "d03b7e5", duration_s: 21 }, cas: "pending" } },
      { n: 2, paths: ["src/routes/authors.ts"], intents: ["i-55e0"], stages: { merge: "done", push: "running", ci: { status: "pending", run: null, sha: null, duration_s: 0 }, cas: "pending" } },
    ],
    bisect: null, result: null,
  },
  {
    id: "t-142", state: "bisected", base_sha: "4be17a2", head_sha: "7e91f00", started_at: "2026-10-12T13:55:02Z", duration_s: 134,
    lanes: [
      { n: 1, paths: ["src/routes/health.ts", "src/lib/validate.ts"], intents: ["i-2a71", "i-8e05"], stages: { merge: "done", push: "done", ci: { status: "success", run: "r-884", sha: "1f0a7c2", duration_s: 31 }, cas: "done" } },
      { n: 2, paths: ["src/routes/books.ts", "src/lib/pagination.ts"], intents: ["i-6d13", "i-c310"], stages: { merge: "done", push: "done", ci: { status: "failure", run: "r-885", sha: "7e91f00", duration_s: 29 }, cas: "skipped" } },
      { n: 3, paths: ["src/middleware/cors.ts"], intents: ["i-e0c7"], stages: { merge: "done", push: "done", ci: { status: "success", run: "r-886", sha: "2c5d8e1", duration_s: 22 }, cas: "done" } },
    ],
    bisect: {
      lane: 2, count: 2, status: "failure", sha: "7e91f00", intents: ["i-6d13", "i-c310"],
      children: [
        { count: 1, status: "success", sha: "3c0a91e", intents: ["i-6d13"], children: [] },
        { count: 1, status: "failure", sha: "88d1f42", intents: ["i-c310"], culprit: true, note: "on top of i-6d13: back to ready, owner notified", children: [] },
      ],
    },
    result: { landed: 4, requeued: 1, sha: HEAD, run: "r-889", tests: 41 },
  },
  {
    id: "t-141", state: "landed", base_sha: "a07c3e9", head_sha: "4be17a2", started_at: "2026-10-12T13:44:10Z", duration_s: 38,
    lanes: [
      { n: 1, paths: ["src/middleware/logging.ts"], intents: ["i-1d4e"], stages: { merge: "done", push: "done", ci: { status: "success", run: "r-871", sha: "4be17a2", duration_s: 31 }, cas: "done" } },
    ],
    bisect: null, result: { landed: 1, requeued: 0, sha: "4be17a2", run: "r-871", tests: 38 },
  },
];

const conflicts = [
  {
    id: "c-9", state: "claimed", files: ["src/middleware/logging.ts"], lines: "12-31", train_id: "t-141",
    a: { intent: "i-1d4e", agent: "a-01", title: "Tag every request with an x-request-id and log it", goal: "g-1", goal_text: "traceable ids on every request",
      why: "Reuse the caller's x-request-id so traces join across hops; add it to the access-log line.", footprint: ["src/middleware/logging.ts", "test/request-id.test.ts"],
      hunk: ["-export function formatLogLine(req, status) {", "+export function formatLogLine(req, status, requestId) {", "+  const id = requestId ?? crypto.randomUUID()"], landed: true },
    b: { intent: "i-31c2", agent: "a-09", title: "Log request latency (durationMs) on every access-log line", goal: "g-3", goal_text: "see slow endpoints before launch",
      why: "Measure around next() with performance.now() and add durationMs to the access-log line.", footprint: ["src/middleware/logging.ts", "test/log-latency.test.ts"],
      hunk: ["-export function formatLogLine(req, status) {", "+export function formatLogLine(req, status, durationMs) {", "+  const started = performance.now()"], landed: false },
    replay: { by: "a-09", stage: "ci", stages: [
      { name: "claimed", status: "done", at: "2026-10-12T14:06:05Z" },
      { name: "replaying", status: "done", at: "2026-10-12T14:06:41Z" },
      { name: "CI on exact SHA", status: "running", at: null },
      { name: "train", status: "pending", at: null },
      { name: "landed", status: "pending", at: null },
    ] },
    race_k: 3,
    race: [
      { attempt: 1, agent: "a-09", ci: { status: "success", duration_s: 29, failed: 0 }, diffstat: { add: 6, del: 2 }, reviewer: "agrees", winner: true, rule: "smallest green diff, reviewer agrees" },
      { attempt: 2, agent: "a-05", ci: { status: "success", duration_s: 31, failed: 0 }, diffstat: { add: 11, del: 4 }, reviewer: "partial", winner: false, rule: "" },
      { attempt: 3, agent: "a-07", ci: { status: "failure", duration_s: 27, failed: 2 }, diffstat: { add: 9, del: 9 }, reviewer: "none", winner: false, rule: "" },
    ],
  },
];

const loggingSource = [
  "import type { Handler } from \"../lib/http.ts\";",
  "",
  "// Access log: one JSON line per request.",
  "export function withLogging(next: Handler): Handler {",
  "  return async (req, env) => {",
  "    const requestId = req.headers.get(\"x-request-id\") ?? req.headers.get(\"cf-ray\") ?? crypto.randomUUID();",
  "    const started = performance.now();",
  "    const res = await next(req, env);",
  "    const durationMs = Math.round(performance.now() - started);",
  "    res.headers.set(\"x-request-id\", requestId);",
  "    console.log(formatLogLine(req, res.status, requestId, durationMs));",
  "    return res;",
  "  };",
  "}",
  "",
  "export function formatLogLine(req: Request, status: number, requestId: string, durationMs: number): string {",
  "  const url = new URL(req.url);",
  "  return JSON.stringify({ method: req.method, path: url.pathname, status, requestId, durationMs });",
  "}",
];

// line (1-based) -> intent that last touched it; null = pre-Forge commit.
const loggingBlame: Record<string, string | null> = {
  "1": null, "3": null, "4": null, "5": null,
  "6": "i-1d4e", "7": "i-31c2", "8": null, "9": "i-31c2", "10": "i-1d4e", "11": "i-31c2", "12": null, "13": null, "14": null,
  "16": "i-31c2", "17": null, "18": "i-31c2", "19": null,
};

const sessions: Record<string, Array<{ t: number; kind: string; text: string }>> = {
  "i-7f3a": [
    { t: 0, kind: "plan", text: "Read src/index.ts and the middleware chain" },
    { t: 41, kind: "reason", text: "Overlap with i-3b90 on src/index.ts; will register inside CORS, after the route table" },
    { t: 72, kind: "tool", text: "declare_intent -> overlaps[1]: i-3b90 (C2)" },
    { t: 95, kind: "tool", text: "send_note -> i-3b90" },
    { t: 210, kind: "push", text: "e4a90c1 +84 -3, 4 files" },
    { t: 214, kind: "alert", text: "drift: src/lib/ip.ts was not declared (+15 risk)" },
    { t: 401, kind: "tool", text: "heartbeat -> lease renewed 300s" },
  ],
};

const mailbox: Record<string, Array<{ from_intent: string; from_agent: string; body: string; at: string }>> = {
  "i-7f3a": [
    { from_intent: "i-3b90", from_agent: "a-02", body: "I'm adding a route-table line in src/index.ts after the health import. Please register your middleware in the chain at the bottom so we merge cleanly.", at: "2026-10-12T14:03:20Z" },
  ],
  "i-31c2": [
    { from_intent: "i-1d4e", from_agent: "a-01", body: "formatLogLine now takes requestId as its third argument. Keep it when you add durationMs.", at: "2026-10-12T13:58:02Z" },
  ],
};

function bookshelfSnapshot() {
  return {
    v: 1,
    repo: BOOKSHELF,
    head: { sha: HEAD, at: "2026-10-12T14:00:12Z" },
    policy: { protected: ["src/auth/**", "migrations/**"], auto_land_max_risk: 30, audit_sample: 0.05 },
    counters: { agents: 7, intents: 8, overlaps_caught: 2, conflicts_open: 1, landed_today: 5, main_red_minutes: 0, human_seconds_today: 90 },
    series: {
      agents: [1, 3, 4, 6, 8, 8, 7, 7],
      intents: [2, 4, 7, 9, 11, 10, 9, 8],
      overlaps_caught: [0, 0, 1, 1, 1, 2, 2, 2],
      landed_today: [0, 0, 0, 1, 1, 5, 5, 5],
    },
    rates: { overlaps_per_min: 0.1, landed_per_min: 0.3 },
    tree,
    overlaps: [
      { a: "i-3b90", b: "i-7f3a", paths: ["src/index.ts"], state: "advisory" },
      { a: "i-1d4e", b: "i-31c2", paths: ["src/middleware/logging.ts"], state: "conflict", conflict: "c-9" },
    ],
  };
}

// Scale fixture: compact spec, expanded client-side with a seeded PRNG.
const monorepoCells: Array<[string, number, number]> = [
  ["apps/web/pages", 412, 940], ["apps/web/components", 388, 1180], ["apps/web/hooks", 96, 210], ["apps/web/styles", 64, 70],
  ["apps/api/routes", 301, 860], ["apps/api/middleware", 58, 240], ["apps/api/db", 144, 330], ["apps/api/auth", 41, 38],
  ["packages/ui", 260, 520], ["packages/sdk", 190, 410], ["packages/config", 22, 15], ["packages/i18n", 88, 64],
  ["services/billing", 133, 290], ["services/search", 121, 230], ["services/notify", 77, 120], ["services/media", 95, 150],
  ["infra/terraform", 66, 44], ["infra/migrations", 54, 31], ["docs/guides", 140, 96], ["docs/api", 80, 52],
  ["test/e2e", 220, 610], ["test/load", 34, 26], ["tools/cli", 70, 140], ["tools/codegen", 45, 88],
  ["apps/admin/pages", 160, 300], ["apps/admin/components", 150, 260], ["apps/mobile/screens", 210, 420], ["apps/mobile/native", 90, 72],
  ["services/queue", 52, 96], ["services/edge", 61, 140], ["packages/analytics", 48, 77], ["packages/flags", 18, 23],
];

function monorepoSpec() {
  return {
    v: 1,
    repo: "sim/monorepo",
    sim: true,
    head: { sha: "3c9e1a0", at: "2026-10-12T14:00:00Z" },
    policy: { protected: ["apps/api/auth/**", "infra/migrations/**"], auto_land_max_risk: 30, audit_sample: 0.05 },
    counters: { agents: 10000, intents: 6118, overlaps_caught: 1628, conflicts_open: 2, landed_today: 4318, main_red_minutes: 0, human_seconds_today: 270 },
    series: {
      agents: [1200, 2600, 4100, 6400, 8200, 9300, 9900, 10000],
      intents: [900, 1900, 3100, 4300, 5200, 5800, 6050, 6118],
      overlaps_caught: [80, 260, 520, 810, 1090, 1310, 1500, 1628],
      landed_today: [120, 600, 1300, 2100, 2900, 3500, 4000, 4318],
    },
    rates: { overlaps_per_min: 14, landed_per_min: 31 },
    cells: monorepoCells.map(([path, files, agents]) => ({ path, files, agents })),
    conflict_cells: ["apps/api/db", "apps/web/components"],
    overlap_cells: ["apps/web/pages", "apps/api/routes", "packages/ui", "test/e2e", "apps/mobile/screens", "services/billing"],
  };
}

function inbox() {
  return {
    v: 1,
    repo: BOOKSHELF,
    metrics: {
      human_seconds_today: 90, needs_you: 2,
      sample: { count: 1, of: 5, rate: 0.05 },
      auto_landed: 4,
      disagreement: { rate: 0.08, days: 7, n: 26 },
      policy: { auto_land_max_risk: 30, audit_sample: 0.05 },
    },
  };
}

function bench() {
  return {
    v: 1,
    run: "b-07",
    agents: 10000,
    measured_at: "2026-10-12T09:30:00Z",
    sha: "3c9e1a0",
    demo: true,
    modes: [
      { mode: "baseline", label: "Baseline PR + merge queue", projected: false, metrics: { changes_per_min: 3.1, median_declare_to_land_s: 11520, conflicts_hit: 1840, conflicts_avoided: 0, red_main_min: 47, human_min: 1210, usd_per_1k_agents: null } },
      { mode: "trains", label: "Forge, trains only", projected: false, metrics: { changes_per_min: 88, median_declare_to_land_s: 580, conflicts_hit: 1790, conflicts_avoided: 0, red_main_min: 0, human_min: 1210, usd_per_1k_agents: 0.41 } },
      { mode: "full", label: "Forge, full", projected: true, metrics: { changes_per_min: 131, median_declare_to_land_s: 245, conflicts_hit: 212, conflicts_avoided: 1628, red_main_min: 0, human_min: 96, usd_per_1k_agents: 0.44 } },
    ],
    declare_bench: { intents: 100000, p50_ms: 3.1, p99_ms: 11, shards: 4 },
    command: "npm run forge:bench -- --agents 10000 --mode all",
  };
}

function plannerProposals() {
  return [
    { title: "Answer GET /books with an ETag and 304 on match", footprint: ["src/routes/books.ts", "src/lib/http.ts"] },
    { title: "Send Cache-Control on catalog reads", footprint: ["src/lib/http.ts", "src/routes/authors.ts"] },
    { title: "Require an API key for POST /authors", footprint: ["src/auth/**", "src/routes/authors.ts"] },
    { title: "Tests for conditional GET", footprint: ["test/etag.test.ts"] },
    { title: "Document the caching headers", footprint: ["README.md"] },
  ];
}

export const FORGE_FIXTURES = {
  v: 1,
  note: "Demo fixtures. Not measurements.",
  repos: [BOOKSHELF, "sim/monorepo"],
  agents,
  goals,
  intents,
  trains,
  conflicts,
  snapshot: { [BOOKSHELF]: bookshelfSnapshot(), "sim/monorepo": monorepoSpec() },
  inbox: inbox(),
  bench: bench(),
  why: { repo: BOOKSHELF, path: "src/middleware/logging.ts", source: loggingSource, blame: loggingBlame },
  sessions,
  mailbox,
  planner: plannerProposals(),
};

// JSON for an inline <script type="application/json">. "<" is escaped so
// no fixture string can close the script element.
export function forgeFixturesJson(): string {
  return JSON.stringify(FORGE_FIXTURES).replace(/</g, "\\u003c");
}
