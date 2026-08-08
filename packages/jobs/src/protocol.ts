import { TASK_STATES, type TaskState, type TaskType, TASK_TYPES } from "./task-types.js";

const protocolLinePattern = /^([^=]+)=(.*)$/;

/**
 * Parse a magic-marker framed key=value protocol payload. Lines before the
 * marker are ignored; CRLF and empty lines are tolerated.
 */
export function parseProtocol(stdout: string, magic: string): Record<string, string> {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === magic);
  if (start < 0) throw new Error(`Invalid Helix job response: missing ${magic}`);
  const values: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const match = protocolLinePattern.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) values[key] = value;
  }
  return values;
}

export function nullableNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function decodeOptionalBase64(value: string | undefined): string | null {
  if (!value) return null;
  return Buffer.from(value, "base64").toString("utf8");
}

export function knownTaskType(value: string | undefined): TaskType | "unknown" {
  return TASK_TYPES.includes(value as TaskType) ? (value as TaskType) : "unknown";
}

export function knownTaskState(value: string | undefined): TaskState {
  return TASK_STATES.includes(value as TaskState) ? (value as TaskState) : "unknown";
}
