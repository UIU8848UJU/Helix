export type OpenUrlErrorCode = "invalid_scheme" | "unauthorized_domain" | "invalid_url";

export interface OpenUrlValidation {
  ok: boolean;
  scheme?: string;
  host?: string;
  error?: { code: OpenUrlErrorCode; message: string };
}

const ALLOWED_SCHEMES = new Set(["https", "http"]);

/**
 * Validate a URL before navigation (CON-S004 / NFR-SEC-002).
 * Scheme allowlist: https/http only. Domain allowlist matches the exact host
 * or any subdomain. URLs with embedded credentials are rejected.
 */
export function validateOpenUrl(input: string, allowedDomains: string[]): OpenUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, error: { code: "invalid_url", message: `URL 无法解析: ${input}` } };
  }

  const scheme = parsed.protocol.slice(0, -1);
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { ok: false, error: { code: "invalid_scheme", message: `禁止的 scheme: ${scheme}` } };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: { code: "invalid_url", message: "URL 不允许内嵌凭据" } };
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = allowedDomains.some((domain) => {
    const candidate = domain.trim().toLowerCase().replace(/^\./, "");
    return host === candidate || host.endsWith(`.${candidate}`);
  });
  if (!allowed) {
    return { ok: false, error: { code: "unauthorized_domain", message: `域名未授权: ${host}` } };
  }

  return { ok: true, scheme, host };
}
export interface StorageStateMappingLike {
  domain: string;
  path: string;
}

/**
 * Pick the storageState mapping for a URL host using longest suffix match
 * (CON-S005 / ADR-003). Returns null when no configured domain matches.
 */
export function resolveStorageState(
  urlHost: string,
  mappings: StorageStateMappingLike[],
): StorageStateMappingLike | null {
  const host = urlHost.toLowerCase();
  let best: StorageStateMappingLike | null = null;
  let bestLength = -1;
  for (const mapping of mappings) {
    const domain = mapping.domain.trim().toLowerCase().replace(/^\./, "");
    if (host === domain || host.endsWith(`.${domain}`)) {
      if (domain.length > bestLength) {
        best = mapping;
        bestLength = domain.length;
      }
    }
  }
  return best;
}
