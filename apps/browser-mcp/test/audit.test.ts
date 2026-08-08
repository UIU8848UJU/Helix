import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, newRequestId, sanitizeUrl } from "../src/audit.js";

describe("browser audit URL sanitization (TDD-111)", () => {
  it("keeps host and path, strips query/hash/credentials", () => {
    const result = sanitizeUrl("https://user:pass@example.com/a/b?token=secret#frag");
    expect(result).toEqual({ host: "example.com", path: "/a/b" });
  });

  it("normalizes empty path and lowercases the host", () => {
    expect(sanitizeUrl("HTTP://Example.COM")).toEqual({ host: "example.com", path: "/" });
  });

  it("returns null for an unparseable url", () => {
    expect(sanitizeUrl("not a url")).toBeNull();
  });
});

describe("browser audit JSONL writer (TDD-111)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes one JSON line per event", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "browser-mcp-audit-"));
    const filePath = path.join(dir, "audit.jsonl");
    const audit = new AuditLog({ filePath, enabled: true });
    audit.record({
      ts: "2026-08-08T10:00:00.000Z",
      requestId: "req-1",
      tool: "browser_open",
      ok: true,
      durationMs: 12,
      host: "example.com",
      path: "/a",
    });
    audit.record({
      ts: "2026-08-08T10:00:01.000Z",
      requestId: "req-2",
      tool: "browser_read",
      ok: false,
      durationMs: 3,
      error: "boom",
    });
    await audit.flush();
    const lines = readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tool: "browser_open", ok: true, host: "example.com", path: "/a" });
    expect(lines[1]).toMatchObject({ tool: "browser_read", ok: false, error: "boom" });
    expect(lines[1]).not.toHaveProperty("host");
  });

  it("never records tokens from query strings", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "browser-mcp-audit-"));
    const filePath = path.join(dir, "audit.jsonl");
    const audit = new AuditLog({ filePath, enabled: true });
    const { host, path: pathname } = sanitizeUrl("https://internal.example.com/dash?session=SECRET-TOKEN&x=1")!;
    audit.record({ ts: "t", requestId: "req-3", tool: "browser_open", ok: true, durationMs: 1, host, path: pathname });
    await audit.flush();
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("internal.example.com");
    expect(content).toContain("/dash");
    expect(content).not.toContain("SECRET-TOKEN");
  });

  it("writes nothing when audit is disabled", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "browser-mcp-audit-"));
    const filePath = path.join(dir, "audit.jsonl");
    const audit = new AuditLog({ filePath, enabled: false });
    audit.record({ ts: "t", requestId: "req-4", tool: "browser_open", ok: true, durationMs: 1 });
    await audit.flush();
    expect(existsSync(filePath)).toBe(false);
  });

  it("warns instead of throwing when the audit write fails", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "browser-mcp-audit-"));
    const blocker = path.join(dir, "blocker");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audit = new AuditLog({ filePath: path.join(blocker, "audit.jsonl"), enabled: true });
    writeFileSync(blocker, "x");
    audit.record({ ts: "t", requestId: "req-5", tool: "browser_open", ok: true, durationMs: 1 });
    await expect(audit.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("browser audit request ids (TDD-111)", () => {
  it("generates unique non-empty ids", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
