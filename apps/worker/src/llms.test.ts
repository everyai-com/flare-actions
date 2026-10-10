import { describe, expect, it } from "vitest";
import { llmsTxtFor } from "./llms";
import { LLMS_TXT } from "./llms-text";

describe("llmsTxtFor", () => {
  it("fills the deployment origin into placeholders", () => {
    const out = llmsTxtFor("https://ci.example.workers.dev");
    expect(LLMS_TXT).toContain("https://<worker>");
    expect(out).not.toContain("https://<worker>");
    expect(out).toContain("https://ci.example.workers.dev/mcp");
    expect(out).toContain("Start here: move a repo's CI to Flare");
  });
});
