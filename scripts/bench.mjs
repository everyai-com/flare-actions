#!/usr/bin/env node
// Latency benchmark: dispatch → claim → terminal, against a running
// deployment (local `npm run dev` or a deployed worker).
//
// Usage:
//   FLARE_ACTIONS_URL=http://127.0.0.1:8787 RUNNER_TOKEN=... node scripts/bench.mjs [runs]
//
// The script plays the runner too: it claims each job through the same
// /v1/jobs/next path a BYO runner uses and reports success immediately,
// so the numbers cover queue + API + rollup latency, not step runtime.

const base = process.env.FLARE_ACTIONS_URL ?? process.env.FLARE_URL;
const token = process.env.RUNNER_TOKEN;
const runs = Number(process.argv[2] ?? 10);

if (!base || !token) {
  console.error("set FLARE_ACTIONS_URL and RUNNER_TOKEN (see `npm run setup`, or start `npm run dev`)");
  process.exit(2);
}

const BODY = { repo: "bench/local", sha: "a".repeat(40), pipeline: "jobs:\n  bench:\n    steps:\n      - run: 'true'\n" };

async function api(path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  // Warm the schema + isolate.
  await api("/v1/admin/status");
  const dispatchMs = [];
  const pickupMs = [];
  const terminalMs = [];
  let failed = 0;

  for (let i = 1; i <= runs; i++) {
    const t0 = performance.now();
    const { runId } = await api("/v1/runs/dispatch", { method: "POST", body: JSON.stringify(BODY) });
    const t1 = performance.now();

    let job = null;
    const claimDeadline = Date.now() + 60000;
    let t2 = t1;
    while (!job) {
      if (Date.now() > claimDeadline) throw new Error(`run ${runId}: no job claimed within 60s`);
      const out = await api(`/v1/jobs/next?labels=`);
      t2 = performance.now();
      if (out.job) {
        job = out.job;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    await api(`/v1/runs/${runId}/status`, {
      method: "POST",
      body: JSON.stringify({ jobId: job.id, status: "success", log: "bench" }),
    });
    let waited;
    do {
      waited = await api(`/v1/runs/${runId}/wait?timeout=30`);
    } while (waited.timedOut);
    const t3 = performance.now();
    if (waited.run.status !== "success") failed += 1;

    dispatchMs.push(t1 - t0);
    pickupMs.push(t2 - t1);
    terminalMs.push(t3 - t1);
    console.log(
      `run ${String(i).padStart(2)}: dispatch ${(t1 - t0).toFixed(0)}ms · pickup ${(t2 - t1).toFixed(0)}ms · terminal ${(t3 - t1).toFixed(0)}ms · total ${(t3 - t0).toFixed(0)}ms`,
    );
  }

  const summarize = (label, values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    console.log(
      `${label.padEnd(10)} avg ${avg.toFixed(0)}ms · p50 ${pct(sorted, 50).toFixed(0)}ms · p95 ${pct(sorted, 95).toFixed(0)}ms · min ${sorted[0].toFixed(0)}ms · max ${sorted[sorted.length - 1].toFixed(0)}ms`,
    );
  };
  console.log(`\n${runs} runs against ${base} (${failed} unexpected statuses)`);
  summarize("dispatch", dispatchMs);
  summarize("pickup", pickupMs);
  summarize("terminal", terminalMs);
}

await main();
