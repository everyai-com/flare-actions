#!/usr/bin/env node
// Step-8 tournament harness: full machine E2E on staging.
// Opens a task, forks per agent, drives 3 concurrent pushes (2 green with a
// forced file collision, 1 red), ticks to decided, asserts the ledger.
// Green bar: exit 0 three runs in a row. Works on 7a (pointer) or 7b (FF push).
//
// Env: HARNESS_URL, HARNESS_ADMIN_TOKEN, HARNESS_NAMESPACE (default
// flare-tournaments), KEEP=1 to skip repo cleanup.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = (process.env.HARNESS_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.HARNESS_ADMIN_TOKEN ?? "";
const NS = process.env.HARNESS_NAMESPACE ?? "flare-tournaments";
const KEEP = process.env.KEEP === "1";
if (!URL || !TOKEN) {
  console.error("need HARNESS_URL + HARNESS_ADMIN_TOKEN");
  process.exit(2);
}

const failures = [];
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${String(stderr || err.message).slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

// The artifacts CLI is open beta and flakes (observed: transient
// issue-token + create failures); retry with backoff, fail loudly.
async function wrangler(args, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await sh("npx", ["wrangler", ...args]);
    } catch (err) {
      last = err;
      console.log(`wrangler retry ${i + 1}/${tries}: ${String(err.message).slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw last;
}

// wrangler prints banners to stdout around JSON; carve the object out.
function parseWranglerJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON in wrangler output: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function api(path, opts = {}) {
  const res = await fetch(`${URL}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const gitEnv = (token) => ({
  ...process.env,
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: Bearer ${token}`,
  GIT_CONFIG_KEY_1: "user.name",
  GIT_CONFIG_VALUE_1: "harness",
  GIT_CONFIG_KEY_2: "user.email",
  GIT_CONFIG_VALUE_2: "harness@flare.local",
});

const reposToDelete = [];
async function deleteRepo(name) {
  try {
    await sh("npx", ["wrangler", "artifacts", "repos", "delete", name, "--namespace", NS, "--force"]);
    console.log(`cleanup: deleted ${name}`);
  } catch (err) {
    console.log(`cleanup: ${name}: ${String(err.message).slice(0, 120)}`);
  }
}

const stamp = Date.now().toString(36);
const sourceRepo = `harness-${stamp}`;
const workdir = mkdtempSync(join(tmpdir(), "flare-harness-"));

async function main() {
  // 1. Source repo + base commit (green base: greeting.txt satisfies flare.yml).
  const created = parseWranglerJson(
    await wrangler(["artifacts", "repos", "create", sourceRepo, "--namespace", NS, "--json"]),
  );
  reposToDelete.push(sourceRepo);
  const srcDir = join(workdir, "src");
  await sh("git", ["init", "-b", "main", srcDir]);
  writeFileSync(
    join(srcDir, "flare.yml"),
    "jobs:\n  verify:\n    steps:\n      - run: test -f greeting.txt && grep -q hello greeting.txt && echo verified\n",
  );
  writeFileSync(join(srcDir, "greeting.txt"), "hello base\n");
  writeFileSync(join(srcDir, "README.md"), "# harness base\n");
  await sh("git", ["-C", srcDir, "add", "."]);
  await sh("git", ["-C", srcDir, "commit", "-m", "base"], { env: gitEnv("x") });
  await sh("git", ["-C", srcDir, "remote", "add", "origin", created.remote]);
  await sh("git", ["-C", srcDir, "push", "origin", "main"], { env: gitEnv(created.token) });
  const baseSha = (await sh("git", ["-C", srcDir, "rev-parse", "HEAD"])).trim();
  console.log(`source ${sourceRepo} @ ${baseSha.slice(0, 12)}`);

  // 2. Tournament + 3 concurrent claims.
  const t = await api("/v1/tournaments", {
    method: "POST",
    body: JSON.stringify({ intent: `harness race ${stamp}`, sourceRepo, baseRef: "main", baseSha }),
  });
  console.log(`tournament ${t.id}`);
  const agents = ["alpha", "beta", "gamma"];
  const claims = await Promise.all(
    agents.map((agent) =>
      api(`/v1/tournaments/${t.id}/claims`, { method: "POST", body: JSON.stringify({ agent }) }).then((c) => ({ agent, ...c })),
    ),
  );
  for (const c of claims) {
    reposToDelete.push(c.forkRepo);
    console.log(`claim ${c.agent} -> ${c.forkRepo}`);
  }

  // 3. Concurrent pushes: alpha/beta green on the SAME file (collision),
  // gamma deletes the file (red).
  const pushOne = async (claim, mutate) => {
    const tokOut = await wrangler(["artifacts", "repos", "issue-token", claim.forkRepo, "--namespace", NS, "--scope", "write", "--ttl", "3600"]);
    const token = tokOut.match(/art_v2_\S+/)?.[0];
    if (!token) throw new Error(`no token issued for ${claim.forkRepo}`);
    const dir = join(workdir, claim.agent);
    await sh("git", ["clone", "--depth", "1", claim.remote, dir], { env: gitEnv(token) });
    await mutate(dir);
    await sh("git", ["-C", dir, "add", "-A"]);
    await sh("git", ["-C", dir, "commit", "-m", `${claim.agent} attempt`], { env: gitEnv(token) });
    await sh("git", ["-C", dir, "push", "origin", "main"], { env: gitEnv(token) });
    return (await sh("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
  };
  const [alphaSha, betaSha, gammaSha] = await Promise.all([
    pushOne(claims[0], (d) => writeFileSync(join(d, "greeting.txt"), "hello from alpha\n")),
    pushOne(claims[1], (d) => writeFileSync(join(d, "greeting.txt"), "hello from beta\n")),
    pushOne(claims[2], (d) => rmSync(join(d, "greeting.txt"))),
  ]);
  console.log(`pushed alpha ${alphaSha.slice(0, 12)} beta ${betaSha.slice(0, 12)} gamma ${gammaSha.slice(0, 12)}`);

  // 4. Tick until decided (12 min cap).
  const deadline = Date.now() + 12 * 60 * 1000;
  let board = null;
  for (;;) {
    const tick = await api("/v1/admin/tournaments/tick", { method: "POST" });
    board = await api(`/v1/tournaments/${t.id}`);
    const states = board.attempts.map((a) => `${a.agent}:${a.state}${a.run_id ? "(run)" : ""}`).join(" ");
    console.log(`tick d=${tick.polled.dispatched} t=${tick.polled.terminal} v=${tick.verdicts.decided} r=${tick.resolved.resolved} p=${tick.pushed.pushed} | ${board.tournament.state} ${states}`);
    if (board.tournament.state === "decided") break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 10000));
  }

  // 5. Assertions.
  check("tournament decided", board.tournament.state === "decided", board.tournament.state);
  check("3 attempts", board.attempts.length === 3, String(board.attempts.length));
  const byAgent = Object.fromEntries(board.attempts.map((a) => [a.agent, a]));
  const runStatus = {};
  for (const a of board.attempts) {
    if (!a.run_id) continue;
    runStatus[a.agent] = (await api(`/v1/runs/${a.run_id}`)).run.status;
  }
  check("alpha green", runStatus.alpha === "success", runStatus.alpha ?? "no-run");
  check("beta green", runStatus.beta === "success", runStatus.beta ?? "no-run");
  check("gamma red", runStatus.gamma === "failure" || runStatus.gamma === "error", runStatus.gamma ?? "no-run");
  const kinds = board.ledger.map((l) => l.kind);
  check("ledger opened", kinds.includes("opened"));
  check("ledger 3 claims", board.ledger.filter((l) => l.kind === "claimed").length === 3);
  check(
    "collision on greeting.txt",
    board.ledger.some((l) => l.kind === "collision" && l.body.includes("greeting.txt")),
    board.ledger.filter((l) => l.kind === "collision").map((l) => l.body).join(" | ").slice(0, 200) || "none",
  );
  check("ledger verdict", kinds.includes("verdict"));
  check("ledger resolved", kinds.includes("resolved"));
  const winner = board.attempts.find((a) => a.verdict_rank === 1);
  check("winner is alpha", winner?.agent === "alpha", winner?.agent ?? "none");
  check("resolved_sha is alpha head", board.tournament.resolved_sha === alphaSha, (board.tournament.resolved_sha ?? "").slice(0, 12));
  const promoted = board.ledger.some((l) => l.kind === "promoted");
  console.log(`INFO promote path: ${promoted ? "7b fast-forward" : "7a pointer"}`);
  if (promoted) {
    const heads = await sh("git", ["ls-remote", created.remote, "refs/heads/main"], { env: gitEnv(created.token) });
    check("source main == alpha head", heads.startsWith(alphaSha), heads.slice(0, 12));
  }

  console.log("--- ledger ---");
  for (const l of board.ledger) console.log(`[${l.kind}] ${l.body.slice(0, 160)}`);
  console.log(`--- ${failures.length ? `HARNESS RED (${failures.join(", ")})` : "HARNESS GREEN"} ---`);
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`HARNESS ERROR ${String(err?.message ?? err).slice(0, 500)}`);
} finally {
  if (!KEEP) for (const r of reposToDelete) await deleteRepo(r);
  else console.log(`KEEP=1: repos left: ${reposToDelete.join(", ")}`);
  rmSync(workdir, { recursive: true, force: true });
}
process.exit(code);
