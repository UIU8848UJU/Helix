import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuditLog, newRequestId, sanitizeUrl } from "./audit.js";
import { ConfigStore } from "./config.js";
import { BrowserManager } from "./session.js";
import {
  clickSelector,
  goBack,
  goForward,
  listButtons,
  loadState,
  openPage,
  readPage,
  reloadPage,
  saveState,
  waitForSelector,
} from "./tools.js";
import type { BrowserConfig } from "./types.js";

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwInvalid(error: unknown): never {
  if (error instanceof McpError) throw error;
  throw new McpError(ErrorCode.InvalidParams, errorMessage(error));
}

export interface CreateServerOptions {
  store?: ConfigStore;
  manager?: BrowserManager;
  audit?: AuditLog;
}

/**
 * Browser MCP server over stdio (ADR-005). All browser_* tools run on the
 * shared BrowserManager singleton; every call is recorded in the JSONL audit
 * with host/path only (query stripped, NFR-AUD-001).
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const store = options.store ?? new ConfigStore();
  const manager = options.manager ?? new BrowserManager({ headless: true, defaultTimeoutSeconds: 20 });
  const audit = options.audit ?? new AuditLog();
  const server = new McpServer({ name: "helix-browser", version: "0.1.0" });

  const loadConfig = async (): Promise<BrowserConfig> => store.read();

  const runWithAudit = async (input: {
    tool: string;
    url?: string;
    run: () => Promise<unknown>;
  }): Promise<unknown> => {
    const started = Date.now();
    const requestId = newRequestId();
    const settings = (await loadConfig()).settings;
    audit.setEnabled(settings.auditEnabled);
    const sanitized = input.url ? sanitizeUrl(input.url) : null;
    const base = {
      ts: new Date().toISOString(),
      requestId,
      tool: input.tool,
      host: sanitized?.host,
      path: sanitized?.path,
    };
    try {
      const result = await input.run();
      audit.record({ ...base, ok: true, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      audit.record({ ...base, ok: false, durationMs: Date.now() - started, error: errorMessage(error) });
      throw error;
    }
  };

  server.tool(
    "browser_open",
    "Open a URL in the shared browser and report title, final URL and load state.",
    {
      url: z.string(),
      timeoutSeconds: z.number().int().min(1).max(60).optional(),
    },
    async ({ url, timeoutSeconds }) => {
      try {
        return textResult(await runWithAudit({
          tool: "browser_open",
          url,
          run: async () => openPage(manager, await loadConfig(), { url, timeoutSeconds }),
        }));
      } catch (error) { throwInvalid(error); }
    },
  );

  server.tool(
    "browser_read",
    "Read the visible text of the current page, optionally truncated.",
    { maxBytes: z.number().int().min(1024).max(10 * 1024 * 1024).optional() },
    async ({ maxBytes }) => {
      try {
        return textResult(await runWithAudit({
          tool: "browser_read",
          run: async () => readPage(manager, await loadConfig(), { maxBytes }),
        }));
      } catch (error) { throwInvalid(error); }
    },
  );

  server.tool(
    "browser_buttons",
    "List buttons on the current page with stable selectors and visibility.",
    {},
    async () => {
      try {
        return textResult(await runWithAudit({ tool: "browser_buttons", run: () => listButtons(manager) }));
      } catch (error) { throwInvalid(error); }
    },
  );

  server.tool(
    "browser_click",
    "Click a selector, auto-dismiss dialogs and close target=_blank popups.",
    {
      selector: z.string(),
      timeoutSeconds: z.number().int().min(1).max(60).optional(),
    },
    async ({ selector, timeoutSeconds }) => {
      try {
        return textResult(await runWithAudit({
          tool: "browser_click",
          run: async () => clickSelector(manager, await loadConfig(), { selector, timeoutSeconds }),
        }));
      } catch (error) { throwInvalid(error); }
    },
  );

  server.tool("browser_back", "Go back one history entry.", {}, async () => {
    try { return textResult(await runWithAudit({ tool: "browser_back", run: () => goBack(manager) })); }
    catch (error) { throwInvalid(error); }
  });

  server.tool("browser_forward", "Go forward one history entry.", {}, async () => {
    try { return textResult(await runWithAudit({ tool: "browser_forward", run: () => goForward(manager) })); }
    catch (error) { throwInvalid(error); }
  });

  server.tool("browser_reload", "Reload the current page.", {}, async () => {
    try { return textResult(await runWithAudit({ tool: "browser_reload", run: () => reloadPage(manager) })); }
    catch (error) { throwInvalid(error); }
  });

  server.tool(
    "browser_wait",
    "Wait for a selector to become visible on the current page.",
    {
      selector: z.string(),
      timeoutSeconds: z.number().int().min(1).max(60).optional(),
    },
    async ({ selector, timeoutSeconds }) => {
      try {
        return textResult(await runWithAudit({
          tool: "browser_wait",
          run: async () => waitForSelector(manager, await loadConfig(), { selector, timeoutSeconds }),
        }));
      } catch (error) { throwInvalid(error); }
    },
  );

  server.tool(
    "browser_save_state",
    "Persist the current login state (cookies + localStorage) for a configured domain.",
    { domain: z.string() },
    async ({ domain }) => {
      try {
        return textResult(await runWithAudit({
          tool: "browser_save_state",
          run: async () => saveState(manager, await loadConfig(), { domain }),
        }));
      } catch (error) { throwInvalid(error); }
    },
  );

  server.tool(
    "browser_load_state",
    "Explicitly load a saved storageState file into a fresh context.",
    { path: z.string() },
    async ({ path: statePath }) => {
      try {
        return textResult(await runWithAudit({
          tool: "browser_load_state",
          run: async () => loadState(manager, await loadConfig(), { path: statePath }),
        }));
      } catch (error) { throwInvalid(error); }
    },
  );

  return server;
}
