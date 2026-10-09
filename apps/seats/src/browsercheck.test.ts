import { describe, expect, it } from "vitest";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import {
  pageContainsText,
  pageVisibleText,
  runBrowserCheck,
  type CheckBrowser,
  type CheckPage,
} from "./browsercheck";

interface ScriptedPage {
  title?: string;
  text?: string;
  shot?: boolean;
  gotoMs?: number;
  failAt?: string;
  failMessage?: string;
}

function fakeLauncher(script: ScriptedPage): {
  launch: (binding: BrowserWorker) => Promise<CheckBrowser>;
  calls: string[];
  waitTexts: string[];
  typed: { selector: string; text: string }[];
} {
  const calls: string[] = [];
  const waitTexts: string[] = [];
  const typed: { selector: string; text: string }[] = [];
  const maybeFail = (at: string) => {
    if (script.failAt === at) throw new Error(script.failMessage ?? `boom at ${at}`);
  };
  const page: CheckPage = {
    setDefaultTimeout: (ms: number) => {
      calls.push(`timeout ${ms}`);
    },
    goto: async (url: string) => {
      calls.push(`goto ${url}`);
      maybeFail("goto");
      if (script.gotoMs) await new Promise((r) => setTimeout(r, script.gotoMs));
      return null;
    },
    click: async (selector: string) => {
      calls.push(`click ${selector}`);
      maybeFail(`click ${selector}`);
    },
    type: async (selector: string, text: string) => {
      calls.push(`type ${selector}`);
      typed.push({ selector, text });
      maybeFail(`type ${selector}`);
    },
    waitForSelector: async (selector: string) => {
      calls.push(`wait ${selector}`);
      maybeFail(`wait ${selector}`);
      return null;
    },
    waitForFunction: async (_fn: (text: string) => boolean, _opts: { timeout: number }, text: string) => {
      calls.push("waitfn");
      waitTexts.push(text);
      maybeFail("waitfn");
      return null;
    },
    title: async () => {
      calls.push("title");
      return script.title ?? "";
    },
    evaluate: async (_fn: (cap: number) => string, cap: number) => {
      calls.push(`evaluate ${cap}`);
      return (script.text ?? "").slice(0, cap);
    },
    screenshot: async () => {
      calls.push("screenshot");
      return script.shot === true ? new TextEncoder().encode("png-bytes") : new Uint8Array();
    },
  };
  return {
    calls,
    waitTexts,
    typed,
    launch: async (_binding: BrowserWorker) => ({
      newPage: async () => {
        calls.push("newPage");
        return page;
      },
      close: async () => {
        calls.push("close");
      },
    }),
  };
}

const BINDING = {} as BrowserWorker;

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("expected promise to reject");
}

