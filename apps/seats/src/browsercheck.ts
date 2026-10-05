// Browser Rendering driver for declarative browser checks. Loaded
// only via seat-do (production); unit tests inject fakes for the
// BrowserDriver interface, so puppeteer never loads under vitest.
import { launch, type BrowserWorker } from "@cloudflare/puppeteer";
import type { BrowserPageResult } from "./seat";

export type BrowserBinding = BrowserWorker;

// The evaluate callback runs in the browser, but tsc checks it
// locally without DOM libs — this minimal shape covers exactly what
// the callback touches.
declare const document: { body?: { innerText?: string } } | undefined;

// Visible-text cap per check: assertions need the gist, not the
// whole DOM, and uncapped text would bloat logs and memory.
const MAX_TEXT_CHARS = 100000;

export async function runBrowserCheck(
  binding: BrowserWorker,
  url: string,
  opts: { screenshot: boolean; timeoutMs: number },
): Promise<BrowserPageResult> {
  const browser = await launch(binding);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    // domcontentloaded, not networkidle: checks assert DOM content,
    // and idle-waiting on third-party trackers just burns sessions.
    await page.goto(url, { timeout: opts.timeoutMs, waitUntil: "domcontentloaded" });
    const title = await page.title();
    const text = await page.evaluate(
      (cap: number) => (typeof document === "undefined" ? "" : (document.body?.innerText?.slice(0, cap) ?? "")),
      MAX_TEXT_CHARS,
    );
    const screenshot = opts.screenshot ? await page.screenshot() : null;
    return { title, text, screenshot };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
