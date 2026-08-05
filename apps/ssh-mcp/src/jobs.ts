import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { newRequestId, writeAudit } from "./audit.js";
import { brokerSshExecute, brokerSudoExecute } from "./broker.js";
import type { ConfigStore } from "./config.js";
import { assertRemotePathAllowed, shellQuote } from "./policy.js";
import { Semaphore } from "./process.js";
import { assertCommandSafe } from "./safety.js";
import { runSsh } from "./ssh.js";
import type { ExecutionResult, GlobalSettings, HostConfig } from "./types.js";

export const JOB_TYPES = [
  "build",
  "test",
  "docker-build",
  "compose-build",
  "deploy",
  "service",
  "data",
  "simulation",
  "run",
  "custom",
] as const;

export type JobType = (typeof JOB_TYPES)[number];
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost" | "not_found" | "unknown";

export interface JobStatus {
  jobId: string;
  type: JobType | "unknown";
  name: string | null;
  command: string | null;
  state: JobState;
  pid: number | null;
  exitCode: number | null;
  privileged: boolean;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logPath: string;
  logSizeBytes: number;
}

export interface JobLogs {
  jobId: string;
  content: string;
  nextCursor: number;
  sizeBytes: number;
  eof: boolean;
}

const JOB_ROOT = "/tmp/helix/jobs";
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const jobIdPattern = /^job-[A-Za-z0-9._-]+$/;
const protocolLinePattern = /^([^=]+)=(.*)$/;

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwInvalid(error: unknown): never {
  if (error instanceof McpError) throw error;
  throw new McpError(ErrorCode.InvalidParams, errorMessage(error));
}

function assertJobId(jobId: string): string {
  if (!jobIdPattern.test(jobId)) throw new Error(`Invalid Helix job id: ${jobId}`);
  return jobId;
}

function jobDirectory(jobId: string): string {
  return `${JOB_ROOT}/${assertJobId(jobId)}`;
}

function parseProtocol(stdout: string, magic: string): Record<string, string> {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === magic);
  if (start < 0) throw new Error(`Invalid Helix job response: missing ${magic}`);
  const values: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const match = protocolLinePattern.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function nullableNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeOptionalBase64(value: string | undefined): string | null {
  if (!value) return null;
  return Buffer.from(value, "base64").toString("utf8");
}

function knownJobType(value: string | undefined): JobType | "unknown" {
  return JOB_TYPES.includes(value as JobType) ? value as JobType : "unknown";
}

function knownJobState(value: string | undefined): JobState {
  const states: JobState[] = ["queued", "running", "succeeded", "failed", "cancelled", "lost", "not_found", "unknown"];
  return states.includes(value as JobState) ? value as JobState : "unknown";
}

export function parseJobStatus(stdout: string): JobStatus {
  const values = parseProtocol(stdout, "HELIX_JOB_STATUS_V1");
  const jobId = values.job_id ?? "unknown";
  return {
    jobId,
    type: knownJobType(values.type),
    name: decodeOptionalBase64(values.name_b64),
    command: decodeOptionalBase64(values.command_b64),
    state: knownJobState(values.state),
    pid: nullableNumber(values.pid),
    exitCode: nullableNumber(values.exit_code),
    privileged: values.privileged === "1",
    createdAt: values.created_at || null,
    startedAt: values.started_at || null,
    finishedAt: values.finished_at || null,
    logPath: values.log_path || `${JOB_ROOT}/${jobId}/output.log`,
    logSizeBytes: nullableNumber(values.log_size) ?? 0,
  };
}

export function parseJobLogs(stdout: string): JobLogs {
  const values = parseProtocol(stdout, "HELIX_JOB_LOGS_V1");
  return {
    jobId: values.job_id ?? "unknown",
    content: Buffer.from(values.content_b64 ?? "", "base64").toString("utf8"),
    nextCursor: nullableNumber(values.next_cursor) ?? 0,
    sizeBytes: nullableNumber(values.size) ?? 0,
    eof: values.eof === "1",
  };
}

