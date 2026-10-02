import {
  audit,
  getJobsForRun,
  getSetting,
  isTerminal,
  listUsers,
  type Db,
  type JobRow,
  type RunRow,
} from "./db";
import { jobDurationMs, summarizeRunCost } from "./cost";
import { SETTING_KEYS } from "./settings";

// Run completion emails via the EMAIL send_email binding. Best-effort like
// triage: unconfigured sender, missing binding, or send errors degrade to a
// skipped notification plus a structured log line, never to a 500. Callers
// fire this from waitUntil (worker) or await it inline (seats); it never
// throws.

export type NotifyMode = "all" | "failures" | "off";
export const DEFAULT_NOTIFY_MODE: NotifyMode = "all";

// Structural subset of the SendEmail binding: the real binding is
// assignable, and tests pass a capturing fake.
export interface EmailSender {
  send(message: EmailMessageBuilder): Promise<unknown>;
}

export interface NotifyMailEnv {
  EMAIL?: EmailSender;
  NOTIFY_FROM_EMAIL?: string;
}

export function parseNotifyMode(value: string | null): NotifyMode {
  if (value === "failures" || value === "off") return value;
  return DEFAULT_NOTIFY_MODE;
}

// "failures" means genuinely failed runs; cancelled/skipped runs notify
// only in "all" mode (a superseded push is not a failure).
export function shouldNotifyForStatus(mode: NotifyMode, status: string): boolean {
  if (mode === "off") return false;
  if (mode === "failures") return status === "failure" || status === "error";
  return isTerminal(status);
}

// Env secrets take precedence; the dashboard-managed D1 setting fills the
// gap so one-click deploys need zero secret commands. Null = unconfigured.
export function resolveNotifySender(envSender: string | undefined, dbSender: string | null): string | null {
  const v = (envSender ?? dbSender ?? "").trim();
  return v ? v : null;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

function fmtDurMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function runDurationMs(run: RunRow): number | null {
  const a = Date.parse(run.created_at);
  const b = Date.parse(run.updated_at);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

export interface RunEmailInput {
  run: RunRow;
  jobs: JobRow[];
  // Dashboard origin for the run link; "" omits it (seats has no origin).
  origin: string;
}

export interface RunEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildRunEmail(input: RunEmailInput): { subject: string; text: string; html: string } {
  const { run, jobs } = input;
  const sha7 = run.sha.slice(0, 7);
  const branchBit = run.branch ? ` (${run.branch})` : "";
  const subject = `[flare] ${run.repo}${branchBit} — ${run.status}`;
  const summary = summarizeRunCost(jobs);
  const dur = runDurationMs(run);
  const jobLines = jobs.map((j) => {
    const jd = jobDurationMs(j);
    return `- ${j.name || j.id.slice(0, 8)}: ${j.status}${jd === null ? "" : ` (${fmtDurMs(jd)})`}`;
  });
  const triageBits = jobs
    .filter((j) => j.triage)
    .map((j) => `--- triage: ${j.name || j.id.slice(0, 8)} ---\n${j.triage.slice(0, 500)}`);
  const link = input.origin ? `${input.origin.replace(/\/$/, "")}/dashboard` : "";
  const text = [
    `${run.repo}${branchBit} @ ${sha7} — ${run.status}`,
    `event: ${run.event}${dur === null ? "" : ` · wall ${fmtDurMs(dur)}`}`,
    `${summary.finishedJobs}/${summary.jobs} jobs finished, ${summary.computeMinutes} compute-min (~$${summary.actionsListUsd} at Actions list price)`,
    "",
    ...jobLines,
    ...(triageBits.length > 0 ? ["", ...triageBits] : []),
    ...(link ? ["", link] : []),
  ].join("\n");
  const statusColor =
    run.status === "success"
      ? "#15803d"
      : run.status === "failure" || run.status === "error"
        ? "#dc2626"
        : "#687182";
  const html =
    `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1c2330">` +
    `<p><strong>${escapeHtml(run.repo)}${escapeHtml(branchBit)} @ ${escapeHtml(sha7)}</strong> — ` +
    `<span style="color:${statusColor};font-weight:700">${escapeHtml(run.status)}</span></p>` +
    `<p style="color:#687182">${escapeHtml(run.event)}${dur === null ? "" : ` · wall ${escapeHtml(fmtDurMs(dur))}`} · ` +
    `${summary.finishedJobs}/${summary.jobs} jobs · ${summary.computeMinutes} compute-min (~$${summary.actionsListUsd})</p>` +
    `<ul>${jobs.map((j) => `<li>${escapeHtml(`${j.name || j.id.slice(0, 8)}: ${j.status}`)}</li>`).join("")}</ul>` +
    (triageBits.length > 0
      ? `<pre style="background:#f6f7f9;padding:10px;border-radius:8px;white-space:pre-wrap">${triageBits.map(escapeHtml).join("\n\n")}</pre>`
      : "") +
    (link ? `<p><a href="${escapeHtml(link)}">Open dashboard</a></p>` : "") +
    `</div>`;
  return { subject, text, html };
}

export async function notifyRunCompleted(
  db: Db,
  mail: NotifyMailEnv,
  input: { run: RunRow; origin: string },
): Promise<{ sent: number; skipped: string | null }> {
  try {
    const mode = parseNotifyMode(await getSetting(db, SETTING_KEYS.notifyMode));
    if (!shouldNotifyForStatus(mode, input.run.status)) {
      return { sent: 0, skipped: `mode ${mode} skips ${input.run.status}` };
    }
    const sender = resolveNotifySender(mail.NOTIFY_FROM_EMAIL, await getSetting(db, SETTING_KEYS.notifyFromEmail));
    if (!sender) return { sent: 0, skipped: "no notify sender configured" };
    const recipients = (await listUsers(db)).map((u) => u.email).filter((e) => e.includes("@"));
    if (recipients.length === 0) return { sent: 0, skipped: "no recipients" };
    const email = mail.EMAIL;
    if (!email) return { sent: 0, skipped: "no EMAIL binding" };
    const jobs = await getJobsForRun(db, input.run.id);
    const { subject, text, html } = buildRunEmail({ run: input.run, jobs, origin: input.origin });
    const from = { name: "Flare Actions", email: sender };
    const results = await Promise.all(
      recipients.map(async (to) => {
        try {
          await email.send({ from, to, subject, text, html });
          return true;
        } catch (err) {
          console.log(JSON.stringify({ level: "warn", msg: "notify send failed", to, error: String(err) }));
          return false;
        }
      }),
    );
    const sent = results.filter(Boolean).length;
    console.log(
      JSON.stringify({ level: "info", msg: "run notified", runId: input.run.id, sent, recipients: recipients.length }),
    );
    await audit(db, "notify", "run.notify", `${input.run.id} ${sent}/${recipients.length}`);
    return { sent, skipped: null };
  } catch (err) {
    console.log(JSON.stringify({ level: "warn", msg: "notify failed", error: String(err) }));
    return { sent: 0, skipped: "error" };
  }
}
