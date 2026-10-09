import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { FlareClient } from "flare-actions-runner-sdk";
import { maybeUpdateRunner } from "./update.ts";

// Runner mode (the flare lane), BYO side: poll the JIT claim lane and
// execute each claimed job with GitHub's official actions/runner binary
// (`run.sh --jitconfig <blob>`, one job per process — JIT configs are
// single-use). Logs and status stay on GitHub; Flare records the job via
// the workflow_job webhook. The JIT blob is single-use and secret: it is
// passed to the child on argv (never logged) and never persisted.

// actions/runner tarball matrix. Windows ships a zip with a different
// bootstrap; documenting it as later keeps this mode honest.
export function runnerTarballName(os: string, cpu: string, version: string): string | null {
  const osPart = os === "linux" ? "linux" : os === "darwin" ? "osx" : null;
  const archPart = cpu === "x64" ? "x64" : cpu === "arm64" ? "arm64" : null;
  if (!osPart || !archPart) return null;
  return `actions-runner-${osPart}-${archPart}-${version}.tar.gz`;
}

function validVersion(value: string): string | null {
  const v = value.trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

export interface VersionResolution {
  version: string;
  source: "env" | "cache" | "release";
}

// FLARE_GH_RUNNER_VERSION wins; else a 24h cache file; else the latest
// actions/runner release tag. Throws on garbage so a bad version can
// never become a download URL.
export async function resolveRunnerVersion(opts: {
  env: Record<string, string | undefined>;
  cacheFile: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<VersionResolution> {
  const pinned = opts.env["FLARE_GH_RUNNER_VERSION"];
  if (pinned !== undefined && pinned !== "") {
    const version = validVersion(pinned);
    if (!version) throw new Error(`invalid FLARE_GH_RUNNER_VERSION: ${pinned}`);
    return { version, source: "env" };
  }
  const now = (opts.now ?? Date.now)();
  try {
    const cached = JSON.parse(readFileSync(opts.cacheFile, "utf8")) as { version?: unknown; fetchedAt?: unknown };
    if (
      typeof cached.version === "string" && validVersion(cached.version) &&
      typeof cached.fetchedAt === "number" && now - cached.fetchedAt < 24 * 3600_000
    ) {
      return { version: validVersion(cached.version) as string, source: "cache" };
    }
  } catch {
    // Missing or corrupt cache: fall through to the release lookup.
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn("https://api.github.com/repos/actions/runner/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "flare-actions" },
  });
  if (!res.ok) throw new Error(`runner release lookup failed: HTTP ${res.status}`);
  const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
  const version = typeof tag === "string" ? validVersion(tag) : null;
  if (!version) throw new Error(`runner release lookup returned a bad tag: ${String(tag)}`);
  mkdirSync(join(opts.cacheFile, ".."), { recursive: true });
  writeFileSync(opts.cacheFile, JSON.stringify({ version, fetchedAt: now }));
  return { version, source: "release" };
}

export interface GithubModeOptions {
  labels: string[];
  home?: string;
  os?: string;
  cpu?: string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  // Seams for tests; defaults shell out / hit the network.
  spawnRunner?: (runSh: string, jitConfig: string, cwd: string) => Promise<number>;
  download?: (url: string, dest: string) => Promise<void>;
  untar?: (file: string, dest: string) => void;
  log?: (obj: Record<string, unknown>) => void;
  now?: () => number;
  // Fleet auto-update (same semantics as the Flare lane): version
  // check while idle, pull + reinstall + exit 42 with autoUpdate.
  update?: {
    current: string;
    autoUpdate: boolean;
    cwd: string;
    getFleetVersion: () => Promise<string | null>;
    exit?: (code: number) => never;
  };
}

function defaultSpawn(runSh: string, jitConfig: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(runSh, ["--jitconfig", jitConfig], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function defaultDownload(url: string, dest: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(url, { headers: { "User-Agent": "flare-actions" } });
  if (!res.ok) throw new Error(`runner download failed: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The extracted runner root for a version (run.sh lives at its top).
// Downloads + unpacks on first use; afterwards it is just a path check.
export async function ensureRunner(version: string, opts: GithubModeOptions): Promise<string> {
  const os = opts.os ?? platform();
  const cpu = opts.cpu ?? arch();
  const tarball = runnerTarballName(os, cpu, version);
  if (!tarball) throw new Error(`runner mode needs linux/macOS (x64/arm64); this machine is ${os}/${cpu} — Windows support is planned, not shipped`);
  const home = opts.home ?? homedir();
  const root = join(home, ".flare", "actions-runner", version);
  const runSh = join(root, "run.sh");
  if (existsSync(runSh)) return runSh;
  const log = opts.log ?? ((obj) => console.log(JSON.stringify(obj)));
  const url = `https://github.com/actions/runner/releases/download/v${version}/${tarball}`;
  log({ msg: "downloading actions/runner", version, os, cpu });
  const tmp = join(home, ".flare", "actions-runner", `${tarball}.download`);
  mkdirSync(join(tmp, ".."), { recursive: true });
  const fetchFn = opts.fetchFn ?? fetch;
  await (opts.download ?? ((u, d) => defaultDownload(u, d, fetchFn)))(url, tmp);
  mkdirSync(root, { recursive: true });
  (opts.untar ?? ((file, dest) => execFileSync("tar", ["-xzf", file, "-C", dest])))(tmp, root);
  rmSync(tmp, { force: true });
  if (!existsSync(runSh)) throw new Error(`runner unpacked without run.sh (${tarball})`);
  return runSh;
}

// One claim → one JIT execution. True when a job ran (regardless of its
// exit code — GitHub owns the verdict); false when the lane was empty.
export async function pollGithubOnce(
  client: Pick<FlareClient, "claimGithubJob">,
  runSh: string,
  opts: GithubModeOptions,
): Promise<boolean> {
  const log = opts.log ?? ((obj) => console.log(JSON.stringify(obj)));
  const claim = await client.claimGithubJob(opts.labels);
  if (!claim) return false;
  const home = opts.home ?? homedir();
  const workdir = join(home, ".flare", "gh-work", claim.job.id);
  log({ msg: "picked up github job", jobId: claim.job.id, repo: claim.job.repo, name: claim.job.jobName, runner: claim.runnerName });
  mkdirSync(workdir, { recursive: true });
  try {
    const exitCode = await (opts.spawnRunner ?? defaultSpawn)(runSh, claim.jitConfig, workdir);
    log({ msg: "github job done", jobId: claim.job.id, exitCode });
  } catch (err) {
    log({ msg: "github job failed", jobId: claim.job.id, error: String(err) });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  return true;
}

// The --github poll loop: same cadence as the Flare lane (2s idle,
// 500ms after a job, 5s after an error). Never returns.
export async function runGithubLoop(
  client: Pick<FlareClient, "claimGithubJob">,
  opts: GithubModeOptions,
): Promise<never> {
  const log = opts.log ?? ((obj) => console.log(JSON.stringify(obj)));
  const home = opts.home ?? homedir();
  const { version, source } = await resolveRunnerVersion({
    env: opts.env ?? process.env as Record<string, string | undefined>,
    cacheFile: join(home, ".flare", "actions-runner", ".version-cache.json"),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  log({ msg: "github runner mode", version, versionSource: source, labels: opts.labels });
  const runSh = await ensureRunner(version, opts);
  const updateState = { lastCheck: 0, lastWarn: 0 };
  for (;;) {
    try {
      const worked = await pollGithubOnce(client, runSh, opts);
      if (!worked && opts.update) {
        const exitCode = await maybeUpdateRunner({
          state: updateState,
          now: (opts.now ?? Date.now)(),
          current: opts.update.current,
          autoUpdate: opts.update.autoUpdate,
          cwd: opts.update.cwd,
          getFleetVersion: opts.update.getFleetVersion,
          log,
        });
        if (exitCode !== null) (opts.update.exit ?? process.exit)(exitCode);
      }
      await new Promise((r) => setTimeout(r, worked ? 500 : 2000));
    } catch (err) {
      log({ msg: "github poll error", error: String(err) });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
