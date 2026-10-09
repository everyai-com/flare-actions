import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { getTemplate, listTemplateMeta, TEMPLATES, templateIds } from "./templates";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

describe("templates", () => {
  it("lists one unique id per template", () => {
    const ids = templateIds();
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(listTemplateMeta()).toHaveLength(TEMPLATES.length);
    for (const meta of listTemplateMeta()) {
      expect(meta.id).toBeTruthy();
      expect(meta.name).toBeTruthy();
      expect(meta.description).toBeTruthy();
    }
  });

  it("looks up templates by id", () => {
    expect(getTemplate("node")?.stack).toBe("node");
    expect(getTemplate("nope")).toBeNull();
  });

  it("ships YAML that parses to a jobs map with runnable steps", () => {
    for (const t of TEMPLATES) {
      const doc: unknown = parseYaml(t.yaml);
      expect(isRecord(doc), `${t.id} parses to a map`).toBe(true);
      const jobs = (doc as Record<string, unknown>)["jobs"];
      expect(isRecord(jobs), `${t.id} has a jobs map`).toBe(true);
      const entries = Object.entries(jobs as Record<string, unknown>);
      expect(entries.length, `${t.id} has jobs`).toBeGreaterThan(0);
      for (const [, job] of entries) {
        expect(isRecord(job), `${t.id} job is a map`).toBe(true);
        const steps = (job as Record<string, unknown>)["steps"];
        expect(Array.isArray(steps), `${t.id} job has steps`).toBe(true);
        for (const step of steps as unknown[]) {
          expect(isRecord(step) && typeof step["run"] === "string" && step["run"].trim(), `${t.id} step runs`).toBeTruthy();
        }
      }
    }
  });
});
