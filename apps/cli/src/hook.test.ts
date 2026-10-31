import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_MARKER, chooseHookCommand, hookPath, hookScript, installHook, uninstallHook } from "./hook";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-hook-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("chooseHookCommand", () => {
  const none = { packageJson: null, flareYml: null };

  it("prefers explicit --run, then --profile", () => {
    expect(chooseHookCommand({ ...none, run: " make lint ", profile: "smoke" }).command).toBe("make lint");
    expect(chooseHookCommand({ ...none, profile: "smoke" }).command).toBe("npx flare-forge-cli local --profile smoke");
  });

  it("uses the repo's own fast loop before the pipeline", () => {
    const pkg = JSON.stringify({ scripts: { check: "node scripts/check.mjs" } });
    expect(chooseHookCommand({ packageJson: pkg, flareYml: "profiles: {smoke: {}}" }).command).toBe("npm run check");
  });

  it("picks the fastest-sounding profile flare.yml defines", () => {
    const yml = "jobs: {}\nprofiles:\n  full: {}\n  smoke: {include: [fast]}\n";
    expect(chooseHookCommand({ packageJson: "{}", flareYml: yml }).command).toBe("npx flare-forge-cli local --profile smoke");
  });

  it("falls back to the whole pipeline and says how to speed it up", () => {
    const choice = chooseHookCommand({ packageJson: "not json", flareYml: "jobs: {}" });
    expect(choice.command).toBe("npx flare-forge-cli local");
    expect(choice.why).toContain("--profile smoke");
  });
});

describe("hookScript", () => {
  it("is a marked sh script with a skip switch and isolated stdin", () => {
    const script = hookScript("npm run check && echo ok");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(HOOK_MARKER);
    expect(script).toContain('[ "${FLARE_SKIP_HOOK:-}" = "1" ] && exit 0');
    expect(script).toContain("( npm run check && echo ok ) </dev/null");
  });
});

describe("installHook / uninstallHook", () => {
  it("writes an executable hook that git runs and that fails the push on red", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { check: "exit 3" } }) });
    const res = installHook({ cwd: dir });
    expect(res).toMatchObject({ command: "npm run check", replaced: "none" });
    expect(res.path).toBe(hookPath(dir));
    expect(statSync(res.path).mode & 0o111).not.toBe(0);
    // Run it the way git does: a red check exits non-zero and blocks the push.
    expect(() => execFileSync(res.path, [], { cwd: dir, stdio: "ignore" })).toThrow();
    expect(() => execFileSync(res.path, [], { cwd: dir, stdio: "ignore", env: { ...process.env, FLARE_SKIP_HOOK: "1" } })).not.toThrow();
  });

  it("updates its own hook in place", () => {
    const dir = repo();
    installHook({ cwd: dir, run: "true" });
    expect(installHook({ cwd: dir, run: "make lint" })).toMatchObject({ replaced: "flare", command: "make lint" });
  });

  it("never clobbers a foreign hook without --force, and restores it on uninstall", () => {
    const dir = repo();
    const path = hookPath(dir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nhusky run\n");
    expect(() => installHook({ cwd: dir, run: "true" })).toThrow(/not written by flare/);
    const forced = installHook({ cwd: dir, run: "true", force: true });
    expect(forced.replaced).toBe("backed-up");
    expect(readFileSync(forced.backup as string, "utf8")).toContain("husky run");
    expect(uninstallHook(dir)).toMatchObject({ removed: true, restored: true });
    expect(readFileSync(path, "utf8")).toContain("husky run");
  });

  it("leaves foreign hooks alone on uninstall", () => {
    const dir = repo();
    expect(uninstallHook(dir)).toMatchObject({ removed: false });
    installHook({ cwd: dir, run: "true" });
    expect(uninstallHook(dir)).toMatchObject({ removed: true, restored: false });
    expect(existsSync(hookPath(dir))).toBe(false);
  });

  it("honors core.hooksPath", () => {
    const dir = repo();
    execFileSync("git", ["config", "core.hooksPath", "githooks"], { cwd: dir });
    expect(installHook({ cwd: dir, run: "true" }).path).toBe(join(dir, "githooks", "pre-push"));
  });
});
