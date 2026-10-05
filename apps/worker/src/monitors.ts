import {
  audit,
  getSetting,
  hasMonitorFired,
  listLongRunningJobs,
  listMonitors,
  pruneMonitorFires,
  recordMonitorFire,
  setMonitorStreak,
  touchMonitorFired,
  type Db,
  type JobRow,
  type MonitorRow,
  type RunRow,
} from "./db";
import { postNotifyWebhook } from "./notify";
import { decryptSettingValue, resolveSecretsKey } from "./secrets";
import { SETTING_KEYS, validateNotifyWebhookUrl } from "./settings";

// Monitors: rule-based alerts on job outcomes and durations
// (Blacksmith monitors equivalent). Two trigger types:
//
// - result: a terminal job in scope (repo + optional branch + optional
//   job-name glob) whose status matches and whose log contains the
//   optional substring. `consecutive` N fires after N matching terminal
//   jobs in a row; a non-matching terminal job in scope resets the
//   streak, and firing resets it so one streak pages exactly once.
// - duration: a still-running job in scope older than the threshold.
//   Evaluated by the per-minute cron; monitor_fires makes each alert
//   one-shot per job even if the job runs for hours.
//
// Delivery reuses the notify chat-webhook path: a per-monitor webhook
// URL (AES-GCM encrypted like the global one) or, when empty, the
// global notify webhook. Best-effort throughout: evaluation never
// throws, and a monitor that cannot fire degrades to skip + audit.

export const MONITOR_RESULTS = ["failure", "error", "cancelled", "skipped", "success"];
export const MAX_MONITORS = 50;
export const MAX_MONITOR_NAME = 80;
export const MAX_LOG_PATTERN = 200;

export interface MonitorSpec {
  name: string;
  repo: string;
  branch: string;
  job: string;
  trigger: "result" | "duration";
  result: string;
  consecutive: number;
  durationSeconds: number;
  logPattern: string;
  webhookUrl: string;
}

export function validateMonitorInput(body: Record<string, unknown>): MonitorSpec | { error: string } {
  const { name, repo, branch, job, trigger, result, consecutive, durationSeconds, logPattern, webhookUrl } = body;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "repo must be owner/name" };
  if (trigger !== "result" && trigger !== "duration") return { error: "trigger must be result or duration" };
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_MONITOR_NAME)) {
    return { error: `name must be a string (max ${MAX_MONITOR_NAME} chars)` };
  }
  if (branch !== undefined && (typeof branch !== "string" || branch.length > 128)) {
    return { error: "branch must be a string (max 128 chars)" };
  }
  if (job !== undefined && (typeof job !== "string" || job.length > 128)) {
    return { error: "job must be a glob string (max 128 chars)" };
  }
  if (trigger === "result") {
    if (typeof result !== "string" || !MONITOR_RESULTS.includes(result)) {
      return { error: `result must be one of ${MONITOR_RESULTS.join(", ")}` };
    }
  }
  const n = consecutive === undefined ? 1 : consecutive;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100) {
    return { error: "consecutive must be an integer 1-100" };
  }
  const d = durationSeconds === undefined ? 0 : durationSeconds;
  if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 86400) {
    return { error: "durationSeconds must be an integer 0-86400" };
  }
  if (trigger === "duration" && d < 60) return { error: "duration monitors need durationSeconds >= 60" };
  if (logPattern !== undefined && (typeof logPattern !== "string" || logPattern.length > MAX_LOG_PATTERN)) {
    return { error: `logPattern must be a string (max ${MAX_LOG_PATTERN} chars)` };
  }
  if (webhookUrl !== undefined && webhookUrl !== "") {
    const err = validateNotifyWebhookUrl(webhookUrl);
    if (err) return { error: err };
  }
  return {
    name: typeof name === "string" ? name.trim() : "",
    repo,
    branch: typeof branch === "string" ? branch : "",
    job: typeof job === "string" ? job : "",
    trigger,
    result: trigger === "result" ? (result as string) : "",
    consecutive: n,
    durationSeconds: d,
    logPattern: typeof logPattern === "string" ? logPattern : "",
    webhookUrl: typeof webhookUrl === "string" ? webhookUrl : "",
  };
}

