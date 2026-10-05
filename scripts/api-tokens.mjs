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
  },
  // Read-only debugging for agents and humans: inspect workers, query
  // D1/queues, read settings and audit log. No writes anywhere.
  debug: {
    description: "read-only debugging (agents and humans)",
    groups: ["Workers Scripts Read", "D1 Read", "Queues Read", "Account Settings Read", "Audit Logs Read"],
  },
  // Billable Usage API reads for `cli usage` dollars. Nothing else.
  billing: {
    description: "Billable Usage API reads only",
    groups: ["Billing Read"],
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

export function buildMintBody(name, accountId, groupIds) {
  return {
    name,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        permission_groups: groupIds,
      },
    ],
  };
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
    "See docs/TOKENS.md for the exact permission checklist.",
  ];
  if (links.length > 0) lines.push(`Cloudflare's missing-permission link: ${links[0]}`);
  return lines.join("\n");
}
