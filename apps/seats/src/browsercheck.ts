// Browser Rendering driver for declarative browser checks. Production
// launches via @cloudflare/puppeteer (seat-do); unit tests inject a
// fake launcher, so no browser session is needed under vitest.
import { launch, type BrowserWorker } from "@cloudflare/puppeteer";
import type { JobBrowserActionSpec } from "../../../packages/runner-sdk/src/spec";
import type { BrowserPageResult } from "./seat";

export type BrowserBinding = BrowserWorker;

// The evaluate callbacks run in the browser, but tsc checks them
// locally without DOM libs — this minimal shape covers exactly what
// the callbacks touch.
declare const document: { body?: { innerText?: string } } | undefined;

// Visible-text cap per check: assertions need the gist, not the
// whole DOM, and uncapped text would bloat logs and memory.
const MAX_TEXT_CHARS = 100000;

// Named (not inline) so unit tests can drive both branches by stubbing
// globalThis.document. Puppeteer serializes the reference fine.
export function pageVisibleText(cap: number): string {
  return typeof document === "undefined" ? "" : (document.body?.innerText?.slice(0, cap) ?? "");
}

export function pageContainsText(text: string): boolean {
  return typeof document === "undefined" ? false : (document.body?.innerText?.includes(text) ?? false);
}

// Narrow page surface runBrowserCheck touches, in method syntax so the
// real puppeteer Page is assignable without casts (methods are
// bivariant) and fakes stay small.
export interface CheckPage {
  setDefaultTimeout(ms: number): void;
  goto(url: string, opts: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  waitForFunction(fn: (text: string) => boolean, opts: { timeout: number }, text: string): Promise<unknown>;
  title(): Promise<string>;
  evaluate(fn: (cap: number) => string, cap: number): Promise<string>;
  screenshot(): Promise<Uint8Array>;
}

export interface CheckBrowser {
  newPage(): Promise<CheckPage>;
  close(): Promise<void>;
}

export async function runBrowserCheck(
  binding: BrowserWorker,
  url: string,
  opts: { screenshot: boolean; timeoutMs: number; actions: JobBrowserActionSpec[] },
  deps: { launch?: (binding: BrowserWorker) => Promise<CheckBrowser> } = {},
): Promise<BrowserPageResult> {
  const browser: CheckBrowser = deps.launch ? await deps.launch(binding) : await launch(binding);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    // One budget for navigation + actions: the deadline shrinks every
    // action's timeout, so a slow page plus 10 slow actions cannot
    // bill many sessions. (Action-less checks behave exactly as
    // before — goto keeps the full timeout, and nothing reads the
    // deadline.)
    const deadline = Date.now() + opts.timeoutMs;
    // domcontentloaded, not networkidle: checks assert DOM content,
    // and idle-waiting on third-party trackers just burns sessions.
    await page.goto(url, { timeout: opts.timeoutMs, waitUntil: "domcontentloaded" });
    for (let i = 0; i < opts.actions.length; i++) {
      const action = opts.actions[i];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`check timed out before action ${i + 1} (${action.kind})`);
      // Selectors name the failure; typed/waited TEXT never echoes
      // (action text may carry secrets — the seat's mask() is the
      // backstop for driver messages, but the label stays clean by
      // construction).
      const label =
        action.selector !== undefined
          ? `action ${i + 1} (${action.kind} ${JSON.stringify(action.selector)})`
          : `action ${i + 1} (${action.kind})`;
      try {
        if (action.kind === "click" && action.selector !== undefined) {
          page.setDefaultTimeout(remaining);
          await page.click(action.selector);
        } else if (action.kind === "type" && action.selector !== undefined && action.text !== undefined) {
          page.setDefaultTimeout(remaining);
          await page.type(action.selector, action.text);
        } else if (action.kind === "wait" && action.selector !== undefined) {
          await page.waitForSelector(action.selector, { timeout: remaining });
        } else if (action.kind === "wait-text" && action.text !== undefined) {
          await page.waitForFunction(pageContainsText, { timeout: remaining }, action.text);
        } else {
          throw new Error(`malformed action of kind ${JSON.stringify(action.kind)}`);
        }
      } catch (err) {
        throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const title = await page.title();
    const text = await page.evaluate(pageVisibleText, MAX_TEXT_CHARS);
    const screenshot = opts.screenshot ? await page.screenshot() : null;
    return { title, text, screenshot };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
