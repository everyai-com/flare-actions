export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // timingSafeEqual exists in the Workers runtime; fall back to a
  // constant-time loop elsewhere (Node tests, local tooling).
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  const a = new Uint8Array(aHex.match(/[\da-f]{2}/gi)?.map((h) => parseInt(h, 16)) ?? []);
  const b = new Uint8Array(bHex.match(/[\da-f]{2}/gi)?.map((h) => parseInt(h, 16)) ?? []);
  return bytesEqual(a, b);
}

export async function verifyGitHubSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const actual = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(actual, expected);
}

function base64UrlEncode(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function mintAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function getInstallationToken(
  jwt: string,
  installationId: number,
): Promise<string | null> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "flare-actions",
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { token?: string };
  return data.token ?? null;
}

// Resolve a branch or tag to its head SHA (heads first, then tags).
// Ref segments are encoded individually so feature/foo style branches
// survive; returns null when the ref does not exist or is unreadable.
export async function resolveRefToSha(
  token: string | null,
  repo: string,
  ref: string,
): Promise<string | null> {
  const encoded = ref
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "flare-actions",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const ns of ["heads", "tags"]) {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/refs/${ns}/${encoded}`, {
      headers,
    });
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as { object?: { sha?: unknown } } | null;
    if (data?.object && typeof data.object.sha === "string" && /^[0-9a-f]{4,64}$/i.test(data.object.sha)) {
      return data.object.sha;
    }
  }
  return null;
}

export async function postCommitStatus(
  token: string,
  repo: string,
  sha: string,
  state: "pending" | "success" | "failure" | "error",
  targetUrl?: string,
): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "flare-actions",
    },
    body: JSON.stringify({
      state,
      context: "flare-actions",
      target_url: targetUrl,
    }),
  });
  return res.ok;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "flare-actions",
  };
}

async function githubJson(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: githubHeaders(token),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// Blob paths at a commit (recursive tree, truncated): the file menu
// the heal model picks repair targets from. Empty on any failure —
// healing degrades to triage-plus-tail context, never throws.
export async function getRepoTreePaths(token: string, repo: string, sha: string, limit = 300): Promise<string[]> {
  const data = (await githubJson(token, `/repos/${repo}/git/trees/${sha}?recursive=1`)) as {
    tree?: { path?: unknown; type?: unknown }[];
    truncated?: unknown;
  } | null;
  if (!data || !Array.isArray(data.tree)) return [];
  const out: string[] = [];
  for (const entry of data.tree) {
    if (out.length >= limit) break;
    if (entry?.type === "blob" && typeof entry.path === "string" && entry.path.length <= 200) out.push(entry.path);
  }
  return out;
}

export async function getDefaultBranch(token: string, repo: string): Promise<string> {
  const data = (await githubJson(token, `/repos/${repo}`)) as { default_branch?: unknown } | null;
  return typeof data?.default_branch === "string" && data.default_branch ? data.default_branch : "main";
}

export const MAX_CHANGED_FILES = 150;

function rawHeaders(token: string | null): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: "application/vnd.github+json",
    "User-Agent": "flare-actions",
  };
}

function filenameList(json: unknown): string[] {
  const list = Array.isArray(json) ? json : ((json as { files?: unknown } | null)?.files ?? []);
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const name = (entry as { filename?: unknown } | null)?.filename;
    if (typeof name === "string" && name) out.push(name);
  }
  return out;
}

// Recently merged PRs (number + merged_at), newest first, for merged-PR
// cost attribution. Closed PRs sorted by update, ≤3 pages of 100;
// stops at the first page older than `sinceIso`. Best-effort: any
// failure returns what was collected so far (possibly nothing).
export async function listMergedPulls(
  token: string,
  repo: string,
  sinceIso: string,
): Promise<{ number: number; mergedAt: string }[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  const out: { number: number; mergedAt: string }[] = [];
  for (let page = 1; page <= 3; page++) {
    let res: Response;
    try {
      res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return out;
    }
    if (!res.ok) return out;
    const json = (await res.json().catch(() => null)) as
      | { number?: unknown; merged_at?: unknown; updated_at?: unknown }[]
      | null;
    if (!Array.isArray(json) || json.length === 0) return out;
    let pageNewest = "";
    for (const pr of json) {
      if (typeof pr !== "object" || pr === null) continue;
      if (typeof pr.updated_at === "string" && pr.updated_at > pageNewest) pageNewest = pr.updated_at;
      if (typeof pr.number === "number" && typeof pr.merged_at === "string" && pr.merged_at >= sinceIso) {
        out.push({ number: pr.number, mergedAt: pr.merged_at });
      }
    }
    if (pageNewest && pageNewest < sinceIso) return out;
  }
  return out;
}

// One lane job's logs, bounded to 256 KiB (the endpoint 302s to a
// signed blob URL; fetch follows it and drops Authorization
// cross-origin per spec). Null on any failure — digest mirroring is
// best-effort, never fatal to the webhook.
export async function fetchJobLogDigest(token: string, repo: string, jobId: string): Promise<string | null> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(jobId)) return null;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 262144) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// Changed files for a run: push compare or PR file list, public-first
// then installation token. Bounded and best-effort — an empty array
// means "unknown", never "no changes", so callers (paths filters) must
// treat it as unfilterable rather than as an empty change set.
export async function fetchChangedFiles(
  repo: string,
  input: { before?: string; after?: string; prNumber?: number | null },
  installationToken: string | null,
): Promise<string[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return [];
  let path: string;
  if (input.prNumber) {
    path = `/repos/${repo}/pulls/${input.prNumber}/files?per_page=100`;
  } else if (input.before && input.after && /^[0-9a-f]{7,40}$/.test(input.before) && !/^0+$/.test(input.before)) {
    path = `/repos/${repo}/compare/${input.before}...${input.after}`;
  } else {
    return [];
  }
  const attempts: (string | null)[] = installationToken ? [installationToken, null] : [null];
  for (const token of attempts) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: rawHeaders(token),
        signal: AbortSignal.timeout(5000),
      });
      // Unknown ref/PR is definitive; other failures try the next credential.
      if (res.status === 404 || res.status === 409 || res.status === 422) return [];
      if (!res.ok) continue;
      const json: unknown = await res.json().catch(() => null);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const name of filenameList(json)) {
        if (out.length >= MAX_CHANGED_FILES) break;
        const file = name.trim();
        if (file && file.length <= 200 && !seen.has(file)) {
          seen.add(file);
          out.push(file);
        }
      }
      return out;
    } catch {
      continue;
    }
  }
  return [];
}

// Commit full-file replacements to a NEW branch via the Git Data API
// (base tree → blobs → tree → commit → ref). Never touches an
// existing branch: the heal branch name is unique per run.
export async function commitFilesToNewBranch(
  token: string,
  repo: string,
  baseSha: string,
  branch: string,
  files: { path: string; content: string }[],
  message: string,
): Promise<boolean> {
  if (files.length === 0) return false;
  const base = (await githubJson(token, `/repos/${repo}/git/commits/${baseSha}`)) as {
    tree?: { sha?: unknown };
  } | null;
  const baseTree = base?.tree && typeof base.tree.sha === "string" ? base.tree.sha : null;
  if (!baseTree) return false;
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const file of files) {
    const blob = (await githubJson(token, `/repos/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
    })) as { sha?: unknown } | null;
    if (!blob || typeof blob.sha !== "string") return false;
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = (await githubJson(token, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree }),
  })) as { sha?: unknown } | null;
  if (!newTree || typeof newTree.sha !== "string") return false;
  const commit = (await githubJson(token, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
  })) as { sha?: unknown } | null;
  if (!commit || typeof commit.sha !== "string") return false;
  const ref = (await githubJson(token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })) as { ref?: unknown } | null;
  return !!ref && typeof ref.ref === "string";
}

