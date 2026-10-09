// Least-privilege Cloudflare API tokens for CI and debug agents.
// Group names below are resolved against the live permission-groups
// list at mint time (names drift; the resolver refuses to mint on any
// miss, printing close matches instead of a half-permissioned token).
export const TOKEN_PROFILES = {
  // GitHub Actions preview deploys (`wrangler preview`): versioned
  // worker + existing staging bindings. No secrets, no containers.
  ci: {
    description: "CI preview deploys (wrangler preview only)",
    groups: ["Workers Scripts Edit", "D1 Edit", "Queues Edit"],
    // Per-Worker scoping (--worker): the account-wide scripts group is
    // replaced by the Individual Workers edit group on nested script
    // resources, so a leaked CI token cannot touch other Workers.
    workerScoped: { replaces: "Workers Scripts Edit", access: "edit" },
  },
  // Read-only debugging for agents and humans: inspect workers, query
  // D1/queues, read settings and audit log. No writes anywhere.
  debug: {
    description: "read-only debugging (agents and humans)",
    groups: ["Workers Scripts Read", "D1 Read", "Queues Read", "Account Settings Read", "Audit Logs Read"],
    // Per-Worker scoping (--worker): metadata (settings, metrics,
    // logs, traces) on the named Workers instead of account-wide
    // code reads. D1/queues reads stay account-wide by design.
    workerScoped: { replaces: "Workers Scripts Read", access: "metadata" },
  },
  // Billable Usage API reads for `cli usage` dollars. Nothing else.
  billing: {
    description: "Billable Usage API reads only",
    groups: ["Billing Read"],
  },
  // Full `npm run setup` without full-access OAuth: D1 + queues + R2 +
  // deploys + secrets + Basin + seats images + Artifacts namespace and
  // push subscriptions (B1/B3 REST calls reuse this same token).
  // Containers/Pipelines only matter when docker is present / Basin is
  // wanted; the resolver fails closed on any renamed group.
  setup: {
    description: "run npm run setup (provision + deploy)",
    groups: [
      "Workers Scripts Edit",
      "D1 Edit",
      "Queues Edit",
      "Workers R2 Storage Edit",
      "Workers Pipelines Edit",
      "Containers Edit",
    ],
  },
};

export function profileNames() {
  return Object.keys(TOKEN_PROFILES);
}

// Resolve curated names to group ids against the live list. Fails
// closed: any miss aborts the mint with near-matches for a human.
export function resolvePermissionIds(groups, names) {
  const byName = new Map((groups ?? []).map((g) => [String(g?.name ?? ""), String(g?.id ?? "")]));
  const ids = [];
  const missing = [];
  for (const want of names) {
    const id = byName.get(want);
    if (id) ids.push({ id });
    else missing.push(want);
  }
  if (missing.length === 0) return { ids };
  const candidates = [];
  for (const want of missing) {
    const words = want.toLowerCase().split(/\s+/);
    for (const [name] of byName) {
      const lower = name.toLowerCase();
      if (words.some((w) => w.length >= 2 && lower.includes(w)) && !candidates.includes(name)) candidates.push(name);
    }
  }
  return { missing, candidates: candidates.slice(0, 12) };
}

// Worker script tags for per-Worker scoping (dashboard "Specified
// Workers" shape, nested under the account resource).
export const WORKER_SCRIPT_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function buildMintBody(name, accountId, groupIds, opts = {}) {
  const accountKey = `com.cloudflare.api.account.${accountId}`;
  const policies = [
    {
      effect: "allow",
      resources: { [accountKey]: "*" },
      permission_groups: groupIds,
    },
  ];
  const scripts = opts.workerScripts ?? [];
  if (scripts.length > 0) {
    for (const tag of scripts) {
      if (!WORKER_SCRIPT_TAG_RE.test(tag)) throw new Error(`invalid worker script tag: ${JSON.stringify(tag)}`);
    }
    if (!opts.workerGroupIds || opts.workerGroupIds.length === 0) {
      throw new Error("worker scoping needs workerGroupIds (resolve the Individual Workers groups first)");
    }
    const nested = {};
    for (const tag of scripts) nested[`com.cloudflare.edge.worker.script.${tag}`] = "*";
    policies.push({
      effect: "allow",
      resources: { [accountKey]: nested },
      permission_groups: opts.workerGroupIds,
    });
  }
  return { name, policies };
}

// Resolve the Individual Workers group for per-Worker scoping against
// the live list (no hardcoded ids): edit for deploys, metadata for
// code-blind debugging. Fails closed on missing/ambiguous matches.
export function resolveWorkerGroupIds(groups, access) {
  const names = (groups ?? []).map((g) => ({ name: String(g?.name ?? ""), id: String(g?.id ?? "") }));
  const want = access === "edit" ? /edit|write/i : /metadata/i;
  const hits = names.filter((g) => /individual/i.test(g.name) && /worker/i.test(g.name) && /script/i.test(g.name) && want.test(g.name) && g.id);
  if (hits.length === 1) return { ids: [{ id: hits[0].id }], group: hits[0].name };
  const individual = names.filter((g) => /individual/i.test(g.name) && /worker/i.test(g.name)).map((g) => g.name);
  return { missing: [`Individual Workers Scripts (${access})`], candidates: individual.slice(0, 12) };
}

export async function mintToken(apiBase, parentToken, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${apiBase}/user/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${parentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || typeof data?.result?.value !== "string") {
    const detail = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`token mint failed: ${detail}`);
  }
  return { value: data.result.value, id: data.result.id ?? null };
}

export async function listPermissionGroups(apiBase, parentToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${apiBase}/user/tokens/permission_groups`, {
    headers: { Authorization: `Bearer ${parentToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !Array.isArray(data?.result)) {
    const detail = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`permission group list failed: ${detail}`);
  }
  return data.result;
}

// Enriched 403s link the missing permission — surface that link plus
// the least-privilege fix instead of a bare stack. Null when the
// output shows no auth/permission failure.
export function permissionHint(output) {
  const text = String(output ?? "");
  if (!/403|forbidden|not authorized|unauthorized|insufficient.{0,20}permiss|missing.{0,20}permiss|authentication failed|invalid.{0,10}token/i.test(text)) {
    return null;
  }
  const links = [...text.matchAll(/https:\/\/[^\s)"]*cloudflare\.com[^\s)"]*/gi)].map((m) => m[0]);
  const lines = [
    "This looks like a Cloudflare API permission failure (403/auth).",
    "Mint a least-privilege token instead of widening to an account key:",
    "  npm run token:mint -- --profile ci      # CI preview deploys",
    "  npm run token:mint -- --profile debug   # read-only agent debugging",
    "  npm run token:mint -- --profile billing # Billable Usage API (cli usage $)",
    "  npm run token:mint -- --profile setup   # full npm run setup",
    "See docs/TOKENS.md for the exact permission checklist.",
  ];
  if (links.length > 0) lines.push(`Cloudflare's missing-permission link: ${links[0]}`);
  return lines.join("\n");
}