function buildPayload(host: HostConfig, input: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  sourceScripts?: string[];
}): string {
  const parts: string[] = [];
  if (input.cwd) parts.push(`cd ${shellQuote(assertRemotePathAllowed(host, input.cwd))} || exit $?`);
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!envNamePattern.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    parts.push(`export ${key}=${shellQuote(value)}`);
  }
  for (const script of input.sourceScripts ?? []) {
    parts.push(`. ${shellQuote(assertRemotePathAllowed(host, script))} || exit $?`);
  }
  parts.push(input.command);
  return parts.join("\n");
}

export function buildJobStartCommand(input: {
  jobId: string;
  type: JobType;
  name: string;
  command: string;
  host: HostConfig;
  cwd?: string;
  env?: Record<string, string>;
  sourceScripts?: string[];
  privileged: boolean;
}): string {
  const jobId = assertJobId(input.jobId);
  const directory = jobDirectory(jobId);
  const payload = buildPayload(input.host, input);
  const nameB64 = Buffer.from(input.name, "utf8").toString("base64");
  const commandB64 = Buffer.from(input.command, "utf8").toString("base64");
  const runner = `#!/bin/sh
set +e
job_dir=${shellQuote(directory)}
finish_job() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ -f "$job_dir/cancel_requested" ]; then
    final_state=cancelled
  elif [ "$rc" -eq 0 ]; then
    final_state=succeeded
  else
    final_state=failed
  fi
  printf '%s\\n' "$rc" > "$job_dir/exit_code"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$job_dir/finished_at"
  printf '%s\\n' "$final_state" > "$job_dir/state"
  exit "$rc"
}
trap finish_job EXIT HUP INT TERM
printf 'running\\n' > "$job_dir/state"
date -u +%Y-%m-%dT%H:%M:%SZ > "$job_dir/started_at"
if command -v bash >/dev/null 2>&1; then
  bash -lc ${shellQuote(payload)}
else
  sh -lc ${shellQuote(payload)}
fi
rc=$?
exit "$rc"
`;
  const runnerB64 = Buffer.from(runner, "utf8").toString("base64");

  return `set -eu
job_dir=${shellQuote(directory)}
mkdir -p "$job_dir"
chmod 755 "$job_dir"
printf '%s' ${shellQuote(runnerB64)} | base64 -d > "$job_dir/run.sh"
chmod 700 "$job_dir/run.sh"
printf '%s\\n' ${shellQuote(input.type)} > "$job_dir/type"
printf '%s\\n' ${shellQuote(nameB64)} > "$job_dir/name.b64"
printf '%s\\n' ${shellQuote(commandB64)} > "$job_dir/command.b64"
printf '%s\\n' ${input.privileged ? "1" : "0"} > "$job_dir/privileged"
date -u +%Y-%m-%dT%H:%M:%SZ > "$job_dir/created_at"
printf 'queued\\n' > "$job_dir/state"
: > "$job_dir/output.log"
chmod 644 "$job_dir"/* 2>/dev/null || true
chmod 700 "$job_dir/run.sh"
if command -v setsid >/dev/null 2>&1; then
  nohup setsid sh "$job_dir/run.sh" > "$job_dir/output.log" 2>&1 < /dev/null &
  launcher=setsid
else
  nohup sh "$job_dir/run.sh" > "$job_dir/output.log" 2>&1 < /dev/null &
  launcher=plain
fi
pid=$!
printf '%s\\n' "$pid" > "$job_dir/pid"
printf '%s\\n' "$launcher" > "$job_dir/launcher"
printf 'HELIX_JOB_START_V1\\njob_id=%s\\npid=%s\\nstate=queued\\nlog_path=%s\\n' ${shellQuote(jobId)} "$pid" ${shellQuote(`${directory}/output.log`)}`;
}

