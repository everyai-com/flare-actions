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
  truncated: boolean;
  totalRows: number;
}

export interface R2BandwidthRow {
  bucket: string;
  ingressBytes: number;
  egressBytes: number;
}

export interface R2BandwidthSummary {
  from: string;
  to: string;
  ingressBytes: number;
  egressBytes: number;
  buckets: R2BandwidthRow[];
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

export function summarizeBillableUsage(
  rows: BillableUsageRow[],
  from: string,
  to: string,
  meta: { skippedRows?: number; truncated?: boolean; totalRows?: number } = {},
): BillableSummary {
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
  return {
    currency,
    from,
    to,
    totalCost,
    families,
    skippedRows: meta.skippedRows ?? 0,
    truncated: meta.truncated ?? false,
    totalRows: meta.totalRows ?? rows.length,
  };
}

export type BillableFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export async function fetchBillableUsage(
  token: string,
  accountId: string,
  from: string,
  to: string,
  fetchImpl: BillableFetch = fetch,
): Promise<{ rows: BillableUsageRow[]; skippedRows: number; truncated: boolean; totalRows: number }> {
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
  const totalRows = body.result.length;
  const rows: BillableUsageRow[] = [];
  let skippedRows = 0;
  for (const raw of body.result.slice(0, MAX_BILLABLE_ROWS)) {
    const row = parseBillableRow(raw);
    if (row) rows.push(row);
    else skippedRows += 1;
  }
  return { rows, skippedRows, truncated: totalRows > MAX_BILLABLE_ROWS, totalRows };
}

// R2 bandwidth pairing (GraphQL Analytics, same billing token — needs
// Account Analytics Read on top of Billing Read): per-bucket uploaded /
// downloaded bytes for the window, so dollars pair with the traffic
// that caused them. Account-level (no bucket filter), 100 buckets max.
const R2_BANDWIDTH_QUERY = `query FlareR2Bandwidth($accountTag: string!, $startDate: Time!, $endDate: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2BandwidthUsageAdaptiveGroups(
        limit: 100
        filter: { datetime_geq: $startDate, datetime_lt: $endDate }
      ) {
        sum { bytesUpload bytesDownload }
        dimensions { bucketName }
      }
    }
  }
}`;

export type GraphqlFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export function parseR2BandwidthGroups(groups: unknown): R2BandwidthRow[] {
  if (!Array.isArray(groups)) return [];
  const rows: R2BandwidthRow[] = [];
  for (const g of groups) {
    if (typeof g !== "object" || g === null) continue;
    const rec = g as { dimensions?: { bucketName?: unknown }; sum?: { bytesUpload?: unknown; bytesDownload?: unknown } };
    const bucket = str(rec.dimensions?.bucketName);
    const up = num(rec.sum?.bytesUpload);
    const down = num(rec.sum?.bytesDownload);
    if (!bucket || up === null || down === null) continue;
    rows.push({ bucket, ingressBytes: Math.max(0, Math.round(up)), egressBytes: Math.max(0, Math.round(down)) });
  }
  return rows.sort((a, b) => b.ingressBytes + b.egressBytes - (a.ingressBytes + a.egressBytes));
}

export async function fetchR2Bandwidth(
  token: string,
  accountId: string,
  from: string,
  to: string,
  fetchImpl: GraphqlFetch = fetch,
): Promise<R2BandwidthSummary> {
  const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: R2_BANDWIDTH_QUERY,
      variables: { accountTag: accountId, startDate: `${from}T00:00:00Z`, endDate: `${to}T00:00:00Z` },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`r2 bandwidth request failed: ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: { r2BandwidthUsageAdaptiveGroups?: unknown }[] } };
    errors?: { message?: unknown }[];
  } | null;
  if (!body || !Array.isArray(body.errors) && !body.data) throw new Error("r2 bandwidth response was not a GraphQL envelope");
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0]?.message;
    throw new Error(`r2 bandwidth query failed: ${typeof first === "string" ? first.slice(0, 160) : "unknown error"}`);
  }
  const groups = body.data?.viewer?.accounts?.[0]?.r2BandwidthUsageAdaptiveGroups;
  const buckets = parseR2BandwidthGroups(groups);
  return {
    from,
    to,
    ingressBytes: buckets.reduce((s, b) => s + b.ingressBytes, 0),
    egressBytes: buckets.reduce((s, b) => s + b.egressBytes, 0),
    buckets,
  };
}

export function billableWindow(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - Math.min(Math.max(days, 1), 365) * 86400000);
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  return { from: day(from), to: day(to) };
}
