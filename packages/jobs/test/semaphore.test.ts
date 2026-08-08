import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/index.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("Semaphore", () => {
  it("rejects a non-positive integer limit", () => {
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(-1)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
  });

  it("limits concurrent operations to the limit", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const work = async () => {
      await semaphore.use(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(10);
        active -= 1;
      });
    };
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(peak).toBe(2);
  });

  it("runs the first operations immediately and queues the rest", async () => {
    const semaphore = new Semaphore(1);
    const order: string[] = [];
    const run = async (name: string) => {
      await semaphore.use(async () => {
        order.push(`start-${name}`);
        await sleep(5);
        order.push(`end-${name}`);
      });
    };
    await Promise.all([run("a"), run("b"), run("c")]);
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
  });

  it("releases waiters in FIFO order and propagates failures", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.use(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(semaphore.use(async () => 1)).resolves.toBe(1);
  });
});
