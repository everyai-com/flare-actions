/// <reference types="node" />
import { describe, expect, it } from "vitest";
import git from "isomorphic-git";
import { MemoryFS } from "./memory-fs";
import type { WhyNote } from "./intents-core";
import {
  createWhyNoteReader,
  readWhyNoteLocal,
  WHY_BRANCH,
  WHY_NOTES_REF,
  whyBranchPath,
  writeWhyNotes,
  type WhyNoteRepo,
  type WhyStorage,
} from "./provenance";
import { bareRemote, gitCli, harnessHttp, type BareRemote } from "./provenance-harness.test-util";

function note(intentId: string, extra: Partial<WhyNote> = {}): WhyNote {
  return {
    v: 1,
    goal: { id: "g1", text: "Rate-limit the login endpoint" },
    intent: { id: intentId, title: "Add limiter", reasoning: "brute force risk", accept: "npm test" },
    agent: "claude-1",
    session_repo: "i-abc",
    alternatives_rejected: ["global middleware"],
    evidence: { run_id: "run-1", sha: "a".repeat(40), status: "success" },
    conflict_decisions: [],
    review: { decision: "auto", by: "policy", policy: "risk 12 <= 30" },
    train_id: "t1",
    ...extra,
  };
}

const author = { name: "t", email: "t@t", timestamp: 1700000000, timezoneOffset: 0 };

async function localRepoWithCommits(n: number): Promise<{ fs: MemoryFS; dir: string; shas: string[] }> {
  const fs = new MemoryFS();
  const dir = "/repo";
  await git.init({ fs, dir, defaultBranch: "main" });
  const shas: string[] = [];
  let parent: string[] = [];
  for (let i = 0; i < n; i++) {
    const blob = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(`v${i}\n`) });
    const tree = await git.writeTree({ fs, dir, tree: [{ mode: "100644", path: "f.txt", oid: blob, type: "blob" }] });
    const sha = await git.writeCommit({ fs, dir, commit: { message: `c${i}\n`, tree, parent, author, committer: author } });
    shas.push(sha);
    parent = [sha];
  }
  await git.writeRef({ fs, dir, ref: "refs/heads/main", value: shas[shas.length - 1], force: true });
  return { fs, dir, shas };
}

// Seed a bare remote with N commits via the git CLI; return their shas.
function seedRemote(remote: BareRemote, n: number): string[] {
  const work = `${remote.root}/seed`;
  gitCli(remote.root, ["init", "-q", "-b", "main", work]);
  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    gitCli(work, ["commit", "-q", "--allow-empty", "-m", `c${i}`]);
    shas.push(gitCli(work, ["rev-parse", "HEAD"]).trim());
  }
  gitCli(work, ["push", "-q", remote.bare, "main"]);
  return shas;
}

async function trainRepo(remote: BareRemote, hooks: { beforeReceivePack?: () => void } = {}) {
  const fs = new MemoryFS();
  const dir = "/train";
  const http = harnessHttp(remote, hooks);
  await git.init({ fs, dir, defaultBranch: "main" });
  await git.addRemote({ fs, dir, remote: "origin", url: remote.url });
  await git.fetch({ fs, http, dir, remote: "origin", ref: "main", singleBranch: true });
  return { fs, dir, http, remoteOpt: { name: "origin", http, onAuth: () => ({ username: "x", password: "tok" }) } };
}

// WhyNoteRepo over the bare remote through the git CLI (stands in for
// the Artifacts binding: readFile by ref/path, first-parent log).
function cliRepo(remote: BareRemote): WhyNoteRepo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readFile({ ref, path }) {
      calls.push(`readFile ${ref} ${path}`);
      try {
        const text = gitCli(remote.bare, ["show", `${ref}:${path}`]);
        return { size: text.length, text: async () => text };
      } catch {
        return null;
      }
    },
    async log({ ref } = {}) {
      calls.push(`log ${ref}`);
      try {
        return [{ hash: gitCli(remote.bare, ["rev-parse", ref ?? "HEAD"]).trim() }];
      } catch {
        return [];
      }
    },
  };
}

