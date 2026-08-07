# Credential Broker Daemon Architecture

## Goal

Helix must support multiple MCP clients, Skill-Matrix subprocesses and sub-agents issuing SSH/SFTP operations at the same time without spawning one Rust Broker process per request or creating an unbounded number of SSH handshakes.

The Broker therefore runs as a persistent local daemon and separates three concerns:

```text
MCP / Skill-Matrix clients
        |
        | local IPC
        v
Credential Broker Daemon
        |
        +-- request protocol: submit / task_status / task_cancel
        |
        +-- bounded local task queue
        |
        +-- fixed worker pool
        |
        +-- persistent SSH session pool
        |
        v
Remote SSH hosts
```

This local Broker task system is different from Helix remote persistent jobs:

```text
Broker task pool     = short/medium local scheduling of SSH/SFTP RPC operations
remote job_* tools   = long-running remote builds/tests/deployments that outlive SSH/MCP sessions
```

Do not replace one with the other.

## IPC Transport

The daemon uses a local socket transport through the Rust `interprocess` crate:

- Windows: Named Pipe `\\.\pipe\helix-credential-broker-v1`
- Unix: Unix Domain Socket `/tmp/helix-credential-broker-v1.sock`

The IPC protocol is newline-delimited JSON. Each local connection sends one request and receives one response.

The TypeScript MCP process auto-starts the daemon on first use when the endpoint is unavailable. The daemon is detached from the MCP client and remains alive when one MCP process exits.

## Protocol

Heavy Broker operations are no longer synchronous one-shot stdin RPCs. The daemon protocol has an explicit `protocolVersion`; v1 clients require daemon protocol version `1`.

### Submit

```json
{
  "op": "submit",
  "request": {
    "op": "ssh_execute",
    "credential_ref": "Helix/ssh/dev/login",
    "host": "192.168.49.128",
    "port": 22,
    "username": "developer",
    "command": "git status --short",
    "timeout_seconds": 60,
    "max_output_bytes": 1048576,
    "strict_host_key_checking": false
  }
}
```

