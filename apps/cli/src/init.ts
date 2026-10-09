import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertActionsWorkflow, isImportSuccess } from "flare-actions-runner-sdk";
import { detectStacks, generateStarter, isStackId, KNOWN_STACKS, primaryStack, type DetectedStack, type StackId } from "./detect.ts";

// `cli init`: agent-led adoption in one command — a flare.yml (converted
// from the repo's first convertible GitHub workflow, or a starter matched
// to the auto-detected stack), an idempotent AGENTS.md snippet that
// teaches agents the verify loop, and next-step pointers (MCP config,
// docs). Nothing here talks to the network; it is pure filesystem
// scaffolding. Safe to re-run: flare.yml is never overwritten without
// --force and the AGENTS block is replaced in place.

export const AGENTS_MARKER_START = "<!-- flare-actions:start -->";
export const AGENTS_MARKER_END = "<!-- flare-actions:end -->";

const AGENTS_SNIPPET = `${AGENTS_MARKER_START}
## CI (Flare Actions)

This repo verifies with Flare Actions. Existing \`.github/workflows\` run
as-is; \`flare.yml\` is the native format and wins when present.

- Inner loop: \`npm run check\` (changed files only) or \`npx flare local\`.
- Server verify: \`npx flare run <owner/repo> HEAD\` — dispatches, waits,
  and prints a compact digest (or MCP \`run_and_wait\`). No polling loops.
- Never claim CI passed without a run digest; surface failures with the
  digest's failing step + tail instead of full logs.
- Flaky tests don't block: \`npx flare quarantine list <repo>\`.
- Budgets: dashboard → Settings → Budgets (warn/block per repo).
${AGENTS_MARKER_END}
`;

export interface InitResult {
  cwd: string;
  pipelinePath: string | null;
  pipelineSource: "converted" | "starter" | null;
  convertedFrom: string | null;
  /** Every stack evidenced by manifest files (priority order; [] = none). */
  stacks: DetectedStack[];
  /** Starter stack when pipelineSource is "starter" (forced or detected). */
  starterStack: StackId | null;
  warnings: string[];
  agentsPath: string | null;
  agentsUpdated: boolean;
  error?: string;
}

export interface InitOptions {
  cwd: string;
  force?: boolean;
  /** Force this stack's starter, skipping workflow conversion. */
  stack?: string;
}

function insertSnippet(existing: string): string {
  const start = existing.indexOf(AGENTS_MARKER_START);
  const end = existing.indexOf(AGENTS_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${AGENTS_SNIPPET}${existing.slice(end + AGENTS_MARKER_END.length)}`;
  }
  const base = existing.trimEnd();
  return base ? `${base}\n\n${AGENTS_SNIPPET}` : AGENTS_SNIPPET;
}

export function runInit(opts: InitOptions): InitResult {
  const pipelinePath = join(opts.cwd, "flare.yml");
  const agentsPath = join(opts.cwd, "AGENTS.md");
  const stacks = detectStacks(opts.cwd);
  const result: InitResult = {
    cwd: opts.cwd,
    pipelinePath: null,
    pipelineSource: null,
    convertedFrom: null,
    stacks,
    starterStack: null,
    warnings: [],
    agentsPath: null,
    agentsUpdated: false,
  };
  if (opts.stack !== undefined && !isStackId(opts.stack)) {
    result.error = `unknown stack "${opts.stack}" — want one of: ${KNOWN_STACKS.join(", ")}`;
    return result;
  }
  if (existsSync(pipelinePath) && !opts.force) {
    result.error = "flare.yml already exists — re-run with --force to replace it";
    return result;
  }

  let pipeline: string | null = null;
  if (!pipeline && opts.stack === undefined) {
    const workflowsDir = join(opts.cwd, ".github", "workflows");
    if (existsSync(workflowsDir)) {
      const names = readdirSync(workflowsDir)
        .filter((name) => /\.ya?ml$/i.test(name))
        .sort();
      for (const name of names) {
        const converted = convertActionsWorkflow(readFileSync(join(workflowsDir, name), "utf8"));
        if (!isImportSuccess(converted)) {
          result.warnings.push(`${name}: not convertible (${converted.error})`);
          continue;
        }
        pipeline = converted.yaml;
        result.pipelineSource = "converted";
        result.convertedFrom = name;
        result.warnings.push(...converted.warnings.map((w) => `${name}: ${w}`));
        break;
      }
    }
  }
  if (!pipeline) {
    const forced = opts.stack !== undefined && isStackId(opts.stack) ? opts.stack : null;
    const starter = generateStarter(opts.cwd, forced ?? primaryStack(stacks)?.stack ?? "generic");
    pipeline = starter.yaml;
    result.pipelineSource = "starter";
    result.starterStack = starter.stack;
    result.warnings.push(...starter.notes.map((n) => `starter (${starter.stack}): ${n}`));
  }
  mkdirSync(opts.cwd, { recursive: true });
  writeFileSync(pipelinePath, pipeline);
  result.pipelinePath = pipelinePath;

  const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  writeFileSync(agentsPath, insertSnippet(existing));
  result.agentsPath = agentsPath;
  result.agentsUpdated = true;
  return result;
}
