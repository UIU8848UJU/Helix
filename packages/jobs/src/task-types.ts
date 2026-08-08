// Generic Task Runtime domain types shared by ssh-mcp and browser-mcp.
// State names and the task-id prefix currently reuse the ssh-mcp job engine contract;
// browser generalization is deferred (see development/tdd_brief.md naming contract).

export const TASK_TYPES = [
  "build",
  "test",
  "docker-build",
  "compose-build",
  "deploy",
  "service",
  "data",
  "simulation",
  "run",
  "custom",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export type TaskState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost"
  | "not_found"
  | "unknown";

export const TASK_STATES: TaskState[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
  "not_found",
  "unknown",
];

export interface TaskStatus {
  taskId: string;
  type: TaskType | "unknown";
  name: string | null;
  command: string | null;
  state: TaskState;
  pid: number | null;
  exitCode: number | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logPath: string;
  logSizeBytes: number;
}

export interface TaskLogs {
  taskId: string;
  content: string;
  nextCursor: number;
  sizeBytes: number;
  eof: boolean;
}
