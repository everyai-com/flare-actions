import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "./dashboard";

// Static guards for the inline dashboard: the HTML is one template
// literal, so embedded JS must avoid ${ (interpolation) and backticks
// (which would not even compile). These tests pin the WebMCP wiring and
// the OAuth grants section against accidental deletion.
describe("dashboard", () => {
  it("keeps embedded JS interpolation-free", () => {
    expect(DASHBOARD_HTML).not.toContain("${");
    expect(DASHBOARD_HTML).not.toContain("`");
  });

  it("registers WebMCP tools behind feature detection", () => {
    expect(DASHBOARD_HTML).toContain("registerWebMcpTools");
    expect(DASHBOARD_HTML).toContain("document.modelContext");
    expect(DASHBOARD_HTML).toContain("navigator.modelContext");
    for (const tool of [
      "flare_list_runs",
      "flare_get_run_digest",
      "flare_get_flaky",
      "flare_dispatch_run",
      "flare_rerun_job",
    ]) {
      expect(DASHBOARD_HTML).toContain(tool);
    }
  });

  it("lists connected OAuth apps", () => {
    expect(DASHBOARD_HTML).toContain("grantsBody");
    expect(DASHBOARD_HTML).toContain("/v1/admin/oauth-grants");
  });

  it("wires the heal-on-failure toggle to settings", () => {
    expect(DASHBOARD_HTML).toContain("healCheck");
    expect(DASHBOARD_HTML).toContain("healOnFailure");
  });

  it("surfaces the Actions drop-in card and per-run pipeline source tags", () => {
    expect(DASHBOARD_HTML).toContain("Coming from GitHub Actions?");
    expect(DASHBOARD_HTML).toContain("pipelineSourceLabel");
    expect(DASHBOARD_HTML).toContain("run-src");
    expect(DASHBOARD_HTML).toContain("GITHUB-ACTIONS-COMPAT.md");
  });

  it("renders the slowest-checks report", () => {
    expect(DASHBOARD_HTML).toContain("bottlenecksBox");
    expect(DASHBOARD_HTML).toContain("loadBottlenecks");
    expect(DASHBOARD_HTML).toContain("/v1/bottlenecks?repo=");
  });

  it("wires budget guardrails and auto-supersede", () => {
    expect(DASHBOARD_HTML).toContain("budgetInput");
    expect(DASHBOARD_HTML).toContain("budgetModeSelect");
    expect(DASHBOARD_HTML).toContain("supersedeCheck");
  });

  it("wires the open-registration toggle and self-serve signup", () => {
    expect(DASHBOARD_HTML).toContain("openRegCheck");
    expect(DASHBOARD_HTML).toContain("openRegistration");
    expect(DASHBOARD_HTML).toContain("registerToggleBtn");
    expect(DASHBOARD_HTML).toContain("setEmailMode");
    expect(DASHBOARD_HTML).toContain("githubOpenHint");
  });
});
