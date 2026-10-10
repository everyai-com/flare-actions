// Artifacts push trigger: `cf.artifacts.repo.pushed` queue messages (and,
// from step 5, the tournament fork poller) share this core: validate the
// envelope → claim delivery → read flare.yml via the ARTIFACTS binding →
// dispatch with event "artifacts".
//
// Push subscriptions are repo-scoped (one per repo; provisioned by setup
// via the REST API since wrangler has no artifacts.repo source options),
// so dynamic tournament forks are watched by poll (same core, synthesized
// event); the subscription path covers stable repos. Every path acks —
// malformed events, missing pipelines, and redeliveries skip cleanly,
// never poison.
//
// Dispatch is injected: dispatchRun lives in index.ts and importing it
// here would cycle (index.ts imports this module for the queue consumer).
// Runs store repo as "namespace/name" (fits the owner/name shape); seats
// render the Artifacts remote verbatim for event "artifacts".
import { type Db, claimWebhookDelivery } from "./db";

export const ARTIFACTS_EVENT = "artifacts";
export const ARTIFACTS_PUSH_TYPE = "cf.artifacts.repo.pushed";

// Pipeline files are small; anything larger is not ours to execute.
export const ARTIFACTS_PIPELINE_CAP = 262144;

export interface ArtifactsPush {
  namespace: string;
  repo: string;
  ref: string;
  before: string;
  after: string;
}

// Minimal structural surface of the ARTIFACTS binding (runtime-free:
// tests inject fakes; index.ts passes env.ARTIFACTS, which satisfies
// this shape structurally).
export interface ArtifactsFileBlob {
  readonly size: number;
  text(): Promise<string>;
}

export interface ArtifactsRepoHandle {
  readFile(args: { ref: string; path: string }): Promise<ArtifactsFileBlob | null>;
  readonly [Symbol.dispose]?: () => void;
}

export interface ArtifactsNamespace {
  get(name: string): Promise<ArtifactsRepoHandle>;
}

export interface ArtifactsDispatchInput {
  repo: string;
  sha: string;
  ref: string;
  pipeline: string;
  event: string;
}

export interface ArtifactsPushDeps {
  db: Db;
  artifacts?: ArtifactsNamespace | null;
  dispatch: (input: ArtifactsDispatchInput) => Promise<{ runId: string }>;
}

export type ArtifactsPushOutcome =
  | { status: "dispatched"; runId: string }
  | { status: "skipped"; reason: "invalid" | "duplicate" | "no-binding" | "no-pipeline" | "dispatch-failed" };

const NAME_RE = /^[\w.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]+$/i;
const ZERO_SHA_RE = /^0+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Strict envelope validation. Only branch pushes dispatch: tags and
// deleted refs (all-zero `after`) skip. Returns null for anything else,
// including account-level lifecycle events sharing the queue.
export function parseArtifactsPush(msg: unknown): ArtifactsPush | null {
  if (!isRecord(msg)) return null;
  if (msg["type"] !== ARTIFACTS_PUSH_TYPE) return null;
  const source = msg["source"];
  const payload = msg["payload"];
  if (!isRecord(source) || !isRecord(payload)) return null;
  if (source["type"] !== "artifacts.repo") return null;
  const namespace = source["namespace"];
  const repo = source["repoName"];
  const ref = payload["ref"];
  const before = payload["before"];
  const after = payload["after"];
  if (typeof namespace !== "string" || !NAME_RE.test(namespace)) return null;
  if (typeof repo !== "string" || !NAME_RE.test(repo)) return null;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref.length > 300) return null;
  if (typeof before !== "string" || !SHA_RE.test(before) || before.length > 64) return null;
  if (typeof after !== "string" || !SHA_RE.test(after) || after.length > 64 || ZERO_SHA_RE.test(after)) return null;
  return { namespace, repo, ref, before, after };
}

export function artifactsRunRepo(push: ArtifactsPush): string {
  return `${push.namespace}/${push.repo}`;
}

// One delivery id per (repo, commit), shared by the push trigger and
// the tournament poller: whichever path sees a head first claims it, so
// a fork that is both subscribed and polled dispatches exactly once.
export function artifactsDeliveryId(namespace: string, repo: string, sha: string): string {
  return `artifacts:${namespace}/${repo}:${sha.toLowerCase()}`;
}

function deliveryId(push: ArtifactsPush): string {
  return artifactsDeliveryId(push.namespace, push.repo, push.after);
}

// Read the pipeline at the pushed commit (the sha pins the exact tree).
// Null on any failure: missing repo, missing file, oversize, read error.
export async function loadArtifactsPipeline(
  artifacts: ArtifactsNamespace,
  repo: string,
  sha: string,
): Promise<string | null> {
  let handle: ArtifactsRepoHandle | null = null;
  try {
    handle = await artifacts.get(repo);
    const file = await handle.readFile({ ref: sha, path: "flare.yml" });
    if (!file || file.size > ARTIFACTS_PIPELINE_CAP) return null;
    const text = await file.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    try {
      handle?.[Symbol.dispose]?.();
    } catch {
      // Disposal must never fail the trigger.
    }
  }
}

export async function handleArtifactsPush(deps: ArtifactsPushDeps, msg: unknown): Promise<ArtifactsPushOutcome> {
  const push = parseArtifactsPush(msg);
  if (!push) return { status: "skipped", reason: "invalid" };
  // Binding check before the claim: an unconfigured worker must not burn
  // the delivery id — a later configured redelivery should dispatch.
  if (!deps.artifacts) return { status: "skipped", reason: "no-binding" };
  if (!(await claimWebhookDelivery(deps.db, deliveryId(push)))) return { status: "skipped", reason: "duplicate" };
  const pipeline = await loadArtifactsPipeline(deps.artifacts, push.repo, push.after);
  if (!pipeline) return { status: "skipped", reason: "no-pipeline" };
  try {
    const out = await deps.dispatch({
      repo: artifactsRunRepo(push),
      sha: push.after,
      ref: push.ref,
      pipeline,
      event: ARTIFACTS_EVENT,
    });
    return { status: "dispatched", runId: out.runId };
  } catch {
    return { status: "skipped", reason: "dispatch-failed" };
  }
}
