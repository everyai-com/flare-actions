import { describe, expect, it } from "vitest";
import { billableWindow, fetchBillableUsage, parseBillableRow, summarizeBillableUsage, type BillableFetch } from "./billing";

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
});

describe("billableWindow", () => {
  it("returns day-bounded from/to", () => {
    const { from, to } = billableWindow(30);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(to) - Date.parse(from)).toBe(30 * 86400000);
  });
});
