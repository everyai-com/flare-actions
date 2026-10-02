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
