import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRunEmail,
  DEFAULT_NOTIFY_PREFS,
  escapeHtml,
  isQuietNow,
  isRepeatFailure,
  notifyRunCompleted,
  parseNotifyMode,
  parseNotifyPrefsInput,
  parseQuietTime,
  postNotifyWebhook,
  resolveNotifySender,
  shouldNotifyForStatus,
  validateNotifyPrefEmail,
  webhookPayload,
  type EmailSender,
} from "./notify";
import type { Db, JobRow, NotifyPrefRow, RunRow, UserRow } from "./db";
import { encryptSettingValue, resolveSecretsKey } from "./secrets";

afterEach(() => {
  vi.unstubAllGlobals();
});

const run: RunRow = {
  id: "run-1",
  repo: "owner/repo",
  sha: "abcdef1234567890",
  event: "push",
  installation_id: null,
  branch: "main",
  source: null,
  pipeline_source: "",
  changed_files: "",
  profile: null,
  pr_number: null,
  pr_comment_id: null,
  heal_branch: null,
  heal_pr_url: null,
  attested_by: null, agent: "",
  status: "success",
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-01T09:02:30.000Z",
};

const job: JobRow = {
  id: "job-1",
  run_id: "run-1",
  status: "success",
  log: "ok",
  name: "test",
  definition: "",
  result: "",
  triage: "",
  labels: "",
  priority: 0,
  attempts: 0,
  started_at: "2026-10-01T09:00:00.000Z",
  finished_at: "2026-10-01T09:02:00.000Z",
  retained_until: null,
    prior_ms: 0,
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-01T09:02:00.000Z",
};

