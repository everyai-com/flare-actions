import type { FlareCacheStats } from "flare-actions-runner-sdk";

// `cli cache stats`: the shared-warm-cache proof as text. Pure and
// unit-tested; the CLI fetches the stats, this module validates the
// payload shape and renders the one-line verdict plus per-scope rows.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Defensive parse of the /v1/cache/stats payload: servers drift, CLI
// output must not print "undefined%". Null on any shape mismatch.
export function parseCacheStats(data: unknown): FlareCacheStats | null {
  if (!isRecord(data)) return null;
  const { days, hits, misses, hitRate, scopes } = data;
  if (typeof days !== "number" || typeof hits !== "number" || typeof misses !== "number") return null;
  if (typeof hitRate !== "number" || !Array.isArray(scopes)) return null;
  const parsed: FlareCacheStats["scopes"] = [];
  for (const s of scopes) {
    if (!isRecord(s) || typeof s.scope !== "string") return null;
    if (typeof s.hits !== "number" || typeof s.misses !== "number" || typeof s.hitRate !== "number") return null;
    parsed.push({ scope: s.scope, hits: s.hits, misses: s.misses, hitRate: s.hitRate });
  }
  return { days, hits, misses, hitRate, scopes: parsed };
}

function pct(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return "0.0%";
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatCacheStats(stats: FlareCacheStats): string {
  const lines = [
    `cache hit rate (${stats.days}d): ${pct(stats.hitRate)} (${stats.hits} hits, ${stats.misses} misses)`,
  ];
  for (const s of stats.scopes) {
    lines.push(`  ${s.scope}: ${pct(s.hitRate)} (${s.hits} hits, ${s.misses} misses)`);
  }
  if (stats.scopes.length === 0) lines.push("  (no cache reads in the window)");
  return lines.join("\n");
}
