/// <reference types="node" />
// Test-only harness: a real git smart-HTTP remote for isomorphic-git,
// served in-process by spawning `git http-backend` (CGI) per request.
// Lets provenance/session tests push and fetch real refs without a
// network or a server.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

export function gitCli(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: tmpdir(),
    },
  });
}

export interface BareRemote {
  root: string;
  bare: string;
  url: string;
}

// A bare repo `remote.git` that accepts pushes over the harness.
export function bareRemote(): BareRemote {
  const root = mkdtempSync(join(tmpdir(), "flare-prov-"));
  const bare = join(root, "remote.git");
  gitCli(root, ["init", "-q", "--bare", "-b", "main", bare]);
  gitCli(bare, ["config", "http.receivepack", "true"]);
  return { root, bare, url: "http://harness.invalid/remote.git" };
}

async function collect(body: GitHttpRequest["body"]): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

export function harnessHttp(
  remote: BareRemote,
  hooks: { beforeReceivePack?: () => void } = {},
): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      const u = new URL(req.url);
      const input = await collect(req.body);
      if (u.pathname.endsWith("/git-receive-pack") && hooks.beforeReceivePack) {
        const hook = hooks.beforeReceivePack;
        hooks.beforeReceivePack = undefined;
        hook();
      }
      const out = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: remote.root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: u.pathname,
            QUERY_STRING: u.search.replace(/^\?/, ""),
            REQUEST_METHOD: req.method ?? "GET",
            CONTENT_TYPE: req.headers?.["content-type"] ?? req.headers?.["Content-Type"] ?? "",
            CONTENT_LENGTH: String(input.length),
            REMOTE_USER: "harness",
            REMOTE_ADDR: "127.0.0.1",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.on("error", reject);
        child.on("close", () => resolve(Buffer.concat(chunks)));
        child.stdin.end(input);
      });
      const sep = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, sep).toString("utf8");
      const body = out.subarray(sep + 4);
      const headers: Record<string, string> = {};
      let statusCode = 200;
      let statusMessage = "OK";
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") {
          statusCode = Number(v.split(" ")[0]);
          statusMessage = v.split(" ").slice(1).join(" ");
        } else headers[k] = v;
      }
      return {
        url: req.url,
        method: req.method,
        statusCode,
        statusMessage,
        headers,
        body: (async function* () {
          yield new Uint8Array(body);
        })(),
      };
    },
  };
}