The daemon immediately returns a TaskID and state:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "taskId": "broker-...",
  "state": "queued"
}
```

### Poll

```json
{
  "op": "task_status",
  "task_id": "broker-..."
}
```

Task states:

```text
queued
running
succeeded
failed
cancelled
```

A `succeeded` Broker task means the Broker operation completed normally. The nested SSH result may still contain a non-zero remote `exitCode`; that is a remote command result, not a Broker transport failure.

### Cancel

```json
{
  "op": "task_cancel",
  "task_id": "broker-..."
}
```

Queued tasks are cancelled before execution. A running blocking libssh2 call is currently marked `cancelRequested` but is not force-interrupted in v1. Remote long-running work should use `job_cancel`, which controls the remote process group directly.

### Shutdown and protocol upgrade

The daemon supports:

```json
{"op":"shutdown"}
```

and the CLI exposes:

```text
helix-credential-broker daemon-stop
```

When MCP finds a daemon on the expected endpoint but with an incompatible `protocolVersion`, it requests a graceful shutdown and then starts the configured runtime binary. This prevents a new MCP client from silently talking to an old resident daemon.

## Worker Pool and Queue

The daemon uses a fixed-size blocking worker pool plus a bounded queue.

Default startup values are derived by the MCP client:

```text
workers        = settings.maxConcurrentCommands
queueCapacity  = max(32, workers * 16)
```

With the default Helix configuration:

```text
workers = 4
queueCapacity = 64
```

This means 20 Skill-Matrix subprocesses can submit work concurrently, but only four Broker operations execute at once. The rest wait in the local queue instead of opening 20 simultaneous SSH handshakes.

The queue is deliberately bounded. When full, the Broker returns `credential broker task queue is full` instead of consuming unbounded memory or threads.

## SSH Session Pool

The persistent daemon also owns an SSH Session pool keyed by:

```text
credentialRef
host
port
username
strictHostKeyChecking
```

A successful operation returns its authenticated SSH Session to the idle pool. The next compatible task reuses the Session instead of repeating TCP connect, SSH KEX and password authentication.

Default behavior:

```text
idle session TTL          = 120 seconds
max idle sessions/key     = 2
SSH keepalive interval    = 30 seconds
```

Before reusing an idle Session, the Broker checks authentication state and sends a keepalive. Stale Sessions are discarded. Per-operation timeout is updated on checkout; the underlying TCP socket is not pinned to the timeout of the first command that created the pooled Session.

New connection establishment performs limited retry only for connection/handshake class failures:

```text
200 ms
500 ms
1000 ms
```

Authentication failures are not retried automatically.

Commands are not replayed automatically after execution has started. This avoids accidentally running non-idempotent operations twice.

## Concurrency Model

The Broker has three independent concurrency boundaries:

1. **MCP clients** may be numerous and submit concurrently.
2. **Broker queue** absorbs bursts and enforces backpressure.
3. **Worker pool** limits active SSH/SFTP operations.

The SSH Session pool reduces handshakes but does not remove worker limits.

A single pooled Session is checked out by one operation at a time. Parallel work can use multiple pooled Sessions for the same host up to the worker limit.

## Runtime Binary and Upgrade Lifecycle

On Windows, a running executable can prevent the build output from being replaced. Helix therefore does not run the long-lived daemon directly from `apps/credential-broker/target/release` after installation.

The installer:

```text
1. stops an existing Broker daemon when possible
2. builds/tests the repository binary
3. hashes the resulting executable
4. copies it to %APPDATA%/Helix/bin/helix-credential-broker-<hash>.exe
5. writes that runtime path to credentialBrokerPath
6. lets MCP auto-start the new daemon on first use
```

This content-addressed runtime copy makes upgrades atomic from the MCP configuration perspective and prevents an old daemon from locking the next repository build artifact.

Old hashed binaries may be garbage-collected by a future maintenance command after they are no longer running. They are not required for task recovery.

## Remote Persistent Jobs

Long work must still use:

```text
job_start
job_status
job_logs
job_cancel
```

Examples:

- full CMake/Cargo/colcon builds;
- Docker/Compose image builds;
- full test suites;
- deployments;
- simulations and replays;
- data imports/backfills.

The local Broker task should only stay alive long enough to create/query/control the remote job. The long-running process itself lives on the remote host under `/tmp/helix/jobs/<jobId>`.

## Persistence and Crash Recovery

Current daemon task metadata is in memory. Completed Broker tasks are retained for ten minutes by default and then reclaimed.

Daemon crash/restart therefore loses local Broker TaskIDs. This does **not** kill remote `job_*` work because those jobs are persisted independently on the remote host.

Future optional enhancement:

```text
local task WAL / SQLite
    -> daemon restart recovery
    -> task history
    -> queue replay policy
```

Do not automatically replay SSH commands after a daemon crash unless the operation is explicitly marked idempotent. Recovery should restore metadata first, not blindly re-execute commands.

## Resource Limits

Current limits:

- fixed worker count;
- bounded queue capacity;
- max MCP output bytes from Helix settings;
- SSH operation timeouts;
- idle SSH Session TTL;
- maximum idle Sessions per connection key;
- completed Broker Task retention TTL.

Recommended future limits if Skill-Matrix fan-out grows significantly:

- per-host active worker limit;
- per-host queue quota;
- task priorities (`interactive`, `normal`, `background`);
- global memory budget for task results;
- fair scheduling across callers/agents;
- metrics for queue wait, execution time, reconnects and pool hit rate.

## Design Rule for Agents

Agents should not know or manage Broker worker threads directly.

From the MCP tool layer they continue to call normal Helix tools. The TypeScript Broker client performs:

```text
ensure compatible daemon
  -> submit
  -> poll TaskID
  -> return nested Broker result
```

For long remote work the Agent explicitly uses `job_*`.

This preserves a simple AI-facing interface while allowing many Skill-Matrix subprocesses to share one stable SSH execution runtime.
