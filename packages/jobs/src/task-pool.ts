import { randomUUID } from "node:crypto";
import { assertTaskId } from "./task-id.js";
import type { TaskLogs, TaskState, TaskStatus, TaskType } from "./task-types.js";

/**
 * Input handed to a TaskExecutor for one task. The executor is the transport
 * adapter (SSH job engine, Browser runtime, ...); TaskPool is generic and only
 * knows how to schedule and track tasks through this interface.
 */
export interface TaskSpec {
  taskId: string;
  type: TaskType;
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface TaskExecutor {
  start(task: TaskSpec): Promise<Record<string, unknown>>;
  status(taskId: string): Promise<Record<string, unknown>>;
  cancel(taskId: string, graceSeconds?: number): Promise<Record<string, unknown>>;
}

export interface TaskSubmitOptions {
  command: string;
  type?: TaskType;
  name?: string;
  priority?: number;
  timeoutMs?: number;
  taskId?: string;
}

export interface TaskPoolOptions {
  executor: TaskExecutor;
  workerLimit: number;
  queueLimit: number;
  retentionLimit: number;
  defaultTimeoutMs?: number;
  /** Injectable clock in milliseconds since epoch; mandatory for deterministic timeout/retention tests. */
  clock?: () => number;
}

export interface TaskPoolMetrics {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  completed: number;
  queueCapacity: number;
  workerLimit: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

interface TaskRecord {
  taskId: string;
  type: TaskType;
  name: string;
  command: string;
  state: TaskState;
  priority: number;
  timeoutMs?: number;
  deadlineAt: number | null;
  createdAt: string;
  startedAt: string | null;
  startedAtMs: number | null;
  finishedAt: string | null;
  pid: number | null;
  exitCode: number | null;
  logPath: string;
  logSizeBytes: number;
  latencyMs: number | null;
}

const terminalStates: TaskState[] = ["succeeded", "failed", "cancelled"];

export class TaskPool {
  private readonly executor: TaskExecutor;
  private readonly workerLimit: number;
  private readonly queueLimit: number;
  private readonly retentionLimit: number;
  private readonly defaultTimeoutMs?: number;
  private readonly clock: () => number;

  private readonly tasks = new Map<string, TaskRecord>();
  private readonly queue: TaskRecord[] = [];
  private readonly completedOrder: string[] = [];
  private runningCount = 0;

  constructor(options: TaskPoolOptions) {
    this.executor = options.executor;
    this.workerLimit = options.workerLimit;
    this.queueLimit = options.queueLimit;
    this.retentionLimit = options.retentionLimit;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.clock = options.clock ?? (() => Date.now());
  }

  async submit(input: TaskSubmitOptions): Promise<TaskStatus> {
    const taskId = input.taskId ?? `job-${randomUUID()}`;
    assertTaskId(taskId);
    const record: TaskRecord = {
      taskId,
      type: input.type ?? "custom",
      name: input.name ?? input.command,
      command: input.command,
      state: "queued",
      priority: input.priority ?? 0,
      timeoutMs: input.timeoutMs,
      deadlineAt: null,
      createdAt: this.nowIso(),
      startedAt: null,
      startedAtMs: null,
      finishedAt: null,
      pid: null,
      exitCode: null,
      logPath: "",
      logSizeBytes: 0,
      latencyMs: null,
    };

    if (this.runningCount < this.workerLimit) {
      this.tasks.set(taskId, record);
      this.startTask(record);
    } else {
      if (this.queue.length >= this.queueLimit) {
        throw new Error(`task queue full (capacity ${this.queueLimit})`);
      }
      this.tasks.set(taskId, record);
      this.queue.push(record);
      this.queue.sort((a, b) => b.priority - a.priority);
    }

    await this.settle();
    return this.toStatus(record);
  }

  async status(taskId: string): Promise<TaskStatus> {
    await this.settle();
    this.evaluateTimeouts();
    const record = this.tasks.get(taskId);
    if (!record) return this.notFoundStatus(taskId);
    return this.toStatus(record);
  }

