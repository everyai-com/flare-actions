import type { TriageInput } from "./triage";

// Web Search grounding for triage (beta API, via the AI binding through AI
// Gateway — gatewayId is required). Best-effort by contract: any failure,
// missing binding, or missing gateway degrades to ungrounded triage, never
// to an error. Off by default (each search bills gateway credits); enabled
// per-deploy with the triage_web_search setting.

export interface WebSearchItem {
  url: string;
  title: string;
  description: string;
}

export interface WebSearchAi {
  websearch?(request: { gatewayId: string; query: string; limit?: number; provider?: string }): Promise<Response>;
}

export const WEB_SEARCH_MAX_LIMIT = 10;
export const WEB_SEARCH_CONTEXT_ITEMS = 3;

export async function webSearch(
  ai: WebSearchAi | undefined,
  gatewayId: string | undefined,
  query: string,
  limit = 5,
): Promise<WebSearchItem[]> {
  const id = gatewayId?.trim();
  const q = query.trim().slice(0, 1000);
  if (!ai || typeof ai.websearch !== "function" || !id || !q) return [];
  try {
    const res = await ai.websearch({ gatewayId: id, query: q, limit: Math.min(Math.max(limit, 1), WEB_SEARCH_MAX_LIMIT) });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: unknown };
    if (!data || !Array.isArray(data.items)) return [];
    const out: WebSearchItem[] = [];
    for (const item of data.items) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.url !== "string" || typeof rec.title !== "string") continue;
      out.push({
        url: rec.url.slice(0, 300),
        title: rec.title.slice(0, 200),
        description: typeof rec.description === "string" ? rec.description.slice(0, 400) : "",
      });
      if (out.length >= WEB_SEARCH_CONTEXT_ITEMS) break;
    }
    return out;
  } catch {
    return [];
  }
}

// The search query is the last error-looking line of the first failing
// step (error text grounds better than the command), falling back to the
// step's last line. Null when nothing failed or no output exists.
export function buildErrorQuery(input: TriageInput): string | null {
  const failing = input.steps.find((s) => s.exitCode !== 0);
  if (!failing) return null;
  const lines = failing.output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-15);
  if (lines.length === 0) return null;
  const hit = [...lines].reverse().find((l) => /error|fail|exception|panic|assert|E\d{3,4}|ERR_|cannot|missing/i.test(l));
  const q = (hit ?? lines[lines.length - 1]).replace(/\s+/g, " ").slice(0, 200);
  return q || null;
}

export function formatSearchContext(items: WebSearchItem[]): string {
  return items.map((it, i) => `${i + 1}. ${it.title}${it.description ? ` — ${it.description}` : ""} (${it.url})`).join("\n");
}
