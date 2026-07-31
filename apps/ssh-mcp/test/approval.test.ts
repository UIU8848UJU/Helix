import { describe, expect, it } from "vitest";
import { hashCommand } from "../src/approval.js";

describe("sudo approval", () => {
  it("binds approval to the exact command", () => {
    expect(hashCommand("systemctl restart demo")).toBe(hashCommand("systemctl restart demo"));
    expect(hashCommand("systemctl restart demo")).not.toBe(hashCommand("systemctl restart demo "));
  });
});
