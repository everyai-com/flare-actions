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

  it("suggests quarantine candidates with sparklines and one-click add", () => {
    expect(DASHBOARD_HTML).toContain("candidateBody");
    expect(DASHBOARD_HTML).toContain("Suggested for quarantine");
    expect(DASHBOARD_HTML).toContain("res.candidates");
    expect(DASHBOARD_HTML).toContain("c.sparkline");
  });

  it("shows the lane log digest first line on runner-mode jobs", () => {
    expect(DASHBOARD_HTML).toContain("j.logDigest");
  });

  it("wires the fleet runner version setting", () => {
    expect(DASHBOARD_HTML).toContain("runnerVersionInput");
    expect(DASHBOARD_HTML).toContain("payload.runnerVersion");
  });

  it("wires the org runner group setting", () => {
    expect(DASHBOARD_HTML).toContain("ghRunnerGroupInput");
    expect(DASHBOARD_HTML).toContain("githubRunnerGroup");
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

  it("renders the shared-cache hit-rate strip", () => {
    expect(DASHBOARD_HTML).toContain("cacheStatsStrip");
    expect(DASHBOARD_HTML).toContain("loadCacheStats");
    expect(DASHBOARD_HTML).toContain("/v1/cache/stats");
  });

  it("wires budget guardrails and auto-supersede", () => {
    expect(DASHBOARD_HTML).toContain("budgetInput");
    expect(DASHBOARD_HTML).toContain("budgetModeSelect");
    expect(DASHBOARD_HTML).toContain("supersedeCheck");
  });

  it("wires the per-agent fair-share cap", () => {
    expect(DASHBOARD_HTML).toContain("agentShareInput");
    expect(DASHBOARD_HTML).toContain("fairSharePerAgent");
  });

  it("wires the kill switch multiplier and paused resume", () => {
    expect(DASHBOARD_HTML).toContain("killMultiplierInput");
    expect(DASHBOARD_HTML).toContain("pausedBox");
    expect(DASHBOARD_HTML).toContain("loadPaused");
    expect(DASHBOARD_HTML).toContain("/v1/admin/paused");
    expect(DASHBOARD_HTML).toContain("Resume");
  });

  it("renders the flaky tab with quarantine add and reinstate", () => {
    expect(DASHBOARD_HTML).toContain("tabFlaky");
    expect(DASHBOARD_HTML).toContain("flakyPane");
    expect(DASHBOARD_HTML).toContain("loadFlaky");
    expect(DASHBOARD_HTML).toContain("/v1/flaky?repo=");
    expect(DASHBOARD_HTML).toContain("/v1/quarantine?repo=");
    expect(DASHBOARD_HTML).toContain("quarantineForm");
    expect(DASHBOARD_HTML).toContain("Reinstate");
  });

  it("wires the open-registration toggle and self-serve signup", () => {
    expect(DASHBOARD_HTML).toContain("openRegCheck");
    expect(DASHBOARD_HTML).toContain("openRegistration");
    expect(DASHBOARD_HTML).toContain("registerToggleBtn");
    expect(DASHBOARD_HTML).toContain("setEmailMode");
    expect(DASHBOARD_HTML).toContain("githubOpenHint");
  });

  it("wires the runner-mode card to settings and the jobs lane", () => {
    expect(DASHBOARD_HTML).toContain("ghRunnerCheck");
    expect(DASHBOARD_HTML).toContain("ghRunnerLabelsInput");
    expect(DASHBOARD_HTML).toContain("githubRunnerMode");
    expect(DASHBOARD_HTML).toContain("githubRunnerLabels");
    expect(DASHBOARD_HTML).toContain("loadGhRunnerJobs");
    expect(DASHBOARD_HTML).toContain("/v1/github/jobs?limit=5");
  });

  it("renders the first-run onboarding checklist", () => {
    expect(DASHBOARD_HTML).toContain("three steps to the first one");
    expect(DASHBOARD_HTML).toContain("setupStep");
    expect(DASHBOARD_HTML).toContain("ol.steps");
    expect(DASHBOARD_HTML).toContain("Start an executor");
    expect(DASHBOARD_HTML).toContain("Dispatch a run");
  });

  it("polishes auth and small screens", () => {
    expect(DASHBOARD_HTML).toContain("oauthDivider");
    expect(DASHBOARD_HTML).toContain("or continue with");
    expect(DASHBOARD_HTML).toContain("@media (max-width: 640px)");
  });

  it("wires the runner pairing card", () => {
    expect(DASHBOARD_HTML).toContain("pairForm");
    expect(DASHBOARD_HTML).toContain("pairName");
    expect(DASHBOARD_HTML).toContain("pairCmd");
    expect(DASHBOARD_HTML).toContain("copyPairBtn");
    expect(DASHBOARD_HTML).toContain("/v1/admin/pair-codes");
    expect(DASHBOARD_HTML).toContain("--pair ");
  });

  it("renders the savings counter strip", () => {
    expect(DASHBOARD_HTML).toContain("usageStrip");
    expect(DASHBOARD_HTML).toContain("loadUsageStrip");
    expect(DASHBOARD_HTML).toContain("/v1/usage?days=30");
    expect(DASHBOARD_HTML).toContain("spend avoided vs Actions list price");
    expect(DASHBOARD_HTML).toContain("/v1/usage/billable?days=30");
    expect(DASHBOARD_HTML).toContain("real Cloudflare spend");
  });

  it("renders the feed with one-click rerun, open-PR, and fix actions", () => {
    expect(DASHBOARD_HTML).toContain("tabFeed");
    expect(DASHBOARD_HTML).toContain("feedPane");
    expect(DASHBOARD_HTML).toContain("loadFeed");
    expect(DASHBOARD_HTML).toContain("appendFeedItem");
    expect(DASHBOARD_HTML).toContain("/v1/feed");
    expect(DASHBOARD_HTML).toContain("Rerun failed (");
    expect(DASHBOARD_HTML).toContain("Open PR #");
    expect(DASHBOARD_HTML).toContain("Open fix PR");
    expect(DASHBOARD_HTML).toContain("isAdmin && failed.length");
  });

  it("wires per-user notification attention prefs", () => {
    expect(DASHBOARD_HTML).toContain("notifyPrefsForm");
    expect(DASHBOARD_HTML).toContain("quietStartInput");
    expect(DASHBOARD_HTML).toContain("quietEndInput");
    expect(DASHBOARD_HTML).toContain("newFailuresCheck");
    expect(DASHBOARD_HTML).toContain("loadNotifyPrefs");
    expect(DASHBOARD_HTML).toContain("/v1/notify/prefs");
  });

  it("stacks tabs, tables, and actions under 640px with no page scroll", () => {
    expect(DASHBOARD_HTML).toContain("overflow-x: hidden");
    expect(DASHBOARD_HTML).toContain("nav.tabs { flex-wrap: wrap; }");
    expect(DASHBOARD_HTML).toContain("thead { display: none; }");
    expect(DASHBOARD_HTML).toContain("table tr { display: block;");
    expect(DASHBOARD_HTML).toContain("table td button { width: 100%; }");
    expect(DASHBOARD_HTML).toContain("form.inline { flex-direction: column;");
  });

  it("renders the template gallery and migration wizard", () => {
    expect(DASHBOARD_HTML).toContain("tabTemplates");
    expect(DASHBOARD_HTML).toContain("templatesPane");
    expect(DASHBOARD_HTML).toContain("loadTemplates");
    expect(DASHBOARD_HTML).toContain("appendTemplateCard");
    expect(DASHBOARD_HTML).toContain("/v1/templates");
    expect(DASHBOARD_HTML).toContain("npx flare init --template ");
    expect(DASHBOARD_HTML).toContain("migrateForm");
    expect(DASHBOARD_HTML).toContain("migrateInput");
    expect(DASHBOARD_HTML).toContain("/v1/migrate");
    expect(DASHBOARD_HTML).toContain("migrateWarnings");
  });

  it("wires the repo egress allowlist editor to the admin API", () => {
    expect(DASHBOARD_HTML).toContain("Egress allowlists");
    expect(DASHBOARD_HTML).toContain("egressForm");
    expect(DASHBOARD_HTML).toContain("egressList");
    expect(DASHBOARD_HTML).toContain("loadEgress");
    expect(DASHBOARD_HTML).toContain("/v1/admin/egress-allowlist");
  });

  it("lists hands-free Artifacts mirrors in Settings", () => {
    expect(DASHBOARD_HTML).toContain("Artifacts mirrors");
    expect(DASHBOARD_HTML).toContain("mirrorList");
    expect(DASHBOARD_HTML).toContain("loadMirrors");
    expect(DASHBOARD_HTML).toContain("/v1/admin/mirrors");
  });

  it("renders per-job peak-RSS bars with size-class hints", () => {
    expect(DASHBOARD_HTML).toContain("Resources (peak RSS per job)");
    expect(DASHBOARD_HTML).toContain("sizeClassForPeak");
    expect(DASHBOARD_HTML).toContain("SIZE_CLASS_BLURB");
    expect(DASHBOARD_HTML).toContain("res-fill");
    expect(DASHBOARD_HTML).toContain("peakRssOf");
    expect(DASHBOARD_HTML).toContain("FLARE_LABELS");
  });

  it("wires the cache browser to the admin cache API", () => {
    expect(DASHBOARD_HTML).toContain("Cache browser");
    expect(DASHBOARD_HTML).toContain("cacheForm");
    expect(DASHBOARD_HTML).toContain("cacheBody");
    expect(DASHBOARD_HTML).toContain("loadCacheEntries");
    expect(DASHBOARD_HTML).toContain("purgeCachePrefix");
    expect(DASHBOARD_HTML).toContain("/v1/admin/cache");
  });

});
