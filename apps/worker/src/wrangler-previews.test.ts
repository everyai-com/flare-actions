// AGENTS.md: "Never point a preview at production resources." Previews
// inherit nothing from the top level for these bindings, so each one in
// the previews block must name a resource distinct from production's.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Named {
  binding?: string;
  name?: string;
  namespace?: string;
  database_name?: string;
  bucket_name?: string;
  dataset?: string;
  queue?: string;
}

interface Block {
  vars?: Record<string, string>;
  artifacts?: Named[];
  d1_databases?: Named[];
  r2_buckets?: Named[];
  analytics_engine_datasets?: Named[];
  workflows?: Named[];
  queues?: { producers?: Named[]; consumers?: Named[] };
}

function loadConfig(): Block & { previews?: Block } {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  // JSONC: drop full-line // comments (the file has no inline ones).
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as Block & { previews?: Block };
}

function names(list: Named[] | undefined, key: keyof Named): string[] {
  return (list ?? []).map((x) => String(x[key] ?? "")).filter(Boolean);
}

describe("wrangler.jsonc previews", () => {
  const cfg = loadConfig();
  const pre = cfg.previews ?? {};

  it("binds a separate Artifacts namespace (never production trunks/forks)", () => {
    const prod = names(cfg.artifacts, "namespace");
    const preview = names(pre.artifacts, "namespace");
    expect(prod.length).toBeGreaterThan(0);
    expect(preview.length).toBeGreaterThan(0);
    for (const ns of preview) expect(prod).not.toContain(ns);
    // The var the worker builds remotes and promotes from must match the binding.
    expect(pre.vars?.["ARTIFACTS_NAMESPACE"]).toBe(preview[0]);
    expect(pre.vars?.["ARTIFACTS_NAMESPACE"]).not.toBe(cfg.vars?.["ARTIFACTS_NAMESPACE"]);
  });

  it("shares no D1, R2, queue, dataset, or Workflow with production", () => {
    const pairs: Array<[string[], string[]]> = [
      [names(cfg.d1_databases, "database_name"), names(pre.d1_databases, "database_name")],
      [names(cfg.r2_buckets, "bucket_name"), names(pre.r2_buckets, "bucket_name")],
      [names(cfg.analytics_engine_datasets, "dataset"), names(pre.analytics_engine_datasets, "dataset")],
      [names(cfg.workflows, "name"), names(pre.workflows, "name")],
      [
        [...names(cfg.queues?.producers, "queue"), ...names(cfg.queues?.consumers, "queue")],
        [...names(pre.queues?.producers, "queue"), ...names(pre.queues?.consumers, "queue")],
      ],
    ];
    for (const [prod, preview] of pairs) {
      for (const n of preview) expect(prod).not.toContain(n);
    }
  });
});
