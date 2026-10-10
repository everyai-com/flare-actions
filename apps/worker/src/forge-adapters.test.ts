import { describe, expect, it } from "vitest";
import type { HappeningItem } from "./coordinator-core";
import { coordinatorPortOver, whyPortOver, type CoordinatorRpc } from "./forge-adapters";
import { forgeSqliteDb } from "./forge.testkit";

function item(over: Partial<HappeningItem> = {}): HappeningItem {
  return {
    intentId: "i1",
    agent: "alpha",
    title: "Cache layer",
    reasoning: "speed",
    state: "claimed",
    paths: ["src/api/cache.ts"],
    actual: null,
    headSha: "",
    leaseExpiresAt: null,
    risk: 0,
    goalId: null,
    updatedAt: "2026-10-10T00:00:00.000Z",
    matched: [{ mine: "src/api/cache.ts", theirs: "src/api/cache.ts" }],
    untrusted: true,
    ...over,
  };
}

function rpc(over: Partial<CoordinatorRpc>): CoordinatorRpc {
  const fail = async (): Promise<never> => {
    throw new Error("not stubbed");
  };
  return {
    declare: fail,
    sync: fail,
    indexPush: fail,
    release: fail,
    snapshot: fail,
    whatsHappening: fail,
    ...over,
  };
}

describe("coordinatorPortOver", () => {
  it("is the D1 fallback when no DO binding exists", () => {
    const port = coordinatorPortOver({ db: forgeSqliteDb(), client: null });
    expect(port.kind).toBe("d1");
  });

  it("maps the DO's whats-happening rows and honours exclude + limit", async () => {
    const port = coordinatorPortOver({
      db: forgeSqliteDb(),
      client: () => rpc({ whatsHappening: async () => ({ items: [item(), item({ intentId: "i2" }), item({ intentId: "i3" })], invalid: [], truncated: false }) }),
    });
    expect(port.kind).toBe("coordinator");
    const live = await port.whatsHappening("demo", { paths: ["src/api/cache.ts"], excludeIntent: "i2", limit: 1 });
    expect(live.map((l) => l.intentId)).toEqual(["i1"]);
    expect(live[0].matchedPaths).toEqual(["src/api/cache.ts"]);
    expect(live[0].footprint).toEqual(["src/api/cache.ts"]);
  });

  it("degrades a throwing DO call to D1 instead of failing the request", async () => {
    const port = coordinatorPortOver({ db: forgeSqliteDb(), client: () => rpc({}) });
    await expect(port.whatsHappening("demo", { paths: ["src/x.ts"] })).resolves.toEqual([]);
  });

  it("never lets a failed release or sync escape", async () => {
    const port = coordinatorPortOver({ db: forgeSqliteDb(), client: () => rpc({}) });
    await expect(port.release("demo", "i1")).resolves.toBeUndefined();
    await expect(port.sync?.("demo", "i1")).resolves.toBeUndefined();
  });
});

describe("whyPortOver", () => {
  it("is the D1 fallback without Artifacts", () => {
    expect(whyPortOver({ db: forgeSqliteDb(), chain: null }).kind).toBe("d1");
  });

  it("falls back to the footprint answer when blame throws", async () => {
    const port = whyPortOver({
      db: forgeSqliteDb(),
      chain: async () => {
        throw new Error("artifacts down");
      },
    });
    expect(port.kind).toBe("notes");
    const out = await port.why("demo", "src/a.ts", 3);
    expect(out.exact).toBe(false);
  });
});
