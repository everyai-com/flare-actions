// Artifacts REST admin: wrangler lacks namespace-create and
// artifacts.repo subscription options, so setup drives the API here.
// Idempotent throughout; `fetchImpl` is injectable for tests.
async function cfApi(fetchImpl, apiToken, accountId, method, path, body) {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = (json.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    const err = new Error(`artifacts API ${method} ${path} failed: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

// Ensure the namespace exists (409 = reuse). Returns { namespace, reused }.
export async function ensureNamespace({ apiToken, accountId, namespace }, fetchImpl = fetch) {
  try {
    await cfApi(fetchImpl, apiToken, accountId, "POST", "/artifacts/namespaces", { namespace });
    return { namespace, reused: false };
  } catch (err) {
    if (err.status === 409) return { namespace, reused: true };
    throw err;
  }
}

// Push-event subscriptions (only one per repo is allowed). Returns
// [{ repo, reused }].
export async function ensurePushSubscriptions(
  { apiToken, accountId, namespace, repos, queueName = "flare-actions-artifacts" },
  fetchImpl = fetch,
) {
  const api = (method, path, body) => cfApi(fetchImpl, apiToken, accountId, method, path, body);
  const queues = await api("GET", "/queues?per_page=100");
  const target = (queues ?? []).find((q) => q.queue_name === queueName);
  if (!target) throw new Error(`queue ${queueName} not found`);
  const existing = await api("GET", "/event_subscriptions/subscriptions?per_page=100");
  const owned = new Set(
    (existing ?? [])
      .filter((s) => s.source?.type === "artifacts.repo" && s.source?.namespace === namespace)
      .map((s) => s.source.repo_name),
  );
  const done = [];
  for (const repo of repos) {
    if (owned.has(repo)) {
      done.push({ repo, reused: true });
      continue;
    }
    await api("POST", "/event_subscriptions/subscriptions", {
      name: `flare-${repo}`.slice(0, 64),
      destination: { type: "queues.queue", queue_id: target.queue_id },
      source: { type: "artifacts.repo", namespace, repo_name: repo },
      events: ["pushed"],
      enabled: true,
    });
    done.push({ repo, reused: false });
  }
  return done;
}