describe("why notes: local round trip", () => {
  for (const strategy of ["notes", "branch"] as WhyStorage[]) {
    it(`${strategy}: writes, reads back, overwrites in place`, async () => {
      const { fs, dir, shas } = await localRepoWithCommits(3);
      const out = await writeWhyNotes(git, fs, dir, [
        { sha: shas[0], note: note("i0") },
        { sha: shas[2], note: note("i2") },
      ], { strategy });
      expect(out.written.sort()).toEqual([shas[0], shas[2]].sort());
      expect(out.pushed).toBe(false);
      expect(out.head).toMatch(/^[0-9a-f]{40}$/);
      expect((await readWhyNoteLocal(git, fs, dir, shas[0], strategy))?.intent.id).toBe("i0");
      expect(await readWhyNoteLocal(git, fs, dir, shas[1], strategy)).toBeNull();
      await writeWhyNotes(git, fs, dir, [{ sha: shas[0], note: note("i0b") }], { strategy });
      expect((await readWhyNoteLocal(git, fs, dir, shas[0], strategy))?.intent.id).toBe("i0b");
      // The earlier note for shas[2] survives the second commit.
      expect((await readWhyNoteLocal(git, fs, dir, shas[2], strategy))?.intent.id).toBe("i2");
    });
  }

  it("skips invalid shas and dedupes (last wins)", async () => {
    const { fs, dir, shas } = await localRepoWithCommits(1);
    const out = await writeWhyNotes(git, fs, dir, [
      { sha: "nope", note: note("x") },
      { sha: shas[0].toUpperCase(), note: note("first") },
      { sha: shas[0], note: note("second") },
    ]);
    expect(out.skipped).toEqual([{ sha: "nope", reason: "invalid-sha" }]);
    expect(out.written).toEqual([shas[0]]);
    expect((await readWhyNoteLocal(git, fs, dir, shas[0]))?.intent.id).toBe("second");
  });

  it("no entries is a no-op", async () => {
    const { fs, dir } = await localRepoWithCommits(1);
    const out = await writeWhyNotes(git, fs, dir, []);
    expect(out).toMatchObject({ written: [], head: null, attempts: 0 });
  });
});

