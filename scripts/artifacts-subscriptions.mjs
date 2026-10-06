// Artifacts push-event subscriptions via the Cloudflare REST API.
// Wrangler has no artifacts.repo source options, and only one
// subscription per repo is allowed (platform limit). Idempotent:
// repos already subscribed are reused. `fetchImpl` is injectable
// for tests; production passes global fetch.
export async function ensurePushSubscriptions(
  { apiToken, accountId, namespace, repos, queueName = "flare-actions-artifacts" },
  fetchImpl = fetch,
) {
  const api = async (method, path, body) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = (json.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new Error(`event-subscription API ${method} ${path} failed: ${msg}`);
    }
    return json.result;
  };
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
