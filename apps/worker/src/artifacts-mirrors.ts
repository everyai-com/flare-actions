// Hands-free Artifacts mirrors: the first push for a repo imports
// github:owner/repo into the ARTIFACTS namespace (server-side; the
// worker never shells out), seats check out from the mirror with
// per-job tokens, and pushes drive a tiny state machine (importing →
// ready, failed retries next push, stale imports reset). GitHub stays
// the source of truth throughout: any mirror gap falls back to a
// GitHub checkout, and deleting a mirror loses nothing.
import { getMirrorRow, setMirrorRow, type Db } from "./db";

// Minimal structural surface of the ARTIFACTS binding (runtime-free:
// tests inject fakes; index.ts passes env.ARTIFACTS, which satisfies
// this shape structurally).
export interface MirrorArtifactsRepo {
  readonly [Symbol.dispose]?: () => void;
}

export interface MirrorArtifactsNamespace {
  import(params: { source: { url: string }; target: { name: string } }): Promise<{ remote: string }>;
  get(name: string): Promise<MirrorArtifactsRepo>;
  delete(name: string): Promise<boolean>;
}

export interface EnsureMirrorDeps {
  db: Db;
  artifacts: MirrorArtifactsNamespace | null;
  repo: string;
  isPrivate: boolean;
  // Short-lived GitHub installation token for private imports
  // (memory-only: embedded in the import URL, never logged/stored).
  installationToken?: string | null;
  // Test hook for the importing/failed freshness windows.
  nowMs?: number;
}

export type EnsureMirrorOutcome =
  | { status: "ready" | "importing" | "failed"; mirror: string; detail?: string }
  | { status: "skipped"; reason: "no-binding" | "bad-name" };

// owner/name → owner-name (matches the manual CLI and the seat's
// non-verbatim render, so all three agree on the mirror name).
export function mirrorNameFor(repo: string): string | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const name = repo.replace("/", "-");
  return name.length <= 100 ? name : null;
}

function codeOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  return String((err as { code?: unknown }).code ?? "");
}

// Fresh importing/failed rows skip the RPC (one attempt per hour per
// repo max); importing rows older than a day reset (a stuck import
// blocks retries behind ALREADY_EXISTS).
export const MIRROR_RETRY_MS = 3_600_000;
export const MIRROR_STALE_MS = 86_400_000;

export async function ensureRepoMirror(deps: EnsureMirrorDeps): Promise<EnsureMirrorOutcome> {
  const mirror = mirrorNameFor(deps.repo);
  if (!mirror) return { status: "skipped", reason: "bad-name" };
  if (!deps.artifacts) return { status: "skipped", reason: "no-binding" };
  const artifacts = deps.artifacts;
  const now = deps.nowMs ?? Date.now();
  const row = await getMirrorRow(deps.db, deps.repo);
  if (row?.status === "ready") return { status: "ready", mirror };
  if ((row?.status === "importing" || row?.status === "failed") && row.updated_at) {
    const age = now - Date.parse(row.updated_at);
    if (Number.isFinite(age) && age >= 0 && age < MIRROR_RETRY_MS) {
      return row.status === "failed"
        ? { status: "failed", mirror, detail: row.detail }
        : { status: "importing", mirror };
    }
    if (row.status === "importing" && Number.isFinite(age) && age >= MIRROR_STALE_MS) {
      // Drop the half-made repo and re-import below (GitHub is source
      // of truth, so this loses nothing).
      await artifacts.delete(mirror).catch(() => false);
    }
  }
  if (deps.isPrivate && !deps.installationToken) {
    const detail = "private repo with no installation token (retry on next push)";
    await setMirrorRow(deps.db, deps.repo, mirror, "failed", detail);
    return { status: "failed", mirror, detail };
  }
  const sourceUrl =
    deps.isPrivate && deps.installationToken
      ? `https://x-access-token:${deps.installationToken}@github.com/${deps.repo}.git`
      : `https://github.com/${deps.repo}.git`;
  await setMirrorRow(deps.db, deps.repo, mirror, "importing", "");
  try {
    await artifacts.import({ source: { url: sourceUrl }, target: { name: mirror } });
  } catch (err) {
    const code = codeOf(err);
    if (code === "ALREADY_EXISTS") {
      // Adopt: someone (an earlier push, the manual CLI) made it.
      try {
        const handle = await artifacts.get(mirror);
        try {
          handle?.[Symbol.dispose]?.();
        } catch {
          // Disposal must never fail provisioning.
        }
        await setMirrorRow(deps.db, deps.repo, mirror, "ready", "");
        return { status: "ready", mirror };
      } catch (getErr) {
        const getCode = codeOf(getErr);
        if (getCode === "IMPORT_IN_PROGRESS" || getCode === "CREATE_IN_PROGRESS" || getCode === "FORK_IN_PROGRESS") {
          return { status: "importing", mirror };
        }
        const detail = `mirror exists but unreadable (${getCode || "error"})`;
        await setMirrorRow(deps.db, deps.repo, mirror, "failed", detail);
        return { status: "failed", mirror, detail };
      }
    }
    if (code === "REMOTE_AUTH_REQUIRED") {
      const detail = "private repo: import authentication refused (GitHub fallback continues)";
      await setMirrorRow(deps.db, deps.repo, mirror, "failed", detail);
      return { status: "failed", mirror, detail };
    }
    // UPSTREAM_UNAVAILABLE, MEMORY_LIMIT, INVALID_URL, NOT_FOUND, …:
    // failed with the code; the next push retries. Never log the URL
    // (private imports embed an installation token).
    const detail = `import ${code || "error"} (retry on next push)`;
    await setMirrorRow(deps.db, deps.repo, mirror, "failed", detail);
    return { status: "failed", mirror, detail };
  }
  await setMirrorRow(deps.db, deps.repo, mirror, "ready", "");
  return { status: "ready", mirror };
}
