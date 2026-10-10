// Demo loop git: clone a fork (or trunk, for a replay), apply a reference
// solution in memory, commit with the Forge trailers, push to the fork.
// isomorphic-git + MemoryFS in production; the git/http/fs trio is
// injected so tests run with fakes (same shape as harness/git.ts).

import type { FsClient, HttpClient } from "isomorphic-git";
import { appendTrailers } from "../../../worker/src/intents-core.ts";
import { applyEdits, editPaths, type SolutionEdit } from "./scenario.ts";

type Auth = () => { username: string; password: string };

export interface DemoGitLib {
  clone(opts: { fs: FsClient; http: HttpClient; dir: string; url: string; ref?: string; singleBranch?: boolean; onAuth: Auth }): Promise<unknown>;
  add(opts: { fs: FsClient; dir: string; filepath: string }): Promise<unknown>;
  commit(opts: { fs: FsClient; dir: string; message: string; author: { name: string; email: string } }): Promise<string>;
  push(opts: { fs: FsClient; http: HttpClient; dir: string; url?: string; ref?: string; remoteRef?: string; force?: boolean; onAuth: Auth }): Promise<unknown>;
}

export interface DemoFs {
  promises: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<unknown>;
    readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string>;
  };
}

export interface CommitInput {
  cloneUrl: string;
  cloneToken: string;
  pushUrl: string;
  pushToken: string;
  force: boolean;
  edits: SolutionEdit[];
  append?: { path: string; text: string };
  summary: string;
  body: string;
  trailers: { intent: string; agent: string; goal?: string; session?: string };
}

export interface DemoGit {
  commitAndPush(input: CommitInput): Promise<{ sha: string; files: string[] }>;
}

export function createDemoGit(deps: { git: DemoGitLib; http: HttpClient; fs: () => FsClient & DemoFs }): DemoGit {
  return {
    async commitAndPush(input) {
      const fs = deps.fs();
      const dir = "/w";
      const auth = (token: string): Auth => () => ({ username: "x", password: token });
      await deps.git.clone({ fs, http: deps.http, dir, url: input.cloneUrl, ref: "main", singleBranch: true, onAuth: auth(input.cloneToken) });
      const paths = editPaths(input.edits);
      const before: Record<string, string> = {};
      for (const p of paths) {
        try {
          const data = await fs.promises.readFile(`${dir}/${p}`, "utf8");
          before[p] = typeof data === "string" ? data : new TextDecoder().decode(data);
        } catch {
          // absent: a create edit
        }
      }
      const after = applyEdits(before, input.edits);
      if (input.append) {
        let cur = after[input.append.path];
        if (cur === undefined) {
          try {
            const data = await fs.promises.readFile(`${dir}/${input.append.path}`, "utf8");
            cur = typeof data === "string" ? data : new TextDecoder().decode(data);
          } catch {
            cur = "";
          }
        }
        after[input.append.path] = cur + input.append.text;
      }
      const touched = Object.keys(after).sort();
      for (const p of touched) {
        const slash = p.lastIndexOf("/");
        if (slash > 0) await fs.promises.mkdir(`${dir}/${p.slice(0, slash)}`, { recursive: true });
        await fs.promises.writeFile(`${dir}/${p}`, after[p]);
        await deps.git.add({ fs, dir, filepath: p });
      }
      const message = appendTrailers(`${input.summary}\n\n${input.body}`, {
        intent: input.trailers.intent,
        agent: input.trailers.agent,
        ...(input.trailers.goal ? { goal: input.trailers.goal } : {}),
        ...(input.trailers.session ? { session: input.trailers.session } : {}),
      });
      const sha = await deps.git.commit({ fs, dir, message, author: { name: `flare-agent ${input.trailers.agent}`, email: `${input.trailers.agent}@flare.invalid` } });
      await deps.git.push({ fs, http: deps.http, dir, url: input.pushUrl, ref: "main", remoteRef: "main", force: input.force, onAuth: auth(input.pushToken) });
      return { sha, files: touched };
    },
  };
}

// Strip anything token-shaped from an error before it lands in status.
export function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/art_v\d+_\S+/g, "art_v_[redacted]")
    .replace(/(https?:\/\/)[^@/\s]+@/g, "$1[redacted]@")
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted]")
    .slice(0, 200);
}
