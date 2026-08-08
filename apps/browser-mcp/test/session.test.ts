import { existsSync } from "node:fs";
import http from "node:http";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserManager } from "../src/session.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const chromiumAvailable = (() => {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
})();
const itWithChromium = chromiumAvailable ? it : it.skip;

const html = `<!doctype html><html><head><title>Session Page</title></head><body><h1>ok</h1></body></html>`;

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("browser session manager (TDD-106)", () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let manager: BrowserManager | null = null;

  afterEach(async () => {
    await manager?.close();
    manager = null;
    await server?.close();
    server = null;
  });

  itWithChromium("launches on first run and reuses the same page", async () => {
    server = await startServer();
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    const url = `http://127.0.0.1:${server.port}/`;
    const title1 = await manager.run(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return page.title();
    });
    const title2 = await manager.run((page) => page.title());
    expect(title1).toBe("Session Page");
    expect(title2).toBe("Session Page");
  });

  itWithChromium("serializes concurrent operations", async () => {
    server = await startServer();
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    const started = Date.now();
    const [a, b] = await Promise.all([
      manager.run(async () => { await sleep(150); return "a"; }),
      manager.run(async () => { await sleep(150); return "b"; }),
    ]);
    const elapsed = Date.now() - started;
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(elapsed).toBeGreaterThanOrEqual(280);
  });

  itWithChromium("recovers from a browser crash on the next run", async () => {
    server = await startServer();
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    const url = `http://127.0.0.1:${server.port}/`;
    await manager.run(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    });
    expect(manager.isConnected()).toBe(true);
    await manager.run(async (page) => {
      const cdp = await page.context().newCDPSession(page);
      cdp.send("Browser.crash").catch(() => {});
      return null;
    });
    await sleep(1500);
    expect(manager.isConnected()).toBe(false);
    const title = await manager.run(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return page.title();
    });
    expect(title).toBe("Session Page");
    expect(manager.isConnected()).toBe(true);
  });

  itWithChromium("close shuts the browser down", async () => {
    server = await startServer();
    manager = new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
    await manager.run(async (page) => { await page.goto(`http://127.0.0.1:${server.port}/`); });
    await manager.close();
    expect(manager.isConnected()).toBe(false);
  });
});
