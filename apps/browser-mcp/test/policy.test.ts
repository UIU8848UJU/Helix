import { describe, expect, it } from "vitest";
import { resolveStorageState, validateOpenUrl } from "../src/policy.js";

describe("browser URL policy (TDD-103)", () => {
  it("accepts an https URL on an allowed domain", () => {
    const result = validateOpenUrl("https://example.com/page?a=1", ["example.com"]);
    expect(result.ok).toBe(true);
    expect(result.scheme).toBe("https");
    expect(result.host).toBe("example.com");
  });

  it("accepts subdomains of an allowed domain", () => {
    const result = validateOpenUrl("https://intranet.example.com/x", ["example.com"]);
    expect(result.ok).toBe(true);
    expect(result.host).toBe("intranet.example.com");
  });

  it("rejects dangerous schemes without navigating", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "about:blank",
      "chrome://settings",
    ]) {
      const result = validateOpenUrl(url, ["example.com"]);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_scheme");
    }
  });

  it("rejects an unauthorized domain", () => {
    const result = validateOpenUrl("https://evil.com/x", ["example.com"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unauthorized_domain");
  });

  it("does not treat a lookalike suffix as allowed", () => {
    const result = validateOpenUrl("https://evil-example.com/x", ["example.com"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unauthorized_domain");
  });

  it("rejects URLs with embedded credentials", () => {
    const result = validateOpenUrl("https://user:pass@example.com/", ["example.com"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_url");
  });

  it("rejects malformed URLs", () => {
    const result = validateOpenUrl("not a url", ["example.com"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_url");
  });

  it("denies everything when the allowlist is empty", () => {
    const result = validateOpenUrl("https://example.com/", []);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unauthorized_domain");
  });
});

describe("storageState mapping resolution (TDD-105)", () => {
  const mappings = [
    { domain: "internal.corp", path: "/states/internal.json" },
    { domain: "a.internal.corp", path: "/states/a.json" },
    { domain: "example.com", path: "/states/example.json" },
  ];

  it("resolves an exact domain match", () => {
    const result = resolveStorageState("internal.corp", mappings);
    expect(result?.path).toBe("/states/internal.json");
  });

  it("picks the longest suffix match for a subdomain", () => {
    const result = resolveStorageState("deep.a.internal.corp", mappings);
    expect(result?.path).toBe("/states/a.json");
  });

  it("returns null when no domain matches", () => {
    expect(resolveStorageState("evil.com", mappings)).toBeNull();
  });

  it("matches case-insensitively", () => {
    const result = resolveStorageState("EXAMPLE.COM", mappings);
    expect(result?.path).toBe("/states/example.json");
  });
});
