import { describe, expect, it } from "vitest";
import { assertCommandSafe, findBlockedCommand } from "../src/safety.js";

describe("Harness command safety guard", () => {
  it.each([
    "rm -rf build",
    "sudo rm /tmp/file",
    "cd /workspace && rm -rf out",
    "find /tmp -type f -delete",
    "sudo mkfs.ext4 /dev/sdb1",
    "dd if=/dev/zero of=/dev/sda",
    "systemctl reboot",
    "kill -9 1",
    ":(){ :|:& };:",
  ])("blocks obvious destructive command: %s", (command) => {
    expect(findBlockedCommand(command)).not.toBeNull();
    expect(() => assertCommandSafe(command)).toThrow("Harness safety guard");
  });

  it.each([
    "sudo systemctl restart nginx",
    "sudo apt-get install -y cmake",
    "docker compose up -d",
    "git checkout -- src/main.cpp",
    "colcon build",
    "echo remove old build output",
  ])("allows ordinary harness command: %s", (command) => {
    expect(findBlockedCommand(command)).toBeNull();
    expect(() => assertCommandSafe(command)).not.toThrow();
  });
});
