import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../src/session.js";
import { clickSelector, goBack, goForward, listButtons, loadState, openPage, readPage, reloadPage, saveState, waitForSelector } from "../src/tools.js";
import type { BrowserConfig } from "../src/types.js";

const chromiumAvailable = (() => {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
})();
const itWithChromium = chromiumAvailable ? it : it.skip;

const config: BrowserConfig = {
  version: 1,
  settings: { headless: true, defaultTimeoutSeconds: 20, maxReadBytes: 204800, auditEnabled: true },
  allowedDomains: ["127.0.0.1"],
  storageStates: [],
};

const pageHtml = `<!doctype html>
<html><head><title>Buttons Page</title></head>
<body>
  <button id="btn-change" onclick="document.getElementById('status').textContent='clicked'">Change Status</button>
  <button id="btn-alert" onclick="alert('hello-alert')">Alert Me</button>
  <a id="blank-link" href="/other" target="_blank">Open Other</a>
  <div id="status">initial</div>
  <button id="btn-hidden" style="display:none">Hidden</button>
</body></html>`;

async function startServer(html: string, secondPage?: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(req.url.startsWith("/two") ? (secondPage ?? html) : req.url.startsWith("/other") ? "<!doctype html><title>Other</title><body>other</body>" : html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("browser open/read tools (TDD-107)", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let manager: BrowserManager | null = null;

  afterEach(async () => {
    await manager?.close();
    manager = null;
    await server?.close();
    server = null;
  });

  itWithChromium("opens a page and reports title, url and loading state", async () => {
    server = await startServer("<!doctype html><title>Open Page</title><body><p>hello world</p></body>");
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    const result = await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    expect(result.ok).toBe(true);
    expect(result.title).toBe("Open Page");
    expect(result.url).toContain(`127.0.0.1:${server.port}/`);
    expect(result.loadingState).toBe("loaded");
    expect(result.storageState).toBe("none");
  });

  itWithChromium("reads visible text with metadata and truncation", async () => {
    server = await startServer(`<!doctype html><title>Read Page</title><body><p>${"A".repeat(400)}</p></body>`);
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const full = await readPage(manager, config);
    expect(full.ok).toBe(true);
    expect(full.title).toBe("Read Page");
    expect(full.text).toContain("A".repeat(400));
    expect(full.truncated).toBe(false);
    const small = await readPage(manager, config, { maxBytes: 100 });
    expect(small.truncated).toBe(true);
    expect(Buffer.byteLength(small.text, "utf8")).toBeLessThanOrEqual(100);
  });

  itWithChromium("rejects opening a URL outside the allowed domains", async () => {
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await expect(openPage(manager, config, { url: "https://example.com/" })).rejects.toThrow("browser_open rejected");
  });
});

describe("browser buttons/click tools (TDD-108)", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let manager: BrowserManager | null = null;

  afterEach(async () => {
    await manager?.close();
    manager = null;
    await server?.close();
    server = null;
  });

  itWithChromium("lists buttons with stable selectors and visibility", async () => {
    server = await startServer(pageHtml);
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await listButtons(manager);
    expect(result.ok).toBe(true);
    const change = result.buttons.find((b) => b.id === "btn-change");
    expect(change?.text).toBe("Change Status");
    expect(change?.selector).toBe("#btn-change");
    expect(change?.visible).toBe(true);
    const hidden = result.buttons.find((b) => b.id === "btn-hidden");
    expect(hidden?.visible).toBe(false);
  });

  itWithChromium("clicks a button and observes the DOM change", async () => {
    server = await startServer(pageHtml);
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await clickSelector(manager, config, { selector: "#btn-change" });
    expect(result.ok).toBe(true);
    expect(result.dialog).toBeNull();
    expect(await manager.run((page) => page.locator("#status").innerText())).toBe("clicked");
  });

  itWithChromium("auto-dismisses dialogs and reports the message", async () => {
    server = await startServer(pageHtml);
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await clickSelector(manager, config, { selector: "#btn-alert" });
    expect(result.dialog).toBe("hello-alert");
  });

  itWithChromium("closes target=_blank popups and keeps the main page", async () => {
    server = await startServer(pageHtml);
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await clickSelector(manager, config, { selector: "#blank-link" });
    expect(result.popupClosed).toBe(true);
    expect(result.url).toContain(`127.0.0.1:${server.port}/`);
  });

  itWithChromium("returns a locator error for a missing selector", async () => {
    server = await startServer(pageHtml);
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await clickSelector(manager, config, { selector: "#does-not-exist", timeoutSeconds: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("selector_not_found");
  });
});


describe("browser navigation tools (TDD-109)", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let manager: BrowserManager | null = null;

  afterEach(async () => {
    await manager?.close();
    manager = null;
    await server?.close();
    server = null;
  });

  itWithChromium("moves back, forward and reloads", async () => {
    server = await startServer(
      "<!doctype html><title>Page One</title><body><p>one</p></body>",
      "<!doctype html><title>Page Two</title><body><p>two</p></body>",
    );
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    const base = `http://127.0.0.1:${server.port}`;
    await openPage(manager, config, { url: base + "/" });
    await openPage(manager, config, { url: base + "/two" });
    const back = await goBack(manager);
    expect(back.ok).toBe(true);
    expect(back.title).toBe("Page One");
    const forward = await goForward(manager);
    expect(forward.title).toBe("Page Two");
    const reloaded = await reloadPage(manager);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.title).toBe("Page Two");
  });

  itWithChromium("waits for a selector that appears", async () => {
    server = await startServer(
      "<!doctype html><title>Wait Page</title><body><div id='late' style='display:none'>x</div><script>setTimeout(()=>{document.getElementById('late').style.display='block'},300)</script></body>",
    );
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await waitForSelector(manager, config, { selector: "#late", timeoutSeconds: 5 });
    expect(result.ok).toBe(true);
    expect(result.visible).toBe(true);
  });

  itWithChromium("reports a timeout when the selector never appears", async () => {
    server = await startServer("<!doctype html><title>No Wait</title><body><p>x</p></body>");
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, config, { url: `http://127.0.0.1:${server.port}/` });
    const result = await waitForSelector(manager, config, { selector: "#never", timeoutSeconds: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
  });
});


describe("browser storage state tools (TDD-110)", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let manager: BrowserManager | null = null;
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "browser-mcp-state-"));
  });

  afterEach(async () => {
    await manager?.close();
    manager = null;
    await server?.close();
    server = null;
    rmSync(stateDir, { recursive: true, force: true });
  });

  itWithChromium("saves the current context to a configured state file", async () => {
    server = await startServer("<!doctype html><title>State</title><body><p>x</p></body>");
    const stateFile = path.join(stateDir, "state.json");
    const stateConfig: BrowserConfig = {
      version: 1,
      settings: { headless: true, defaultTimeoutSeconds: 20, maxReadBytes: 204800, auditEnabled: true },
      allowedDomains: ["127.0.0.1"],
      storageStates: [{ domain: "127.0.0.1", path: stateFile }],
    };
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, stateConfig, { url: `http://127.0.0.1:${server.port}/` });
    await manager.run(async (page) => {
      await page.context().addCookies([{ name: "sess", value: "tok", url: `http://127.0.0.1:${server.port}/` }]);
      await page.evaluate(() => localStorage.setItem("k", "v"));
    });
    const result = await saveState(manager, stateConfig, { domain: "127.0.0.1" });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(stateFile);
    expect(existsSync(stateFile)).toBe(true);
    const written = JSON.parse(readFileSync(stateFile, "utf8")) as { cookies?: Array<{ name: string; value: string }> };
    expect(JSON.stringify(written)).toContain("k");
    expect(written.cookies?.find((c) => c.name === "sess")?.value).toBe("tok");
  });

  itWithChromium("loads a saved state file into a fresh context", async () => {
    server = await startServer("<!doctype html><title>State</title><body><p>x</p></body>");
    const stateFile = path.join(stateDir, "state.json");
    const stateConfig: BrowserConfig = {
      version: 1,
      settings: { headless: true, defaultTimeoutSeconds: 20, maxReadBytes: 204800, auditEnabled: true },
      allowedDomains: ["127.0.0.1"],
      storageStates: [{ domain: "127.0.0.1", path: stateFile }],
    };
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await openPage(manager, stateConfig, { url: `http://127.0.0.1:${server.port}/` });
    await manager.run(async (page) => {
      await page.context().addCookies([{ name: "sess", value: "tok", url: `http://127.0.0.1:${server.port}/` }]);
      await page.evaluate(() => localStorage.setItem("k", "v"));
    });
    await saveState(manager, stateConfig, { domain: "127.0.0.1" });

    await loadState(manager, stateConfig, { path: stateFile });
    await openPage(manager, stateConfig, { url: `http://127.0.0.1:${server.port}/` });
    const cookies = await manager.withContext(stateFile, (page) =>
      page.context().cookies(`http://127.0.0.1:${server.port}/`),
    );
    expect(cookies.find((c) => c.name === "sess")?.value).toBe("tok");
  });

  itWithChromium("rejects saving state for an unconfigured domain", async () => {
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await expect(saveState(manager, config, { domain: "example.com" })).rejects.toThrow();
  });

  itWithChromium("rejects loading a relative state path", async () => {
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await expect(loadState(manager, config, { path: "states/x.json" })).rejects.toThrow("绝对路径");
  });
});