export function buildJobStatusCommand(jobIdInput: string): string {
  const jobId = assertJobId(jobIdInput);
  const directory = jobDirectory(jobId);
  return `job_dir=${shellQuote(directory)}
read_value() { [ -f "$1" ] && tr -d '\\r\\n' < "$1" || true; }
if [ ! -d "$job_dir" ]; then
  printf 'HELIX_JOB_STATUS_V1\\njob_id=%s\\nstate=not_found\\nlog_path=%s\\nlog_size=0\\n' ${shellQuote(jobId)} ${shellQuote(`${directory}/output.log`)}
  exit 0
fi
state=$(read_value "$job_dir/state")
pid=$(read_value "$job_dir/pid")
exit_code=$(read_value "$job_dir/exit_code")
if [ "$state" = queued ] || [ "$state" = running ]; then
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    state=running
  elif [ -n "$exit_code" ]; then
    if [ -f "$job_dir/cancel_requested" ]; then state=cancelled; elif [ "$exit_code" = 0 ]; then state=succeeded; else state=failed; fi
  else
    state=lost
  fi
fi
log_size=0
[ -f "$job_dir/output.log" ] && log_size=$(wc -c < "$job_dir/output.log" | tr -d ' ')
printf 'HELIX_JOB_STATUS_V1\\n'
printf 'job_id=%s\\n' ${shellQuote(jobId)}
printf 'type=%s\\n' "$(read_value "$job_dir/type")"
printf 'name_b64=%s\\n' "$(read_value "$job_dir/name.b64")"
printf 'command_b64=%s\\n' "$(read_value "$job_dir/command.b64")"
printf 'state=%s\\n' "$state"
printf 'pid=%s\\n' "$pid"
printf 'exit_code=%s\\n' "$exit_code"
printf 'privileged=%s\\n' "$(read_value "$job_dir/privileged")"
printf 'created_at=%s\\n' "$(read_value "$job_dir/created_at")"
printf 'started_at=%s\\n' "$(read_value "$job_dir/started_at")"
printf 'finished_at=%s\\n' "$(read_value "$job_dir/finished_at")"
printf 'log_path=%s\\n' ${shellQuote(`${directory}/output.log`)}
printf 'log_size=%s\\n' "$log_size"`;
}

export function buildJobLogsCommand(input: {
  jobId: string;
  lines: number;
  cursor?: number;
  maxBytes: number;
}): string {
  const jobId = assertJobId(input.jobId);
  const directory = jobDirectory(jobId);
  const cursor = input.cursor;
  const contentCommand = cursor === undefined
    ? `tail -n ${input.lines} "$log_file" | tail -c ${input.maxBytes}`
    : `tail -c +$((start + 1)) "$log_file" | head -c "$bytes"`;
  return `job_dir=${shellQuote(directory)}
log_file="$job_dir/output.log"
size=0
[ -f "$log_file" ] && size=$(wc -c < "$log_file" | tr -d ' ')
start=${cursor ?? 0}
if [ "$start" -lt 0 ]; then start=0; fi
if [ "$start" -gt "$size" ]; then start="$size"; fi
bytes=$((size - start))
if [ "$bytes" -gt ${input.maxBytes} ]; then bytes=${input.maxBytes}; fi
if [ -f "$log_file" ]; then
  content_b64=$(${contentCommand} | base64 | tr -d '\\r\\n')
else
  content_b64=
fi
if [ ${cursor === undefined ? 1 : 0} -eq 1 ]; then next="$size"; else next=$((start + bytes)); fi
if [ "$next" -ge "$size" ]; then eof=1; else eof=0; fi
printf 'HELIX_JOB_LOGS_V1\\njob_id=%s\\nsize=%s\\nnext_cursor=%s\\neof=%s\\ncontent_b64=%s\\n' ${shellQuote(jobId)} "$size" "$next" "$eof" "$content_b64"`;
}

