// ForgePushWorkflow: target of the namespace-wide
// `cf.artifacts.repo.pushed` event trigger (wrangler.jsonc
// triggers.events). One instance per event (instance id = event id).
// The durable step retries transient failures; duplicate deliveries
// and the agent's own report_push dedupe in the Coordinator on
// (intent, sha). Logic: forge-push.ts (runtime-free, tested).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { WorkerEnv } from "./env";
import { coordinatorFor } from "./coordinator";
import { handleForgePush, type ForgePushOutcome, type TreeReader } from "./forge-push";

export class ForgePushWorkflow extends WorkflowEntrypoint<WorkerEnv, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<ForgePushOutcome> {
    const env = this.env;
    const outcome = await step.do(
      "reconcile push",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async (): Promise<ForgePushOutcome> => {
        const artifacts = env.ARTIFACTS;
        if (!artifacts) return { status: "skipped", reason: "unreadable" };
        const out = await handleForgePush(
          {
            db: env.DB,
            namespace: env.ARTIFACTS_NAMESPACE ?? "",
            openRepo: async (name: string): Promise<TreeReader & { [Symbol.dispose]?: () => void }> => artifacts.get(name),
            reportPush: (repo, intentId, input) => coordinatorFor(env, repo).reportPush(intentId, input),
          },
          event.payload,
        );
        // A coordinator error other than an ownership/state race is
        // worth a retry; surface it so the step backs off.
        if (out.status === "failed" && out.error !== "not-owner" && out.error !== "not-pushable" && out.error !== "conflict") {
          throw new Error(`reportPush failed: ${out.error}`);
        }
        return out;
      },
    );
    console.log(JSON.stringify({ level: "info", msg: "forge push reconciled", instance: event.instanceId, ...outcome }));
    return outcome;
  }
}
