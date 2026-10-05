# Model evals (refreshed Oct 5, 2026, second run)

`npm run eval:models` runs golden failure cases through candidate
Workers AI models over REST with the exact prompts the worker uses
(`buildTriageMessages` + a flaky-vs-real judge prompt, temperature 0).
Re-run after any prompt or candidate change; raw JSON lands in
`/tmp/model-eval-<ts>.json`.

## Triage (6 cases: missing dep, flaky timeout, TS error, OOM, docker auth, assert)

| Model | Keyword recall | Sections /3 | p50 | Notes |
|---|---|---|---|---|
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (default) | 0.83 | 3.0 | ~1.2s | Fast, format-reliable, stable across runs |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | 0.83 | 2.5 | ~8.6s | Was 1.00/3.0 in run 1 — server-side drift or case variance; still quality-first pick |
| `@cf/zai-org/glm-5.3-flash` | 0.50 | 1.5 | ~14s | Regressed from 0.83 — avoid |
| `@cf/qwen/qwen3.8-27b` | 0.78 | 2.3 | ~25s | Thinking model: burns budget on reasoning, needs 4x max_tokens; wrong shape for triage |

Run-to-run variance at temperature 0 (deepseek 1.00 → 0.83,
glm 0.83 → 0.50) is a finding by itself: server-side model drift
moves these numbers, so the default stays the stable fast model and
re-runs stay cheap.

## Judge: flaky-vs-real (4 cases, verdict accuracy)

| Model | Accuracy | p50 | Notes |
|---|---|---|---|
| `@cf/cloudflare/clef` | **1.00** | ~0.5s | Typed `noul` probability via `{model, state, questions}`; stable 1.00 across both runs |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 1.00 | ~0.5s | One-word chat verdict; fastest, stable |
| `@cf/cloudflare/clef-flash` | 0.75 | ~0.8s | Missed one case in both runs; full Clef preferred |

Clef answers carry the probability under the question-type key
(`answers.flaky = {type: "noul", noul: 0.01}`); the eval and the
worker gate both threshold at 0.5.

## Recommendation (unchanged default)

Keep `@cf/meta/llama-3.1-8b-instruct-fp8-fast` as the default: sub-second,
format-reliable, cheapest, and the only triage model stable across
both runs. Switch per deployment when the trade-off fits:

- Quality-first triage: `@cf/deepseek-ai/deepseek-v4-flash-0731`
  (~8s per failure — fine for background triage; re-run before
  trusting a single number).
- Flaky-vs-real routing: `@cf/cloudflare/clef`, wired as the
  HealingAgent judge gate (`judge.ts`, skips heals at p(flaky) ≥ 0.5,
  fails open). Typed probabilities beat chat verdicts for automation.
- Avoid `@cf/qwen/qwen3.8-27b` for short-form slots (thinking tax) and
  `@cf/zai-org/glm-5.3-flash` (regressed to 0.50 recall).

Switch via dashboard Settings → Scheduling and AI → triage model,
`POST /v1/admin/settings {"triageModel": "..."}`, or `TRIAGE_MODEL` env
(env wins, D1 fills the gap, blank restores the default).

## `cloudflare/auto`: considered, not adopted

Auto Router (beta, free) would pick a model per call for cost. Not
adopted: triage/heal/judge slots are scripted (fixed shape, fixed
budget, eval-pinned behavior), and a router adds latency variance
plus non-determinism exactly where the evals measure stability.
Revisit for open-ended slots (NL pipeline generation) if model
pricing spreads further.
