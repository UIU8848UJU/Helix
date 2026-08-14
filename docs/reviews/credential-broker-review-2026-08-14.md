# Credential Broker Code Review — 2026-08-14

## Scope and baseline

- Review baseline: `fa411f4` (`main`), read from Git objects rather than the modified worktree.
- Scope: Rust credential broker, daemon protocol and task lifecycle, WinCred adapter,
  TypeScript daemon bootstrap/upgrade path, installer shutdown path, and Windows/Unix IPC boundary.
- Depth: L4 — every Must finding maps to an architecture decision and a TDD behavior slice.
- Clean baseline evidence:
  - Rust: 16 passed, 6 real-SSH tests ignored by their environment gate.
  - SSH-MCP broker tests: 11 passed.

## Findings

### P1 — Daemon owns transport, scheduling, execution wiring, and task state

`apps/credential-broker/src/daemon.rs:24-249` defines the task record, queue, worker
implementation and engine coupling; `serve_daemon` then creates all of them. This prevents task
state and concurrency behavior from being tested without constructing the concrete SSH engine and
makes future persistence, priorities, or alternate executors a daemon rewrite.

**Must:** isolate `TaskPool`; depend on a minimal `TaskExecutor` and `Clock`, not directly on
`BrokerEngine` or wall-clock functions. The daemon may compose these components but must not
implement scheduling.

### P1 — Task lifecycle invariants are unprotected

`daemon.rs:88-147,187-248` updates the task map and atomic counters through separate operations.
Cancellation of a running task is only a flag; terminal-state monotonicity, queue-full rollback,
concurrent ID uniqueness, retention, executor failure, and cancellation/dequeue races have no
direct tests. Worker creation also panics.

**Must:** queued cancellation must prevent execution; running cancellation remains pending until the
executor observes a cooperative token. Make worker creation fallible and test state/counter
invariants through fake executor and clock seams.

### P1 — One incomplete IPC request blocks the entire daemon

`daemon.rs:284-292` accepts and handles connections serially. `daemon.rs:319-323` performs an
unbounded blocking `read_line` and checks 4 MiB only afterwards. A client that never sends a
newline can block ping, task polling, upgrade and shutdown; oversized input is accumulated before
rejection. Responses and `daemon-stop` are also unbounded waits.

**Must:** bound bytes while reading, bound read/write time, isolate connections, cap handlers,
preserve a route for shutdown under saturation, and verify slow-read plus non-reading-client cases
on a real Windows named pipe.

### P1 — WinCred FFI has avoidable unsafe scanning and an error-path leak

`credential.rs:22-30` manually scans an unbounded raw UTF-16 pointer. `credential.rs:74-89` can
return through `?` before `CredFree`; zero-size/null blob handling is not explicit. Input strings
with embedded NUL are accepted and silently truncated by Win32.

**Must:** use a maintained UTF-16 type, reject embedded NUL, own `CredReadW` memory with a Drop
guard, special-case empty blobs, and zeroize write buffers. Verify Unicode, empty secret and NUL
failure against the real Windows Credential Manager.

### P1 — IPC is a credential-execution trust boundary without an explicit ACL

`serve_daemon` creates the named pipe/UDS using default permissions and every accepted client may
submit credential-backed SSH operations or request shutdown. Windows documents that a default
named-pipe descriptor grants read access beyond the creator; the `interprocess` crate exposes an
explicit security descriptor API.

**Must:** restrict Windows pipe access to the current logon/user boundary and Unix socket mode to
owner-only. Treat authorization as part of listener creation, not request routing. Add a real ACL /
mode assertion; do not claim process identity alone is authorization.

### P1 — Output collection and retained results are not memory-bounded

`apps/credential-broker/src/ssh.rs:129-137` reads all stdout and then all stderr before truncation.
This can deadlock when stderr fills while stdout is being drained, and `max_output_bytes` does not
bound collection memory. Completed responses remain in the task map with no global retained-byte
budget; configuration permits 100 MiB per result.

**Must:** drain stdout/stderr without pipe-window deadlock and enforce a shared byte budget while
reading. `TaskPool` must bound retained result bytes and evict deterministically. Retention cleanup
uses the `Clock` seam and must not require a later client request to trigger it.

### P1 — Protocol request set changed without a compatibility change

`protocol.rs` and the TypeScript client still report protocol v1 even though `ssh_pty` was added to
the Rust request enum. An older resident v1 daemon is therefore accepted as compatible and only
fails after the new request is submitted.

**Must:** bump the incompatible protocol revision and advertise capabilities in ping/status. The
client decides reuse/upgrade from version plus required capability. Cross-language fixtures cover
every request variant.

### P1 — Bootstrap/upgrade/shutdown is not a complete lifecycle state machine

`apps/ssh-mcp/src/broker.ts:347-365` coalesces starts only inside one Node process. Multiple MCP
processes can race to stop/start the same fixed endpoint. The daemon's shutdown returns from the
accept loop without a documented drain/cancel contract, while installer and client call it as
“graceful”.

**Must:** define v2 shutdown as quiesce, queued cancellation and deadline-bounded cooperative drain;
never replay local tasks. Listener ownership must be atomic; concurrent starters must converge on
the compatible winner instead of treating a bind race as a fatal startup failure.

## Non-Must future extensions

- Persistent task metadata/WAL and replay policy.
- Priority/fair queues and per-host quotas.
- Stronger interruption inside currently blocking libssh2 sections.
- Metrics and structured tracing.

These are extension points for the selected boundaries, not requirements for this repair.

## TDD evidence log

- IPC RED: on clean `fa411f4`, 64 partial-line clients caused the next named-pipe connection to
  fail with `ETIMEDOUT`. GREEN: the same real-process smoke passed slow-read, non-reading large
  response, 64-handler saturation, shutdown and two-process startup-race cases.
- ACL RED: clean HEAD had no explicit listener security adapter. GREEN: real pipe SDDL inspection
  shows a protected DACL and no Everyone/Anonymous ACE; real WinCred integration also passed.
- TaskPool RED: clean HEAD had no injectable executor, cancellation token or clock. GREEN: fake
  executor/clock tests cover queued/running cancellation, failure, queue rollback, unique IDs,
  retention and retained-byte eviction.
- Output RED: clean HEAD had no shared stdout/stderr budget and used sequential `read_to_end`.
  GREEN: collector budget unit coverage passes and production collection alternates streams with a
  progress-independent deadline. The real remote SSH stress test remains gated because remote
  credential use was not authorized in this review.
- Protocol RED: v1 advertised `ssh_pty` without a capability contract. GREEN: Rust and TypeScript
  require v2 plus capabilities; concurrent listener creation converges on one compatible winner.