class MemDb implements Db {
  settings = new Map<string, string>();
  users: UserRow[] = [];
  jobs: JobRow[] = [];
  prefs: NotifyPrefRow[] = [];
  runStatuses: { id: string; repo: string; branch: string; status: string; created_at: string }[] = [];
  audits: { actor: string; action: string; target: string }[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT * FROM users")) return { results: this.users as T[] };
          if (norm.startsWith("SELECT * FROM notify_prefs")) return { results: this.prefs as T[] };
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (norm.startsWith("SELECT value FROM app_settings")) {
            const v = this.settings.get(values[0] as string);
            return (v === undefined ? null : { value: v }) as T | null;
          }
          if (norm.startsWith("SELECT status FROM runs WHERE repo")) {
            const [repo, branch, exclude] = values as string[];
            const rows = this.runStatuses
              .filter((r) => r.repo === repo && r.branch === branch && r.id !== exclude)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            return ((rows[0] ? { status: rows[0].status } : null) as T | null);
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async () => {
          if (norm.startsWith("INSERT INTO audit_log")) {
            this.audits.push({ actor: values[1] as string, action: values[2] as string, target: values[3] as string });
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

describe("parseNotifyMode", () => {
  it("honors stored modes and defaults to all", () => {
    expect(parseNotifyMode("failures")).toBe("failures");
    expect(parseNotifyMode("off")).toBe("off");
    expect(parseNotifyMode("all")).toBe("all");
    expect(parseNotifyMode(null)).toBe("all");
    expect(parseNotifyMode("bogus")).toBe("all");
  });
});

describe("shouldNotifyForStatus", () => {
  it("covers all terminal statuses in all mode", () => {
    for (const s of ["success", "failure", "error", "cancelled", "skipped"]) {
      expect(shouldNotifyForStatus("all", s)).toBe(true);
    }
    expect(shouldNotifyForStatus("all", "running")).toBe(false);
  });

  it("restricts failures mode to failure and error", () => {
    expect(shouldNotifyForStatus("failures", "failure")).toBe(true);
    expect(shouldNotifyForStatus("failures", "error")).toBe(true);
    expect(shouldNotifyForStatus("failures", "success")).toBe(false);
    expect(shouldNotifyForStatus("failures", "cancelled")).toBe(false);
  });

  it("never notifies in off mode", () => {
    expect(shouldNotifyForStatus("off", "failure")).toBe(false);
  });
});

describe("resolveNotifySender", () => {
  it("prefers env, trims, and nulls when unconfigured", () => {
    expect(resolveNotifySender("a@x.com", "b@x.com")).toBe("a@x.com");
    expect(resolveNotifySender(undefined, " b@x.com ")).toBe("b@x.com");
    expect(resolveNotifySender(undefined, null)).toBeNull();
    expect(resolveNotifySender("  ", null)).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("buildRunEmail", () => {
  it("composes subject, text, and html with run facts", () => {
    const { subject, text, html } = buildRunEmail({ run, jobs: [job], origin: "https://ci.example.com/" });
    expect(subject).toBe("[flare] owner/repo (main) — success");
    expect(text).toContain("owner/repo (main) @ abcdef1");
    expect(text).toContain("- test: success (2m)");
    expect(text).toContain("https://ci.example.com/dashboard");
    expect(html).toContain("Open dashboard");
    expect(html).toContain("#15803d");
  });

  it("omits the link without an origin and escapes hostile data", () => {
    const evil = { ...run, repo: "<script>alert(1)</script>", branch: "", status: "failure" };
    const { text, html } = buildRunEmail({ run: evil, jobs: [], origin: "" });
    expect(text).not.toContain("dashboard");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes capped triage for failed jobs", () => {
    const failed = { ...job, status: "failure", triage: "t".repeat(600) };
    const { text } = buildRunEmail({ run: { ...run, status: "failure" }, jobs: [failed], origin: "" });
    expect(text).toContain("--- triage: test ---");
    expect(text).toContain("t".repeat(500));
    expect(text).not.toContain("t".repeat(501));
  });
});

describe("notifyRunCompleted", () => {
  function user(email: string): UserRow {
    return { email, password_hash: "x", is_admin: 0, created_at: "2026-10-01T00:00:00.000Z" };
  }

  it("sends one email per recipient and audits the delivery", async () => {
    const db = new MemDb();
    db.settings.set("notify_mode", "all");
    db.settings.set("notify_from_email", "ci@example.com");
    db.users = [user("a@example.com"), user("b@example.com")];
    db.jobs = [job];
    const sent: { to: unknown; subject: string }[] = [];
    const out = await notifyRunCompleted(
      db,
      { EMAIL: { send: async (m) => void sent.push({ to: m.to, subject: m.subject }) } },
      { run, origin: "https://ci.example.com" },
    );
    expect(out).toEqual({ sent: 2, webhook: false, skipped: null });
    expect(sent.map((s) => s.to).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(sent[0]?.subject).toContain("owner/repo");
    expect(db.audits).toEqual([{ actor: "notify", action: "run.notify", target: "run-1 2/2" }]);
  });

  it("skips without sending when unconfigured", async () => {
    const db = new MemDb();
    db.users = [user("a@example.com")];
    let calls = 0;
    const mail = { EMAIL: { send: async () => void calls++ } };
    // No sender configured.
    expect(await notifyRunCompleted(db, mail, { run, origin: "" })).toEqual({
      sent: 0,
      webhook: false,
      skipped: "no notify sender configured",
    });
    // Mode off.
    db.settings.set("notify_from_email", "ci@example.com");
    db.settings.set("notify_mode", "off");
    const out = await notifyRunCompleted(db, mail, { run, origin: "" });
    expect(out.sent).toBe(0);
    expect(out.skipped).toContain("off");
    // No binding.
    db.settings.set("notify_mode", "all");
    expect(await notifyRunCompleted(db, {}, { run, origin: "" })).toEqual({
      sent: 0,
      webhook: false,
      skipped: "no EMAIL binding",
    });
    expect(calls).toBe(0);
    expect(db.audits).toEqual([]);
  });

  it("isolates per-recipient failures and never throws", async () => {
    const db = new MemDb();
    db.settings.set("notify_from_email", "ci@example.com");
    db.users = [user("ok@example.com"), user("bad@example.com")];
    const out = await notifyRunCompleted(
      db,
      {
        EMAIL: {
          send: async (m) => {
            if (m.to === "bad@example.com") throw new Error("bounce");
          },
        },
      },
      { run, origin: "" },
    );
    expect(out).toEqual({ sent: 1, webhook: false, skipped: null });
    // A broken db still resolves instead of rejecting.
    const broken = {
      prepare() {
        throw new Error("d1 down");
      },
    } as unknown as Db;
    await expect(notifyRunCompleted(broken, {}, { run, origin: "" })).resolves.toEqual({
      sent: 0,
      webhook: false,
      skipped: "error",
    });
  });

  it("posts a chat webhook even when email is unconfigured", async () => {
    const db = new MemDb();
    db.settings.set("secrets_key", Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
    const key = await resolveSecretsKey(db, undefined);
    db.settings.set("notify_webhook_url", await encryptSettingValue(key, "https://hooks.slack.com/services/T/B/X"));
    db.jobs = [job];
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("ok", { status: 200 });
    });
    const out = await notifyRunCompleted(db, {}, { run, origin: "https://ci.example.com" });
    expect(out).toEqual({ sent: 0, webhook: true, skipped: "no notify sender configured" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.slack.com/services/T/B/X");
    expect(JSON.parse(String(calls[0].init?.body)).text).toContain("owner/repo (main)");
    expect(db.audits).toEqual([{ actor: "notify", action: "run.webhook", target: "run-1" }]);
  });

  it("degrades a rejected webhook without failing the notify", async () => {
    const db = new MemDb();
    db.settings.set("secrets_key", Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
    const key = await resolveSecretsKey(db, undefined);
    db.settings.set("notify_webhook_url", await encryptSettingValue(key, "https://discord.com/api/webhooks/1/x"));
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Discord shape check happens inside postNotifyWebhook.
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.content === undefined) return new Response("bad request", { status: 400 });
      return new Response("nope", { status: 500 });
    });
    const out = await notifyRunCompleted(db, {}, { run, origin: "" });
    expect(out.webhook).toBe(false);
    expect(db.audits).toEqual([{ actor: "notify", action: "run.webhook_failed", target: "run-1" }]);
  });
});

describe("webhook payloads", () => {
  it("uses text for Slack-style hosts and content for Discord", () => {
    expect(webhookPayload("https://hooks.slack.com/services/x", "hi")).toEqual({ text: "hi" });
    expect(webhookPayload("https://discord.com/api/webhooks/1/x", "hi")).toEqual({ content: "hi" });
    expect(webhookPayload("https://canary.discordapp.com/api/webhooks/1/x", "hi")).toEqual({ content: "hi" });
  });

  it("postNotifyWebhook returns false on network errors and non-2xx", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(await postNotifyWebhook("https://hooks.slack.com/services/x", "hi")).toBe(false);
    vi.stubGlobal("fetch", async () => new Response("", { status: 410 }));
    expect(await postNotifyWebhook("https://hooks.slack.com/services/x", "hi")).toBe(false);
  });
});

describe("validateNotifyPrefEmail", () => {
  it("accepts valid emails and rejects the rest", () => {
    expect(validateNotifyPrefEmail("a@example.com")).toBeNull();
    expect(validateNotifyPrefEmail("not-an-email")).not.toBeNull();
    expect(validateNotifyPrefEmail("")).not.toBeNull();
    expect(validateNotifyPrefEmail(42)).not.toBeNull();
  });
});

describe("parseQuietTime", () => {
  it("parses UTC HH:MM bounds", () => {
    expect(parseQuietTime("22:00")).toEqual({ minutes: 1320 });
    expect(parseQuietTime("07:30")).toEqual({ minutes: 450 });
    expect(parseQuietTime("00:00")).toEqual({ minutes: 0 });
  });

  it("rejects malformed times", () => {
    for (const bad of ["24:00", "7pm", "7:30", "22:60", "", "  ", 5, null]) {
      expect("error" in parseQuietTime(bad)).toBe(true);
    }
  });
});

describe("isQuietNow", () => {
  const at = (iso: string): Date => new Date(iso);

  it("matches daytime windows with inclusive start, exclusive end", () => {
    expect(isQuietNow("09:00", "17:00", at("2026-10-09T12:00:00Z"))).toBe(true);
    expect(isQuietNow("09:00", "17:00", at("2026-10-09T09:00:00Z"))).toBe(true);
    expect(isQuietNow("09:00", "17:00", at("2026-10-09T17:00:00Z"))).toBe(false);
    expect(isQuietNow("09:00", "17:00", at("2026-10-09T08:59:00Z"))).toBe(false);
  });

  it("wraps overnight windows past midnight", () => {
    expect(isQuietNow("22:00", "07:00", at("2026-10-09T23:30:00Z"))).toBe(true);
    expect(isQuietNow("22:00", "07:00", at("2026-10-09T06:59:00Z"))).toBe(true);
    expect(isQuietNow("22:00", "07:00", at("2026-10-09T07:00:00Z"))).toBe(false);
    expect(isQuietNow("22:00", "07:00", at("2026-10-09T12:00:00Z"))).toBe(false);
  });

  it("fails open on empty or malformed windows", () => {
    expect(isQuietNow("", "", at("2026-10-09T12:00:00Z"))).toBe(false);
    expect(isQuietNow("22:00", "", at("2026-10-09T23:00:00Z"))).toBe(false);
    expect(isQuietNow("bogus", "07:00", at("2026-10-09T23:00:00Z"))).toBe(false);
  });
});

describe("isRepeatFailure", () => {
  it("flags consecutive reds only", () => {
    expect(isRepeatFailure("failure", "failure")).toBe(true);
    expect(isRepeatFailure("error", "failure")).toBe(true);
    expect(isRepeatFailure("failure", "error")).toBe(true);
    expect(isRepeatFailure("failure", "success")).toBe(false);
    expect(isRepeatFailure("failure", null)).toBe(false);
    expect(isRepeatFailure("failure", "cancelled")).toBe(false);
    expect(isRepeatFailure("success", "failure")).toBe(false);
  });
});

describe("parseNotifyPrefsInput", () => {
  it("merges partial updates over stored prefs", () => {
    const base = { quietStart: "22:00", quietEnd: "07:00", newFailuresOnly: false };
    expect(parseNotifyPrefsInput({ newFailuresOnly: true }, base)).toEqual({
      prefs: { quietStart: "22:00", quietEnd: "07:00", newFailuresOnly: true },
    });
    expect(parseNotifyPrefsInput({}, base)).toEqual({ prefs: base });
    expect(parseNotifyPrefsInput({ quietStart: "", quietEnd: "" }, base)).toEqual({
      prefs: { ...DEFAULT_NOTIFY_PREFS },
    });
  });

  it("requires both quiet bounds and valid values", () => {
    expect("error" in parseNotifyPrefsInput({ quietStart: "22:00" }, DEFAULT_NOTIFY_PREFS)).toBe(true);
    expect("error" in parseNotifyPrefsInput({ quietStart: "late" }, DEFAULT_NOTIFY_PREFS)).toBe(true);
    expect("error" in parseNotifyPrefsInput({ newFailuresOnly: "maybe" }, DEFAULT_NOTIFY_PREFS)).toBe(true);
    expect(parseNotifyPrefsInput({ newFailuresOnly: 1 }, DEFAULT_NOTIFY_PREFS)).toEqual({
      prefs: { ...DEFAULT_NOTIFY_PREFS, newFailuresOnly: true },
    });
  });
});

describe("notifyRunCompleted attention prefs", () => {
  function user(email: string): UserRow {
    return { email, password_hash: "x", is_admin: 0, created_at: "2026-10-01T00:00:00.000Z" };
  }

  function pref(email: string, quietStart = "", quietEnd = "", newFailuresOnly = 0): NotifyPrefRow {
    return { email, quiet_start: quietStart, quiet_end: quietEnd, new_failures_only: newFailuresOnly, updated_at: "" };
  }

  function wired(): { sent: string[]; mail: { EMAIL: EmailSender } } {
    const sent: string[] = [];
    return {
      sent,
      mail: { EMAIL: { send: async (m) => void sent.push(String(m.to)) } },
    };
  }

  it("drops quiet-hours recipients and keeps the rest", async () => {
    const db = new MemDb();
    db.settings.set("notify_mode", "all");
    db.settings.set("notify_from_email", "ci@example.com");
    db.users = [user("night@example.com"), user("day@example.com")];
    db.jobs = [job];
    db.prefs = [pref("night@example.com", "22:00", "07:00")];
    const { sent, mail } = wired();
    const out = await notifyRunCompleted(db, mail, {
      run,
      origin: "",
      now: new Date("2026-10-09T23:30:00Z"),
    });
    expect(out).toEqual({ sent: 1, webhook: false, skipped: null });
    expect(sent).toEqual(["day@example.com"]);
  });

  it("reports when every recipient is deferred by prefs", async () => {
    const db = new MemDb();
    db.settings.set("notify_from_email", "ci@example.com");
    db.users = [user("night@example.com")];
    db.jobs = [job];
    db.prefs = [pref("night@example.com", "00:00", "23:59")];
    const { sent, mail } = wired();
    const out = await notifyRunCompleted(db, mail, { run, origin: "", now: new Date("2026-10-09T12:00:00Z") });
    expect(out).toEqual({ sent: 0, webhook: false, skipped: "all recipients deferred by notification prefs" });
    expect(sent).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it("dedups repeat reds but always notifies recovery", async () => {
    const db = new MemDb();
    db.settings.set("notify_mode", "all");
    db.settings.set("notify_from_email", "ci@example.com");
    db.users = [user("dedup@example.com"), user("plain@example.com")];
    db.prefs = [pref("dedup@example.com", "", "", 1)];
    db.runStatuses = [
      { id: "run-0", repo: "owner/repo", branch: "main", status: "failure", created_at: "2026-10-01T08:00:00Z" },
    ];
    // Repeat red: the dedup user stays quiet, the plain user is emailed.
    db.jobs = [{ ...job, status: "failure" }];
    const first = wired();
    const out = await notifyRunCompleted(db, first.mail, { run: { ...run, status: "failure" }, origin: "" });
    expect(out.sent).toBe(1);
    expect(first.sent).toEqual(["plain@example.com"]);

    // Green after red reaches both recipients.
    db.jobs = [job];
    const second = wired();
    const green = await notifyRunCompleted(db, second.mail, { run: { ...run, id: "run-2" }, origin: "" });
    expect(green.sent).toBe(2);
    expect(second.sent.sort()).toEqual(["dedup@example.com", "plain@example.com"]);
  });

  it("notifies the first failure in a streak", async () => {
    const db = new MemDb();
    db.settings.set("notify_mode", "failures");
    db.settings.set("notify_from_email", "ci@example.com");
    db.users = [user("dedup@example.com")];
    db.jobs = [{ ...job, status: "failure" }];
    db.prefs = [pref("dedup@example.com", "", "", 1)];
    db.runStatuses = [
      { id: "run-0", repo: "owner/repo", branch: "main", status: "success", created_at: "2026-10-01T08:00:00Z" },
    ];
    const { sent, mail } = wired();
    const out = await notifyRunCompleted(db, mail, { run: { ...run, status: "failure" }, origin: "" });
    expect(out.sent).toBe(1);
    expect(sent).toEqual(["dedup@example.com"]);
  });
});
