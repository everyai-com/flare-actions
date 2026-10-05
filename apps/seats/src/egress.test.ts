import { describe, expect, it } from "vitest";
import { OTHER_DOMAINS_HOST, parseEgressLog } from "./egress";

describe("parseEgressLog", () => {
  it("attributes bytes to resolved hostnames", () => {
    const rows = parseEgressLog(
      ["DNS 93.184.216.34 example.com", "OUT 93.184.216.34 120", "IN 93.184.216.34 4567", "OUT 93.184.216.34 30"].join("\n"),
    );
    expect(rows).toEqual([{ host: "example.com", reqBytes: 150, respBytes: 4567 }]);
  });

  it("is order-free and buckets unknown IPs", () => {
    const rows = parseEgressLog(["OUT 10.0.0.9 50", "IN 10.0.0.9 60", "DNS 10.0.0.9 Late.Name.COM."].join("\n"));
    // Trailing-dot FQDNs normalize; mapping applies regardless of order.
    expect(rows).toEqual([{ host: "late.name.com", reqBytes: 50, respBytes: 60 }]);
    expect(parseEgressLog("OUT 10.0.0.10 5\n")).toEqual([{ host: "ip:10.0.0.10", reqBytes: 5, respBytes: 0 }]);
  });

  it("keeps the first hostname per IP and drops invalid names", () => {
    const rows = parseEgressLog(
      ["DNS 1.1.1.1 one.example", "DNS 1.1.1.1 two.example", "DNS 2.2.2.2 'not a host'", "OUT 1.1.1.1 1", "OUT 2.2.2.2 2"].join(
        "\n",
      ),
    );
    expect(rows.map((r) => r.host).sort()).toEqual(["ip:2.2.2.2", "one.example"]);
  });

  it("ignores malformed lines and non-positive counts", () => {
    const rows = parseEgressLog(
      ["garbage", "OUT 1.1.1.1", "OUT 1.1.1.1 nope", "OUT 1.1.1.1 -5", "OUT 1.1.1.1 0", "SIDEWAYS 1.1.1.1 5", ""].join("\n"),
    );
    expect(rows).toEqual([]);
  });

  it("sorts by bytes desc and caps the tail in (other-domains)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(`DNS 10.1.0.${i % 250} h${i}.example`, `IN 10.1.0.${i % 250} ${1000 + i}`);
    }
    const rows = parseEgressLog(lines.join("\n"));
    expect(rows).toHaveLength(200);
    expect(rows[0].respBytes).toBe(1249);
    const other = rows[rows.length - 1];
    expect(other.host).toBe(OTHER_DOMAINS_HOST);
    expect(other.respBytes).toBeGreaterThan(0);
  });

  it("never throws on hostile input", () => {
    // NUL IPs die on the charset check; huge counts clamp int64-safe.
    expect(parseEgressLog("DNS ${x} ../../etc\nOUT \u0000 99999999999999999999999\n")).toEqual([]);
    expect(parseEgressLog("OUT 1.1.1.1 99999999999999999999999\n")).toEqual([
      { host: "ip:1.1.1.1", reqBytes: Number.MAX_SAFE_INTEGER, respBytes: 0 },
    ]);
    expect(parseEgressLog("x".repeat(3 * 1024 * 1024))).toEqual([]);
  });
});
