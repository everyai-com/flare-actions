import { describe, expect, it } from "vitest";
import {
  buildMintBody,
  listPermissionGroups,
  mintToken,
  permissionHint,
  resolvePermissionIds,
  TOKEN_PROFILES,
} from "./api-tokens.mjs";

const GROUPS = [
  { id: "g1", name: "Workers Scripts Edit" },
  { id: "g2", name: "D1 Edit" },
  { id: "g3", name: "Queues Edit" },
  { id: "g4", name: "Billing Read" },
];

describe("token profiles", () => {
  it("defines ci, debug, and billing profiles", () => {
    expect(Object.keys(TOKEN_PROFILES).sort()).toEqual(["billing", "ci", "debug"]);
    expect(TOKEN_PROFILES.ci.groups).toContain("Workers Scripts Edit");
    expect(TOKEN_PROFILES.debug.groups.every((g) => /read/i.test(g))).toBe(true);
  });
});

describe("resolvePermissionIds", () => {
  it("maps names to ids", () => {
    expect(resolvePermissionIds(GROUPS, ["D1 Edit", "Queues Edit"])).toEqual({ ids: [{ id: "g2" }, { id: "g3" }] });
  });
  it("fails closed with near-matches on unknown names", () => {
    const out = resolvePermissionIds(GROUPS, ["D1 Edit", "D1 Superpower"]);
    expect(out.missing).toEqual(["D1 Superpower"]);
    expect(out.candidates).toContain("D1 Edit");
  });
});

describe("buildMintBody", () => {
  it("scopes the policy to the one account", () => {
    const body = buildMintBody("flare-actions-ci", "acct1", [{ id: "g1" }]);
    expect(body.name).toBe("flare-actions-ci");
    expect(body.policies).toEqual([
      { effect: "allow", resources: { "com.cloudflare.api.account.acct1": "*" }, permission_groups: [{ id: "g1" }] },
    ]);
  });
});

describe("mint + list", () => {
  it("mints and returns the once-only value", async () => {
    const seen = {};
    const fetchImpl = async (url, init) => {
      seen.url = url;
      seen.method = init.method;
      seen.auth = init.headers.Authorization;
      return { ok: true, json: async () => ({ success: true, result: { value: "SECRET", id: "t1" } }) };
    };
    const out = await mintToken("https://api.test", "parent", { name: "x" }, fetchImpl);
    expect(out).toEqual({ value: "SECRET", id: "t1" });
    expect(seen.url).toBe("https://api.test/user/tokens");
    expect(seen.auth).toBe("Bearer parent");
  });
  it("surfaces API errors instead of a value", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ errors: [{ message: "nope" }] }) });
    await expect(mintToken("https://api.test", "p", {}, fetchImpl)).rejects.toThrow("nope");
    await expect(listPermissionGroups("https://api.test", "p", fetchImpl)).rejects.toThrow("nope");
  });
});

describe("permissionHint", () => {
  it("stays silent on non-auth failures", () => {
    expect(permissionHint("seat image build failed:\nERROR: no space")).toBeNull();
    expect(permissionHint("")).toBeNull();
  });
  it("guides 403s to least-privilege tokens and echoes enriched links", () => {
    const hint = permissionHint("A request failed [code: 10000]\n  forbidden (403) see https://developers.cloudflare.com/x/y");
    expect(hint).toContain("npm run token:mint");
    expect(hint).toContain("https://developers.cloudflare.com/x/y");
    expect(permissionHint("Unauthorized to access requested resource")).toContain("token:mint");
  });
});
