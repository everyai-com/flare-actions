// Remote dev boxes: the same DevboxOps surface as the local
// BoxManager, backed by the seats worker (`/v1/boxes` + `/v1/box/*`)
// instead of local docker. Sync walks the local tree into Files-based
// writes (no tar-over-exec); fetch writes server bytes straight to
// disk, or extracts a server tarball for directories.
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeTar, extractTar } from "flare-actions-runner-sdk";
import type { BoxSnapshot, BoxSummary, DevboxOps, ExecResult, FetchResult, SyncResult } from "./devbox.ts";
import { validateBoxName } from "./devbox.ts";

export const REMOTE_SYNC_MAX_FILES = 256;

export interface RemoteBoxDeps {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  untar?: (dir: string, data: Uint8Array) => Promise<void>;
  assertSafe?: (data: Uint8Array) => Promise<void>;
}

interface RemoteBoxSnapshotJson {
  tag: string;
  snapshotId: string;
  createdAt: string;
}

interface RemoteBoxJson {
  name: string;
  container: string;
  image: string;
  workdir: string;
  createdAt: string;
  lastUsedAt: string;
  snapshots: RemoteBoxSnapshotJson[];
}

function toSummary(box: RemoteBoxJson): BoxSummary {
  return {
    name: box.name,
    container: box.container,
    image: box.image,
    workdir: box.workdir,
    createdAt: box.createdAt,
    snapshots: box.snapshots.map((s): BoxSnapshot => ({ tag: s.tag, createdAt: s.createdAt })),
  };
}

function needRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`remote devbox ${what}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function needString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`remote devbox ${what}: expected string ${key}`);
  return value;
}

// Regular files under dir for the requested workdir-relative paths,
// sorted for deterministic batches. Symlinks, sockets, and friends
// are skipped: the server writes plain files only, and a dangling
// link must never fail a whole sync.
function collectSyncFiles(dir: string, paths: string[]): { rel: string; abs: string }[] {
  const root = resolve(dir);
  const out: { rel: string; abs: string }[] = [];
  const seen = new Set<string>();
  const visit = (abs: string): void => {
    // lstat, not stat: a symlink must be seen as a link (skipped
    // below), not followed into its target's content.
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) visit(join(abs, entry));
      return;
    }
    if (!st.isFile()) return;
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel || rel.startsWith("../")) return;
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push({ rel, abs });
  };
  for (const p of paths) {
    if (!p || p === ".") {
      visit(root);
      continue;
    }
    if (p.startsWith("/") || p.split("/").some((seg) => seg === "..")) {
      throw new Error(`refusing to sync ${JSON.stringify(p)}: must stay inside ${dir}`);
    }
    visit(join(root, p));
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

export class RemoteBoxManager implements DevboxOps {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly untar: (dir: string, data: Uint8Array) => Promise<void>;
  private readonly assertSafe: (data: Uint8Array) => Promise<void>;

  constructor(deps: RemoteBoxDeps) {
    // Local names validate client-side so typos fail before any HTTP;
    // the server re-validates (BoxError 400) since HTTP is untrusted.
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.untar = deps.untar ?? ((dir, data) => extractTar(dir, data));
    this.assertSafe = deps.assertSafe ?? ((data) => assertSafeTar(data));
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): RemoteBoxManager {
    const baseUrl = env["SEATS_URL"];
    const token = env["SEATS_TOKEN"];
    if (!baseUrl || !token) {
      throw new Error("remote dev boxes need SEATS_URL and SEATS_TOKEN (run `npm run setup` with the seats worker, or set them by hand)");
    }
    return new RemoteBoxManager({ baseUrl, token });
  }

  private async call(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/box/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`remote devbox ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = payload && typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
      throw new Error(`remote devbox ${op} failed: ${detail}`);
    }
    return needRecord(payload, op);
  }

  async list(): Promise<BoxSummary[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/boxes`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new Error(`remote devbox list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const payload = (await res.json().catch(() => null)) as { boxes?: RemoteBoxJson[] } | null;
    if (!res.ok || !payload || !Array.isArray(payload.boxes)) {
      const detail = payload && typeof (payload as Record<string, unknown>).error === "string" ? (payload as Record<string, unknown>).error : `HTTP ${res.status}`;
      throw new Error(`remote devbox list failed: ${detail}`);
    }
    return payload.boxes.map(toSummary);
  }

  async create(name: string, opts?: { image?: string }): Promise<BoxSummary> {
    validateBoxName(name);
    const res = await this.call("create", { name, ...(opts?.image !== undefined ? { image: opts.image } : {}) });
    return toSummary(needRecord(res["box"], "create") as unknown as RemoteBoxJson);
  }

  async exec(name: string, cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult> {
    validateBoxName(name);
    if (cmd.length === 0) throw new Error("devbox exec needs a command");
    const res = await this.call("exec", {
      name,
      command: cmd,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.env !== undefined ? { env: opts.env } : {}),
    });
    const exitCode = res["exitCode"];
    if (typeof exitCode !== "number") throw new Error("remote devbox exec: expected numeric exitCode");
    let stderr = needString(res, "stderr", "exec");
    if (res["timedOut"] === true) {
      stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}[exec timed out after 10 minutes]\n`;
    }
    return {
      exitCode,
      stdout: needString(res, "stdout", "exec"),
      stderr,
      truncated: res["truncated"] === true,
    };
  }

  async sync(name: string, dir: string, paths: string[]): Promise<SyncResult> {
    validateBoxName(name);
    const collected = collectSyncFiles(dir, paths);
    if (collected.length === 0) throw new Error(`nothing to sync under ${dir} (no regular files matched)`);
    if (collected.length > REMOTE_SYNC_MAX_FILES) {
      throw new Error(`too many files to sync (${collected.length} > ${REMOTE_SYNC_MAX_FILES}); narrow the paths`);
    }
    const res = await this.call("sync", {
      name,
      files: collected.map((f) => ({ path: f.rel, content_b64: Buffer.from(readFileSync(f.abs)).toString("base64") })),
    });
    const bytes = res["bytes"];
    const resPaths = res["paths"];
    if (typeof bytes !== "number" || !Array.isArray(resPaths) || !resPaths.every((p) => typeof p === "string")) {
      throw new Error("remote devbox sync: malformed response");
    }
    return { bytes, paths: resPaths as string[] };
  }

  async fetch(name: string, containerPath: string, dir: string): Promise<FetchResult> {
    validateBoxName(name);
    if (!containerPath || containerPath.startsWith("/") || containerPath.split("/").some((seg) => seg === "..")) {
      throw new Error(`refusing to fetch ${JSON.stringify(containerPath)}: must stay inside the box workdir`);
    }
    const res = await this.call("fetch", { name, path: containerPath });
    const kind = res["kind"];
    const content = res["content_b64"];
    const bytes = res["bytes"];
    if ((kind !== "file" && kind !== "tarball") || typeof content !== "string" || typeof bytes !== "number") {
      throw new Error("remote devbox fetch: malformed response");
    }
    const data = new Uint8Array(Buffer.from(content, "base64"));
    const root = resolve(dir);
    if (kind === "tarball") {
      await this.assertSafe(data);
      await this.untar(root, data);
      return { bytes, path: containerPath };
    }
    // The pre-call guard above pins containerPath inside the workdir,
    // so this join cannot escape root.
    const dest = resolve(root, containerPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    return { bytes, path: containerPath };
  }

  async snapshot(name: string, tag?: string): Promise<BoxSnapshot> {
    validateBoxName(name);
    const res = await this.call("snapshot", { name, ...(tag !== undefined ? { tag } : {}) });
    const snap = needRecord(res["snapshot"], "snapshot");
    return { tag: needString(snap, "tag", "snapshot"), createdAt: needString(snap, "createdAt", "snapshot") };
  }

  async restore(name: string, tag: string): Promise<BoxSummary> {
    validateBoxName(name);
    const res = await this.call("restore", { name, tag });
    return toSummary(needRecord(res["box"], "restore") as unknown as RemoteBoxJson);
  }

  async destroy(name: string): Promise<{ name: string; imagesKept: string[] }> {
    validateBoxName(name);
    const res = await this.call("destroy", { name });
    const snapshots = res["snapshots"];
    if (!Array.isArray(snapshots) || !snapshots.every((s) => typeof s === "string")) {
      throw new Error("remote devbox destroy: malformed response");
    }
    // No snapshot delete exists remotely: tags persist per platform
    // retention, reported as kept like local committed images.
    return { name, imagesKept: snapshots as string[] };
  }
}