export function buildJobCancelCommand(jobIdInput: string, graceSeconds: number): string {
  const jobId = assertJobId(jobIdInput);
  const directory = jobDirectory(jobId);
  return `job_dir=${shellQuote(directory)}
if [ ! -d "$job_dir" ]; then
  printf 'HELIX_JOB_STATUS_V1\\njob_id=%s\\nstate=not_found\\nlog_path=%s\\nlog_size=0\\n' ${shellQuote(jobId)} ${shellQuote(`${directory}/output.log`)}
  exit 0
fi
read_value() { [ -f "$1" ] && tr -d '\\r\\n' < "$1" || true; }
touch "$job_dir/cancel_requested"
pid=$(read_value "$job_dir/pid")
launcher=$(read_value "$job_dir/launcher")
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  if [ "$launcher" = setsid ]; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  else
    command -v pkill >/dev/null 2>&1 && pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  fi
  i=0
  limit=$((${graceSeconds} * 10))
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$limit" ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    if [ "$launcher" = setsid ]; then kill -KILL -- "-$pid" 2>/dev/null || true; else kill -KILL "$pid" 2>/dev/null || true; fi
  fi
fi
printf 'cancelled\\n' > "$job_dir/state"
[ -f "$job_dir/exit_code" ] || printf '143\\n' > "$job_dir/exit_code"
[ -f "$job_dir/finished_at" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$job_dir/finished_at"
${buildJobStatusCommand(jobId)}`;
}

