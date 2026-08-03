#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAdminTools } from "./admin.js";
import { ConfigStore } from "./config.js";
import { registerGuidance } from "./guidance.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const store = new ConfigStore();
  await store.read();

  const server = createServer(store);
  registerAdminTools(server, store);
  registerGuidance(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Helix SSH MCP running on stdio; config=${store.filePath}`);
}

main().catch((error) => {
  console.error("Helix SSH MCP failed to start:", error);
  process.exitCode = 1;
});
