// Bindings for the flare-forge-sim Worker (apps/sim/wrangler.jsonc).
// Hand-written (no `wrangler types` step for this app).

import type { AgentPool, SimRegistry } from "./pool-do.ts";

export interface SimEnv {
  AGENT_POOL: DurableObjectNamespace<AgentPool>;
  SIM_REGISTRY: DurableObjectNamespace<SimRegistry>;
  // Artifacts namespace `flare-sim`: only used by cleanup to delete the
  // forks a run created (the target Forge must create its forks there).
  ARTIFACTS?: Artifacts;
  // Target Forge deployment (e.g. https://<preview>-flare-actions.<sub>.workers.dev).
  FORGE_URL?: string;
  // Forge API token (secret; `wrangler secret put FORGE_TOKEN`).
  FORGE_TOKEN?: string;
  // Guards this harness's own write endpoints (secret).
  SIM_ADMIN_TOKEN?: string;
  SIM_REPO?: string;
  MAX_FULL_GIT_AGENTS?: string;
  // "true" lets anyone read /results and the HTML page (counters only).
  PUBLIC_RESULTS?: string;
}