// Draft PR for a heal branch (human review is mandatory — heals never
// merge themselves). Returns the PR URL, or null when the PR API
// refuses (missing scope, branch collision, rate limit).
export async function openDraftPullRequest(
  token: string,
  repo: string,
  base: string,
  head: string,
  title: string,
  body: string,
): Promise<string | null> {
  const data = (await githubJson(token, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body, draft: true }),
  })) as { html_url?: unknown } | null;
  return typeof data?.html_url === "string" ? data.html_url : null;
}

// Ephemeral JIT runner for GitHub runner mode (`runs-on: flare`):
// GitHub mints a single-job configuration the official actions/runner
// binary consumes via --jitconfig (expires after 1 hour). The returned
// runner id lets a stale claim delete the orphaned registration before
// requeueing, so a dead machine cannot double-run the job later.
export async function generateJitConfig(
  token: string,
  repo: string,
  input: { name: string; labels: string[]; runnerGroupId?: number },
): Promise<{ runnerId: number; jitConfig: string } | null> {
  const data = (await githubJson(token, `/repos/${repo}/actions/runners/generate-jitconfig`, {
    method: "POST",
    body: JSON.stringify({ name: input.name, runner_group_id: input.runnerGroupId ?? 1, labels: input.labels }),
  })) as { runner?: { id?: unknown }; encoded_jit_config?: unknown } | null;
  if (!data || typeof data.encoded_jit_config !== "string" || !data.encoded_jit_config) return null;
  const runnerId = typeof data.runner?.id === "number" ? data.runner.id : 0;
  return { runnerId, jitConfig: data.encoded_jit_config };
}

