#!/usr/bin/env node
// Model refresh evals for triage + flaky-vs-real judging.
// Runs golden failure cases through candidate Workers AI models over
// REST (same prompts the worker uses) and scores keyword recall,
// section adherence, verdict accuracy, and latency.
// Usage: npm run eval:models [-- --models a,b] [--cases triage|judge|all]
// Needs CLOUDFLARE_API_TOKEN (Workers AI perms) or `wrangler login`
// plus --account <id> / CLOUDFLARE_ACCOUNT_ID. Results print as a
// table and land in /tmp/model-eval-<ts>.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildTriageMessages, TRIAGE_MODEL } from "../apps/worker/src/triage.ts";

const TRIAGE_MODELS = [
  TRIAGE_MODEL,
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/qwen/qwen3.8-27b",
];
const JUDGE_MODELS = ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef", TRIAGE_MODEL];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}
const onlyCases = arg("--cases") ?? "all";
const modelOverride = arg("--models")?.split(",").map((m) => m.trim()).filter(Boolean) ?? null;
const accountId = arg("--account") ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;

let token = process.env.CLOUDFLARE_API_TOKEN ?? null;
if (!token) {
  const toml = join(homedir(), ".wrangler", "config", "default.toml");
  if (existsSync(toml)) {
    const m = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(toml, "utf8"));
    if (m) token = m[1];
  }
}
if (!token || !accountId) {
  console.error("need a token (CLOUDFLARE_API_TOKEN or wrangler login) and --account <id> (or CLOUDFLARE_ACCOUNT_ID)");
  process.exit(1);
}

// Golden triage cases: realistic failures + the evidence a good
// triage must cite (keywords) and generic filler it must avoid.
const TRIAGE_CASES = [
  {
    id: "missing-dep",
    input: {
      repo: "octo/app", sha: "abc123def456", jobName: "test",
      steps: [
        { command: "npm ci", exitCode: 0, output: "added 214 packages" },
        { command: "npm test", exitCode: 1, output: "Error: Cannot find module 'express'\nRequire stack:\n- /home/runner/work/app/src/server.js:4:15\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145)" },
      ],
      logTail: "npm test failed with exit code 1",
    },
    keywords: ["express", "server.js", "npm"],
  },
  {
    id: "flaky-timeout",
    input: {
      repo: "octo/app", sha: "abc123def456", jobName: "e2e",
      steps: [{ command: "npx playwright test", exitCode: 1, output: "1 flaky\n  [chromium] › checkout.spec.ts:41:5 › completes purchase ── timeout 30000ms exceeded\n  waiting for locator('[data-testid=confirm]')\n2 passed, 1 flaky (52.3s)" }],
      logTail: "flaky",
    },
    keywords: ["checkout.spec", "confirm", "timeout"],
  },
  {
    id: "ts-error",
    input: {
      repo: "octo/app", sha: "abc123def456", jobName: "typecheck",
      steps: [{ command: "npx tsc --noEmit", exitCode: 2, output: "src/billing.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error." }],
      logTail: "typecheck failed",
    },
    keywords: ["billing.ts", "TS2322", "string"],
  },
  {
    id: "oom",
    input: {
      repo: "octo/app", sha: "abc123def456", jobName: "build",
      steps: [{ command: "npm run build", exitCode: 137, output: "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nKilled" }],
      logTail: "container exit 137",
    },
    keywords: ["memory", "heap", "137"],
  },
  {
    id: "docker-auth",
    input: {
      repo: "octo/app", sha: "abc123def456", jobName: "image",
      steps: [{ command: "docker push registry/app:sha", exitCode: 1, output: "denied: requested access to the resource is denied\nunauthorized: authentication required" }],
      logTail: "push failed",
    },
    keywords: ["denied", "authentication", "push"],
  },
  {
    id: "test-assert",
    input: {
      repo: "octo/app", sha: "abc123def456", jobName: "unit",
      steps: [{ command: "npx vitest run", exitCode: 1, output: "FAIL src/pricing.test.ts > applies volume discount\nAssertionError: expected 42 to equal 38\n ❯ src/pricing.test.ts:17:28\n Test Files  1 failed | 12 passed" }],
      logTail: "1 failed",
    },
    keywords: ["pricing.test", "42", "38"],
  },
];

