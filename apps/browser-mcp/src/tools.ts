import { existsSync } from "node:fs";
import path from "node:path";
import type { BrowserConfig } from "./types.js";
import type { BrowserManager } from "./session.js";
import { resolveStorageState, validateOpenUrl } from "./policy.js";

export interface OpenResult {
  ok: boolean;
  title: string;
  url: string;
  loadingState: string;
  storageState: "loaded" | "missing" | "none";
}

export async function openPage(
  manager: BrowserManager,
  config: BrowserConfig,
  input: { url: string; timeoutSeconds?: number },
): Promise<OpenResult> {
  const validation = validateOpenUrl(input.url, config.allowedDomains);
  if (!validation.ok) {
    throw new Error(`browser_open rejected: ${validation.error?.code}: ${validation.error?.message}`);
  }
  const host = validation.host as string;
  const mapping = resolveStorageState(host, config.storageStates);
  const statePath = mapping && existsSync(mapping.path) ? mapping.path : undefined;
  const storageState: OpenResult["storageState"] = mapping
    ? (statePath ? "loaded" : "missing")
    : "none";
  const timeoutMs = (input.timeoutSeconds ?? config.settings.defaultTimeoutSeconds) * 1000;
  return manager.withContext(statePath, async (page) => {
    await page.goto(input.url.trim(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    let loadingState = "loaded";
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 5000) });
    } catch {
      loadingState = "networkidle-timeout";
    }
    return { ok: true, title: await page.title(), url: page.url(), loadingState, storageState };
  });
}

export interface ReadResult {
  ok: boolean;
  title: string;
  url: string;
  text: string;
  byteLength: number;
  truncated: boolean;
}

export async function readPage(
  manager: BrowserManager,
  config: BrowserConfig,
  input: { maxBytes?: number } = {},
): Promise<ReadResult> {
  const maxBytes = input.maxBytes ?? config.settings.maxReadBytes;
  return manager.run(async (page) => {
    const text = await page.locator("body").innerText().catch(() => "");
    const byteLength = Buffer.byteLength(text, "utf8");
    const truncated = byteLength > maxBytes;
    return {
      ok: true,
      title: await page.title(),
      url: page.url(),
      text: truncated ? Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8") : text,
      byteLength,
      truncated,
    };
  });
}
export interface ButtonInfo {
  id: string | null;
  selector: string;
  text: string | null;
  visible: boolean;
}

export interface ButtonsResult {
  ok: boolean;
  title: string;
  url: string;
  buttons: ButtonInfo[];
}

export async function listButtons(manager: BrowserManager): Promise<ButtonsResult> {
  return manager.run(async (page) => {
    const collected = await page
      .locator("button, input[type='button'], input[type='submit'], [role='button']")
      .evaluateAll((elements) =>
        elements.map((el, index) => {
          const element = el as HTMLElement;
          const id = element.id || null;
          const text = (element.innerText || element.getAttribute("value") || element.textContent || "").trim();
          const rect = element.getBoundingClientRect();
          return {
            id,
            text,
            visible: rect.width > 0 && rect.height > 0,
            index,
          };
        }),
      );
    return {
      ok: true,
      title: await page.title(),
      url: page.url(),
      buttons: collected.map((button) => ({
        id: button.id,
        selector: button.id ? `#${button.id}` : `button >> nth=${button.index}`,
        text: button.text || null,
        visible: button.visible,
      })),
    };
  });
}

export interface ClickResult {
  ok: boolean;
  title: string;
  url: string;
  dialog: string | null;
  popupClosed: boolean;
  error?: { code: "selector_not_found"; message: string };
}

export async function clickSelector(
  manager: BrowserManager,
  config: BrowserConfig,
  input: { selector: string; timeoutSeconds?: number },
): Promise<ClickResult> {
  const timeoutMs = Math.min((input.timeoutSeconds ?? config.settings.defaultTimeoutSeconds) * 1000, 5000);
  return manager.run(async (page) => {
    const locator = page.locator(input.selector).first();
    try {
      await locator.waitFor({ state: "attached", timeout: timeoutMs });
    } catch {
      return {
        ok: false,
        title: await page.title().catch(() => ""),
        url: page.url(),
        dialog: null,
        popupClosed: false,
        error: { code: "selector_not_found", message: `未找到元素: ${input.selector}` },
      };
    }

    let dialogMessage: string | null = null;
    const handleDialog = async (dialog: { message(): string; dismiss(): Promise<void> }): Promise<void> => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    };
    page.on("dialog", handleDialog);
    let popupClosed = false;
    try {
      const [popup] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 1500 }).catch(() => null),
        locator.click({ timeout: timeoutMs }),
      ]);
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        await popup.close().catch(() => {});
        popupClosed = true;
      }
    } finally {
      page.off("dialog", handleDialog);
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    return { ok: true, title: await page.title(), url: page.url(), dialog: dialogMessage, popupClosed };
  });
}

export interface NavResult {
  ok: boolean;
  title: string;
  url: string;
}

async function currentState(page: { title(): Promise<string>; url(): string }): Promise<NavResult> {
  return { ok: true, title: await page.title(), url: page.url() };
}

export async function goBack(manager: BrowserManager): Promise<NavResult> {
  return manager.run(async (page) => {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    return currentState(page);
  });
}

export async function goForward(manager: BrowserManager): Promise<NavResult> {
  return manager.run(async (page) => {
    await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
    return currentState(page);
  });
}

export async function reloadPage(manager: BrowserManager): Promise<NavResult> {
  return manager.run(async (page) => {
    await page.reload({ waitUntil: "domcontentloaded" });
    return currentState(page);
  });
}

export interface WaitResult {
  ok: boolean;
  title: string;
  url: string;
  visible: boolean;
  error?: { code: "timeout"; message: string };
}

export async function waitForSelector(
  manager: BrowserManager,
  config: BrowserConfig,
  input: { selector: string; timeoutSeconds?: number },
): Promise<WaitResult> {
  const timeoutMs = Math.min((input.timeoutSeconds ?? config.settings.defaultTimeoutSeconds) * 1000, 30000);
  return manager.run(async (page) => {
    try {
      await page.locator(input.selector).first().waitFor({ state: "visible", timeout: timeoutMs });
      return { ok: true, title: await page.title(), url: page.url(), visible: true };
    } catch {
      return {
        ok: false,
        title: await page.title().catch(() => ""),
        url: page.url(),
        visible: false,
        error: { code: "timeout", message: `等待元素超时: ${input.selector}` },
      };
    }
  });
}

export interface SaveStateResult {
  ok: boolean;
  path: string;
}

export async function saveState(
  manager: BrowserManager,
  config: BrowserConfig,
  input: { domain: string },
): Promise<SaveStateResult> {
  const mapping = resolveStorageState(input.domain, config.storageStates);
  if (!mapping) throw new Error(`未配置 storageState 映射: ${input.domain}`);
  return manager.run(async (page) => {
    await page.context().storageState({ path: mapping.path });
    return { ok: true, path: mapping.path };
  });
}

export interface LoadStateResult {
  ok: boolean;
  url: string;
}

export async function loadState(
  manager: BrowserManager,
  config: BrowserConfig,
  input: { path: string },
): Promise<LoadStateResult> {
  if (!path.posix.isAbsolute(input.path) && !path.win32.isAbsolute(input.path)) {
    throw new Error(`storageState path 必须为绝对路径: ${input.path}`);
  }
  if (!existsSync(input.path)) {
    throw new Error(`storageState 文件缺失: ${input.path}`);
  }
  return manager.withContext(input.path, async (page) => ({ ok: true, url: page.url() }));
}
