import { describe, expect, it } from "vitest";
import { LocalContainer, splitEnvForDocker, type LocalRunner, type LocalRunResult } from "./local-docker";

const enc = new TextEncoder();

// Fake docker CLI: records argv, answers run/wait/rm, and lets tests
// script exec children per command.
function fakeRunner(script: {
  runExit?: number;
  runStderr?: string;
  inspect?: { exitCode: number; stdout: string; stderr?: string };
  execs?: { exitCode: number; stdout: string; stderr?: string }[];
}): LocalRunner & { argv: string[][]; waited: string[] } {
  const argv: string[][] = [];
  const waited: string[] = [];
  const execs = [...(script.execs ?? [])];
  let waitResolve: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    waitResolve = resolve;
  });
  return {
    argv,
    waited,
    run: async (cmd, args): Promise<LocalRunResult> => {
      argv.push([cmd, ...args]);
      if (args[0] === "wait") {
        waited.push(args[1]);
        await gate;
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      if (args[0] === "run") return { exitCode: 0, stdout: "deadbeef\n", stderr: "" };
      if (args[0] === "inspect") {
        const i = script.inspect ?? { exitCode: 0, stdout: "true\n" };
        return { exitCode: i.exitCode, stdout: i.stdout, stderr: i.stderr ?? "" };
      }
      return { exitCode: script.runExit ?? 0, stdout: "", stderr: script.runStderr ?? "" };
    },
    spawn: (cmd, args, opts) => {
      argv.push([cmd, ...args]);
      const next = execs.shift() ?? { exitCode: 0, stdout: "" };
      void opts;
      return {
        pid: 4242,
        done: Promise.resolve({
          exitCode: next.exitCode,
          stdout: enc.encode(next.stdout),
          stderr: enc.encode(next.stderr ?? ""),
        }),
        kill: () => {
          waitResolve?.();
        },
      };
    },
  };
}

describe("splitEnvForDocker", () => {
  it("routes flat values to the env file and multiline values to argv", () => {
    const { file, argv } = splitEnvForDocker({ A: "1", KEY: "line1\nline2", "bad-name": "x" });
    expect(file).toEqual([["A", "1"]]);
    expect(argv).toEqual([
      ["KEY", "line1\nline2"],
      ["bad-name", "x"],
    ]);
  });
});

describe("LocalContainer", () => {
  it("starts detached with --rm and a unique name, execs in the instance", async () => {
    const runner = fakeRunner({ execs: [{ exitCode: 0, stdout: "hi\n" }] });
    const c = new LocalContainer("img:1", runner);
    await c.start();
    expect(c.running).toBe(true);
    expect(c.name).toMatch(/^flare-seat-local-/);
    const handle = await c.exec(["echo", "hi"]);
    const out = await handle.output();
    expect(out.exitCode).toBe(0);
    expect(new TextDecoder().decode(out.stdout)).toBe("hi\n");
    const run = runner.argv[0];
    expect(run.slice(0, 5)).toEqual(["docker", "run", "-d", "--rm", "--name"]);
    const exec = runner.argv.find((a) => a[1] === "exec");
    expect(exec).toBeDefined();
    expect(exec?.slice(-2)).toEqual(["echo", "hi"]);
    c.destroy();
  });

  it("passes flat env via --env-file and keeps multiline values on -e", async () => {
    const runner = fakeRunner({});
    const c = new LocalContainer("img:1", runner);
    await c.start({ env: { FLAT: "v", PEM: "a\nb" } });
    const run = runner.argv[0].join(" ");
    expect(run).toContain("--env-file");
    expect(run).toContain("-e PEM=a\nb");
    expect(run).not.toContain("-e FLAT=");
    c.destroy();
  });

  it("disables networking when enableInternet is false", async () => {
    const runner = fakeRunner({});
    const c = new LocalContainer("img:1", runner);
    await c.start({ enableInternet: false });
    expect(runner.argv[0].join(" ")).toContain("--network none");
    c.destroy();
  });

  it("rejects snapshot start and snapshot()", async () => {
    const runner = fakeRunner({});
    const c = new LocalContainer("img:1", runner);
    await expect(c.start({ snapshotId: "snap" })).rejects.toThrow("snapshots are unsupported");
    await expect(c.snapshot()).rejects.toThrow("snapshots are unsupported");
  });

  it("fails start loudly when docker run exits nonzero", async () => {
    const runner: LocalRunner & { argv: string[][] } = {
      argv: [],
      run: async (cmd, args) => {
        runner.argv.push([cmd, ...args]);
        return { exitCode: 125, stdout: "", stderr: "no such image" };
      },
      spawn: () => {
        throw new Error("must not spawn");
      },
    };
    const c = new LocalContainer("img:missing", runner);
    await expect(c.start()).rejects.toThrow("no such image");
    expect(c.running).toBe(false);
  });

  it("start accepts a fixed name and rejects invalid names", async () => {
    const runner = fakeRunner({});
    const c = new LocalContainer("img:1", runner);
    await c.start(undefined, "my-box_1.2");
    expect(c.name).toBe("my-box_1.2");
    expect(runner.argv[0]).toContain("my-box_1.2");
    c.destroy();
    const d = new LocalContainer("img:1", runner);
    await expect(d.start(undefined, "../evil")).rejects.toThrow("invalid container name");
  });

  it("attach reattaches to a running instance and execs in it", async () => {
    const runner = fakeRunner({
      inspect: { exitCode: 0, stdout: "true\n" },
      execs: [{ exitCode: 0, stdout: "reattached\n" }],
    });
    const c = new LocalContainer("img:1", runner);
    await c.attach("flare-devbox-demo");
    expect(c.running).toBe(true);
    const out = await (await c.exec(["hostname"])).output();
    expect(new TextDecoder().decode(out.stdout)).toBe("reattached\n");
    const exec = runner.argv.find((a) => a[1] === "exec");
    expect(exec).toContain("flare-devbox-demo");
    c.destroy();
  });

  it("attach rejects missing and stopped instances", async () => {
    const missing = fakeRunner({ inspect: { exitCode: 1, stdout: "", stderr: "No such object" } });
    await expect(new LocalContainer("img:1", missing).attach("gone")).rejects.toThrow("not available");
    const stopped = fakeRunner({ inspect: { exitCode: 0, stdout: "false\n" } });
    await expect(new LocalContainer("img:1", stopped).attach("stopped")).rejects.toThrow("not running");
  });

  it("spawns no waiter until monitor() is awaited (one-shot CLIs must exit)", async () => {
    const runner = fakeRunner({});
    const c = new LocalContainer("img:1", runner);
    await c.start();
    expect(runner.argv.some((a) => a[1] === "wait")).toBe(false);
    c.destroy();
    // Destroyed already: resolves without spawning anything.
    await c.monitor();
    expect(runner.argv.some((a) => a[1] === "wait")).toBe(false);
  });

  it("destroy removes the instance and monitor resolves", async () => {
    const runner = fakeRunner({});
    const c = new LocalContainer("img:1", runner);
    await c.start();
    const name = c.name;
    let stopped = false;
    const p = c.monitor().then(() => {
      stopped = true;
    });
    c.destroy();
    await p;
    expect(stopped).toBe(true);
    expect(c.running).toBe(false);
    expect(runner.argv.some((a) => a[1] === "rm" && a[2] === "-f" && a[3] === name)).toBe(true);
  });
});
