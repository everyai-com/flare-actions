// CPUs a job may actually use: the cgroup CPU quota, not the host's
// core count. Containers and CPU-limited pods report every host core
// through nproc / os.availableParallelism(), so tools that size worker
// pools from it (vitest, jest, make -j, cargo) start 8 workers on a
// 2-CPU limit and thrash, which is slower and flakier than matching the
// limit. Steps get the answer as FLARE_CPUS. Dependency-free: seats
// probe their container and parse with the same function.

// `online` is what the OS reports (nproc / availableParallelism);
// `cpuMax` is cgroup v2's /sys/fs/cgroup/cpu.max ("max 100000" = no
// limit, "200000 100000" = 2 CPUs) or the same "<quota> <period>" pair
// rebuilt from cgroup v1 (quota -1 = no limit). Fractional quotas round
// down, never below 1: a pool sized to 1.5 CPUs oversubscribes.
export function effectiveCpus(online: number, cpuMax?: string | null): number {
  const base = Number.isFinite(online) && online >= 1 ? Math.floor(online) : 1;
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(cpuMax ?? "");
  if (!m) return base;
  const quota = Number(m[1]);
  const period = Number(m[2]);
  if (quota <= 0 || period <= 0) return base;
  return Math.max(1, Math.min(base, Math.floor(quota / period)));
}

// One shell probe for executors that can only exec (seats): first line
// nproc, second line cgroup v2 cpu.max, else the v1 quota/period pair.
export const CPU_PROBE_SCRIPT =
  "nproc 2>/dev/null || echo 1; " +
  "cat /sys/fs/cgroup/cpu.max 2>/dev/null || " +
  "echo \"$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null)\"";

export function cpusFromProbe(stdout: string): number {
  const [online = "", cpuMax = ""] = stdout.split("\n");
  return effectiveCpus(Number(online.trim()), cpuMax);
}
