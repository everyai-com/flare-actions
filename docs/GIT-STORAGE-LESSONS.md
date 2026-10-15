# Git on object storage: what Enroute taught us, and what Forge does about it

> Provenance: agent-drafted 2026-10-15 from a read of Enroute's
> "Everyone is doing Git on S3 wrong" (2026-10-13). Every number in
> the "What they claim" section is Enroute's own measurement and is
> quoted as theirs. Nothing here has been re-measured by us.
> Forge-side facts come from `docs/COMPETITION-PLAN.md` §4 and
> `docs/FORGE.md` (spikes S1/S5), not from new runs.

## Why this matters

Enroute is the clearest public statement of the storage-layer thesis
for agent git: "thousands of agents in one repository" needs a git
server that absorbs thousands of pushes per second. Judges and
competitors will have read it. Forge is built on the opposite bet,
so the position has to be explicit, and the one idea worth borrowing
has to be on the roadmap.

## What they claim (their numbers)

| Claim | Source |
|---|---|
| Git on object storage fails as plain content-addressed storage: each object read is a 30-40 ms round trip and Git walks pointers | Enroute post |
| WAL-on-S3 (Cursor Continuity, walgit) scales reads but keeps one writer per repo; Cursor reports 120 pushes/s on S3 Standard, ~300 on Express One Zone | Cursor "Git at any scale", quoted by Enroute |
| Enroute: Raft "ledger" per repo (refs + layer list, 1-2 ms commits), stateless compute, packs rewritten into per-commit *segments* so fetches never walk the tree | Enroute post |
| Peak 7,600 pushes/s into one repo (forgemark, their run); "~18× Entire, ~1,000× GitHub" | Enroute's own forgemark runs |
| Clone/fetch vs stock git on linux.git: shallow 2× faster, full 17% slower, incremental fetch 13% slower, cold cache ≈ warm | Enroute post |
| Admitted gaps: client-side delta decode cost, no GC, HTTP only, no node routing, cold-start gap | Enroute post |

## What it means for Forge

Enroute makes the pipe wider. Forge decides what goes through it.

- **Forge never contends on one repo.** Every intent owns an
  Artifacts fork, so agent pushes hit per-fork limits, not a shared
  WAL. Trunk moves only through trains: about 100 CAS pushes for
  10k agents instead of 10k serial merges (plan §4 scale math).
- **Trunk is Forge's single writer too.** Trains serialize on trunk
  with compare-and-swap, exactly the WAL-leader shape. That is bounded
  by train count, not agent count, and is by design.
- **Forge is host-agnostic.** Artifacts is the substrate today; an
  Enroute-backed trunk would be a faster substrate under the same
  intent protocol. Storage throughput and intent coordination are
  separable claims and must stay separate in the pitch (plan §4,
  "two scale claims, kept honest").
- **The real question is not push rate.** 7,600 agents pushing
  7,600 conflicting edits to one file is still 7,600 conflicts.
  Footprints, overlap math, replay and CI-verified trains are the
  part Enroute does not have and does not claim.

## What to borrow

1. **Push every commit.** Enroute's best product argument: when a
   push is cheap, agents push every step, nothing is lost, every
   intermediate state is visible. Forge already has cheap per-fork
   pushes; what is missing is the *surface*: `report_push` on every
   commit, live progress in the Feed, and why-notes that cover
   intermediate states, not only landed ones.
2. **Optimistic work, ordered commit.** Enroute does all pack work
   lock-free and orders only the ref CAS. Trains should keep the same
   shape: merge + verify in parallel lanes, serialize only the trunk
   write. Check that `lanes.maxParallel` is actually exercised in the
   demo and bench, not only in config.
3. **Provenance as a log.** Enroute's ledger is a replayable log of
   every push and repack. Forge's `forge_ledger` + why-notes are the
   analogue; make replay from the ledger a tested property, not an
   implied one.
4. **Honest benchmark framing.** Enroute separates "our runs" from
   "their reported number" in every chart. Keep doing the same with
   the 10k-agent bench and never mix projected and measured.

## What to improve (ranked)

| # | Improvement | Why | Size |
|---|---|---|---|
| 1 | Push-every-commit surface: per-commit `report_push`, Feed shows intent progress, why-notes on intermediate shas | Enroute's strongest "agents at scale" story, and Forge can tell it today on Artifacts | M |
| 2 | Measured train parallelism: bench lanes merging concurrently, trunk CAS the only serial point; publish the number | Mirrors their "only the ref update is ordered" claim with our own data | M |
| 3 | Storage-backend abstraction note in `docs/FORGE.md`: what Forge needs from a host (forks, CAS ref update, notes refs, push events) so an Enroute/other backend is a documented swap | Makes "host-agnostic" a checkable claim | S |
| 4 | Ledger replay test: rebuild intent + train state from `forge_ledger` rows and assert equality | Provenance that survives restarts is a judge-visible property | M |
| 5 | Fork GC: expired/abandoned intent forks pile up like Enroute's unreachable layers; add a bounded sweep | Cost + hygiene; Enroute lists GC as their own gap | S |
| 6 | Pitch slide: "Others make the pipe wider. Forge decides what goes through it." with the two-claims table | Pre-empts the obvious judge question | S |

## Where we do not follow them

- Not building a git server. Artifacts is the substrate; the
  competition is about what sits on top.
- Not chasing single-repo push throughput numbers. Our scale claim
  is coordination (100k intents, DO-only) plus measured 1k-10k agent
  git traffic on forks.
- Not rewriting packs or deltas. Segment-style storage is a host
  concern and Enroute's own data shows it costs clients on full
  clones and fetches.

## Source

- Enroute, "Everyone is doing Git on S3 wrong" (2026-10-13):
  https://enroute.sh/blog/everyone-is-doing-git-on-s3-wrong
- Cursor, "Git at any scale": https://cursor.com/blog/git-at-any-scale
- forgemark: https://github.com/entireio/forgemark
