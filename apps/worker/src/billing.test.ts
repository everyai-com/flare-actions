import { describe, expect, it } from "vitest";
import {
  billableWindow,
  fetchBillableUsage,
  fetchR2Bandwidth,
  parseBillableRow,
  parseR2BandwidthGroups,
  summarizeBillableUsage,
  type BillableFetch,
  type GraphqlFetch,
} from "./billing";

const ROW = {
  BillingCurrency: "USD",
  BillingPeriodStart: "2026-09-01T00:00:00Z",
  ChargePeriodStart: "2026-09-01T00:00:00Z",
  ChargePeriodEnd: "2026-09-01T23:59:59Z",
  ServiceName: "Workers Standard",
  ServiceFamilyName: "Workers",
  ConsumedQuantity: 150000,
  ConsumedUnit: "requests",
  PricingQuantity: 150000,
  ContractedCost: 0.75,
  CumulatedContractedCost: 2.25,
};

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("parseBillableRow", () => {
  it("parses full rows and rejects malformed ones", () => {
    expect(parseBillableRow(ROW)).toMatchObject({ ServiceFamilyName: "Workers", ContractedCost: 0.75 });
    expect(parseBillableRow({ ...ROW, ServiceName: "" })).toBeNull();
    expect(parseBillableRow({ ...ROW, ContractedCost: "0.75" })).toBeNull();
    expect(parseBillableRow(null)).toBeNull();
    expect(parseBillableRow("nope")).toBeNull();
  });
});

describe("summarizeBillableUsage", () => {
  it("totals cost and ranks families", () => {
    const rows = [
      parseBillableRow(ROW)!,
      parseBillableRow({ ...ROW, ServiceName: "R2 Storage", ServiceFamilyName: "R2", ContractedCost: 3.5 })!,
      parseBillableRow({ ...ROW, ServiceName: "Workers R2?", ServiceFamilyName: "Workers", ContractedCost: 0.25 })!,
    ];
    const s = summarizeBillableUsage(rows, "2026-09-01", "2026-09-30");
    expect(s.totalCost).toBe(4.5);
    expect(s.currency).toBe("USD");
    expect(s.families.map((f) => f.family)).toEqual(["R2", "Workers"]);
    expect(s.families[1]).toEqual({ family: "Workers", cost: 1, rows: 2 });
    expect(s.truncated).toBe(false);
    expect(s.totalRows).toBe(3);
  });
  it("carries truncation metadata", () => {
    const s = summarizeBillableUsage([], "2026-09-01", "2026-09-30", { skippedRows: 4, truncated: true, totalRows: 2500 });
    expect(s).toMatchObject({ skippedRows: 4, truncated: true, totalRows: 2500 });
  });
});

describe("fetchBillableUsage", () => {
  it("sends the dated request with a bearer token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const stub: BillableFetch = async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return okResponse({ success: true, errors: [], messages: [], result: [ROW, { junk: true }] });
    };
    const out = await fetchBillableUsage("tok", "acct", "2026-09-01", "2026-09-30", stub);
    expect(seenUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct/billable-usage?from=2026-09-01&to=2026-09-30");
    expect(seenAuth).toBe("Bearer tok");
    expect(out.rows).toHaveLength(1);
    expect(out.skippedRows).toBe(1);
  });
  it("throws on HTTP and envelope failures", async () => {
    const forbidden: BillableFetch = async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response;
    await expect(fetchBillableUsage("t", "a", "f", "t", forbidden)).rejects.toThrow("403");
    const badEnvelope: BillableFetch = async () => okResponse({ success: false, result: [] });
    await expect(fetchBillableUsage("t", "a", "f", "t", badEnvelope)).rejects.toThrow("envelope");
  });
  it("reports truncation past the row cap", async () => {
    const stub: BillableFetch = async () => okResponse({ success: true, result: Array.from({ length: 2001 }, () => ROW) });
    const out = await fetchBillableUsage("t", "a", "f", "t", stub);
    expect(out.rows).toHaveLength(2000);
    expect(out.truncated).toBe(true);
    expect(out.totalRows).toBe(2001);
  });
});

describe("parseR2BandwidthGroups", () => {
  it("parses and ranks buckets, skipping malformed groups", () => {
    const rows = parseR2BandwidthGroups([
      { dimensions: { bucketName: "a" }, sum: { bytesUpload: 10, bytesDownload: 5 } },
      { dimensions: { bucketName: "b" }, sum: { bytesUpload: 100, bytesDownload: 0 } },
      { dimensions: {}, sum: {} },
      null,
    ]);
    expect(rows).toEqual([
      { bucket: "b", ingressBytes: 100, egressBytes: 0 },
      { bucket: "a", ingressBytes: 10, egressBytes: 5 },
    ]);
    expect(parseR2BandwidthGroups(null)).toEqual([]);
  });
});

describe("fetchR2Bandwidth", () => {
  it("posts the dated bandwidth query with a Bearer [REDACTED]", async () => {
    let seenUrl = "";
    let seenBody = "";
    const stub: GraphqlFetch = async (url, init) => {
      seenUrl = url;
      seenBody = init.body;
      return okResponse({
        data: { viewer: { accounts: [{ r2BandwidthUsageAdaptiveGroups: [{ dimensions: { bucketName: "c" }, sum: { bytesUpload: 7, bytesDownload: 3 } }] }] } },
      });
    };
    const out = await fetchR2Bandwidth("tok", "acct", "2026-09-01", "2026-09-30", stub);
    expect(seenUrl).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(JSON.parse(seenBody).variables).toEqual({
      accountTag: "acct",
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
    });
    expect(out).toMatchObject({ ingressBytes: 7, egressBytes: 3, from: "2026-09-01", to: "2026-09-30" });
    expect(out.buckets).toEqual([{ bucket: "c", ingressBytes: 7, egressBytes: 3 }]);
  });
  it("throws on HTTP and GraphQL errors", async () => {
    const forbidden: GraphqlFetch = async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response;
    await expect(fetchR2Bandwidth("t", "a", "f", "t", forbidden)).rejects.toThrow("403");
    const gqlErr: GraphqlFetch = async () => okResponse({ errors: [{ message: "bad query" }] });
    await expect(fetchR2Bandwidth("t", "a", "f", "t", gqlErr)).rejects.toThrow("bad query");
  });
});

describe("billableWindow", () => {
  it("returns day-bounded from/to", () => {
    const { from, to } = billableWindow(30);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(to) - Date.parse(from)).toBe(30 * 86400000);
  });
});
