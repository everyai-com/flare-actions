// full-git mode: push one tiny commit to the intent's fork with plain
// git (isomorphic-git over an in-memory FS in the Worker). The commit
// carries the Forge provenance trailers via the shipped appendTrailers.
// Injected git/http/fs keep this testable without a network.

import type { FsClient, HttpClient } from "isomorphic-git";
import { appendTrailers } from "../../../worker/src/intents-core.ts";

type Auth = () => { username: string; password: string };

// The isomorphic-git subset the harness uses (structural, so fakes fit).
export interface SimGit {
  clone(opts: {
    fs: FsClient;
    http: HttpClient;
    dir: string;
    url: string;
    ref?: string;
    singleBranch?: boolean;
    depth?: number;
    onAuth: Auth;
  }): Promise<unknown>;
  add(opts: { fs: FsClient; dir: string; filepath: string }): Promise<unknown>;
  commit(opts: { fs: FsClient; dir: string; message: string; author: { name: string; email: string } }): Promise<string>;
  push(opts: { fs: FsClient; http: HttpClient; dir: string; remote?: string; ref?: string; onAuth: Auth }): Promise<unknown>;
}

export interface WritableFs {
  promises: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<unknown>;
  };
}

export interface GitPushInput {
  remote: string;
  token: string;
  agent: string;
  intentId: string;
  goalId: string | null;
  path: string; // repo-relative file to write
  content: string;
  branch?: string;
}

export interface GitPusher {
  pushTinyChange(input: GitPushInput): Promise<{ sha: string }>;
}

export function createGitPusher(deps: { git: SimGit; http: HttpClient; fs: () => FsClient & WritableFs }): GitPusher {
  return {
    async pushTinyChange(input) {
      const fs = deps.fs();
      const dir = "/w";
      const onAuth: Auth = () => ({ username: "x", password: input.token });
      const ref = input.branch ?? "main";
      await deps.git.clone({ fs, http: deps.http, dir, url: input.remote, ref, singleBranch: true, depth: 1, onAuth });
      const slash = input.path.lastIndexOf("/");
      if (slash > 0) await fs.promises.mkdir(`${dir}/${input.path.slice(0, slash)}`, { recursive: true });
      await fs.promises.writeFile(`${dir}/${input.path}`, input.content);
      await deps.git.add({ fs, dir, filepath: input.path });
      const message = appendTrailers(`sim: ${input.agent} touches ${input.path}`, {
        intent: input.intentId,
        agent: input.agent,
        ...(input.goalId ? { goal: input.goalId } : {}),
      });
      const sha = await deps.git.commit({
        fs,
        dir,
        message,
        author: { name: input.agent, email: `${input.agent}@sim.flare.invalid` },
      });
      await deps.git.push({ fs, http: deps.http, dir, remote: "origin", ref, onAuth });
      return { sha };
    },
  };
}

// Strip anything token-shaped from an error before it reaches counters.
export function redactGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/art_v2_\S+/g, "art_v2_[redacted]")
    .replace(/(https?:\/\/)[^@/\s]+@/g, "$1[redacted]@")
    .slice(0, 160);
}
