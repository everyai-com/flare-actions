import { LLMS_TXT } from "./llms-txt";

// GET /llms.txt: the repo's llms.txt with worker-URL placeholders filled
// in from the request origin, so an agent handed a Flare URL gets
// commands that already point at it. Placeholder forms used in llms.txt:
// `https://<worker>` and `https://<their-worker>.workers.dev`.
export function llmsTxtFor(origin: string): string {
  return LLMS_TXT.replaceAll("https://<their-worker>.workers.dev", origin).replaceAll("https://<worker>", origin);
}
