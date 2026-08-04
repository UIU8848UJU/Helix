export interface BlockedCommandMatch {
  id: string;
  reason: string;
}

interface BlockedCommandRule extends BlockedCommandMatch {
  pattern: RegExp;
}

/**
 * Harness mode intentionally permits broad remote execution, including sudo.
 * These rules are a small anti-footgun guard for obvious destructive commands;
 * they are not intended to be a complete shell sandbox or security boundary.
 */
export const BLOCKED_COMMAND_RULES: readonly BlockedCommandRule[] = [
  {
    id: "remove-files",
    reason: "rm commands are disabled by the default Harness safety guard",
    pattern: /(?:^|[;&|]\s*|\$\(\s*|`\s*)(?:sudo\s+(?:-[^\s]+\s+)*)?(?:command\s+)?(?:\/[A-Za-z0-9._-]+)*\/??rm(?:\s|$)/i,
  },
  {
    id: "nested-remove-files",
    reason: "nested shell commands containing rm are disabled",
    pattern: /\b(?:ba|z|k)?sh\s+-c\s+['"][^'"]*(?:^|[;&|\s])rm(?:\s|$)/i,
  },
  {
    id: "find-delete",
    reason: "find -delete is disabled by the default Harness safety guard",
    pattern: /(?:^|[;&|]\s*)find\b[^\n;&|]*\s-delete(?:\s|$)/i,
  },
  {
    id: "secure-delete",
    reason: "secure deletion and filesystem wiping commands are disabled",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:shred|wipefs)(?:\s|$)/i,
  },
  {
    id: "filesystem-format",
    reason: "filesystem formatting and partition editing commands are disabled",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:mkfs(?:\.[A-Za-z0-9_-]+)?|fdisk|sfdisk|cfdisk|parted)(?:\s|$)/i,
  },
  {
    id: "raw-device-write",
    reason: "raw writes to block devices are disabled",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?dd\b[^\n;&|]*\bof\s*=\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk)/i,
  },
  {
    id: "block-device-redirection",
    reason: "shell redirection to block devices is disabled",
    pattern: /(?:>|>>)\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk)/i,
  },
  {
    id: "power-control",
    reason: "shutdown, poweroff, halt and reboot commands are disabled",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|poweroff|halt|reboot)(?:\s|$)/i,
  },
  {
    id: "systemd-power-control",
    reason: "systemd power-control commands are disabled",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?systemctl\s+(?:reboot|poweroff|halt|kexec)(?:\s|$)/i,
  },
  {
    id: "kill-init",
    reason: "terminating PID 1 is disabled",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?kill\s+(?:-[A-Za-z0-9]+\s+)*1(?:\s|$)/i,
  },
  {
    id: "fork-bomb",
    reason: "fork-bomb patterns are disabled",
    pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:?/,
  },
];

export function findBlockedCommand(command: string): BlockedCommandMatch | null {
  for (const rule of BLOCKED_COMMAND_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(command)) return { id: rule.id, reason: rule.reason };
  }
  return null;
}

export function assertCommandSafe(command: string): void {
  const blocked = findBlockedCommand(command);
  if (blocked) {
    throw new Error(`Command blocked by Harness safety guard (${blocked.id}): ${blocked.reason}`);
  }
}
