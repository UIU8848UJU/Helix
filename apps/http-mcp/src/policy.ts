import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { HttpConfig } from "./types.js";

export class RequestPolicyError extends Error {
  constructor(public readonly code: "policy_rejected" | "dns_failed", message: string) { super(message); this.name = "RequestPolicyError"; }
}
function ipv4Number(value: string): number | null {
  const parts = value.split(".").map(Number); if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!);
}
function isPrivateIpv4(value: string): boolean {
  const number = ipv4Number(value); if (number === null) return false;
  const inRange = (start: number, end: number) => number >= start && number <= end;
  return inRange(0x0a000000, 0x0affffff) || inRange(0xac100000, 0xac1fffff) || inRange(0xc0a80000, 0xc0a8ffff);
}
function isLoopbackOrLinkLocalIpv4(value: string): boolean {
  const number = ipv4Number(value); if (number === null) return false;
  return (number >= 0x7f000000 && number <= 0x7fffffff) || (number >= 0xa9fe0000 && number <= 0xa9feffff) || number === 0;
}
function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}
export function isRestrictedAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address) || isLoopbackOrLinkLocalIpv4(address);
  if (isIP(address) === 6) return address.toLowerCase().startsWith("::ffff:") ? isRestrictedAddress(address.slice(7)) : isPrivateIpv6(address);
  return false;
}
function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean { return allowedDomains.length === 0 || allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)); }
export interface ValidatedUrl { url: URL; addresses: string[]; }
export async function validateTarget(rawUrl: string, config: HttpConfig): Promise<ValidatedUrl> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new RequestPolicyError("policy_rejected", "url must be an absolute http or https URL"); }
  const protocolAllowed = url.protocol === "http:" ? config.allowHttp : url.protocol === "https:" ? config.allowHttps : false;
  if (!protocolAllowed) throw new RequestPolicyError("policy_rejected", `protocol ${url.protocol} is not allowed`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || !isAllowedDomain(hostname, config.allowedDomains)) throw new RequestPolicyError("policy_rejected", `domain is not allowed: ${hostname}`);
  let addresses: string[];
  try { addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; throw new RequestPolicyError("dns_failed", `DNS lookup failed for ${hostname}${code ? ` (${code})` : ""}`); }
  if (addresses.length === 0) throw new RequestPolicyError("dns_failed", `DNS lookup returned no address for ${hostname}`);
  for (const address of addresses) {
    if (address === "169.254.169.254") throw new RequestPolicyError("policy_rejected", "cloud metadata endpoint is never allowed");
    if (isRestrictedAddress(address) && !config.allowPrivateNetworks) throw new RequestPolicyError("policy_rejected", `private, loopback, or link-local address is not allowed: ${address}`);
  }
  return { url, addresses };
}
