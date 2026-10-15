import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./index.ts";

const KEYS = ["FLARE_LOADENV_A", "FLARE_LOADENV_B", "FLARE_LOADENV_C"];
const cwd = process.cwd();

afterEach(() => {
  process.chdir(cwd);
  for (const k of KEYS) delete process.env[k];
});

describe("loadEnv", () => {
  it("walks up to .env, keeps explicit values, fills empty ones, reports the path", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flare-loadenv-")));
    writeFileSync(join(root, ".env"), "FLARE_LOADENV_A=file\nFLARE_LOADENV_B=file\nFLARE_LOADENV_C=file\n");
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    process.env["FLARE_LOADENV_A"] = "explicit";
    process.env["FLARE_LOADENV_B"] = "";
    const out = loadEnv();
    expect(out).toEqual({ path: join(root, ".env"), searchedFrom: sub });
    expect(process.env["FLARE_LOADENV_A"]).toBe("explicit");
    expect(process.env["FLARE_LOADENV_B"]).toBe("file");
    expect(process.env["FLARE_LOADENV_C"]).toBe("file");
  });

  it("returns path null when no .env is found", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "flare-loadenv-none-")));
    const deep = join(root, "1", "2", "3", "4", "5", "6");
    mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    expect(loadEnv()).toEqual({ path: null, searchedFrom: deep });
  });
});
