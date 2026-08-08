import { describe, expect, it } from "vitest";
import { assertTaskId, taskDirectory } from "../src/index.js";

describe("task id validation", () => {
  it("accepts a valid task id", () => {
    expect(assertTaskId("job-test-123")).toBe("job-test-123");
  });

  it("rejects path traversal and unsafe ids", () => {
    expect(() => assertTaskId("../../etc/passwd")).toThrow();
    expect(() => assertTaskId("job-../etc")).toThrow();
    expect(() => assertTaskId("job-id with space")).toThrow();
    expect(() => assertTaskId("")).toThrow();
  });

  it("builds a task directory under the given root", () => {
    expect(taskDirectory("job-test-123", "/tmp/helix/jobs")).toBe("/tmp/helix/jobs/job-test-123");
  });

  it("refuses to build a directory for an unsafe id", () => {
    expect(() => taskDirectory("../../etc/passwd", "/tmp/helix/jobs")).toThrow();
  });
});
