import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog } from "../src/audit.js";
import { ConfigStore } from "../src/config.js";
import { registerGuidance } from "../src/guidance.js";
import { createServer } from "../src/server.js";
import type { BrowserManager } from "../src/session.js";
import * as tools from "../src/tools.js";

vi.mock("../src/tools.js", () => ({
  openPage: vi.fn(),
  readPage: vi.fn(),
  listButtons: vi.fn(),
  clickSelector: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  reloadPage: vi.fn(),
  waitForSelector: vi.fn(),
  saveState: vi.fn(),
  loadState: vi.fn(),
}));

const mockedOpenPage = vi.mocked(tools.openPage);
const mockedReadPage = vi.mocked(tools.readPage);
const mockedLoadState = vi.mocked(tools.loadState);

const fakeManager = {
  run: vi.fn(),
  withContext: vi.fn(),
  close: vi.fn(),
} as unknown as BrowserManager;

const openResult = {
  ok: true,
  title: "Example",
  url: "http://127.0.0.1:8080/",
  loadingState: "loaded",
  storageState: "none" as const,
};

const ALL_TOOLS = [
  "browser_open",
  "browser_read",
  "browser_buttons",
  "browser_click",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_wait",
  "browser_save_state",
  "browser_load_state",
];

describe("browser MCP server (TDD-112)", () => {
  let dir: string;
  let auditPath: string;
  let audit: AuditLog;
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedOpenPage.mockResolvedValue(openResult);
    mockedReadPage.mockResolvedValue({ ok: true, title: "Example", url: openResult.url, text: "hello", byteLength: 5, truncated: false });
    mockedLoadState.mockResolvedValue({ ok: true, url: "http://127.0.0.1:8080/" });

    dir = mkdtempSync(path.join(os.tmpdir(), "browser-mcp-server-"));
    const store = new ConfigStore(path.join(dir, "config.json"));
    await store.write({
      version: 1,
      settings: { headless: true, defaultTimeoutSeconds: 20, maxReadBytes: 204800, auditEnabled: true },
      allowedDomains: ["127.0.0.1"],
      storageStates: [],
    });
    auditPath = path.join(dir, "audit.jsonl");
    audit = new AuditLog({ filePath: auditPath, enabled: true });

    server = createServer({ store, manager: fakeManager, audit });
    registerGuidance(server);

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "browser-mcp-test", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers every browser_* tool plus help", async () => {
    const toolsList = await client.listTools();
    const names = toolsList.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(ALL_TOOLS));
    expect(names).toContain("browser_help");
  });

  it("browser_open delegates to openPage and returns a text result", async () => {
    const result = await client.callTool({ name: "browser_open", arguments: { url: "http://127.0.0.1:8080/" } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ ok: true, title: "Example" });
    expect(mockedOpenPage).toHaveBeenCalledTimes(1);
  });

  it("browser_read delegates to readPage with a maxBytes cap", async () => {
    await client.callTool({ name: "browser_read", arguments: { maxBytes: 4096 } });
    expect(mockedReadPage).toHaveBeenCalledWith(fakeManager, expect.anything(), { maxBytes: 4096 });
  });

  it("surfaces tool errors as isError text results", async () => {
    mockedOpenPage.mockRejectedValue(new Error("unauthorized_domain: example.com"));
    const result = await client.callTool({ name: "browser_open", arguments: { url: "http://127.0.0.1:8080/" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("unauthorized_domain");
  });

  it("records a success audit event with host and path only", async () => {
    await client.callTool({ name: "browser_open", arguments: { url: "http://127.0.0.1:8080/a?token=SECRET&x=1" } });
    await audit.flush();
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "browser_open", ok: true, host: "127.0.0.1", path: "/a" });
    expect(JSON.stringify(lines[0])).not.toContain("SECRET");
  });

  it("records a failure audit event without the token", async () => {
    mockedOpenPage.mockRejectedValue(new Error("boom"));
    await client.callTool({ name: "browser_open", arguments: { url: "http://127.0.0.1:8080/dash?session=TOP-SECRET" } });
    await audit.flush();
    const content = readFileSync(auditPath, "utf8");
    expect(content).toContain('"ok":false');
    expect(content).toContain('"host":"127.0.0.1"');
    expect(content).toContain('"error":"boom"');
    expect(content).not.toContain("TOP-SECRET");
  });

  it("browser_load_state delegates with the absolute path", async () => {
    const stateFile = path.join(dir, "state.json");
    await client.callTool({ name: "browser_load_state", arguments: { path: stateFile } });
    expect(mockedLoadState).toHaveBeenCalledWith(fakeManager, expect.anything(), { path: stateFile });
  });
});
