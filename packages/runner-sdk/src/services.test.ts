import { describe, expect, it } from "vitest";
import { dockerArgsForService, dockerArgsForStep } from "./services";

describe("docker args", () => {
  it("builds service run commands", () => {
    expect(
      dockerArgsForService("flare-abc-db", { image: "postgres:16", ports: ["5432:5432"], env: { P: "x" } }),
    ).toEqual(["run", "-d", "--name", "flare-abc-db", "-p", "5432:5432", "-e", "P=x", "postgres:16"]);
  });

  it("prepends GITHUB_PATH entries to the container's own PATH via a trampoline", () => {
    const args = dockerArgsForStep("node:20", "/tmp/w", { ...process.env }, [], "tool --v", "bash", ["/work/bin", "/o'q"]);
    expect(args.slice(-6)).toEqual([
      "node:20",
      "sh",
      "-c",
      `PATH='/work/bin:/o'\\''q':"$PATH"; export PATH; exec "$0" -c "$1"`,
      "bash",
      "tool --v",
    ]);
  });

  it("builds container step commands with forwarded env only", () => {
    expect(
      dockerArgsForStep("node:20", "/tmp/w", { ...process.env, A: "1", B: "2", FLARE_SHA: "s" }, ["FLARE_SHA", "A"], "npm test"),
    ).toEqual([
      "run",
      "--rm",
      "-v",
      "/tmp/w:/work",
      "-w",
      "/work",
      "-e",
      "FLARE_SHA=s",
      "-e",
      "A=1",
      "node:20",
      "sh",
      "-c",
      "npm test",
    ]);
  });
});