// Resolve an org runner group name to its id (JIT registration pins
// it). Exact match, first 100 groups; null when missing or on any API
// failure — callers fail the claim loudly rather than landing the
// runner in the wrong group.
export async function resolveRunnerGroupId(token: string, org: string, name: string): Promise<number | null> {
  if (!/^[\w.-]+$/.test(org) || !name) return null;
  const data = (await githubJson(token, `/orgs/${org}/actions/runner-groups?per_page=100`)) as {
    runner_groups?: { id?: unknown; name?: unknown }[];
  } | null;
  if (!data || !Array.isArray(data.runner_groups)) return null;
  for (const g of data.runner_groups) {
    if (typeof g === "object" && g !== null && g.name === name && typeof g.id === "number") return g.id;
  }
  return null;
}

// Merge queue: fold the base branch into the PR (the queue's "rebase
// onto current head") and merge the PR on green. Both best-effort —
// false/null parks the entry visibly, never throws.
export async function updatePullRequestBranch(token: string, repo: string, pr: number): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/update-branch`, {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify({}),
    });
    // 422 = already up to date or unmergeable; the verify-then-land
    // checks decide, so only transport success counts here.
    return res.ok;
  } catch {
    return false;
  }
}

export async function mergePullRequest(
  token: string,
  repo: string,
  pr: number,
  headSha: string,
): Promise<{ merged: boolean; detail: string }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/merge`, {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify({ sha: headSha, merge_method: "merge" }),
    });
    const data = (await res.json().catch(() => null)) as { merged?: unknown; message?: unknown } | null;
    if (res.ok && data?.merged === true) return { merged: true, detail: `PR #${pr} merged` };
    const detail = typeof data?.message === "string" && data.message ? data.message.slice(0, 200) : `merge rejected (HTTP ${res.status})`;
    return { merged: false, detail };
  } catch {
    return { merged: false, detail: "merge call failed" };
  }
}

export async function deleteRunner(token: string, repo: string, runnerId: number): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runners/${runnerId}`, {
      method: "DELETE",
      headers: githubHeaders(token),
    });
    // 404 means it is already gone — a success for cleanup purposes.
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
