import { describe, expect, it } from "vitest";
import type { Db, JobRow, RunRow } from "./db";
import type { PipelineJob } from "./pipeline";
import {
  attestationHash,
  attestationInputForJobs,
  findAttestationForDispatch,
  getAttestationReceipt,
  parseReceiptJobs,
  planAttestedJobs,
  setRunAttestation,
  storeReceiptForRun,
  storeVerdictReceipt,
  verifyAttestationReceipt,
  type AttestationReceiptRow,
} from "./attestation";

// In-memory attestation store: receipts keyed by (repo, hash),
// faithful success-wins upsert, plus minimal runs/jobs rows.
class AttestationDb implements Db {
  receipts = new Map<string, AttestationReceiptRow>();
  runs = new Map<string, RunRow>();
  jobs: JobRow[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        all: async <T,>(): Promise<{ results: T[] }> => {
          if (norm.startsWith("SELECT * FROM jobs WHERE run_id")) {
            return { results: this.jobs.filter((j) => j.run_id === values[0]) as T[] };
          }
          throw new Error(`unrouted all: ${norm}`);
        },
        first: async <T,>(): Promise<T | null> => {
          if (norm.startsWith("SELECT * FROM attestation_receipts WHERE repo = ? AND hash = ?")) {
            const found = [...this.receipts.values()].find((r) => r.repo === values[0] && r.hash === values[1]);
            return (found ?? null) as unknown as T | null;
          }
          if (norm.startsWith("SELECT * FROM attestation_receipts WHERE id = ?")) {
            const found = [...this.receipts.values()].find((r) => r.id === values[0]);
            return (found ?? null) as unknown as T | null;
          }
          if (norm.startsWith("SELECT * FROM runs WHERE id = ?")) {
            return (this.runs.get(values[0] as string) ?? null) as unknown as T | null;
          }
          throw new Error(`unrouted first: ${norm}`);
        },
        run: async (): Promise<unknown> => {
          if (norm.startsWith("INSERT INTO attestation_receipts")) {
            const [id, repo, sha, profile, hash, verdict, runId, jobCount, jobsJson, createdAt] = values as [
              string, string, string, string, string, string, string, number, string, string,
            ];
            const key = `${repo}\0${hash}`;
            const existing = this.receipts.get(key);
            if (!existing) {
              this.receipts.set(key, {
                id, repo, sha, profile, hash, verdict, run_id: runId, job_count: jobCount, jobs_json: jobsJson, created_at: createdAt,
              });
            } else if (verdict === "success" && existing.verdict !== "success") {
              this.receipts.set(key, { ...existing, verdict, run_id: runId, job_count: jobCount, jobs_json: jobsJson });
            }
            return {};
          }
          if (norm.startsWith("UPDATE runs SET attested_by")) {
            const run = this.runs.get(values[2] as string);
            if (run) {
              run.attested_by = values[0] as string;
              run.updated_at = values[1] as string;
            }
            return {};
          }
          throw new Error(`unrouted run: ${norm}`);
        },
      }),
    };
  }
}

function job(name: string, over: Partial<PipelineJob> = {}): PipelineJob {
  return { name, steps: [{ run: "npm test" }], ...over };
}

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    repo: "o/r",
    sha: "abc123",
    event: "push",
    installation_id: null,
    profile: null,
    branch: "main",
    source: null,
    pipeline_source: "",
    changed_files: "",
    pr_number: null,
    pr_comment_id: null,
    heal_branch: null,
    heal_pr_url: null,
    attested_by: null,
    agent: "",
    status: "success",
    created_at: "2026-10-08T10:00:00.000Z",
    updated_at: "2026-10-08T10:00:00.000Z",
    ...over,
  };
}

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    run_id: "run-1",
    status: "success",
    log: "",
    name: "test",
    definition: JSON.stringify({ steps: [{ run: "npm test" }] }),
    result: "",
    triage: "",
    labels: "",
    priority: 0,
    attempts: 0,
    started_at: null,
    finished_at: null,
    retained_until: null,
    prior_ms: 0,
    created_at: "2026-10-08T10:00:00.000Z",
    updated_at: "2026-10-08T10:00:00.000Z",
    ...over,
  };
}

describe("attestationHash", () => {
  const base = () =>
    attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("test")]);

  it("is stable and hex-shaped", async () => {
    expect(await attestationHash(base())).toBe(await attestationHash(base()));
    expect(await attestationHash(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores job order", async () => {
    const reordered = attestationInputForJobs("o/r", "abc123", null, [job("test"), job("lint")]);
    expect(await attestationHash(reordered)).toBe(await attestationHash(base()));
  });

  it("changes on every state mismatch", async () => {
    const expected = await attestationHash(base());
    const cases: [string, () => ReturnType<typeof base>][] = [
      ["repo", () => attestationInputForJobs("o/other", "abc123", null, [job("lint"), job("test")])],
      ["sha", () => attestationInputForJobs("o/r", "def456", null, [job("lint"), job("test")])],
      ["profile", () => attestationInputForJobs("o/r", "abc123", "full", [job("lint"), job("test")])],
      ["added job", () => attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("test"), job("e2e")])],
      ["removed job", () => attestationInputForJobs("o/r", "abc123", null, [job("test")])],
      ["renamed job", () => attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("unit")])],
      ["step command", () => attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("test", { steps: [{ run: "npm run test:other" }] })])],
      ["labels", () => attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("test", { labels: ["linux", "arm64"] })])],
      ["image", () => attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("test", { container: "node:22" })])],
      ["env", () => attestationInputForJobs("o/r", "abc123", null, [job("lint"), job("test", { env: { NODE_ENV: "test" } })])],
    ];
    for (const [label, make] of cases) {
      expect(await attestationHash(make()), label).not.toBe(expected);
    }
  });
});

