// Vitest-only stand-in for the `cloudflare:workers` runtime module
// (aliased in vitest.config.ts). index.ts re-exports Durable Object and
// Workflow classes, so importing it from a runtime-free test must still
// resolve; these bases are never instantiated by unit tests.
export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env = {};
