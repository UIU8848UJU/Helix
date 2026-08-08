import { describe, expect, it } from "vitest";
import { decodeOptionalBase64, knownTaskState, nullableNumber, parseProtocol } from "../src/index.js";

describe("generic wire-protocol helpers", () => {
  it("parses key=value fields after the magic marker and ignores noise before it", () => {
    const values = parseProtocol("noise\nHELIX_JOB_STATUS_V1\njob_id=job-1\nstate=running\n", "HELIX_JOB_STATUS_V1");
    expect(values.job_id).toBe("job-1");
    expect(values.state).toBe("running");
  });

  it("throws when the magic marker is missing", () => {
    expect(() => parseProtocol("noise\nstate=running\n", "HELIX_JOB_STATUS_V1")).toThrow(/missing HELIX_JOB_STATUS_V1/);
  });

  it("handles CRLF and empty lines", () => {
    const values = parseProtocol("HELIX_JOB_LOGS_V1\r\njob_id=job-2\r\nsize=10\r\n\r\n", "HELIX_JOB_LOGS_V1");
    expect(values.job_id).toBe("job-2");
    expect(values.size).toBe("10");
  });

  it("parses optional numbers, returning null for empty or non-finite values", () => {
    expect(nullableNumber("42")).toBe(42);
    expect(nullableNumber("")).toBeNull();
    expect(nullableNumber("abc")).toBeNull();
    expect(nullableNumber(undefined)).toBeNull();
  });

  it("decodes optional base64, returning null for empty values", () => {
    const encoded = Buffer.from("hello").toString("base64");
    expect(decodeOptionalBase64(encoded)).toBe("hello");
    expect(decodeOptionalBase64("")).toBeNull();
    expect(decodeOptionalBase64(undefined)).toBeNull();
  });

  it("normalizes unknown task states to 'unknown'", () => {
    expect(knownTaskState("running")).toBe("running");
    expect(knownTaskState("weird-state")).toBe("unknown");
    expect(knownTaskState(undefined)).toBe("unknown");
  });
});