const BANNED_PHRASES = ["review the test", "check the code", "as an ai", "i'm sorry", "cannot determine"];

// Golden judge cases: flaky-vs-real verdicts for the Clef decision
// models (and the current model as a baseline).
const JUDGE_CASES = [
  { id: "net-flake", text: "FAIL e2e: checkout.spec timeout 30s waiting for [data-testid=confirm]; passed on rerun, no code change", verdict: "flaky" },
  { id: "port-flake", text: "FAIL integration: listen EADDRINUSE :::3000; service from a prior attempt still held the port", verdict: "flaky" },
  { id: "real-assert", text: "FAIL unit: pricing.test.ts:17 expected 42 to equal 38; fails on every run including main", verdict: "real" },
  { id: "real-type", text: "FAIL typecheck: billing.ts(42,7) TS2322 string not assignable to number; deterministic", verdict: "real" },
];

function judgeMessages(text) {
  return [
    { role: "system", content: "You classify CI failures. Reply with exactly one word: flaky (transient/environmental, passes on retry) or real (deterministic code or config defect). No other text." },
    { role: "user", content: text },
  ];
}

function extractText(result) {
  if (typeof result?.response === "string" && result.response) return result.response;
  const choice = result?.choices?.[0]?.message?.content;
  return typeof choice === "string" ? choice : "";
}

async function callChat(model, messages, maxTokens) {
  const started = Date.now();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0 }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => null);
  return { res, data, ms: Date.now() - started };
}

async function runModel(model, messages, maxTokens) {
  let call = await callChat(model, messages, maxTokens);
  let ms = call.ms;
  // Thinking models can burn a small budget on reasoning and return no
  // content: retry once at 4x so the eval scores the answer, not the
  // cutoff (the latency column still shows the real cost).
  const reasoning = call.data?.result?.choices?.[0]?.message?.reasoning;
  if (call.res.ok && call.data?.success && !extractText(call.data?.result) && typeof reasoning === "string" && reasoning) {
    call = await callChat(model, messages, Math.min(maxTokens * 4, 4096));
    ms += call.ms;
  }
  if (!call.res.ok || !call.data?.success) {
    const detail = call.data?.errors?.map((e) => e.message).join("; ") || `HTTP ${call.res.status}`;
    return { ok: false, ms, error: String(detail).slice(0, 200) };
  }
  return { ok: true, ms, text: extractText(call.data?.result), usage: call.data?.result?.usage ?? null };
}

function isClefModel(model) {
  return model.includes("/clef");
}

// Clef decision call: state + typed questions -> per-option
// probabilities (no chat text). Short name is the model path suffix.
async function runDecision(model, state, questions) {
  const started = Date.now();
  const short = model.slice(model.lastIndexOf("/") + 1);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: short, state, questions }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => null);
  const ms = Date.now() - started;
  if (!res.ok || !data?.success) {
    const detail = data?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    return { ok: false, ms, error: String(detail).slice(0, 200) };
  }
  return { ok: true, ms, answers: data?.result?.answers ?? null };
}

function readNoul(answers) {
  const v = answers?.flaky;
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    // Clef answers carry the probability under the question-type key
    // ({type: "noul", noul: 0.01}); take the first numeric member.
    for (const [k, n] of Object.entries(v)) {
      if (k !== "type" && typeof n === "number") return n;
    }
    if (typeof v.probability === "number") return v.probability;
  }
  return null;
}

function scoreTriage(text, keywords) {
  const lower = text.toLowerCase();
  const hits = keywords.filter((k) => lower.includes(k.toLowerCase()));
  const sections = ["cause:", "culprit:", "fix:"].filter((s) => lower.includes(s)).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const banned = BANNED_PHRASES.filter((p) => lower.includes(p));
  return {
    recall: keywords.length === 0 ? 1 : hits.length / keywords.length,
    sections,
    words,
    lengthOk: words <= 150,
    banned,
  };
}

