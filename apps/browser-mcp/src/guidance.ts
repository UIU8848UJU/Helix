import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const BROWSER_SERVER_INSTRUCTIONS = [
  "The browser MCP keeps one shared Chromium session; all browser_* tools act on that single page.",
  "Only http/https URLs inside the configured allowedDomains can be opened; the default is deny-all.",
  "browser_open applies the matching storageState file automatically when the domain is mapped; browser_save_state persists login state, browser_load_state applies a saved state explicitly.",
  "Credentials never leave the machine: cookies and localStorage stay in storageState files and never appear in tool results or audit logs.",
  "After a browser crash the session is recreated automatically on the next call.",
].join("\n");

export const HELP_TOPICS = ["overview", "limits", "login"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  browser_open:
    "Open a URL in the shared browser and report title, final URL and load state. The URL must be http/https and inside allowedDomains.",
  browser_read:
    "Read the visible text of the current page, with byteLength, truncated flag and an optional maxBytes cap.",
  browser_buttons:
    "List buttons on the current page with stable selectors, text and visibility.",
  browser_click:
    "Click a selector, auto-dismiss alert/confirm/prompt dialogs and close target=_blank popups.",
  browser_back:
    "Go back one history entry on the shared page.",
  browser_forward:
    "Go forward one history entry on the shared page.",
  browser_reload:
    "Reload the current page.",
  browser_wait:
    "Wait for a selector to become visible on the current page.",
  browser_save_state:
    "Persist the current login state (cookies + localStorage) to the storageState file mapped for a domain.",
  browser_load_state:
    "Explicitly load a saved storageState file into a fresh context.",
};

export const HELP: Record<HelpTopic, object> = {
  overview: {
    workflow: [
      "Start with browser_open to navigate to a URL inside the allowlist.",
      "Use browser_read / browser_buttons to inspect the page, then browser_click / browser_wait to interact.",
      "Use browser_back / browser_forward / browser_reload to move through history.",
    ],
  },
  limits: {
    allowedSchemes: ["http", "https"],
    defaultPolicy: "Deny all domains until added to allowedDomains in the config.",
    readCap: "browser_read truncates at maxReadBytes (default 204800) and reports truncated=true.",
    session: "One shared page; serialized operations; lazy relaunch after a browser crash.",
  },
  login: {
    workflow: [
      "Configure a storageStates mapping {domain, path} with an absolute path.",
      "Save state once from a real session, then browser_open auto-loads it for that domain.",
      "Call browser_load_state with an absolute path to apply a state explicitly.",
    ],
    security: "Cookies and localStorage never enter tool results or audit logs; audit records host/path only.",
  },
};

export function getBrowserHelp(topic: HelpTopic = "overview"): object {
  return { topic, ...HELP[topic] };
}

type MutableRegisteredTool = {
  description?: string;
};

type McpServerInternals = {
  _registeredTools?: Record<string, MutableRegisteredTool>;
  server: {
    _instructions?: string;
  };
};

export function registerGuidance(server: McpServer): void {
  const internals = server as unknown as McpServerInternals;
  internals.server._instructions = BROWSER_SERVER_INSTRUCTIONS;

  const registeredTools = internals._registeredTools ?? {};
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    const tool = registeredTools[name];
    if (tool) tool.description = description;
  }

  if (!registeredTools.browser_help) {
    server.tool(
      "browser_help",
      "Read the browser MCP workflow: overview, URL limits, and login state management.",
      { topic: z.enum(HELP_TOPICS).optional() },
      async ({ topic }) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(getBrowserHelp(topic ?? "overview"), null, 2),
        }],
      }),
    );
  }
}
