#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore } from "./config.js";
import { registerGuidance } from "./guidance.js";
import { BrowserManager } from "./session.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const store = new ConfigStore();
  const config = await store.read();
  const manager = new BrowserManager({
    headless: config.settings.headless,
    defaultTimeoutSeconds: config.settings.defaultTimeoutSeconds,
  });

  const server = createServer({ store, manager });
  registerGuidance(server);

  const closeBrowser = (): void => {
    void manager.close().catch(() => {});
  };
  process.on("beforeExit", closeBrowser);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      closeBrowser();
      process.exit(0);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Helix Browser MCP running on stdio; config=${store.filePath}`);
}

main().catch((error) => {
  console.error("Helix Browser MCP failed to start:", error);
  process.exitCode = 1;
});