describe("receipt store and lookup", () => {
  it("round-trips dispatch jobs to a stored receipt", async () => {
    const db = new AttestationDb();
    const jobs = [job("lint"), job("test")];
    const hash = await attestationHash(attestationInputForJobs("o/r", "abc123", null, jobs));
    await storeVerdictReceipt(db, {
      repo: "o/r", sha: "abc123", profile: "", hash, verdict: "success", runId: "run-1",
      jobs: [{ name: "lint", status: "success" }, { name: "test", status: "success" }],
    });
    const found = await findAttestationForDispatch(db, "o/r", "abc123", null, jobs);
    expect(found?.verdict).toBe("success");
    expect(found?.hash).toBe(hash);
    expect(await getAttestationReceipt(db, found?.id ?? "")).toEqual(found);
  });

  it("never reuses across repos", async () => {
    const db = new AttestationDb();
    const jobs = [job("test")];
    const hash = await attestationHash(attestationInputForJobs("o/a", "abc123", null, jobs));
    await storeVerdictReceipt(db, {
      repo: "o/a", sha: "abc123", profile: "", hash, verdict: "success", runId: "run-1",
      jobs: [{ name: "test", status: "success" }],
    });
    // Same sha and suite, different repo: no match.
    expect(await findAttestationForDispatch(db, "o/b", "abc123", null, jobs)).toBeNull();
  });

  it("misses when the suite changed since the receipt", async () => {
    const db = new AttestationDb();
    const hash = await attestationHash(attestationInputForJobs("o/r", "abc123", null, [job("test")]));
    await storeVerdictReceipt(db, {
      repo: "o/r", sha: "abc123", profile: "", hash, verdict: "success", runId: "run-1",
      jobs: [{ name: "test", status: "success" }],
    });
    expect(await findAttestationForDispatch(db, "o/r", "abc123", null, [job("test", { steps: [{ run: "npm run test:changed" }] })])).toBeNull();
    expect(await findAttestationForDispatch(db, "o/r", "abc123", "full", [job("test")])).toBeNull();
  });

  it("lets success upgrade a stored failure, never the reverse", async () => {
    const db = new AttestationDb();
    const jobs = [job("test")];
    const hash = await attestationHash(attestationInputForJobs("o/r", "abc123", null, jobs));
    await storeVerdictReceipt(db, {
      repo: "o/r", sha: "abc123", profile: "", hash, verdict: "failure", runId: "run-red",
      jobs: [{ name: "test", status: "failure" }],
    });
    expect((await findAttestationForDispatch(db, "o/r", "abc123", null, jobs))?.verdict).toBe("failure");
    // The green rerun upgrades the receipt and becomes the witness run.
    await storeVerdictReceipt(db, {
      repo: "o/r", sha: "abc123", profile: "", hash, verdict: "success", runId: "run-green",
      jobs: [{ name: "test", status: "success" }],
    });
    const upgraded = await findAttestationForDispatch(db, "o/r", "abc123", null, jobs);
    expect(upgraded?.verdict).toBe("success");
    expect(upgraded?.run_id).toBe("run-green");
    // A later failure does not downgrade the recorded pass.
    await storeVerdictReceipt(db, {
      repo: "o/r", sha: "abc123", profile: "", hash, verdict: "failure", runId: "run-red-2",
      jobs: [{ name: "test", status: "failure" }],
    });
    const kept = await findAttestationForDispatch(db, "o/r", "abc123", null, jobs);
    expect(kept?.verdict).toBe("success");
    expect(kept?.run_id).toBe("run-green");
  });

  it("ignores verdicts without signal", async () => {
    const db = new AttestationDb();
    for (const verdict of ["cancelled", "error", "skipped", "queued"]) {
      const jobs = [job("test")];
      const hash = await attestationHash(attestationInputForJobs("o/r", `sha-${verdict}`, null, jobs));
      await storeVerdictReceipt(db, {
        repo: "o/r", sha: `sha-${verdict}`, profile: "", hash, verdict, runId: "run-1",
        jobs: [{ name: "test", status: verdict }],
      });
      expect(await findAttestationForDispatch(db, "o/r", `sha-${verdict}`, null, jobs)).toBeNull();
    }
  });
});

