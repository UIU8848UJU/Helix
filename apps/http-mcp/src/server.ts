import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConfigStore } from "./config.js";
import { executeHttpRequest } from "./http.js";
import { HTTP_METHODS } from "./types.js";
const requestSchema = { url: z.string().min(1), method: z.enum(HTTP_METHODS).optional(), headers: z.record(z.string()).optional(), query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), json: z.unknown().optional(), body: z.string().optional(), timeoutSeconds: z.number().min(0.1).max(300).optional(), maxResponseBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional(), responseType: z.enum(["auto", "json", "text"]).optional(), responseFilter: z.object({ fields: z.array(z.string().min(1)).optional(), arrayLimit: z.number().int().min(0).optional(), maxStringBytes: z.number().int().min(1).optional() }).optional() };
function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
export function createServer(store = new ConfigStore()): McpServer { const server = new McpServer({ name: "helix-http", version: "0.1.0" }); server.tool("http_request", "Perform a bounded, policy-controlled HTTP request.", requestSchema, async (input) => textResult(await executeHttpRequest(input, await store.read()))); return server; }
