// Billable Usage API client (self-serve accounts): FOCUS-shaped daily
// rows of real Cloudflare dollars per product family, so `cli usage`
// shows measured spend next to the Actions-list-price comparison.
// Needs a Billing-Read API token + account id (env or admin D1
// settings); everything degrades to "not configured" when absent.
export interface BillableUsageRow {
  BillingCurrency: string;
  BillingPeriodStart: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ServiceName: string;
  ServiceFamilyName: string;
  ConsumedQuantity: number;
  ConsumedUnit: string;
  PricingQuantity: number;
  ContractedCost: number;
  CumulatedContractedCost: number;
}

export interface BillableFamilySpend {
  family: string;
  cost: number;
  rows: number;
}

export interface BillableSummary {
  currency: string;
  from: string;
  to: string;
  totalCost: number;
  families: BillableFamilySpend[];
  skippedRows: number;
}

const MAX_BILLABLE_ROWS = 2000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseBillableRow(raw: unknown): BillableUsageRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const currency = str(r.BillingCurrency);
  const service = str(r.ServiceName);
  const family = str(r.ServiceFamilyName);
  const cost = num(r.ContractedCost);
  if (!currency || !service || !family || cost === null) return null;
  return {
    BillingCurrency: currency,
    BillingPeriodStart: str(r.BillingPeriodStart) ?? "",
    ChargePeriodStart: str(r.ChargePeriodStart) ?? "",
    ChargePeriodEnd: str(r.ChargePeriodEnd) ?? "",
    ServiceName: service,
    ServiceFamilyName: family,
    ConsumedQuantity: num(r.ConsumedQuantity) ?? 0,
    ConsumedUnit: str(r.ConsumedUnit) ?? "",
    PricingQuantity: num(r.PricingQuantity) ?? 0,
    ContractedCost: cost,
    CumulatedContractedCost: num(r.CumulatedContractedCost) ?? 0,
  };
}

export function summarizeBillableUsage(rows: BillableUsageRow[], from: string, to: string): BillableSummary {
  const byFamily = new Map<string, { cost: number; rows: number }>();
  let currency = "USD";
  for (const row of rows) {
    currency = row.BillingCurrency;
    const cur = byFamily.get(row.ServiceFamilyName) ?? { cost: 0, rows: 0 };
    cur.cost += row.ContractedCost;
    cur.rows += 1;
    byFamily.set(row.ServiceFamilyName, cur);
  }
  const families = [...byFamily]
    .map(([family, v]) => ({ family, cost: Math.round(v.cost * 100) / 100, rows: v.rows }))
    .sort((a, b) => b.cost - a.cost);
  const totalCost = Math.round(families.reduce((s, f) => s + f.cost, 0) * 100) / 100;
  return { currency, from, to, totalCost, families, skippedRows: 0 };
}

export type BillableFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export async function fetchBillableUsage(
  token: string,
  accountId: string,
  from: string,
  to: string,
  fetchImpl: BillableFetch = fetch,
): Promise<{ rows: BillableUsageRow[]; skippedRows: number }> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/billable-usage` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`billable usage request failed: ${res.status}`);
  const body = (await res.json().catch(() => null)) as { result?: unknown; success?: unknown } | null;
  if (!body || body.success !== true || !Array.isArray(body.result)) {
    throw new Error("billable usage response was not a success envelope");
  }
  const rows: BillableUsageRow[] = [];
  let skippedRows = 0;
  for (const raw of body.result.slice(0, MAX_BILLABLE_ROWS)) {
    const row = parseBillableRow(raw);
    if (row) rows.push(row);
    else skippedRows += 1;
  }
  return { rows, skippedRows };
}

export function billableWindow(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - Math.min(Math.max(days, 1), 365) * 86400000);
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  return { from: day(from), to: day(to) };
}