describe("storeReceiptForRun", () => {
  it("files a receipt from live run rows", async () => {
    const db = new AttestationDb();
    db.runs.set("run-1", runRow());
    db.jobs = [jobRow({ id: "job-1", name: "test", status: "success" })];
    await storeReceiptForRun(db, "run-1", db.jobs, "success");
    expect(db.receipts.size).toBe(1);
    const receipt = [...db.receipts.values()][0];
    expect(receipt.run_id).toBe("run-1");
    expect(receipt.verdict).toBe("success");
  });

  it("skips runs that were themselves short-circuited", async () => {
    const db = new AttestationDb();
    db.runs.set("run-1", runRow({ attested_by: "receipt-1" }));
    db.jobs = [jobRow()];
    await storeReceiptForRun(db, "run-1", db.jobs, "success");
    expect(db.receipts.size).toBe(0);
  });

  it("skips missing runs and empty job sets", async () => {
    const db = new AttestationDb();
    await storeReceiptForRun(db, "run-gone", [jobRow()], "success");
    db.runs.set("run-1", runRow());
    await storeReceiptForRun(db, "run-1", [], "success");
    expect(db.receipts.size).toBe(0);
  });
});

describe("setRunAttestation", () => {
  it("points the run at its receipt", async () => {
    const db = new AttestationDb();
    db.runs.set("run-1", runRow());
    await setRunAttestation(db, "run-1", "receipt-1");
    expect(db.runs.get("run-1")?.attested_by).toBe("receipt-1");
  });
});

describe("verifyAttestationReceipt", () => {
  function seeded(): { db: AttestationDb; receipt: AttestationReceiptRow } {
    const db = new AttestationDb();
    db.runs.set("run-1", runRow({ profile: "smoke" }));
    db.jobs = [jobRow({ definition: "def-1" }), jobRow({ id: "job-2", name: "lint", definition: "def-2" })];
    const receipt: AttestationReceiptRow = {
      id: "receipt-1",
      repo: "o/r",
      sha: "abc123",
      profile: "smoke",
      hash: "",
      verdict: "success",
      run_id: "run-1",
      job_count: 2,
      jobs_json: JSON.stringify([{ name: "lint", status: "success" }, { name: "test", status: "success" }]),
      created_at: "2026-10-08T10:00:00.000Z",
    };
    return { db, receipt };
  }

  it("verifies when the recomputed hash matches", async () => {
    const { db, receipt } = seeded();
    receipt.hash = await attestationHash({
      repo: "o/r",
      sha: "abc123",
      profile: "smoke",
      jobs: db.jobs.map((j) => ({ name: j.name, definition: j.definition, labels: j.labels })),
    });
    expect(await verifyAttestationReceipt(db, receipt)).toEqual({ verified: true, reason: expect.any(String), runStatus: "success" });
  });

  it("fails when a stored definition drifted after the fact", async () => {
    const { db, receipt } = seeded();
    receipt.hash = await attestationHash({
      repo: "o/r",
      sha: "abc123",
      profile: "smoke",
      jobs: db.jobs.map((j) => ({ name: j.name, definition: j.definition, labels: j.labels })),
    });
    db.jobs[0].definition = "tampered";
    const out = await verifyAttestationReceipt(db, receipt);
    expect(out.verified).toBe(false);
  });

  it("is unknown when the recorded run was pruned", async () => {
    const { db, receipt } = seeded();
    receipt.hash = "0".repeat(64);
    db.runs.clear();
    const out = await verifyAttestationReceipt(db, receipt);
    expect(out.verified).toBeNull();
    expect(out.runStatus).toBeNull();
  });

  it("fails when the recorded run moved repos", async () => {
    const { db, receipt } = seeded();
    receipt.hash = "0".repeat(64);
    db.runs.set("run-1", runRow({ repo: "o/other" }));
    expect((await verifyAttestationReceipt(db, receipt)).verified).toBe(false);
  });
});

describe("receipt replay", () => {
  it("parses recorded outcomes, falling back to the verdict", () => {
    expect(parseReceiptJobs("not json", "success")).toEqual([]);
    expect(parseReceiptJobs(JSON.stringify({}), "success")).toEqual([]);
    expect(
      parseReceiptJobs(
        JSON.stringify([{ name: "test", status: "failure" }, { name: "weird", status: "exploded" }, { name: "", status: "success" }]),
        "failure",
      ),
    ).toEqual([
      { name: "test", status: "failure" },
      { name: "weird", status: "failure" },
    ]);
  });

  it("plans attested jobs from recorded outcomes", async () => {
    const receipt: AttestationReceiptRow = {
      id: "receipt-1",
      repo: "o/r",
      sha: "abc123",
      profile: "",
      hash: "0".repeat(64),
      verdict: "failure",
      run_id: "run-1",
      job_count: 2,
      jobs_json: JSON.stringify([{ name: "test", status: "failure" }]),
      created_at: "2026-10-08T10:00:00.000Z",
    };
    const planned = planAttestedJobs(receipt, [job("test"), job("new-job")]);
    expect(planned.map((p) => [p.name, p.status])).toEqual([
      ["test", "failure"],
      ["new-job", "failure"],
    ]);
    expect(planned[0].definition).toContain("npm test");
  });
});
