/// <reference types="node" />
// Test fixture for Forge trains/replay (imported only by *.test.ts):
// real bare git repos on local disk served to isomorphic-git through
// `git http-backend` invoked as CGI per request (an in-process HTTP
// fake: no sockets, no network), an Artifacts binding fake backed by
// the same repos, and a node:sqlite D1 shim with the real schema.
import type { HttpClient } from "isomorphic-git";
import type { Db } from "../db";
import { SCHEMA_STATEMENTS } from "../schema";
import type { TrainArtifacts, TrainRepoHandle } from "../train";

const cp = process.getBuiltinModule("node:child_process");
const nfs = process.getBuiltinModule("node:fs");
const os = process.getBuiltinModule("node:os");
const path = process.getBuiltinModule("node:path");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export function sqliteDb(): Db {
  const raw = new DatabaseSync(":memory:");
  for (const sql of SCHEMA_STATEMENTS) {
    try {
      raw.exec(sql);
    } catch {
      // A few statements are D1-only; the forge/run tables all apply.
    }
  }
  const db = {
    prepare(query: string) {
      const bound = (values: unknown[]) => {
        if (values.length > 100) throw new Error("D1: too many SQL variables");
        const params = values as (string | number | null)[];
        return {
          all: async <T,>() => ({ results: raw.prepare(query).all(...params) as T[] }),
          first: async <T,>() => (raw.prepare(query).get(...params) as T | undefined) ?? null,
          run: async () => {
            const info = raw.prepare(query).run(...params) as { changes?: unknown };
            return { meta: { changes: typeof info.changes === "number" ? info.changes : Number(info.changes ?? 0) } };
          },
        };
      };
      return { bind: (...values: unknown[]) => bound(values), ...bound([]) };
    },
  };
  // The shim implements the subset of D1 the forge modules use.
  return db as unknown as Db;
}

export interface TokenRecord {
  repo: string;
  scope: "read" | "write";
  token: string;
  id: string;
  revoked: boolean;
}

export interface GitFixture {
  root: string;
  http: HttpClient;
  remoteFor: (repo: string) => string;
  sh: (args: string[], cwd?: string) => string;
  createRepo: (name: string, files: Record<string, string>) => string;
  // Commit file changes (null deletes) on `branch` of a bare repo; returns the sha.
  commit: (repo: string, files: Record<string, string | null>, message: string, branch?: string) => string;
  head: (repo: string, ref?: string) => string | null;
  show: (repo: string, ref: string, file: string) => string | null;
  log: (repo: string, ref?: string) => string[];
  messages: (repo: string, ref?: string) => string[];
  fork: (src: string, dst: string) => void;
  artifacts: TrainArtifacts;
  tokens: TokenRecord[];
  requests: Array<{ repo: string; service: string }>;
  cleanup: () => void;
}

