import { chromium } from "playwright";
import http from "node:http";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const outFile = path.join(process.cwd(), "spike-results.jsonl");
try { rmSync(outFile, { force: true }); } catch {}

const record = (name, ok, detail) => {
  const line = JSON.stringify({ name, ok, detail });
  appendFileSync(outFile, line + "\n", "utf8");
  console.log(`${ok ? "PASS" : "FAIL"}\t${name}\t${JSON.stringify(detail)}`);
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

const pageA = `<!doctype html>
<html><head><title>Spike Page A</title></head>
<body>
  <h1 id="heading">Hello Browser MCP</h1>
  <p id="intro">visible text content for read test</p>
  <button id="btn-alert" onclick="alert('hello-alert')">Alert Me</button>
  <button id="btn-change" onclick="document.getElementById('status').textContent='clicked'">Change Status</button>
  <a id="blank-link" href="/other" target="_blank">Open Other</a>
  <div id="status">initial</div>
  <script>localStorage.setItem('spike','persisted');</script>
</body></html>`;
const pageB = `<!doctype html>
<html><head><title>Spike Page B</title></head>
<body><p>other page body</p></body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url.startsWith("/other") ? pageB : pageA);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const stateDir = mkdtempSync(path.join(tmpdir(), "browser-mcp-spike-"));
const stateFile = path.join(stateDir, "state.json");

let browser;
try {
  browser = await withTimeout(chromium.launch({ headless: true }), 30000, "launch");
  const context = await browser.newContext();
  const page = await context.newPage();

  await withTimeout(page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 20000 }), 25000, "goto A");
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  record("ASM-002 open", (await page.title()) === "Spike Page A", { title: await page.title(), url: page.url() });

  await withTimeout(page.locator("#intro").waitFor({ state: "visible", timeout: 3000 }), 6000, "wait selector");
  record("ASM wait selector", true, {});

  const text = await page.locator("body").innerText();
  record("ASM-003 read text", text.includes("Hello Browser MCP") && text.includes("visible text content"), { length: text.length });

  const buttons = await page.locator("button").evaluateAll((els) => els.map((el) => ({ id: el.id, text: (el.innerText || el.textContent || "").trim() })));
  record("ASM buttons", buttons.length === 2 && buttons.some((b) => b.id === "btn-alert") && buttons.some((b) => b.id === "btn-change"), { buttons });

  await withTimeout(page.locator("#btn-change").click(), 6000, "click change");
  record("ASM click", (await page.locator("#status").innerText()) === "clicked", {});

  let dialogMessage = null;
  page.once("dialog", async (d) => { dialogMessage = d.message(); await d.dismiss(); });
  await withTimeout(page.locator("#btn-alert").click(), 6000, "click alert");
  await new Promise((r) => setTimeout(r, 300));
  record("ASM dialog", dialogMessage === "hello-alert", { dialogMessage });

  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }),
    page.locator("#blank-link").click(),
  ]);
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  const popupCreated = !popup.isClosed();
  await popup.close().catch(() => {});
  record("ASM popup", popupCreated && popup.isClosed() && page.url() === `${base}/`, { popupCreated, closedAfterAppHandling: popup.isClosed() });

  const state = await context.storageState();
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  const freshContext = await browser.newContext({ storageState: stateFile });
  const freshPage = await freshContext.newPage();
  await withTimeout(freshPage.goto(`${base}/`, { waitUntil: "domcontentloaded" }), 20000, "goto fresh");
  const stored = await freshPage.evaluate(() => localStorage.getItem("spike"));
  record("ASM-004 storageState", stored === "persisted", { stored, stateFile });
  await freshContext.close();

  await withTimeout(page.goto(`${base}/other`, { waitUntil: "domcontentloaded" }), 20000, "goto other");
  await withTimeout(page.goBack({ waitUntil: "domcontentloaded" }), 20000, "back");
  const backTitle = await page.title();
  await withTimeout(page.goForward({ waitUntil: "domcontentloaded" }), 20000, "forward");
  const forwardTitle = await page.title();
  await withTimeout(page.reload({ waitUntil: "domcontentloaded" }), 20000, "reload");
  record("ASM nav", backTitle === "Spike Page A" && forwardTitle === "Spike Page B", { backTitle, forwardTitle });

  // ASM-005 crash recovery — last, isolated, watchdog-guarded
  let disconnected = false;
  browser.on("disconnected", () => { disconnected = true; });
  const cdp = await context.newCDPSession(page);
  cdp.send("Browser.crash").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const detected = disconnected || !browser.isConnected();
  browser = null; // do NOT call close() on the crashed browser (can hang)
  const browser2 = await withTimeout(chromium.launch({ headless: true }), 30000, "relaunch");
  const ctx2 = await browser2.newContext();
  const p2 = await ctx2.newPage();
  await withTimeout(p2.goto(`${base}/`, { waitUntil: "domcontentloaded" }), 20000, "goto after relaunch");
  record("ASM-005 crash recovery", detected && (await p2.title()) === "Spike Page A", { detected, relaunched: true });
  await ctx2.close();
  await browser2.close();
  browser = null;
} catch (error) {
  record("SPIKE FATAL", false, { error: String(error).slice(0, 300) });
} finally {
  try { await browser?.close(); } catch {}
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
}