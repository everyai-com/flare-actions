import { describe, expect, it } from "vitest";
import { buildGenerateMessages, extractYaml, runGenerate } from "./generate";

describe("generate", () => {
  it("builds constrained generation prompts", () => {
    const [sys, user] = buildGenerateMessages("node tests");
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("flare.yml");
    expect(user.content).toBe("node tests");
  });

  it("extracts yaml from fences", () => {
    expect(extractYaml("```yaml\njobs:\n  a: {}\n```")).toContain("jobs:");
    expect(extractYaml("jobs:\n  a: {}")).toContain("jobs:");
  });

  it("runs the model and rejects non-pipelines", async () => {
    const ok = await runGenerate({ run: async () => ({ response: "jobs:\n  a:\n    steps:\n      - run: echo\n" }) }, "x");
    expect(ok).toContain("jobs:");
    const bad = await runGenerate({ run: async () => ({ response: "hello there" }) }, "x");
    expect(bad).toBeNull();
    const throwing = await runGenerate(
      {
        run: async () => {
          throw new Error("down");
        },
      },
      "x",
    );
    expect(throwing).toBeNull();
  });

  it("fronts AI Gateway when a gateway id is set", async () => {
    let seen: unknown;
    const fake = {
      run: async (_m: string, _i: unknown, o?: unknown) => {
        seen = o;
        return { response: "jobs:\n  a: {}\n" };
      },
    };
    await runGenerate(fake, "x", { gatewayId: "prod" });
    expect(seen).toEqual({ gateway: { id: "prod" } });
  });
});
