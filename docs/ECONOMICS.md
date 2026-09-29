# Flare Actions economics: why this is 10x cheaper

All figures from vendor docs, checked 2026-09-29. Re-verify before quoting
externally — links below.

## GitHub Actions (private repos, beyond included minutes)

Source: GitHub billing docs.

| Runner | $/min |
|---|---|
| Linux 1-core (slim) | $0.002 |
| Linux 2-core x64 | $0.006 |
| Linux 2-core arm64 | $0.005 |
| Windows 2-core | $0.010 |
| macOS (M1/Intel) | $0.062 |

Billed per minute including VM boot (~30–60s per job), queue overhead, and
setup. A 2-minute test suite typically bills ~3 minutes.

## Flare Actions cost stack

Orchestration (dispatch, API, dashboard, state) runs on Cloudflare free tiers:

| Piece | Free tier | Source |
|---|---|---|
| Workers requests | 100,000/day | Workers pricing |
| Queues ops | 10,000/day (~3,300 dispatches/day) | Queues pricing |
| D1 | 5M rows read + 100k rows written/day, 5 GB | D1 pricing |

Orchestration cost at small-to-medium scale: **$0**.

Execution has two modes:

### Mode 1 — Cloudflare Containers (managed, scale-to-zero)

Source: Containers pricing (Workers Paid, $5/mo base).

A 2-vCPU / 8 GiB / 16 GB job-minute costs ~$0.0037 in active compute
(CPU $0.000020/vCPU-s, mem $0.0000025/GiB-s, disk $0.00000007/GB-s),
vs GitHub's $0.006 for 2-core Linux — **~1.6x cheaper**, with millisecond
dispatch instead of minute-scale queues, and no billed boot time.

### Mode 2 — Bring-your-own warm box (the 10x story)

A $6/mo 4-vCPU VPS (Hetzner/DO-class) running the Flare runner executes
**unlimited** minutes, always warm, with hot caches:

| Workload | GitHub (Linux 2-core) | Flare + $6 box |
|---|---|---|
| 3,000 min/mo | ~$18 (or free quota) | ~$6 |
| 20,000 min/mo | ~$120 | ~$6 (**20x**) |
| 100,000 min/mo | ~$600 | ~$6–12 (**50–100x**) |

The meter disappears. Flare's cut of this stack is $0 of compute margin —
it just orchestrates.

## Honest gaps

- **macOS/iOS builds**: Cloudflare has no macOS compute. Apple-platform teams
  stay on GitHub/ARC or Mac Minis until we ship a mac-remote story. We say so
  up front instead of pretending.
- **Windows**: same story via BYO runners only.
- Numbers above exclude the user's VPS/egress at extreme scale; R2 cache
  has zero egress, which is where GitHub cache/artifact bills usually hide.

## Sources

- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Workers: https://developers.cloudflare.com/workers/platform/pricing/
- Queues: https://developers.cloudflare.com/queues/platform/pricing/
- D1: https://developers.cloudflare.com/d1/platform/pricing/
- Containers: https://developers.cloudflare.com/containers/platform/pricing/
