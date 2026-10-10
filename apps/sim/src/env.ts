// Bindings for the flare-forge-sim Worker (apps/sim/wrangler.jsonc).
// Hand-written (no `wrangler types` step for this app).

import type { AgentPool, SimRegistry } from "./pool-do.ts";
import type { DemoLoop } from "./demo-do.ts";

export interface SimEnv {
  AGENT_POOL: DurableObjectNamespace<AgentPool>;
  SIM_REGISTRY: DurableObjectNamespace<SimRegistry>;
  // demo-loop (docs/DEMO.md "Watch it live"): one singleton DO that keeps
  // the public spectator repo moving.
  DEMO_LOOP: DurableObjectNamespace<DemoLoop>;
  // The Forge deployment's own Artifacts namespace (trunk reset + fork
  // cleanup for the public repo). Operator-added; unset = loop refuses.
  DEMO_ARTIFACTS?: Artifacts;
  // Runner token for the loop's agents (secret), pinned to the public repo
  // (`<namespace>/<repo>`); falls back to FORGE_TOKEN.
  DEMO_FORGE_TOKEN?: string;
  // Default public repo for the loop (e.g. bookshelf).
  DEMO_REPO?: string;
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
