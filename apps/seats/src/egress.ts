// Per-domain egress: parsing for the LD_PRELOAD shim's log
// (apps/seats/egress.c). The shim appends tally lines to a
// container-side file; seats cat it at terminal accounting and merge
// the rows into job_egress alongside the r2:* and (interface) rows.
// Pure and total: malformed input yields fewer rows, never throws.
import type { EgressTally } from "./seat";

export const EGRESS_SHIM_PATH = "/opt/flare/egress.so";
export const EGRESS_LOG_PATH = "/tmp/flare-egress.log";

// Bounds: the log of a chatty job stays small, but a hostile or
// runaway step must not inflate D1 rows or memory.
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 20000;
const MAX_DNS_ENTRIES = 4096;
const MAX_DOMAINS = 199;
export const OTHER_DOMAINS_HOST = "(other-domains)";

function cleanHostname(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || name.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) return null;
  return name;
}

export function parseEgressLog(text: string): EgressTally[] {
  const dns = new Map<string, string>();
  const out = new Map<string, number>();
  const inbound = new Map<string, number>();
  const add = (m: Map<string, number>, ip: string, n: number): void => {
    if (m.size >= MAX_DNS_ENTRIES && !m.has(ip)) return;
    m.set(ip, (m.get(ip) ?? 0) + n);
  };
  const lines = text.slice(0, MAX_LOG_BYTES).split("\n");
  for (let i = 0; i < lines.length && i < MAX_LOG_LINES; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const [kind, ip, rest] = parts;
    // The log path is step-writable, so a hostile step could append
    // anything; IPs must look like inet_ntop output or the line dies.
    if (!/^[0-9a-fA-F.:]{1,64}$/.test(ip)) continue;
    if (kind === "DNS") {
      if (dns.size >= MAX_DNS_ENTRIES) continue;
      const name = cleanHostname(rest);
      // First mapping wins: re-resolution to another CDN name for
      // the same IP keeps the job's first-seen label, stable within
      // the run.
      if (name && !dns.has(ip)) dns.set(ip, name);
      continue;
    }
    const n = Number(rest);
    if ((kind !== "OUT" && kind !== "IN") || !Number.isInteger(n) || n <= 0) continue;
    if (kind === "OUT") add(out, ip, n);
    else add(inbound, ip, n);
  }
  const merged = new Map<string, EgressTally>();
  const ips = new Set([...out.keys(), ...inbound.keys()]);
  for (const ip of ips) {
    const host = dns.get(ip) ?? `ip:${ip}`;
    const row = merged.get(host) ?? { host, reqBytes: 0, respBytes: 0 };
    // Clamp to int64-safe: D1 INTEGERs top out at 2^63-1 and a lying
    // step must not break the egress INSERT.
    row.reqBytes = Math.min(Number.MAX_SAFE_INTEGER, row.reqBytes + (out.get(ip) ?? 0));
    row.respBytes = Math.min(Number.MAX_SAFE_INTEGER, row.respBytes + (inbound.get(ip) ?? 0));
    merged.set(host, row);
  }
  const rows = [...merged.values()].filter((r) => r.reqBytes > 0 || r.respBytes > 0);
  rows.sort((a, b) => b.respBytes - a.respBytes || b.reqBytes - a.reqBytes || (a.host < b.host ? -1 : 1));
  if (rows.length <= MAX_DOMAINS) return rows;
  const head = rows.slice(0, MAX_DOMAINS);
  const rest = rows.slice(MAX_DOMAINS);
  head.push({
    host: OTHER_DOMAINS_HOST,
    reqBytes: rest.reduce((s, r) => s + r.reqBytes, 0),
    respBytes: rest.reduce((s, r) => s + r.respBytes, 0),
  });
  return head;
}
