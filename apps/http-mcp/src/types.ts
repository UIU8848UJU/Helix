export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type ResponseType = "auto" | "json" | "text";
export interface ResponseFilter { fields?: string[]; arrayLimit?: number; maxStringBytes?: number; }
export interface HttpRequestInput {
  url: string; method?: HttpMethod; headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>; json?: unknown; body?: string;
  timeoutSeconds?: number; maxResponseBytes?: number; responseType?: ResponseType;
  responseFilter?: ResponseFilter;
}
export interface HttpConfig {
  version: 1; allowedDomains: string[]; allowPrivateNetworks: boolean; allowHttp: boolean;
  allowHttps: boolean; maxResponseBytes: number; defaultTimeoutSeconds: number;
  maxRedirects: number; auditEnabled: boolean;
}
export type HttpErrorCode = "timeout" | "dns_failed" | "connection_failed" | "tls_failed" | "http_error" | "response_too_large" | "invalid_json" | "policy_rejected" | "redirect_rejected";
export interface HttpError { code: HttpErrorCode; message: string; status?: number; recommendedStrategy?: "local_search" | "ssh_strategy"; }
export interface HttpSuccess { ok: true; status: number; contentType: string | null; url: string; elapsedMs: number; byteLength: number; truncated: boolean; data?: unknown; text?: string; }
export interface HttpFailure { ok: false; status?: number; contentType?: string | null; url: string; elapsedMs: number; byteLength?: number; error: HttpError; }
export type HttpResult = HttpSuccess | HttpFailure;
