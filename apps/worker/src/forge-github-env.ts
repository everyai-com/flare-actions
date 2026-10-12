// Runtime wiring for the Forge <-> GitHub bridge: binds forge-github.ts
// (runtime-free, tested) to the Worker environment — isomorphic-git
// over MemoryFS, the ARTIFACTS binding, and GitHub REST authenticated
// as the connected GitHub App (env creds or dashboard Connect). Shared
// by REST/MCP (forge-adapters.ts), trains (train-workflow.ts) and the
// webhook + cron hooks in index.ts.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { resolveAppCreds } from "./connect";
import type { WorkerEnv } from "./env";
import { getGithubLink, githubRestPort, linksForGithubRepo, patchGithubLink, reconcileGithubLinks, syncFromGithub, syncToGithub, type BridgeDeps } from "./forge-github";
import { mintAppJwt } from "./github";
import { MemoryFS } from "./memory-fs";
import { artifactsRemoteFor } from "./promote";

function log(level: "info" | "warn", msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...fields }));
}

// null when the deployment has no Artifacts binding (nothing to sync).
export function bridgeDepsFromEnv(env: WorkerEnv): BridgeDeps | null {
  const artifacts = env.ARTIFACTS ?? null;
  if (!artifacts) return null;
  const namespace = env.ARTIFACTS_NAMESPACE ?? "";
  const accountId = env.ARTIFACTS_ACCOUNT_ID ?? "";
  return {
    db: env.DB,
    artifacts,
    github: githubRestPort({
      appJwt: async () => {
        const creds = await resolveAppCreds(env.DB, { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY }, env.SECRETS_KEY);
        return creds ? mintAppJwt(creds.appId, creds.privateKey) : null;
      },
    }),
    git,
    http,
    fs: () => new MemoryFS(),
    remoteFor: (repo) => artifactsRemoteFor(accountId, namespace, repo),
  };
}

// After a train lands: deliver the new trunk head to GitHub (per the
// link's sync mode). Best-effort: a failure is recorded on the link and
// retried by the next landing or a manual sync, never thrown.
export async function syncLandedToGithub(env: WorkerEnv, repo: string): Promise<string> {
  const deps = bridgeDepsFromEnv(env);
  if (!deps) return "unwired";
  try {
    const link = await getGithubLink(env.DB, repo);
    if (!link || link.syncMode === "off") return "unlinked";
    const out = await syncToGithub(deps, repo);
    if (out.status !== "noop") log("info", "forge github push sync", { repo, status: out.status, detail: out.detail });
    return out.status;
  } catch (err) {
    log("warn", "forge github push sync failed", { repo, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
    return "failed";
  }
}

// GitHub push webhook: fast-forward every trunk linked to this repo
// whose tracked branch moved. Bounded (≤10 links per repo).
export async function syncPushFromGithub(env: WorkerEnv, githubRepo: string, branch: string, installationId: number | null): Promise<number> {
  const deps = bridgeDepsFromEnv(env);
  if (!deps) return 0;
  let synced = 0;
  try {
    for (const link of await linksForGithubRepo(env.DB, githubRepo)) {
      if (installationId && link.installationId !== installationId) await patchGithubLink(env.DB, link.repo, { installationId });
      if (!link.pullUpstream || link.status !== "ready" || link.defaultBranch !== branch) continue;
      const out = await syncFromGithub(deps, link.repo);
      log("info", "forge github pull sync", { repo: link.repo, githubRepo, status: out.status });
      synced += 1;
    }
  } catch (err) {
    log("warn", "forge github pull sync failed", { githubRepo, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
  }
  return synced;
}

// Cron: finish imports that were still settling.
export async function reconcileBridge(env: WorkerEnv): Promise<number> {
  const deps = bridgeDepsFromEnv(env);
  if (!deps) return 0;
  try {
    return await reconcileGithubLinks(deps);
  } catch (err) {
    log("warn", "forge github reconcile failed", { error: String(err instanceof Error ? err.message : err).slice(0, 200) });
    return 0;
  }
}
