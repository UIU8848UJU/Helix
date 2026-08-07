export type WorkerProvider = "claude" | "gpt";
export type WorkerMode = "answer" | "workspace";

export interface ModelWorkerSettings {
  claudeCommand: string;
  gptCommand: string;
  allowedWorkingDirectories: string[];
  defaultWorkingDirectory: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  maxOutputBytes: number;
  maxPromptChars: number;
  maxConcurrentWorkers: number;
  auditEnabled: boolean;
  auditPath?: string;
}

export interface ModelWorkerConfig {
  version: 1;
  settings: ModelWorkerSettings;
}

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
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

export type ProcessRunner = (
  executable: string,
  args: string[],
  options: ProcessOptions,
) => Promise<ExecutionResult>;

export interface WorkerRequest {
  provider: WorkerProvider;
  prompt: string;
  cwd: string;
  mode: WorkerMode;
  model?: string;
  timeoutSeconds: number;
}

export interface WorkerResponse {
  provider: WorkerProvider;
  ok: boolean;
  response: string;
  sessionId?: string;
  usage?: unknown;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

export interface ProviderInvocation {
  executable: string;
  args: string[];
  stdin: string;
}

export interface ProviderStatus {
  installed: boolean;
  authenticated: boolean | null;
  version?: string;
  detail?: string;
}

export interface ModelWorkerStatus {
  claude: ProviderStatus;
  gpt: ProviderStatus;
  config: {
    allowedWorkingDirectories: string[];
    defaultWorkingDirectory: string;
    defaultTimeoutSeconds: number;
    maxTimeoutSeconds: number;
    maxConcurrentWorkers: number;
  };
}

export interface AuditEvent {
  timestamp: string;
  requestId: string;
  provider: WorkerProvider;
  mode: WorkerMode;
  cwd: string;
  promptHash: string;
  model?: string;
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}
