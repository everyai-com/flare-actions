import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertActionsWorkflow, isImportSuccess } from "flare-actions-runner-sdk";

// `cli init`: agent-led adoption in one command — a flare.yml (converted
// from the repo's first convertible GitHub workflow, or a starter), an
// idempotent AGENTS.md snippet that teaches agents the verify loop, and
// next-step pointers (MCP config, docs). Nothing here talks to the
// network; it is pure filesystem scaffolding.

export const AGENTS_MARKER_START = "<!-- flare-actions:start -->";
export const AGENTS_MARKER_END = "<!-- flare-actions:end -->";

const STARTER_PIPELINE = `# flare.yml — native pipeline format. Docs: docs/PIPELINES.md
# Repos without this file run their .github/workflows unchanged; keep
# whichever you prefer — flare.yml wins when present.
jobs:
  verify:
    steps:
      - run: npm ci
      - run: npm test
`;

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
  warnings: string[];
  agentsPath: string | null;
  agentsUpdated: boolean;
  error?: string;
}

export interface InitOptions {
  cwd: string;
  force?: boolean;
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
  const result: InitResult = {
    cwd: opts.cwd,
    pipelinePath: null,
    pipelineSource: null,
    convertedFrom: null,
    warnings: [],
    agentsPath: null,
    agentsUpdated: false,
  };
  if (existsSync(pipelinePath) && !opts.force) {
    result.error = "flare.yml already exists — re-run with --force to replace it";
    return result;
  }

  // Convert the first workflow that translates cleanly.
  let pipeline: string | null = null;
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
  if (!pipeline) {
    pipeline = STARTER_PIPELINE;
    result.pipelineSource = "starter";
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