  async cancel(taskId: string, graceSeconds?: number): Promise<TaskStatus> {
    await this.settle();
    const record = this.tasks.get(taskId);
    if (!record) return this.notFoundStatus(taskId);
    if (record.state === "queued" || record.state === "running") {
      try {
        await this.executor.cancel(taskId, graceSeconds);
      } catch {
        // cancellation notification failure does not block the pool transition
      }
      if (record.state === "queued") {
        const index = this.queue.indexOf(record);
        if (index >= 0) this.queue.splice(index, 1);
      }
      if (record.state === "queued" || record.state === "running") {
        this.transition(record, "cancelled", {});
      }
    }
    return this.toStatus(record);
  }

  metrics(): TaskPoolMetrics {
    const retained = [...this.tasks.values()].filter(
      (record) => record.state !== "queued" && record.state !== "running",
    );
    const latencies = retained
      .map((record) => record.latencyMs)
      .filter((value): value is number => value !== null);
    const sum = latencies.reduce((acc, value) => acc + value, 0);
    return {
      queued: this.queue.length,
      running: this.runningCount,
      succeeded: retained.filter((record) => record.state === "succeeded").length,
      failed: retained.filter((record) => record.state === "failed").length,
      cancelled: retained.filter((record) => record.state === "cancelled").length,
      completed: retained.length,
      queueCapacity: this.queueLimit,
      workerLimit: this.workerLimit,
      avgLatencyMs: latencies.length > 0 ? sum / latencies.length : 0,
      maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    };
  }

  private startTask(record: TaskRecord): void {
    record.state = "running";
    record.startedAt = this.nowIso();
    record.startedAtMs = this.clock();
    record.deadlineAt =
      record.timeoutMs !== undefined
        ? record.startedAtMs + record.timeoutMs
        : this.defaultTimeoutMs !== undefined
          ? record.startedAtMs + this.defaultTimeoutMs
          : null;
    this.runningCount += 1;

    void this.executor
      .start({
        taskId: record.taskId,
        type: record.type,
        name: record.name,
        command: record.command,
        timeoutMs: record.timeoutMs ?? this.defaultTimeoutMs,
      })
      .then(
        (result) => {
          if (record.state === "running") this.transition(record, "succeeded", result);
        },
        () => {
          if (record.state === "running") this.transition(record, "failed", {});
        },
      );
  }

  private evaluateTimeouts(): void {
    const now = this.clock();
    for (const record of this.tasks.values()) {
      if (record.state === "running" && record.deadlineAt !== null && now > record.deadlineAt) {
        this.transition(record, "failed", {});
      }
    }
  }

  private transition(record: TaskRecord, state: TaskState, result: Record<string, unknown>): void {
    record.state = state;
    record.finishedAt = this.nowIso();
    if (result.pid !== undefined) record.pid = Number(result.pid) || null;
    if (result.exitCode !== undefined) record.exitCode = Number(result.exitCode) ?? null;
    record.latencyMs = record.startedAtMs !== null ? this.clock() - record.startedAtMs : null;
    record.deadlineAt = null;
    if (record.state === "running") {
      record.state = state; // state was already set above; keep transition for running only
    }
    this.runningCount -= 1;
    this.completedOrder.push(record.taskId);
    this.prune();
    this.drain();
  }

  private drain(): void {
    while (this.runningCount < this.workerLimit && this.queue.length > 0) {
      const record = this.queue.shift();
      if (record) this.startTask(record);
    }
  }

  private prune(): void {
    while (this.completedOrder.length > this.retentionLimit) {
      const oldest = this.completedOrder.shift();
      if (oldest !== undefined) this.tasks.delete(oldest);
    }
  }

  private settle(): Promise<void> {
    return Promise.resolve();
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private notFoundStatus(taskId: string): TaskStatus {
    return {
      taskId,
      type: "unknown",
      name: null,
      command: null,
      state: "not_found",
      pid: null,
      exitCode: null,
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      logPath: "",
      logSizeBytes: 0,
    };
  }

  private toStatus(record: TaskRecord): TaskStatus {
    return {
      taskId: record.taskId,
      type: record.type,
      name: record.name,
      command: record.command,
      state: record.state,
      pid: record.pid,
      exitCode: record.exitCode,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      logPath: record.logPath,
      logSizeBytes: record.logSizeBytes,
    };
  }
}