describe("runBrowserCheck", () => {
  it("reads title/text/screenshot with no actions (legacy shape)", async () => {
    const fake = fakeLauncher({ title: "Example Domain", text: "hello", shot: true });
    const page = await runBrowserCheck(
      BINDING,
      "https://example.com/",
      { screenshot: true, timeoutMs: 30000, actions: [] },
      { launch: fake.launch },
    );
    expect(page.title).toBe("Example Domain");
    expect(page.text).toBe("hello");
    expect(page.screenshot).toEqual(new TextEncoder().encode("png-bytes"));
    expect(fake.calls).toEqual([
      "newPage",
      "timeout 30000",
      "goto https://example.com/",
      "title",
      "evaluate 100000",
      "screenshot",
      "close",
    ]);
  });

  it("skips the screenshot when asked", async () => {
    const fake = fakeLauncher({ title: "t", shot: true });
    const page = await runBrowserCheck(BINDING, "https://example.com/", { screenshot: false, timeoutMs: 30000, actions: [] }, { launch: fake.launch });
    expect(page.screenshot).toBeNull();
    expect(fake.calls).not.toContain("screenshot");
  });

  it("runs actions in order between navigation and assertions", async () => {
    const fake = fakeLauncher({ title: "Dashboard", text: "Welcome back" });
    await runBrowserCheck(
      BINDING,
      "https://example.com/login",
      {
        screenshot: false,
        timeoutMs: 30000,
        actions: [
          { kind: "type", selector: "#user", text: "demo@example.com" },
          { kind: "type", selector: "#pass", text: "s3cret" },
          { kind: "click", selector: "#submit" },
          { kind: "wait", selector: "#dashboard" },
          { kind: "wait-text", text: "Welcome back" },
        ],
      },
      { launch: fake.launch },
    );
    expect(fake.calls.filter((c) => !c.startsWith("timeout"))).toEqual([
      "newPage",
      "goto https://example.com/login",
      "type #user",
      "type #pass",
      "click #submit",
      "wait #dashboard",
      "waitfn",
      "title",
      "evaluate 100000",
      "close",
    ]);
    // Secret-valued text flows to the page, intact and uninterpolated here.
    expect(fake.typed).toEqual([
      { selector: "#user", text: "demo@example.com" },
      { selector: "#pass", text: "s3cret" },
    ]);
    expect(fake.waitTexts).toEqual(["Welcome back"]);
  });

  it("shrinks each action timeout against the shared deadline", async () => {
    const fake = fakeLauncher({ title: "t" });
    await runBrowserCheck(
      BINDING,
      "https://example.com/",
      { screenshot: false, timeoutMs: 30000, actions: [{ kind: "click", selector: "#a" }] },
      { launch: fake.launch },
    );
    const timeouts = fake.calls.filter((c) => c.startsWith("timeout")).map((c) => Number(c.split(" ")[1]));
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBe(30000);
    expect(timeouts[1]).toBeLessThanOrEqual(30000);
    expect(timeouts[1]).toBeGreaterThan(0);
  });

  it("names the failing action with its selector, never typed text", async () => {
    const fake = fakeLauncher({ title: "t", failAt: "type #pass", failMessage: "node is not visible" });
    const err = await errorOf(
      runBrowserCheck(
      BINDING,
      "https://example.com/login",
      { screenshot: false, timeoutMs: 30000, actions: [{ kind: "type", selector: "#pass", text: "s3cret-value" }] },
      { launch: fake.launch },
      ),
    );
    expect(err.message).toBe('action 1 (type "#pass") failed: node is not visible');
    expect(err.message).not.toContain("s3cret-value");
    expect(fake.calls).toContain("close");
  });

  it("fails loud when the budget is spent before an action", async () => {
    const fake = fakeLauncher({ title: "t", gotoMs: 15 });
    const err = await errorOf(
      runBrowserCheck(
      BINDING,
      "https://example.com/slow",
      { screenshot: false, timeoutMs: 1, actions: [{ kind: "click", selector: "#x" }] },
      { launch: fake.launch },
      ),
    );
    expect(err.message).toBe("check timed out before action 1 (click)");
    expect(fake.calls).toContain("close");
    expect(fake.calls).not.toContain("click #x");
  });

  it("fails loud on malformed hand-built actions", async () => {
    const fake = fakeLauncher({ title: "t" });
    const err = await errorOf(
      runBrowserCheck(
      BINDING,
      "https://example.com/",
      { screenshot: false, timeoutMs: 30000, actions: [{ kind: "click" }] },
      { launch: fake.launch },
      ),
    );
    expect(err.message).toContain("action 1 (click) failed");
    expect(err.message).toContain("malformed action");
  });

  it("closes the browser when navigation throws", async () => {
    const fake = fakeLauncher({ title: "t", failAt: "goto", failMessage: "net::ERR_FAILED" });
    const err = await errorOf(
      runBrowserCheck(
      BINDING,
      "https://down.example/",
      { screenshot: false, timeoutMs: 30000, actions: [] },
      { launch: fake.launch },
      ),
    );
    expect(err.message).toBe("net::ERR_FAILED");
    expect(fake.calls).toContain("close");
  });
});

describe("page predicates", () => {
  it("reads visible text capped, empty without a DOM", () => {
    const g = globalThis as { document?: { body?: { innerText?: string } } };
    const prev = g.document;
    try {
      g.document = undefined;
      expect(pageVisibleText(10)).toBe("");
      expect(pageContainsText("x")).toBe(false);
      g.document = { body: { innerText: "hello world" } };
      expect(pageVisibleText(5)).toBe("hello");
      expect(pageContainsText("world")).toBe(true);
      expect(pageContainsText("nope")).toBe(false);
      g.document = {};
      expect(pageVisibleText(5)).toBe("");
      expect(pageContainsText("x")).toBe(false);
    } finally {
      if (prev === undefined) delete g.document;
      else g.document = prev;
    }
  });
});
