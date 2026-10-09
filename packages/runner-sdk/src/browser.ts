import { interpolateSecrets } from "./secrets.ts";

// Preview-URL templates for browser checks: `{branch}`, `{pr}`,
// `{sha}`, and `{short_sha}` resolve seat-side from the run row, so
// one pipeline verifies every PR's preview deploy (e.g.
// `https://app-git-{branch}.example.com`). `{{` and `}}` escape
// literal braces; `${{ secrets.NAME }}` placeholders pass through
// verbatim for the later secrets-interpolation pass (which runs after
// this one precisely so secret VALUES are never scanned).
//
// `{branch}` slugifies (runs of non-`[A-Za-z0-9_-]` collapse to one
// `-`, matching Vercel/Pages/Workers preview rules): branch names
// are fork-PR-author-controlled, and a raw branch could break out of
// the hostname (`?token=` + attacker host = secret exfil). `{pr}` is
// digits and SHAs are hex, so they substitute raw.
export const PREVIEW_URL_VARS = ["branch", "pr", "sha", "short_sha"] as const;
export type PreviewUrlVar = (typeof PREVIEW_URL_VARS)[number];

export interface PreviewUrlContext {
  branch: string;
  prNumber: number | null;
  sha: string;
}

export function slugBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function varValue(name: string, ctx: PreviewUrlContext): { value: string } | { error: string } {
  switch (name) {
    case "branch": {
      if (!ctx.branch) return { error: 'preview URL uses {branch} but the run has no branch (tag/schedule/dispatch runs often do not)' };
      return { value: slugBranch(ctx.branch) };
    }
    case "pr":
      return ctx.prNumber !== null && ctx.prNumber !== undefined
        ? { value: String(ctx.prNumber) }
        : { error: 'preview URL uses {pr} but the run has no pull request number' };
    case "sha":
      return ctx.sha ? { value: ctx.sha } : { error: 'preview URL uses {sha} but the run has no SHA' };
    case "short_sha":
      return ctx.sha ? { value: ctx.sha.slice(0, 7) } : { error: 'preview URL uses {short_sha} but the run has no SHA' };
    default:
      return { error: `unknown preview URL variable {${name}} (want one of: ${PREVIEW_URL_VARS.map((v) => `{${v}}`).join(", ")})` };
  }
}

export function resolvePreviewTemplate(url: string, ctx: PreviewUrlContext): { url: string } | { error: string } {
  let out = "";
  let i = 0;
  while (i < url.length) {
    const ch = url[i];
    if (ch === "{") {
      // A secrets placeholder (`${{ ... }}`) passes through verbatim
      // for interpolateSecrets: the `$` was already emitted, so rewind
      // it and copy the whole placeholder untouched.
      if (url[i + 1] === "{" && out.endsWith("$")) {
        const close = url.indexOf("}}", i + 2);
        if (close === -1) return { error: `malformed preview URL: unterminated secrets placeholder near ${JSON.stringify(url.slice(Math.max(0, i - 10), i + 20))}` };
        out = out.slice(0, -1) + url.slice(i - 1, close + 2);
        i = close + 2;
        continue;
      }
      if (url[i + 1] === "{") {
        out += "{";
        i += 2;
        continue;
      }
      const end = url.indexOf("}", i + 1);
      if (end === -1) return { error: `malformed preview URL: unterminated { near ${JSON.stringify(url.slice(i, i + 20))}` };
      const name = url.slice(i + 1, end);
      const value = varValue(name, ctx);
      if ("error" in value) return value;
      out += value.value;
      i = end + 1;
      continue;
    }
    if (ch === "}") {
      if (url[i + 1] === "}") {
        out += "}";
        i += 2;
        continue;
      }
      return { error: `malformed preview URL: lone } near ${JSON.stringify(url.slice(Math.max(0, i - 10), i + 10))}` };
    }
    out += ch;
    i += 1;
  }
  return { url: out };
}

// Parse-time shape check (pipeline.ts, spec.ts): resolve against dummy
// context so only structural errors (unknown vars, malformed braces)
// surface — empty-run-context errors cannot fire on dummies.
export function validatePreviewTemplate(url: string): string | null {
  const r = resolvePreviewTemplate(url, { branch: "branch", prNumber: 1, sha: "sha" });
  return "error" in r ? r.error : null;
}

// Seat-side final resolution: placeholders, then secrets (values are
// never scanned), then the resolved URL re-validates https-only like
// parse time. Secrets placeholders must be well-formed — a typo fails
// the file at parse, never renders half a credential into a URL.
export function resolveCheckUrl(
  template: string,
  ctx: PreviewUrlContext,
  secrets: Record<string, string>,
): { url: string } | { error: string } {
  const resolved = resolvePreviewTemplate(template, ctx);
  if ("error" in resolved) return resolved;
  const finalUrl = interpolateSecrets(resolved.url, secrets);
  try {
    if (new URL(finalUrl).protocol !== "https:") {
      return { error: `resolved check URL is not https: ${finalUrl.slice(0, 120)}` };
    }
  } catch {
    return { error: `resolved check URL does not parse: ${finalUrl.slice(0, 120)}` };
  }
  return { url: finalUrl };
}