function scoreJudge(text, verdict) {
  const first = text.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  return { verdict: first, correct: first === verdict };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { at: new Date().toISOString(), triage: {}, judge: {} };

if (onlyCases === "all" || onlyCases === "triage") {
  for (const model of modelOverride ?? TRIAGE_MODELS) {
    const perCase = [];
    for (const c of TRIAGE_CASES) {
      const messages = buildTriageMessages(c.input);
      let out = await runModel(model, messages, 512);
      if (!out.ok && /busy|429|503|timeout/i.test(out.error ?? "")) {
        await sleep(10000);
        out = await runModel(model, messages, 512);
      }
      perCase.push(
        out.ok
          ? { id: c.id, ms: out.ms, excerpt: out.text.slice(0, 200), ...scoreTriage(out.text, c.keywords) }
          : { id: c.id, ms: out.ms, error: out.error },
      );
      await sleep(1000);
    }
    const scored = perCase.filter((c) => !("error" in c));
    results.triage[model] = {
      cases: perCase,
      avgRecall: scored.length ? scored.reduce((s, c) => s + c.recall, 0) / scored.length : 0,
      avgSections: scored.length ? scored.reduce((s, c) => s + c.sections, 0) / scored.length : 0,
      lengthOkRate: scored.length ? scored.filter((c) => c.lengthOk).length / scored.length : 0,
      p50Ms: scored.length ? scored.map((c) => c.ms).sort((a, b) => a - b)[Math.floor(scored.length / 2)] : 0,
      errors: perCase.length - scored.length,
    };
    console.log(`triage ${model}: recall ${results.triage[model].avgRecall.toFixed(2)} sections ${results.triage[model].avgSections.toFixed(1)}/3 p50 ${results.triage[model].p50Ms}ms errors ${results.triage[model].errors}`);
  }
}

const FLAKY_QUESTION = {
  flaky: { type: "noul", instructions: "Is this CI failure flaky (transient or environmental, likely to pass on retry)?" },
};

if (onlyCases === "all" || onlyCases === "judge") {
  for (const model of modelOverride ?? JUDGE_MODELS) {
    const perCase = [];
    for (const c of JUDGE_CASES) {
      let entry;
      if (isClefModel(model)) {
        let out = await runDecision(model, c.text, FLAKY_QUESTION);
        if (!out.ok && /busy|429|503|timeout/i.test(out.error ?? "")) {
          await sleep(10000);
          out = await runDecision(model, c.text, FLAKY_QUESTION);
        }
        if (!out.ok) {
          entry = { id: c.id, ms: out.ms, error: out.error };
        } else {
          const p = readNoul(out.answers);
          const verdict = p === null ? "unknown" : p > 0.5 ? "flaky" : "real";
          entry = { id: c.id, ms: out.ms, verdict, pFlaky: p, correct: verdict === c.verdict };
        }
      } else {
        let out = await runModel(model, judgeMessages(c.text), 16);
        if (!out.ok && /busy|429|503|timeout/i.test(out.error ?? "")) {
          await sleep(10000);
          out = await runModel(model, judgeMessages(c.text), 16);
        }
        entry = out.ok
          ? { id: c.id, ms: out.ms, ...scoreJudge(out.text, c.verdict) }
          : { id: c.id, ms: out.ms, error: out.error };
      }
      perCase.push(entry);
      await sleep(1000);
    }
    const scored = perCase.filter((c) => !("error" in c));
    results.judge[model] = {
      cases: perCase,
      accuracy: scored.length ? scored.filter((c) => c.correct).length / scored.length : 0,
      p50Ms: scored.length ? scored.map((c) => c.ms).sort((a, b) => a - b)[Math.floor(scored.length / 2)] : 0,
      errors: perCase.length - scored.length,
    };
    console.log(`judge ${model}: accuracy ${results.judge[model].accuracy.toFixed(2)} p50 ${results.judge[model].p50Ms}ms errors ${results.judge[model].errors}`);
  }
}

const path = `/tmp/model-eval-${Date.now()}.json`;
writeFileSync(path, JSON.stringify(results, null, 2));
console.log(`wrote ${path}`);