async function collect(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

export function gitFixture(): GitFixture {
  const root = nfs.mkdtempSync(path.join(os.tmpdir(), "forge-train-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@test", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@test", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  const sh = (args: string[], cwd?: string): string => cp.execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const bare = (repo: string): string => path.join(root, `${repo}.git`);
  const requests: Array<{ repo: string; service: string }> = [];

  const http: HttpClient = {
    async request({ url, method = "GET", headers = {}, body }) {
      const u = new URL(url);
      const input = await collect(body);
      const pathInfo = u.pathname.replace(/^\/git/, "");
      const m = /^\/([^/]+)\.git\/(.*)$/.exec(pathInfo);
      requests.push({ repo: m?.[1] ?? "?", service: `${method} ${m?.[2] ?? ""}${u.search}` });
      const cgiEnv = {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: method,
        QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: headers["content-type"] ?? headers["Content-Type"] ?? "",
        CONTENT_LENGTH: String(input.length),
        REMOTE_USER: "train",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.receivepack",
        GIT_CONFIG_VALUE_0: "true",
      };
      const out = await new Promise<Buffer>((resolve, reject) => {
        const p = cp.spawn("git", ["http-backend"], { env: cgiEnv });
        const chunks: Buffer[] = [];
        p.stdout.on("data", (c: Buffer) => chunks.push(c));
        p.stderr.on("data", () => undefined);
        p.on("error", reject);
        p.on("close", () => resolve(Buffer.concat(chunks)));
        p.stdin.end(input);
      });
      const sep = out.indexOf("\r\n\r\n");
      const head = sep >= 0 ? out.subarray(0, sep).toString() : "";
      const rest = sep >= 0 ? out.subarray(sep + 4) : out;
      const h: Record<string, string> = {};
      let status = 200;
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") status = parseInt(v, 10);
        else h[k] = v;
      }
      return { url, method, statusCode: status, statusMessage: status === 200 ? "OK" : "ERR", headers: h, body: [new Uint8Array(rest)] };
    },
  };

  let workN = 0;
  const commit = (repo: string, files: Record<string, string | null>, message: string, branch = "main"): string => {
    const work = path.join(root, `work-${workN++}`);
    sh(["clone", "-q", bare(repo), work]);
    const branches = sh(["branch", "-r"], work);
    if (branches.includes(`origin/${branch}`)) sh(["checkout", "-q", branch], work);
    else sh(["checkout", "-q", "-b", branch], work);
    for (const [file, content] of Object.entries(files)) {
      const p = path.join(work, file);
      if (content === null) nfs.rmSync(p, { force: true });
      else {
        nfs.mkdirSync(path.dirname(p), { recursive: true });
        nfs.writeFileSync(p, content);
      }
    }
    sh(["add", "-A"], work);
    sh(["commit", "-q", "--allow-empty", "-m", message], work);
    sh(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], work);
    const sha = sh(["rev-parse", "HEAD"], work);
    nfs.rmSync(work, { recursive: true, force: true });
    return sha;
  };

  const createRepo = (name: string, files: Record<string, string>): string => {
    sh(["init", "-q", "--bare", "-b", "main", bare(name)]);
    return commit(name, files, "seed");
  };

  const head = (repo: string, ref = "main"): string | null => {
    try {
      return sh(["--git-dir", bare(repo), "rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    } catch {
      return null;
    }
  };

  const show = (repo: string, ref: string, file: string): string | null => {
    try {
      return cp.execFileSync("git", ["--git-dir", bare(repo), "show", `${ref}:${file}`], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };

  const log = (repo: string, ref = "main"): string[] => sh(["--git-dir", bare(repo), "log", "--format=%H", ref]).split("\n").filter(Boolean);
  const messages = (repo: string, ref = "main"): string[] =>
    sh(["--git-dir", bare(repo), "log", "--format=%B%x00", ref])
      .split("\u0000")
      .map((s) => s.trim())
      .filter(Boolean);

  const fork = (src: string, dst: string): void => {
    sh(["clone", "-q", "--bare", "--single-branch", "-b", "main", bare(src), bare(dst)]);
  };

  const tokens: TokenRecord[] = [];
  let tokenN = 0;
  const handle = (name: string): TrainRepoHandle => ({
    async fork(dst: string) {
      if (nfs.existsSync(bare(dst))) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
      if (!nfs.existsSync(bare(name))) throw new Error("no such repo");
      fork(name, dst);
      return { name: dst, remote: `http://git.test/git/${dst}.git`, defaultBranch: "main" };
    },
    async log(opts?: { ref?: string; limit?: number }) {
      const h = head(name, opts?.ref ?? "main");
      return h ? [{ hash: h }] : [];
    },
    async readTree() {
      return null;
    },
    async readCommit() {
      return null;
    },
    async createToken(scope: "read" | "write") {
      const token = `art_v2_${name}_${scope}_${++tokenN}`;
      tokens.push({ repo: name, scope, token, id: `tok-${tokenN}`, revoked: false });
      return { plaintext: token };
    },
    async readFile({ ref, path: file }: { ref: string; path: string }) {
      const text = show(name, ref, file);
      if (text === null) return null;
      return { size: text.length, text: async () => text };
    },
    async listTokens() {
      const live = tokens.filter((t) => t.repo === name && !t.revoked);
      return { total: live.length, tokens: live.map((t) => ({ id: t.id, scope: t.scope })) };
    },
    async revokeToken(id: string) {
      const t = tokens.find((x) => x.id === id && x.repo === name && !x.revoked);
      if (!t) return false;
      t.revoked = true;
      return true;
    },
  });
  const artifacts: TrainArtifacts = {
    async get(name: string) {
      if (!nfs.existsSync(bare(name))) throw new Error(`repo ${name} not found`);
      return handle(name);
    },
  };

  return {
    root,
    http,
    remoteFor: (repo) => `http://git.test/git/${repo}.git`,
    sh,
    createRepo,
    commit,
    head,
    show,
    log,
    messages,
    fork,
    artifacts,
    tokens,
    requests,
    cleanup: () => nfs.rmSync(root, { recursive: true, force: true }),
  };
}
