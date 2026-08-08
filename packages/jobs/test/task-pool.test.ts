import { describe, expect, it } from "vitest";
import { TaskPool, type TaskExecutor, type TaskSpec } from "../src/index.js";

class FakeExecutor implements TaskExecutor {
  started: string[] = [];
  cancelled: string[] = [];
  private readonly pending = new Map<string, {
    resolve: (status: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly autoComplete: boolean) {}

  start(task: TaskSpec): Promise<Record<string, unknown>> {
    this.started.push(task.taskId);
    if (this.autoComplete) {
      return Promise.resolve({ taskId: task.taskId, state: "succeeded", exitCode: 0, pid: 1 });
    }
    return new Promise((resolve, reject) => this.pending.set(task.taskId, { resolve, reject }));
  }

  status(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  cancel(taskId: string): Promise<Record<string, unknown>> {
    this.cancelled.push(taskId);
    return Promise.resolve({ taskId, state: "cancelled" });
  }

  complete(taskId: string): void {
    const entry = this.pending.get(taskId);
    if (entry) {
      this.pending.delete(taskId);
      entry.resolve({ taskId, state: "succeeded", exitCode: 0 });
    }
  }

  fail(taskId: string, error = new Error("boom")): void {
    const entry = this.pending.get(taskId);
    if (entry) {
      this.pending.delete(taskId);
      entry.reject(error);
    }
  }
}

describe("TaskPool", () => {
  it("submits a task, runs it, and reaches a terminal state", async () => {
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({ executor, workerLimit: 1, queueLimit: 5, retentionLimit: 10 });
    const submitted = await pool.submit({ command: "echo hi", name: "t", type: "test" });
    expect(submitted.state).toBe("running");
    expect(submitted.taskId).toMatch(/^job-/);

    executor.complete(submitted.taskId);
    const done = await pool.status(submitted.taskId);
    expect(done.state).toBe("succeeded");
    expect(done.exitCode).toBe(0);
  });

  it("marks a task failed when the executor rejects", async () => {
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({ executor, workerLimit: 1, queueLimit: 5, retentionLimit: 10 });
    const submitted = await pool.submit({ command: "boom" });
    executor.fail(submitted.taskId);
    const done = await pool.status(submitted.taskId);
    expect(done.state).toBe("failed");
  });

  it("caps concurrent running tasks at the worker limit and queues the rest", async () => {
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({ executor, workerLimit: 2, queueLimit: 10, retentionLimit: 20 });
    const a = await pool.submit({ command: "a" });
    const b = await pool.submit({ command: "b" });
    const c = await pool.submit({ command: "c" });
    expect((await pool.status(a.taskId)).state).toBe("running");
    expect((await pool.status(b.taskId)).state).toBe("running");
    expect((await pool.status(c.taskId)).state).toBe("queued");
    expect(pool.metrics().running).toBe(2);
    expect(pool.metrics().queued).toBe(1);

    executor.complete(a.taskId);
    expect((await pool.status(c.taskId)).state).toBe("running");
    expect(executor.started).toEqual([a.taskId, b.taskId, c.taskId]);
  });

  it("rejects submission when the bounded queue is full", async () => {
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({ executor, workerLimit: 1, queueLimit: 2, retentionLimit: 5 });
    const a = await pool.submit({ command: "a" });
    await pool.submit({ command: "b" });
    await pool.submit({ command: "c" });
    expect((await pool.status(a.taskId)).state).toBe("running");
    await expect(pool.submit({ command: "d" })).rejects.toThrow(/queue/);
  });

  it("promotes higher-priority queued tasks first", async () => {
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({ executor, workerLimit: 1, queueLimit: 10, retentionLimit: 10 });
    const first = await pool.submit({ command: "first" }); // running immediately
    const low = await pool.submit({ command: "low", priority: 1 });
    const high = await pool.submit({ command: "high", priority: 10 });
    expect((await pool.status(low.taskId)).state).toBe("queued");
    expect((await pool.status(high.taskId)).state).toBe("queued");

    executor.complete(first.taskId);
    expect((await pool.status(high.taskId)).state).toBe("running");
    expect(executor.started[1]).toBe(high.taskId);
  });

  it("fails a running task whose deadline passes (injectable clock)", async () => {
    let now = 1000;
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({
      executor,
      workerLimit: 1,
      queueLimit: 5,
      retentionLimit: 5,
      clock: () => now,
    });
    const submitted = await pool.submit({ command: "slow", timeoutMs: 100 });
    expect((await pool.status(submitted.taskId)).state).toBe("running");

    now += 200;
    const after = await pool.status(submitted.taskId);
    expect(after.state).toBe("failed");
  });

  it("cancels a running task", async () => {
    const executor = new FakeExecutor(false);
    const pool = new TaskPool({ executor, workerLimit: 1, queueLimit: 5, retentionLimit: 5 });
    const submitted = await pool.submit({ command: "long" });
    const cancelled = await pool.cancel(submitted.taskId, 2);
    expect(cancelled.state).toBe("cancelled");
    expect(executor.cancelled).toContain(submitted.taskId);
    expect((await pool.status(submitted.taskId)).state).toBe("cancelled");
  });

  it("reports not_found for unknown task ids", async () => {
    const pool = new TaskPool({ executor: new FakeExecutor(true), workerLimit: 1, queueLimit: 5, retentionLimit: 5 });
    const status = await pool.status("job-nope");
    expect(status.state).toBe("not_found");
  });

  it("retains only the most recent completed tasks and exposes metrics", async () => {
    const executor = new FakeExecutor(true);
    const pool = new TaskPool({ executor, workerLimit: 1, queueLimit: 5, retentionLimit: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const s = await pool.submit({ command: `c${i}` });
      ids.push(s.taskId);
      await pool.status(s.taskId); // allow completion handler to settle
    }
    expect(pool.metrics().completed).toBe(3);
    expect((await pool.status(ids[0]!)).state).toBe("not_found");
    expect((await pool.status(ids[4]!)).state).toBe("succeeded");
    const metrics = pool.metrics();
    expect(metrics.succeeded).toBe(3);
    expect(metrics.running).toBe(0);
    expect(metrics.queued).toBe(0);
    expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.maxLatencyMs).toBeGreaterThanOrEqual(metrics.avgLatencyMs);
  });
});
