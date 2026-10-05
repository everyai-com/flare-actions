# Model evals (Oct 5, 2026)

`npm run eval:models` runs golden failure cases through candidate
Workers AI models over REST with the exact prompts the worker uses
(`buildTriageMessages` + a flaky-vs-real judge prompt, temperature 0).
Re-run after any prompt or candidate change; raw JSON lands in
`/tmp/model-eval-<ts>.json`.

## Triage (6 cases: missing dep, flaky timeout, TS error, OOM, docker auth, assert)

| Model | Keyword recall | Sections /3 | p50 | Notes |
|---|---|---|---|---|
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (default) | 0.83 | 3.0 | ~1.0s | Fast, format-reliable |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | **1.00** | 3.0 | ~6.2s | Best quality; 6x slower |
| `@cf/zai-org/glm-5.3-flash` | 0.83 | 2.3 | ~10.8s | No win over default |
| `@cf/qwen/qwen3.8-27b` | 0.78 | 2.3 | ~44s | Thinking model: burns budget on reasoning, needs 4x max_tokens; wrong shape for triage |

## Judge: flaky-vs-real (4 cases, verdict accuracy)

| Model | Accuracy | p50 | Notes |
|---|---|---|---|
| `@cf/cloudflare/clef` | **1.00** | ~0.7s | Typed `noul` probability via `{model, state, questions}` — best judge substrate |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 1.00 | ~0.4s | One-word chat verdict; fastest |
| `@cf/cloudflare/clef-flash` | 0.75 | ~1.0s | Missed one case; full Clef preferred |

Clef answers carry the probability under the question-type key
(`answers.flaky = {type: "noul", noul: 0.01}`); the eval thresholds at 0.5.

## Recommendation (unchanged default)

Keep `@cf/meta/llama-3.1-8b-instruct-fp8-fast` as the default: sub-second,
format-reliable, cheapest. Switch per deployment when the trade-off fits:

- Quality-first triage: `@cf/deepseek-ai/deepseek-v4-flash-0731`
  (perfect recall here, ~6s per failure — fine for background triage).
- Flaky-vs-real routing: `@cf/cloudflare/clef` (typed probabilities beat
  chat verdicts for automation; see the HealingAgent judge step).
- Avoid `@cf/qwen/qwen3.8-27b` for short-form slots (thinking tax) and
  `@cf/zai-org/glm-5.3-flash` (no measured win).

Switch via dashboard Settings → Scheduling and AI → triage model,
`POST /v1/admin/settings {"triageModel": "..."}`, or `TRIAGE_MODEL` env
(env wins, D1 fills the gap, blank restores the default).
