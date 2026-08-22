export type AuditCommandMode = "plain" | "hash";
export type AuthConfig =
  | { type: "openssh" }
  | { type: "windows-credential"; credentialRef: string };
export type SudoMode = "disabled" | "reviewed-nopasswd" | "reviewed-password";

export interface SudoPolicy {
  mode: SudoMode;
  credentialRef?: string;
  allow: string[];
  approvalTtlSeconds: number;
}

export interface HostConfig {
  hostname: string;
  os?: "unix" | "windows";
  port?: number;
  username?: string;
  identityFile?: string;
  proxyJump?: string | null;
  tags?: string[];
  defaultWorkingDir?: string;
  allowedRemotePaths: string[];
  auth: AuthConfig;
  sudo: SudoPolicy;
}

export interface GlobalSettings {
  allowHostMutation: boolean;
  allowPolicyMutation: boolean;
  defaultTimeoutSeconds: number;
  maxOutputBytes: number;
  maxConcurrentCommands: number;
  strictHostKeyChecking: boolean;
  auditEnabled: boolean;
  auditCommandMode: AuditCommandMode;
  credentialBrokerPath?: string | null;
}

export interface HelixConfig {
  version: 1;
  settings: GlobalSettings;
  hosts: Record<string, HostConfig>;
}

export interface ExecutionResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdoutRef?: string;
  stderrRef?: string;
  stdoutSize?: number;
  stderrSize?: number;
}

export interface RemoteExecutionOptions {
  timeoutSeconds?: number;
  cwd?: string;
  env?: Record<string, string>;
  sourceScripts?: string[];
}

export interface ProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  tool: string;
  host?: string;
  operation?: string;
  command?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  success: boolean;
  error?: string;
}

export interface EnvironmentProbe {
  os: {
    name: string | null;
    version: string | null;
    prettyName: string | null;
    kernel: string | null;
  };
  arch: string | null;
  shell: string | null;
  cwd: string | null;
  tools: Record<string, string | null>;
  containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
  }>;
  candidateSourceScripts: string[];
}

export interface BrokerResponse {
  ok: boolean;
  exists?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutRef?: string;
  stderrRef?: string;
  stdoutSize?: number;
  stderrSize?: number;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
}

export interface SpoolReadResult {
  content: string;
  nextCursor: number;
  eof: boolean;
  size: number;
}

export interface SpoolTailResult {
  content: string;
  size: number;
  start: number;
}

export interface SpoolMatch {
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SpoolSearchResult {
  matches: SpoolMatch[];
}

export type TerminalState = "running" | "finished" | "closed";

/** Summary-first envelope returned by terminal_open / terminal_status. */
export interface TerminalStatusResult {
  terminalId: string;
  state: TerminalState;
  exitCode?: number;
  size: number;
  tail: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  durationMs: number;
}

export interface TerminalReadResult {
  content: string;
  nextCursor: number;
  eof: boolean;
  size: number;
}

export interface TerminalTailResult {
  content: string;
  size: number;
}

export interface PendingApproval {
  version: 1;
  requestId: string;
  hostAlias: string;
  hostname: string;
  username?: string;
  command: string;
  commandHash: string;
  reason: string;
  createdAt: string;
  expiresAtUnixMs: number;
}
