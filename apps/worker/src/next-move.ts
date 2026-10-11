// The next-move engine (docs/OCTALYSIS.md): one pure function picks the
// single primary action shown on Home and in the side bar "Next:" chip.
// The first matching rule wins; rule order follows the doc's table.
//
// It lives here as an ES5 source string because the dashboard's inline
// script cannot import: dashboard.ts splices NEXT_MOVE_JS into its
// <script>, and next-move.test.ts compiles the same string with
// new Function, so the tested code is the shipped code. Keep it ES5
// (var, function), with no backticks and no dollar-brace sequences.
//
// Input (all optional): signedIn, admin, githubConnected, projectPicked,
// waitingForComputer, checks (count), passed (count), latestStatus,
// inboxCount, agentSeen, teammateSeen.
// Output: { key, label, phase, owner } where owner = only an admin can
// do it (readers are told to ask the owner instead).
//
// Phase note: rules 6-8 are Scaffolding in the doc's table, but until
// the first green check the person is still on quest level 5, so the
// engine reports Onboarding there. Rule 11 (everything done, agent and
// teammate seen) reports Endgame: it is only reachable by an expert.
export const NEXT_MOVE_JS = String.raw`function nextMove(s) {
    s = s || {};
    var green = (s.passed || 0) > 0;
    var daily = green ? "scaffolding" : "onboarding";
    function mv(key, label, phase, owner) { return { key: key, label: label, phase: phase, owner: !!owner }; }
    if (!s.signedIn) return mv("account", "Make your account", "discovery", false);
    if (!s.githubConnected) return mv("github", "Connect GitHub", "onboarding", true);
    if (!s.projectPicked) return mv("project", "Pick a project", "onboarding", true);
    if (s.waitingForComputer) return mv("computer", "Use my computer", daily, true);
    if (!s.checks) return mv("first_check", "Run your first check", "onboarding", true);
    if (s.latestStatus === "failure" || s.latestStatus === "error") return mv("see_broke", "See what broke", daily, false);
    if ((s.inboxCount || 0) > 0) return mv("inbox", "Review " + s.inboxCount + " waiting", daily, false);
    if (s.latestStatus === "running" || s.latestStatus === "queued" || s.latestStatus === "blocked") return mv("watch", "Watch it run", daily, false);
    if (!s.agentSeen) return mv("agent", "Connect an AI agent", daily, false);
    if (!s.teammateSeen) return mv("invite", "Invite a teammate", green ? "endgame" : "onboarding", true);
    return mv("run", "Run a check", green ? "endgame" : "onboarding", true);
  }`;

export type NextMoveKey =
  | "account"
  | "github"
  | "project"
  | "computer"
  | "first_check"
  | "see_broke"
  | "inbox"
  | "watch"
  | "agent"
  | "invite"
  | "run";

export interface NextMoveState {
  signedIn?: boolean;
  admin?: boolean;
  githubConnected?: boolean;
  projectPicked?: boolean;
  waitingForComputer?: boolean;
  checks?: number;
  passed?: number;
  latestStatus?: string;
  inboxCount?: number;
  agentSeen?: boolean;
  teammateSeen?: boolean;
}

export interface NextMove {
  key: NextMoveKey;
  label: string;
  phase: "discovery" | "onboarding" | "scaffolding" | "endgame";
  owner: boolean;
}
