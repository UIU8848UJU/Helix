import type { ResponseFilter } from "./types.js";
export interface FilterResult { value: unknown; truncated: boolean; }
function cropString(value: string, maxBytes: number | undefined): FilterResult { if (maxBytes === undefined || Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false }; return { value: Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true }; }
function selectFields(value: unknown, fields: string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split(".").filter(Boolean); let source: unknown = value;
    for (const part of parts) { if (!source || typeof source !== "object" || !(part in source)) { source = undefined; break; } source = (source as Record<string, unknown>)[part]; }
    if (source === undefined || parts.length === 0) continue;
    let target = selected; for (const part of parts.slice(0, -1)) { const existing = target[part]; if (!existing || typeof existing !== "object" || Array.isArray(existing)) target[part] = {}; target = target[part] as Record<string, unknown>; }
    target[parts[parts.length - 1]!] = source;
  }
  return selected;
}
function crop(value: unknown, filter: ResponseFilter): FilterResult {
  if (typeof value === "string") return cropString(value, filter.maxStringBytes);
  if (Array.isArray(value)) { const limit = filter.arrayLimit === undefined ? value.length : Math.min(value.length, filter.arrayLimit); let truncated = limit < value.length; const output: unknown[] = []; for (const item of value.slice(0, limit)) { const result = crop(item, filter); output.push(result.value); truncated ||= result.truncated; } return { value: output, truncated }; }
  if (value && typeof value === "object") { let truncated = false; const output: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) { const result = crop(item, filter); output[key] = result.value; truncated ||= result.truncated; } return { value: output, truncated }; }
  return { value, truncated: false };
}
export function applyResponseFilter(value: unknown, filter: ResponseFilter | undefined): FilterResult { if (!filter) return { value, truncated: false }; const selected = filter.fields?.length ? selectFields(value, filter.fields) : value; const result = crop(selected, filter); return { value: result.value, truncated: result.truncated || selected !== value }; }
