export type AuditCommandMode = "plain" | "hash";

export interface SudoPolicy {
  enabled: boolean;
  allow: string[];
}

export interface HostConfig {
  hostname: string;
  port?: number;
  username?: string;
  identityFile?: string;
  proxyJump?: string | null;
  tags?: string[];
  allowedRemotePaths: string[];
  sudo: SudoPolicy;
}

export interface GlobalSettings {
  allowHostMutation: boolean;
  defaultTimeoutSeconds: number;
  maxOutputBytes: number;
  maxConcurrentCommands: number;
  strictHostKeyChecking: boolean;
  auditEnabled: boolean;
  auditCommandMode: AuditCommandMode;
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
