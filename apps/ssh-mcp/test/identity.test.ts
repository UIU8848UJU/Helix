import { describe, expect, it } from "vitest";
import { Semaphore as ProcessSemaphore } from "../src/process.js";
import { shellQuote as PolicyShellQuote } from "../src/policy.js";
import { Semaphore, shellQuote } from "@helix/jobs";

// TDD-102 RED/GREEN driver: proves the shared pieces ssh-mcp exposes to the rest
// of the app (Semaphore via ./process, shellQuote via ./policy) are the SAME
// objects @helix/jobs exports. Before the refactor these are local copies, so
// the identity assertions below fail (TARGET_BEHAVIOR_MISSING). After the
// refactor they must resolve to the shared package instances.
describe("ssh-mcp re-exports @helix/jobs shared objects", () => {
  it("process.ts re-exports the @helix/jobs Semaphore (same object)", () => {
    expect(ProcessSemaphore).toBe(Semaphore);
  });

  it("policy.ts re-exports the @helix/jobs shellQuote (same object)", () => {
    expect(PolicyShellQuote).toBe(shellQuote);
  });
});