export function registerJobTools(server: McpServer, store: ConfigStore): void {
  let limiter: Semaphore | null = null;
  let limiterSize = 0;
  const getLimiter = (settings: GlobalSettings): Semaphore => {
    if (!limiter || limiterSize !== settings.maxConcurrentCommands) {
      limiter = new Semaphore(settings.maxConcurrentCommands);
      limiterSize = settings.maxConcurrentCommands;
    }
    return limiter;
  };

  const execute = async (input: {
    tool: string;
    hostAlias: string;
    command: string;
    timeoutSeconds?: number;
    privileged?: boolean;
    auditCommand?: string;
    operation?: string;
  }): Promise<ExecutionResult> => {
    const config = await store.read();
    const host = config.hosts[input.hostAlias];
    if (!host) throw new Error(`Unknown host alias: ${input.hostAlias}`);
    const requestId = newRequestId();
    const started = Date.now();
    try {
      let result: ExecutionResult;
      if (input.privileged) {
        if (host.auth.type === "windows-credential") {
          result = await brokerSudoExecute({
            settings: config.settings,
            hostAlias: input.hostAlias,
            host,
            command: input.command,
            timeoutSeconds: input.timeoutSeconds,
          });
        } else {
          result = await runSsh({
            host,
            settings: config.settings,
            command: `sudo -n -- sh -lc ${shellQuote(input.command)}`,
            timeoutSeconds: input.timeoutSeconds,
            limiter: getLimiter(config.settings),
          });
        }
      } else if (host.auth.type === "windows-credential") {
        result = await brokerSshExecute({
          settings: config.settings,
          hostAlias: input.hostAlias,
          host,
          command: input.command,
          timeoutSeconds: input.timeoutSeconds,
        });
      } else {
        result = await runSsh({
          host,
          settings: config.settings,
          command: input.command,
          timeoutSeconds: input.timeoutSeconds,
          limiter: getLimiter(config.settings),
        });
      }
      await writeAudit(config.settings, {
        timestamp: new Date().toISOString(),
        requestId,
        tool: input.tool,
        host: input.hostAlias,
        operation: input.operation,
        command: input.auditCommand,
        durationMs: result.durationMs || Date.now() - started,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        success: result.ok,
      });
      return result;
    } catch (error) {
      await writeAudit(config.settings, {
        timestamp: new Date().toISOString(),
        requestId,
        tool: input.tool,
        host: input.hostAlias,
        operation: input.operation,
        command: input.auditCommand,
        durationMs: Date.now() - started,
        success: false,
        error: errorMessage(error),
      });
      throw error;
    }
  };

  server.tool("job_start", "Start a persistent remote background job and return immediately. Use for builds, tests, Docker image builds, deployments, simulations, data jobs, or any task expected to outlive one MCP call.", {
    host: z.string(),
    type: z.enum(JOB_TYPES).optional(),
    name: z.string().min(1).max(120).optional(),
    command: z.string().min(1),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    sourceScripts: z.array(z.string()).optional(),
    useSudo: z.boolean().optional(),
    startTimeoutSeconds: z.number().int().min(1).max(120).optional(),
  }, async ({ host, type, name, command, cwd, env, sourceScripts, useSudo, startTimeoutSeconds }) => {
    try {
      assertCommandSafe(command);
      const hostConfig = await store.getHost(host);
      const jobType = type ?? "custom";
      const jobId = `job-${newRequestId()}`;
      const jobName = name ?? `${jobType}-${jobId.slice(-8)}`;
      const privileged = useSudo ?? false;
      const startCommand = buildJobStartCommand({
        jobId,
        type: jobType,
        name: jobName,
        command,
        host: hostConfig,
        cwd,
        env,
        sourceScripts,
        privileged,
      });
      const result = await execute({
        tool: "job_start",
        hostAlias: host,
        command: startCommand,
        timeoutSeconds: startTimeoutSeconds ?? 30,
        privileged,
        auditCommand: command,
        operation: `${jobType}: ${jobName}`,
      });
      const values = parseProtocol(result.stdout, "HELIX_JOB_START_V1");
      return textResult({
        ok: result.ok,
        jobId,
        host,
        type: jobType,
        name: jobName,
        state: values.state ?? "queued",
        pid: nullableNumber(values.pid),
        privileged,
        logPath: values.log_path ?? `${jobDirectory(jobId)}/output.log`,
        next: ["job_status", "job_logs", "job_cancel"],
      });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("job_status", "Read persistent remote job state after the original MCP call, SSH connection, or client session has ended.", {
    host: z.string(),
    jobId: z.string(),
    timeoutSeconds: z.number().int().min(1).max(120).optional(),
  }, async ({ host, jobId, timeoutSeconds }) => {
    try {
      const result = await execute({
        tool: "job_status",
        hostAlias: host,
        command: buildJobStatusCommand(jobId),
        timeoutSeconds: timeoutSeconds ?? 30,
        operation: jobId,
      });
      return textResult({ ...parseJobStatus(result.stdout), host });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("job_logs", "Read a tail snapshot or incremental byte-cursor chunk from a persistent remote job log.", {
    host: z.string(),
    jobId: z.string(),
    lines: z.number().int().min(1).max(5000).optional(),
    cursor: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(1024).max(512 * 1024).optional(),
    timeoutSeconds: z.number().int().min(1).max(120).optional(),
  }, async ({ host, jobId, lines, cursor, maxBytes, timeoutSeconds }) => {
    try {
      const result = await execute({
        tool: "job_logs",
        hostAlias: host,
        command: buildJobLogsCommand({
          jobId,
          lines: lines ?? 100,
          cursor,
          maxBytes: maxBytes ?? 128 * 1024,
        }),
        timeoutSeconds: timeoutSeconds ?? 30,
        operation: jobId,
      });
      return textResult({ ...parseJobLogs(result.stdout), host });
    } catch (error) { throwInvalid(error); }
  });

  server.tool("job_cancel", "Cancel a persistent remote job. The tool sends TERM, waits briefly, then uses KILL only if the process group remains alive.", {
    host: z.string(),
    jobId: z.string(),
    graceSeconds: z.number().int().min(0).max(30).optional(),
    timeoutSeconds: z.number().int().min(1).max(120).optional(),
  }, async ({ host, jobId, graceSeconds, timeoutSeconds }) => {
    try {
      const statusResult = await execute({
        tool: "job_status",
        hostAlias: host,
        command: buildJobStatusCommand(jobId),
        timeoutSeconds: timeoutSeconds ?? 30,
        operation: jobId,
      });
      const current = parseJobStatus(statusResult.stdout);
      if (current.state === "not_found") return textResult({ ...current, host });
      const result = await execute({
        tool: "job_cancel",
        hostAlias: host,
        command: buildJobCancelCommand(jobId, graceSeconds ?? 5),
        timeoutSeconds: timeoutSeconds ?? 30,
        privileged: current.privileged,
        operation: jobId,
      });
      return textResult({ ...parseJobStatus(result.stdout), host });
    } catch (error) { throwInvalid(error); }
  });
}
