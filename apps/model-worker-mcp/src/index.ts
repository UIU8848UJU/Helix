#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  if (process.env.HELIX_MODEL_WORKER_ACTIVE === "1") {
    throw new Error("Nested Helix Model Worker startup was blocked to prevent recursion");
  }
  const store = new ConfigStore();
  const config = await store.read();
  const server = createServer(config, store.filePath);
  await server.connect(new StdioServerTransport());
  console.error(`Helix Model Worker MCP running on stdio; config=${store.filePath}`);
}

main().catch((error) => {
  console.error("Helix Model Worker MCP failed to start:", error);
  process.exitCode = 1;
});
