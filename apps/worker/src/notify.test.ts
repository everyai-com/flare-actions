import { describe, expect, it } from "vitest";
import {
  buildRunEmail,
  escapeHtml,
  notifyRunCompleted,
  parseNotifyMode,
  resolveNotifySender,
  shouldNotifyForStatus,
} from "./notify";
import type { Db, JobRow, RunRow, UserRow } from "./db";

const run: RunRow = {
  id: "run-1",
  repo: "owner/repo",
  sha: "abcdef1234567890",
  event: "push",
  installation_id: null,
  branch: "main",
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
  started_at: "2026-10-01T09:00:00.000Z",
  finished_at: "2026-10-01T09:02:00.000Z",
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-01T09:02:00.000Z",
};

class MemDb implements Db {
  settings = new Map<string, string>();
  users: UserRow[] = [];
  jobs: JobRow[] = [];
  audits: { actor: string; action: string; target: string }[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>() => {
          if (norm.startsWith("SELECT * FROM users")) return { results: this.users as T[] };
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>() => {
          if (!norm.startsWith("SELECT value FROM app_settings")) throw new Error(`unrouted first: ${norm}`);
          const v = this.settings.get(values[0] as string);
          return (v === undefined ? null : { value: v }) as T | null;
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
    expect(out).toEqual({ sent: 2, skipped: null });
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
    expect(await notifyRunCompleted(db, {}, { run, origin: "" })).toEqual({ sent: 0, skipped: "no EMAIL binding" });
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
    expect(out).toEqual({ sent: 1, skipped: null });
    // A broken db still resolves instead of rejecting.
    const broken = {
      prepare() {
        throw new Error("d1 down");
      },
    } as unknown as Db;
    await expect(notifyRunCompleted(broken, {}, { run, origin: "" })).resolves.toEqual({ sent: 0, skipped: "error" });
  });
});
