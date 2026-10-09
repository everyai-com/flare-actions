// BYO resource self-report: sample the runner's process subtree once a
// second while a job runs, keeping peak RSS + peak CPU%. Zero
// dependencies (the SDK ships dependency-free): one `ps` invocation
// per sample on Linux/macOS, failing open everywhere else (Windows,
// minimal containers without `ps`) — missing peaks simply omit the
// fields, mirroring the seat cgroupfs sampler. Container-step work
// runs inside Docker, so host-side sampling only sees the docker CLI:
// peaks cover non-container step subtrees, tar cache ops, and service
// shims — the work footprint, not the runner baseline (the runner's
// own RSS is constant overhead and excluded).
import { execFile } from "node:child_process";

export interface TreeUsage {
  rssBytes: number;
  cpuPercent: number;
}

export interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpu: number;
}

// Pure: parse `ps -o pid=,ppid=,rss=,%cpu=` output (both procps and
// BSD accept the %cpu spelling; `=` suppresses headers). Malformed
// lines are skipped — a partial table still yields a lower bound.
export function parsePsOutput(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0] === "") continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const rssKb = Number(fields[2]);
    const cpu = Number(fields[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!Number.isFinite(rssKb) || rssKb < 0 || !Number.isFinite(cpu) || cpu < 0) continue;
    rows.push({ pid, ppid, rssKb, cpu });
  }
  return rows;
}

// Pure: sum rss/cpu over rootPid's DESCENDANTS (the visited set guards
// pathological tables; PID reuse across samples is accepted noise for
// a best-effort signal).
export function sumProcessTree(rows: PsRow[], rootPid: number): TreeUsage {
  const children = new Map<number, PsRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  let rssBytes = 0;
  let cpuPercent = 0;
  const visited = new Set<number>([rootPid]);
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const row = queue.pop() as PsRow;
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    rssBytes += row.rssKb * 1024;
    cpuPercent += row.cpu;
    queue.push(...(children.get(row.pid) ?? []));
  }
  return { rssBytes, cpuPercent };
}

export function psArgs(): string[] {
  return process.platform === "darwin"
    ? ["-ax", "-o", "pid=,ppid=,rss=,%cpu="]
    : ["-e", "-o", "pid=,ppid=,rss=,%cpu="];
}

export function sampleProcessTree(rootPid: number): Promise<TreeUsage> {
  return new Promise((resolve, reject) => {
    execFile("ps", psArgs(), { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      try {
        resolve(sumProcessTree(parsePsOutput(String(stdout ?? "")), rootPid));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

export interface ResourcePeaks {
  peakRssBytes: number;
  peakCpuPercent: number;
}

export interface ResourceMonitor {
  start(): void;
  stop(): Promise<ResourcePeaks>;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const rounded = u === 0 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
  return `${rounded} ${units[u]}`;
}

export class JobResourceMonitor implements ResourceMonitor {
  private readonly rootPid: number;
  private readonly intervalMs: number;
  private readonly sampler: () => Promise<TreeUsage>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private stopped = false;
  private peaks: ResourcePeaks = { peakRssBytes: 0, peakCpuPercent: 0 };

  constructor(rootPid: number = process.pid, opts: { intervalMs?: number; sample?: () => Promise<TreeUsage> } = {}) {
    this.rootPid = rootPid;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.sampler = opts.sample ?? (() => sampleProcessTree(rootPid));
  }

  start(): void {
    if (this.timer) return;
    // The immediate sample is handled, never floating: takeSample
    // catches everything internally, and the .catch is belt-and-braces.
    this.takeSample().catch(() => undefined);
    this.timer = setInterval(() => {
      this.takeSample().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<ResourcePeaks> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Idempotent, and safe before start: the final sample covers
    // sub-interval jobs whose children are still alive at stop time.
    if (!this.stopped) {
      this.stopped = true;
      await this.takeSample();
    }
    return { ...this.peaks };
  }

  private async takeSample(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sample = await this.sampler();
      if (Number.isFinite(sample.rssBytes) && sample.rssBytes > this.peaks.peakRssBytes) {
        this.peaks.peakRssBytes = Math.floor(sample.rssBytes);
      }
      if (Number.isFinite(sample.cpuPercent) && sample.cpuPercent > this.peaks.peakCpuPercent) {
        this.peaks.peakCpuPercent = Math.round(sample.cpuPercent * 10) / 10;
      }
    } catch {
      // Best effort: a failed sample never fails the job.
    } finally {
      this.busy = false;
    }
  }
}
