import { chromium } from "playwright";
setTimeout(() => { console.log("WATCHDOG_FORCE_EXIT"); process.exit(2); }, 30000).unref();
const browser = await chromium.launch({ headless: true });
let disconnected = false;
browser.on("disconnected", () => { disconnected = true; console.log("EVENT disconnected"); });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("data:text/html,<p>x</p>");
const cdp = await context.newCDPSession(page);
console.log("before crash");
try { await cdp.send("Browser.crash"); } catch (e) { console.log("crash send error:", String(e).slice(0,120)); }
console.log("after crash send");
await new Promise((r) => setTimeout(r, 2000));
console.log("connected:", browser.isConnected(), "event:", disconnected);
console.log("relaunching...");
const b2 = await chromium.launch({ headless: true });
console.log("relaunch ok");
await b2.close();
process.exit(0);