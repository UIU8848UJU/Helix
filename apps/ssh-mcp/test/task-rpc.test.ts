import { describe, expect, it } from "vitest";
import {
  brokerTaskCancelWithRpc,
  brokerTaskStatusWithRpc,
  brokerTaskWatchWithRpc,
  buildBrokerTaskCancelRequest,
  buildBrokerTaskStatusRequest,
  buildBrokerTaskWatchRequest,
} from "../src/broker.js";

const capabilities = [
  "task_pool_v2", "bounded_ipc", "owner_only_ipc", "pty_v1", "terminal_v1",
  "terminal_policy_v2", "terminal_cursor_v2", "terminal_task_v1", "spool_v1",
  "identity_file_v1", "task_watch_v1",
];

const snapshot = {
  ok: true,
  protocolVersion: 7,
  capabilities,
  taskId: "task-1",
  state: "running",
  progress: { version: 2, done: 10, total: 100 },
} as const;

describe("task rpc methods", () => {
  it("sends the right status request and maps progress", async () => {
    const calls: Array<[unknown, number | undefined]> = [];
    const result = await brokerTaskStatusWithRpc(async (request, timeout) => {
      calls.push([request, timeout]);
      return snapshot;
    }, "task-1");
    expect(calls[0]![0]).toEqual(buildBrokerTaskStatusRequest("task-1"));
    expect(calls[0]![1]).toBe(10_000);
    expect(result.progress).toEqual({ version: 2, done: 10, total: 100 });
  });

  it("returns the cancellation snapshot", async () => {
    const result = await brokerTaskCancelWithRpc(async () => ({
      ...snapshot,
      cancelRequested: true,
    }), "task-1");
    expect(result.cancelRequested).toBe(true);
    expect(buildBrokerTaskCancelRequest("task-1")).toEqual({
      op: "task_cancel",
      task_id: "task-1",
    });
  });

  it("pads the local watch timeout above the daemon deadline", async () => {
    const calls: Array<[unknown, number | undefined]> = [];
    await brokerTaskWatchWithRpc(async (request, timeout) => {
      calls.push([request, timeout]);
      return snapshot;
    }, "task-1", 1, 3);
    expect(calls[0]![0]).toEqual(buildBrokerTaskWatchRequest("task-1", 1, 3));
    expect(calls[0]![1]).toBe(3_000 + 2_000);
  });

  it("keeps a 2000ms floor for a zero-second watch", async () => {
    const calls: Array<[unknown, number | undefined]> = [];
    await brokerTaskWatchWithRpc(async (request, timeout) => {
      calls.push([request, timeout]);
      return snapshot;
    }, "task-1", 0, 0);
    expect(calls[0]![1]).toBe(2_000);
  });

  it("rejects a response without taskId", async () => {
    await expect(
      brokerTaskStatusWithRpc(async () => {
        const { taskId: _taskId, ...rest } = snapshot;
        return rest;
      }, "task-1"),
    ).rejects.toThrow(/taskId/);
  });

  it("rejects a response without state", async () => {
    await expect(
      brokerTaskStatusWithRpc(async () => {
        const { state: _state, ...rest } = snapshot;
        return rest;
      }, "task-1"),
    ).rejects.toThrow(/state/);
  });

  it("rejects an incompatible protocol", async () => {
    await expect(
      brokerTaskStatusWithRpc(async () => ({ ...snapshot, protocolVersion: 6 }), "task-1"),
    ).rejects.toThrow(/protocol mismatch/);
  });

  it("propagates rpc errors instead of inventing a snapshot", async () => {
    await expect(
      brokerTaskStatusWithRpc(async () => {
        throw new Error("daemon gone");
      }, "task-1"),
    ).rejects.toThrow(/daemon gone/);
  });
});