describe("why notes: push to a real git remote", () => {
  it("notes: creates refs/notes/why, git CLI reads it, binding reader reads it", async () => {
    const remote = bareRemote();
    const shas = seedRemote(remote, 2);
    const t = await trainRepo(remote);
    const out = await writeWhyNotes(git, t.fs, t.dir, [{ sha: shas[1], note: note("i1") }], { remote: t.remoteOpt });
    expect(out.pushed).toBe(true);
    const shown = gitCli(remote.bare, ["notes", "--ref", "why", "show", shas[1]]);
    expect(JSON.parse(shown).intent.id).toBe("i1");
    // Second write updates the existing ref (fetch -> replay -> push).
    const t2 = await trainRepo(remote);
    await writeWhyNotes(git, t2.fs, t2.dir, [{ sha: shas[0], note: note("i0") }], { remote: t2.remoteOpt });
    expect(JSON.parse(gitCli(remote.bare, ["notes", "--ref", "why", "show", shas[0]])).intent.id).toBe("i0");
    expect(JSON.parse(gitCli(remote.bare, ["notes", "--ref", "why", "show", shas[1]])).intent.id).toBe("i1");

    const reader = createWhyNoteReader(cliRepo(remote), "auto");
    expect(await reader.read(shas[1])).toMatchObject({ source: "notes", note: { intent: { id: "i1" } } });
    expect(await reader.read("f".repeat(40))).toBeNull();
  });

  it("notes: a concurrent writer forces a refetch + replay; both notes survive", async () => {
    const remote = bareRemote();
    const shas = seedRemote(remote, 2);
    // Bootstrap the ref so both writers race on an existing ref.
    const boot = await trainRepo(remote);
    await writeWhyNotes(git, boot.fs, boot.dir, [{ sha: shas[0], note: note("boot") }], { remote: boot.remoteOpt });
    const rival = `${remote.root}/rival`;
    gitCli(remote.root, ["clone", "-q", remote.bare, rival]);
    gitCli(rival, ["fetch", "-q", "origin", `${WHY_NOTES_REF}:${WHY_NOTES_REF}`]);
    const t = await trainRepo(remote, {
      beforeReceivePack: () => {
        gitCli(rival, ["notes", "--ref", "why", "add", "-f", "-m", JSON.stringify(note("rival")), shas[0]]);
        gitCli(rival, ["push", "-q", "origin", WHY_NOTES_REF]);
      },
    });
    const out = await writeWhyNotes(git, t.fs, t.dir, [{ sha: shas[1], note: note("mine") }], { remote: t.remoteOpt });
    expect(out.pushed).toBe(true);
    expect(out.attempts).toBe(2);
    expect(JSON.parse(gitCli(remote.bare, ["notes", "--ref", "why", "show", shas[1]])).intent.id).toBe("mine");
    expect(JSON.parse(gitCli(remote.bare, ["notes", "--ref", "why", "show", shas[0]])).intent.id).toBe("rival");
  });

  it("branch: writes why/<sha>.json on flare/why; binding reader falls back to it", async () => {
    const remote = bareRemote();
    const shas = seedRemote(remote, 2);
    const t = await trainRepo(remote);
    const out = await writeWhyNotes(git, t.fs, t.dir, [{ sha: shas[1], note: note("b1") }], {
      strategy: "branch",
      remote: t.remoteOpt,
    });
    expect(out.pushed).toBe(true);
    expect(JSON.parse(gitCli(remote.bare, ["show", `${WHY_BRANCH}:${whyBranchPath(shas[1])}`])).intent.id).toBe("b1");
    const t2 = await trainRepo(remote);
    await writeWhyNotes(git, t2.fs, t2.dir, [{ sha: shas[0], note: note("b0") }], { strategy: "branch", remote: t2.remoteOpt });
    expect(JSON.parse(gitCli(remote.bare, ["show", `${WHY_BRANCH}:${whyBranchPath(shas[1])}`])).intent.id).toBe("b1");
    expect(gitCli(remote.bare, ["rev-list", "--count", WHY_BRANCH]).trim()).toBe("2");
    const auto = createWhyNoteReader(cliRepo(remote), "auto");
    expect(await auto.read(shas[0])).toMatchObject({ source: "branch", note: { intent: { id: "b0" } } });
    const notesOnly = createWhyNoteReader(cliRepo(remote), "notes");
    expect(await notesOnly.read(shas[0])).toBeNull();
  });
});

describe("binding reader", () => {
  it("finds fanned-out notes and treats corrupt notes as missing", async () => {
    const sha = "ab".repeat(20);
    const bad = "cd".repeat(20);
    const files = new Map<string, string>([
      [`tip:${sha.slice(0, 2)}/${sha.slice(2)}`, JSON.stringify(note("fan"))],
      [`tip:${bad}`, "{not json"],
    ]);
    const repo: WhyNoteRepo = {
      async readFile({ ref, path }) {
        const t = files.get(`${ref}:${path}`);
        return t === undefined ? null : { size: t.length, text: async () => t };
      },
      async log() {
        return [{ hash: "tip" }];
      },
    };
    const reader = createWhyNoteReader(repo, "notes");
    expect((await reader.read(sha))?.note.intent.id).toBe("fan");
    expect(await reader.read(bad)).toBeNull();
    expect(await reader.read("not-a-sha")).toBeNull();
  });
});
