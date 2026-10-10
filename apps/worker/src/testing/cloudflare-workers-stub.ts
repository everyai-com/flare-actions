// Vitest stand-in for the `cloudflare:workers` runtime module (aliased in
// vitest.config.ts). Main-module class exports (Workflows, Durable
// Objects) extend these bases; under vitest index.ts can then load
// without the Workers runtime. It deliberately exports no `tracing`, so
// trace.ts keeps degrading to a no-op exactly as before.
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: unknown;
  protected env: Env;
  // Params only shapes the runtime class's type signature.
  declare readonly paramsType?: Params;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