// Job-name filter: exact match, or `*`/`?` globs ("Run tests*").
// Empty pattern matches everything.
export function jobNameMatches(pattern: string, name: string): boolean {
  if (!pattern) return true;
  let rx = "^";
  for (const c of pattern) {
    if (c === "*") rx += ".*";
    else if (c === "?") rx += ".";
    else rx += c.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  rx += "$";
  try {
    return new RegExp(rx).test(name);
  } catch {
    return false;
  }
}

export function monitorScopeMatches(m: MonitorRow, repo: string, branch: string, jobName: string): boolean {
  if (m.repo !== repo) return false;
  if (m.branch && m.branch !== branch) return false;
  return jobNameMatches(m.job, jobName);
}

export function monitorMuted(m: MonitorRow, nowMs = Date.now()): boolean {
  if (!m.muted_until) return false;
  const until = Date.parse(m.muted_until);
  return Number.isFinite(until) && until > nowMs;
}

export interface MonitorMailEnv {
  SECRETS_KEY?: string;
}

async function resolveMonitorWebhook(db: Db, mail: MonitorMailEnv, m: MonitorRow): Promise<string | null> {
  const stored = m.webhook_url || (await getSetting(db, SETTING_KEYS.notifyWebhookUrl));
  if (!stored) return null;
  try {
    const key = await resolveSecretsKey(db, mail.SECRETS_KEY);
    return await decryptSettingValue(key, stored);
  } catch {
    return null;
  }
}

async function fireMonitor(
  db: Db,
  mail: MonitorMailEnv,
  m: MonitorRow,
  text: string,
  target: string,
): Promise<boolean> {
  const url = await resolveMonitorWebhook(db, mail, m);
  if (!url) {
    console.log(JSON.stringify({ level: "info", msg: "monitor skipped: no webhook", monitorId: m.id }));
    await audit(db, "monitor", "monitor.skipped", `${m.id} no webhook`).catch(() => undefined);
    return false;
  }
  const ok = await postNotifyWebhook(url, text);
  console.log(JSON.stringify({ level: ok ? "info" : "warn", msg: "monitor fired", monitorId: m.id, ok }));
  await audit(db, "monitor", ok ? "monitor.fired" : "monitor.fire_failed", `${m.id} ${target}`).catch(() => undefined);
  return ok;
}

function monitorTitle(m: MonitorRow): string {
  return m.name || `${m.repo} ${m.trigger}`;
}

// Result evaluation: call after a job lands terminal, from either
// executor. Streaks advance only on in-scope terminal jobs.
export async function evaluateResultMonitors(
  db: Db,
  mail: MonitorMailEnv,
  run: RunRow,
  job: JobRow,
): Promise<string[]> {
  const fired: string[] = [];
  try {
    const monitors = await listMonitors(db);
    for (const m of monitors) {
      if (m.enabled !== 1 || m.trigger !== "result") continue;
      if (!monitorScopeMatches(m, run.repo, run.branch, job.name)) continue;
      const matches = job.status === m.result && (!m.log_pattern || job.log.toLowerCase().includes(m.log_pattern.toLowerCase()));
      if (!matches) {
        if (m.streak !== 0) await setMonitorStreak(db, m.id, 0);
        continue;
      }
      const streak = m.streak + 1;
      if (streak < m.consecutive) {
        await setMonitorStreak(db, m.id, streak);
        continue;
      }
      await touchMonitorFired(db, m.id);
      if (monitorMuted(m)) continue;
      const ok = await fireMonitor(
        db,
        mail,
        m,
        `[flare monitor] ${monitorTitle(m)}: ${job.name || job.id.slice(0, 8)} ${job.status} ` +
          `(${run.repo}${run.branch ? ` ${run.branch}` : ""} @ ${run.sha.slice(0, 7)}, streak ${streak})`,
        job.id,
      );
      if (ok) fired.push(m.id);
    }
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "result monitors failed", error: String(err) }));
  }
  return fired;
}

// Duration evaluation: call from the per-minute cron (production only).
// One alert per monitor per pass, listing every newly-over-threshold
// job; monitor_fires keeps each job one-shot.
export async function evaluateDurationMonitors(db: Db, mail: MonitorMailEnv): Promise<string[]> {
  const fired: string[] = [];
  try {
    const monitors = await listMonitors(db);
    for (const m of monitors) {
      if (m.enabled !== 1 || m.trigger !== "duration" || m.duration_seconds < 60) continue;
      if (monitorMuted(m)) continue;
      const cutoff = new Date(Date.now() - m.duration_seconds * 1000).toISOString();
      const candidates = await listLongRunningJobs(db, m.repo, cutoff);
      const fresh: { id: string; runId: string; name: string; startedAt: string }[] = [];
      for (const c of candidates) {
        if (!c.started_at) continue;
        if (m.branch && m.branch !== c.branch) continue;
        if (!jobNameMatches(m.job, c.name)) continue;
        if (await hasMonitorFired(db, m.id, c.id)) continue;
        fresh.push({ id: c.id, runId: c.run_id, name: c.name, startedAt: c.started_at });
        if (fresh.length >= 10) break;
      }
      if (fresh.length === 0) continue;
      const lines = fresh.map((f) => {
        const mins = Math.max(1, Math.round((Date.now() - Date.parse(f.startedAt)) / 60000));
        return `- ${f.name || f.id.slice(0, 8)} running ${mins}m+ (run ${f.runId.slice(0, 8)})`;
      });
      const ok = await fireMonitor(
        db,
        mail,
        m,
        `[flare monitor] ${monitorTitle(m)}: ${fresh.length} job(s) over ${m.duration_seconds}s in ${m.repo}\n${lines.join("\n")}`,
        fresh.map((f) => f.id).join(","),
      );
      for (const f of fresh) await recordMonitorFire(db, m.id, f.id);
      await touchMonitorFired(db, m.id);
      if (ok) fired.push(m.id);
    }
    await pruneMonitorFires(db).catch(() => 0);
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "duration monitors failed", error: String(err) }));
  }
  return fired;
}

// Resolve helper for the admin toggle endpoint: mute for N minutes, or
// unmute when minutes is 0/null.
export function muteUntilIso(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  return new Date(Date.now() + Math.min(minutes, 7 * 24 * 60) * 60000).toISOString();
}
