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

  it("offers passwordless magic-link login", () => {
    expect(DASHBOARD_HTML).toContain("magicForm");
    expect(DASHBOARD_HTML).toContain("magicEmail");
    expect(DASHBOARD_HTML).toContain("magicOk");
    expect(DASHBOARD_HTML).toContain("magicErr");
    expect(DASHBOARD_HTML).toContain("/v1/admin/magic/request");
    expect(DASHBOARD_HTML).toContain('q.get("magic")');
    // Links land on a confirm screen; only the explicit POST redeems, so
    // mail scanners that prefetch the link cannot burn it.
    expect(DASHBOARD_HTML).toContain('q.get("magic_token")');
    expect(DASHBOARD_HTML).toContain("magicConfirmPane");
    expect(DASHBOARD_HTML).toMatch(/fetch\("\/v1\/admin\/magic\/consume", \{ method: "POST"/);
    expect(DASHBOARD_HTML).toContain('=== "expired"');
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

  it("stacks tabs, tables, and actions under 640px with no page scroll", () => {
    expect(DASHBOARD_HTML).toContain("overflow-x: hidden");
    expect(DASHBOARD_HTML).toContain(".side-link { min-height: 44px; }");
    expect(DASHBOARD_HTML).toContain("thead { display: none; }");
    expect(DASHBOARD_HTML).toContain("table tr { display: block;");
    expect(DASHBOARD_HTML).toContain("table td button { width: 100%; }");
    expect(DASHBOARD_HTML).toContain("form.inline { flex-direction: column;");
  });

  it("renders per-job peak-RSS bars with size-class hints", () => {
    expect(DASHBOARD_HTML).toContain("Resources (peak RSS per job)");
    expect(DASHBOARD_HTML).toContain("sizeClassForPeak");
    expect(DASHBOARD_HTML).toContain("SIZE_CLASS_BLURB");
    expect(DASHBOARD_HTML).toContain("res-fill");
    expect(DASHBOARD_HTML).toContain("peakRssOf");
    expect(DASHBOARD_HTML).toContain("FLARE_LABELS");
  });

  it("renders the tournament board around the four review questions", () => {
    for (const id of ["tWhy", "tReview", "tLanes", "tRadar", "tActivity"]) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
    for (const fn of [
      "renderTournamentWhy",
      "renderTournamentReview",
      "renderTournamentLanes",
      "renderTournamentRadar",
      "renderTournamentActivity",
      "parseCollision",
      "verdictOrder",
      "agentAvatar",
    ]) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain("Why this race exists");
    expect(DASHBOARD_HTML).toContain("Collision radar");
    expect(DASHBOARD_HTML).toContain("Deterministic ranking");
    expect(DASHBOARD_HTML).toContain("Open verification run");
    expect(DASHBOARD_HTML).toContain("run_status");
  });

  it("wires the command palette, shortcuts, deep links, and toasts", () => {
    for (const id of ["paletteOverlay", "palette", "paletteInput", "paletteList", "paletteFoot", "paletteBtn", "toasts"]) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
    for (const fn of [
      "openPalette",
      "closePalette",
      "renderPalette",
      "palMove",
      "palRunActive",
      "palCommands",
      "palGoTab",
      "refreshCurrent",
      "applyHashRoute",
      "syncHash",
      "toast(",
      "skeleton(",
    ]) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain("data-ago");
    expect(DASHBOARD_HTML).toContain("skel-row");
    expect(DASHBOARD_HTML).toContain("pane-enter");
    expect(DASHBOARD_HTML).toContain("Copy board link");
    expect(DASHBOARD_HTML).toContain("tPulse");
  });

  it("routes palette Go to Merge queue through a loading branch", () => {
    const start = DASHBOARD_HTML.indexOf("function palGoTab(name)");
    expect(start).toBeGreaterThan(-1);
    const body = DASHBOARD_HTML.slice(start, DASHBOARD_HTML.indexOf("function refreshCurrent", start));
    // Every palette tab needs a loader branch, or the pane opens empty.
    for (const tab of ["runs", "tournaments", "repos", "merge", "settings"]) {
      expect(body).toContain('name === "' + tab + '"');
    }
    expect(body).toContain("openMergeQueue()");
    expect(DASHBOARD_HTML).toContain("function openMergeQueue()");
  });

  it("keeps hidden-gated flex elements hidden until shown", () => {
    expect(DASHBOARD_HTML).toContain("#paletteOverlay[hidden]");
    expect(DASHBOARD_HTML).toContain(".side-link[hidden]");
    expect(DASHBOARD_HTML).toContain(".field[hidden], form.inline[hidden]");
  });

  it("renders the app sidebar with icon nav and auth gating", () => {
    expect(DASHBOARD_HTML).toContain('id="sideNav"');
    expect(DASHBOARD_HTML).toContain("side-link");
    expect(DASHBOARD_HTML).toContain("body.app nav.side-nav");
    expect(DASHBOARD_HTML).toContain("body.app main");
    expect(DASHBOARD_HTML).toContain("@media (max-width: 900px)");
    expect(DASHBOARD_HTML).toContain('class="wrap"');
    expect(DASHBOARD_HTML).toContain('classList.add("app")');
    expect(DASHBOARD_HTML).toContain("side-foot");
    expect(DASHBOARD_HTML).toContain("side-group");
    expect(DASHBOARD_HTML).not.toContain("nav.tabs");
    expect(DASHBOARD_HTML.indexOf('id="tabTournaments"')).toBeLessThan(DASHBOARD_HTML.indexOf('id="tabRuns"'));
    expect(DASHBOARD_HTML).toContain('if (!applyHashRoute()) palGoTab("tournaments")');
    expect(DASHBOARD_HTML).toContain("No races yet");
  });

  it("renders the forge repositories surface with race wiring", () => {
    for (const id of ["tabRepos", "reposPane", "reposList", "repoDetail", "repoHead", "repoFiles", "repoRuns", "repoCommits", "backToRepos"]) {
      expect(DASHBOARD_HTML).toContain('id="' + id + '"');
    }
    for (const fn of ["loadRepos", "openRepo", "renderRepoHead", "loadRepoTree", "repoCrumbs", "openRepoFile", "loadRepoRuns", "loadRepoCommits"]) {
      expect(DASHBOARD_HTML).toContain(fn);
    }
    expect(DASHBOARD_HTML).toContain("Open race");
    expect(DASHBOARD_HTML).toContain("CI ready");
    expect(DASHBOARD_HTML).toContain("Race agents on this repo");
    expect(DASHBOARD_HTML).toContain("/v1/repos");
    expect(DASHBOARD_HTML).toContain("Agent races");
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
