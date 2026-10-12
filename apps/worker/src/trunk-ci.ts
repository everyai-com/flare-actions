// What verifies a Forge trunk (or any Artifacts repo) at a commit:
// `flare.yml` when present, else the repo's existing GitHub Actions
// workflows read straight out of Artifacts and translated by the same
// Actions-compat module the GitHub webhook path uses. This is what lets
// a repo imported from GitHub ride trains on day one: its own CI is the
// landing gate, with no `flare.yml` to write first.
//
// Runtime-free: the Artifacts handle is a structural interface so tests
// drive every path with fakes. Bounded like the GitHub path: at most
// MAX_WORKFLOW_FILES files of MAX_WORKFLOW_BYTES each.
import type { ArtifactsFileBlob } from "./artifacts-push";
import {
  buildCompatJobs,
  GHA_WORKFLOWS_DIR,
  MAX_WORKFLOW_BYTES,
  MAX_WORKFLOW_FILES,
  type WorkflowEventContext,
  type WorkflowFile,
} from "./actionsCompat";
import type { PipelineJob } from "./pipeline";

export const TRUNK_PIPELINE_PATH = "flare.yml";
// Same cap the Artifacts push trigger applies to flare.yml.
const PIPELINE_CAP = 64 * 1024;

export interface TrunkCiTreeEntry {
  name: string;
  mode: string;
  hash: string;
}

// Git tree mode for a directory (Artifacts reports it as "40000").
function isTreeEntry(e: TrunkCiTreeEntry): boolean {
  return e.mode === "40000" || e.mode === "040000";
}

export interface TrunkCiHandle {
  readFile(args: { ref: string; path: string }): Promise<ArtifactsFileBlob | null>;
  readCommit?(hash: string): Promise<{ treeHash: string } | null>;
  readTree?(hash: string): Promise<TrunkCiTreeEntry[] | null>;
  readonly [Symbol.dispose]?: () => void;
}

export interface TrunkCiArtifacts {
  get(name: string): Promise<TrunkCiHandle>;
}

export type TrunkCi =
  | { kind: "flare"; pipeline: string }
  | { kind: "actions"; jobs: PipelineJob[]; warnings: string[]; used: string[] };

function dispose(h: { [Symbol.dispose]?: () => void } | null): void {
  try {
    h?.[Symbol.dispose]?.();
  } catch {
    // Disposal never fails a read.
  }
}

async function readText(handle: TrunkCiHandle, sha: string, path: string, cap: number): Promise<string | null> {
  try {
    const file = await handle.readFile({ ref: sha, path });
    if (!file || file.size > cap) return null;
    const text = await file.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

// Walk commit -> tree -> `.github` -> `workflows` and list the YAML
// files (sorted, bounded). Handles without tree reads list nothing.
export async function listTrunkWorkflowNames(handle: TrunkCiHandle, sha: string): Promise<string[]> {
  if (!handle.readCommit || !handle.readTree) return [];
  try {
    const commit = await handle.readCommit(sha);
    if (!commit) return [];
    let tree = commit.treeHash;
    for (const segment of GHA_WORKFLOWS_DIR.split("/")) {
      const entries = await handle.readTree(tree);
      const next = entries?.find((e) => e.name === segment && isTreeEntry(e));
      if (!next) return [];
      tree = next.hash;
    }
    const files = (await handle.readTree(tree)) ?? [];
    return files
      .filter((e) => !isTreeEntry(e) && /\.ya?ml$/i.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_WORKFLOW_FILES);
  } catch {
    return [];
  }
}

export async function readTrunkWorkflows(handle: TrunkCiHandle, sha: string): Promise<WorkflowFile[]> {
  const out: WorkflowFile[] = [];
  for (const name of await listTrunkWorkflowNames(handle, sha)) {
    const text = await readText(handle, sha, `${GHA_WORKFLOWS_DIR}/${name}`, MAX_WORKFLOW_BYTES);
    if (text) out.push({ name, text });
  }
  return out;
}

// A train verifies the combined commit trunk would move to, which is
// exactly what a push to the default branch (and a PR into it) checks
// on GitHub: workflows matching either event contribute jobs.
export function trunkEventContexts(branch: string): WorkflowEventContext[] {
  return [
    { event: "push", branch },
    { event: "pull_request", baseBranch: branch },
  ];
}

export function compatForTrunk(files: WorkflowFile[], branch: string): TrunkCi | null {
  if (!files.length) return null;
  const warnings: string[] = [];
  for (const ctx of trunkEventContexts(branch)) {
    const run = buildCompatJobs(files, ctx);
    warnings.push(...run.warnings);
    if (run.jobs && run.jobs.length) return { kind: "actions", jobs: run.jobs, warnings: warnings.slice(0, 50), used: run.used };
  }
  return null;
}

// flare.yml wins; else translated Actions workflows; null = nothing to
// verify with (callers must not land: CI is the gate).
export async function loadTrunkCi(
  artifacts: TrunkCiArtifacts | null,
  repo: string,
  sha: string,
  opts: { branch?: string } = {},
): Promise<TrunkCi | null> {
  if (!artifacts) return null;
  let handle: TrunkCiHandle | null = null;
  try {
    handle = await artifacts.get(repo);
    const pipeline = await readText(handle, sha, TRUNK_PIPELINE_PATH, PIPELINE_CAP);
    if (pipeline) return { kind: "flare", pipeline };
    return compatForTrunk(await readTrunkWorkflows(handle, sha), opts.branch ?? "main");
  } catch {
    return null;
  } finally {
    dispose(handle);
  }
}
