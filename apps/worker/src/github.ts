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
