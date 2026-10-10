// Runtime wiring for Forge trains: the `TrainWorkflow` Cloudflare
// Workflow (durable steps: build -> CI wait -> land/bisect -> notes ->
// revoke tokens -> next round) and the cron fallback `runTrainTick`.
// All logic lives in train.ts / replay.ts (runtime-free, tested); this
// file only binds it to the Worker environment. It holds the
// `cloudflare:workers` import, so vitest never loads it (index.ts
// re-exports the class; the vitest config aliases the module).
//
// The Coordinator decides *when* a repo needs a train (enqueueReady /
// cutTrain launch an instance); the Workflow *executes* it. Every step is
// idempotent over D1 state, so a replayed step never double-applies.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { WorkerEnv } from "./env";
import { validateRepo } from "./intents";
import { MemoryFS } from "./memory-fs";
import { artifactsRemoteFor } from "./promote";
import { pollRaces, startReplay, type ReplayDeps } from "./replay";
import {
  activeTrains,
  advanceRepo,
  buildTrains,
  checkTrains,
  cutTrain,
  revokeLandedTokens,
  writeNotes,
  loadPolicy,
  type CheckResult,
  type TrainDispatchInput,
} from "./train";
import { MAX_CI_POLLS, maxTrainRounds, pollBackoffSeconds } from "./train-core";

export interface TrainWorkflowParams {
  repo: string;
}

export type TrainDispatcher = (env: WorkerEnv, input: TrainDispatchInput) => Promise<{ runId: string }>;

// Isolate wiring, not request state: index.ts registers its dispatchRun
// adapter once at module load (importing index.ts from here would cycle).
let dispatcher: TrainDispatcher | null = null;

export function registerTrainDispatch(fn: TrainDispatcher): void {
  dispatcher = fn;
}

function workflowOf(env: WorkerEnv): Workflow<TrainWorkflowParams> | null {
  return env.TRAIN_WORKFLOW ?? null;
}

// Workflow instance ids: [A-Za-z0-9_-], ≤ 100 chars; one per train cut.
export function trainInstanceId(repo: string, key: string): string {
  return `train-${repo}-${key}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
}

export function trainDepsFromEnv(env: WorkerEnv, opts: { launch?: boolean } = {}): ReplayDeps {
  const namespace = env.ARTIFACTS_NAMESPACE ?? "";
  const registered = dispatcher;
  const wf = opts.launch === false ? null : workflowOf(env);
  const deps: ReplayDeps = {
    db: env.DB,
    artifacts: env.ARTIFACTS ?? null,
    namespace,
    remoteFor: (repo) => artifactsRemoteFor(env.ARTIFACTS_ACCOUNT_ID ?? "", namespace, repo),
    git,
    http,
    fs: () => new MemoryFS(),
    dispatch: registered ? (input) => registered(env, input) : null,
    launch: wf
      ? async (repo, key) => {
          await wf.create({ id: trainInstanceId(repo, key), params: { repo } });
        }
      : null,
    ai: env.AI ?? null,
    gatewayId: env.AI_GATEWAY_ID,
  };
  deps.onConflict = async (conflict) => {
    await startReplay(deps, conflict.id);
  };
  return deps;
}

const STEP = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;

export class TrainWorkflow extends WorkflowEntrypoint<WorkerEnv, TrainWorkflowParams> {
  async run(event: WorkflowEvent<TrainWorkflowParams>, step: WorkflowStep): Promise<{ rounds: number }> {
    const repo = event.payload.repo;
    if (!validateRepo(repo)) return { rounds: 0 };
    // Rounds must not spawn sibling instances: this one drives the repo.
    const deps = trainDepsFromEnv(this.env, { launch: false });
    const policy = await step.do("policy", () => loadPolicy(deps, repo));
    const rounds = maxTrainRounds(policy);
    let round = 0;
    for (; round < rounds; round++) {
      await step.do(`build-${round}`, STEP, async () => {
        const out = await buildTrains(deps, repo);
        return { status: out.status };
      });
      let decided: CheckResult | null = null;
      for (let poll = 0; poll < MAX_CI_POLLS; poll++) {
        const r = await step.do(`check-${round}-${poll}`, STEP, () => checkTrains(deps, repo));
        if (r.status === "waiting" || r.status === "retry" || r.status === "building") {
          await step.sleep(`ci-wait-${round}-${poll}`, pollBackoffSeconds(poll) * 1000);
          continue;
        }
        decided = r;
        break;
      }
      await step.do(`notes-${round}`, STEP, () => writeNotes(deps, repo));
      await step.do(`revoke-${round}`, STEP, () => revokeLandedTokens(deps, repo));
      await step.do(`races-${round}`, STEP, () => pollRaces(deps, repo));
      if (!decided || decided.status === "idle") break;
      // Bisect children are already forming; requeued or rebuilt intents
      // need a fresh cut on the new main.
      const next = await step.do(`cut-${round + 1}`, STEP, async () => {
        if ((await activeTrains(deps.db, repo)).length) return { status: "busy" };
        const cut = await cutTrain(deps, repo);
        return { status: cut.status };
      });
      if (next.status !== "busy" && next.status !== "cut") break;
    }
    return { rounds: round };
  }
}

// Cron fallback (every minute). With a Workflow binding: cut trains for
// idle repos (the cut launches an instance) and advance only repos whose
// trains look abandoned. Without one: advance every repo a step.
export const TICK_STALE_MS = 10 * 60 * 1000;

export async function runTrainTick(env: WorkerEnv): Promise<{ repos: number; advanced: number; cut: number }> {
  const out = { repos: 0, advanced: 0, cut: 0 };
  const deps = trainDepsFromEnv(env);
  const rows = await env.DB.prepare(
    `SELECT repo FROM intents WHERE state = 'ready'
     UNION SELECT repo FROM trains WHERE state IN ('forming', 'merging', 'verifying')
     UNION SELECT repo FROM conflicts WHERE state = 'claimed'
     LIMIT 20`,
  )
    .bind()
    .all<{ repo: string }>();
  const hasWorkflow = workflowOf(env) !== null;
  for (const { repo } of rows.results) {
    if (!validateRepo(repo)) continue;
    out.repos += 1;
    try {
      const active = await activeTrains(env.DB, repo);
      if (hasWorkflow && !active.length) {
        if ((await cutTrain(deps, repo)).status === "cut") out.cut += 1;
      } else if (!hasWorkflow || active.every((t) => Date.now() - Date.parse(t.updatedAt) > TICK_STALE_MS)) {
        const res = await advanceRepo(deps, repo);
        if (res.cut?.status === "cut") out.cut += 1;
        out.advanced += 1;
      }
      await pollRaces(deps, repo);
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "train tick failed", repo, error: String(err instanceof Error ? err.message : err).slice(0, 200) }));
    }
  }
  return out;
}
