# Credential Broker Repair Design Baseline

Status: implemented and validated locally after review of baseline `fa411f4`.

## Constraints

- Preserve the wire shapes of existing operations while moving the incompatible request set to v2.
- Preserve synchronous `interprocess` transport; no async runtime is justified.
- Keep SSH behavior and real-SSH integration scope unchanged.
- Bound memory, threads and IPC waits.
- Unsafe code is limited to small platform adapters with ownership invariants documented.
- Windows and Unix access control is enforced when creating the listener.

## Considered designs

1. **File-only split:** move `TaskPool` out of `daemon.rs` without changing dependencies.
   Rejected: improves navigation but leaves execution/time coupled and task invariants hard to test.
2. **Small ports-and-adapters split:** `IpcServer → TaskPool → TaskExecutor`, with a `Clock` seam
   and platform IPC/credential adapters. Selected: minimal change with stable future boundaries.
3. **Async runtime and generic scheduler:** Tokio plus pluggable persistence/priority framework.
   Rejected for this repair: migration risk and complexity are not supported by current needs.

## Decisions

### ADR-1 — Separate transport, scheduling and execution

`daemon` owns listener lifecycle, bounded framing, authorization and request routing. `TaskPool`
owns queue, workers, task records and state transitions. `TaskExecutor` owns operation execution;
`BrokerEngine` is its production implementation. `Clock` supplies retention timestamps.

### ADR-2 — Task and shutdown lifecycle

Queued cancellation prevents execution. Running cancellation returns an explicit pending or
unsupported disposition until the executor has a cooperative interrupt path; it is never reported
as already cancelled. Terminal transitions are monotonic. Shutdown first stops admission, cancels
queued work, waits only for a configured deadline, and records a deterministic forced outcome for
remaining local tasks. It does not replay work after restart.

### ADR-3 — Bounded synchronous IPC

Each connection carries one newline-delimited JSON request and response. Framing enforces 4 MiB
during reading. Reads and writes have five-second deadlines. Connections are isolated and capped;
saturation must recover and must not permanently exclude shutdown.

### ADR-4 — Platform security adapters

Windows listener creation supplies an owner/logon-restricted security descriptor. Unix listener
creation ensures owner-only socket permissions. WinCred uses RAII for `CredFree` and maintained
UTF-16 conversions. Platform unsafe code cannot leak into task or routing code.

### ADR-5 — Atomic startup convergence

The fixed endpoint is the ownership lock. A process losing the listener-creation race probes the
winner; if it is protocol-compatible, startup succeeds. Incompatible daemon replacement remains a
client-controlled stop/wait/start operation.

### ADR-6 — Resource budgets belong to execution and task storage

The SSH output collector drains stdout and stderr without sequential pipe-window deadlock and
applies one shared byte budget while reading. Task storage has per-result and global retained-byte
budgets with deterministic oldest-terminal eviction. Cleanup is clock-driven rather than relying
on the next API call.

### ADR-7 — Version and capabilities jointly define compatibility

The request-set change moves the daemon protocol to v2. Ping/status advertises capabilities; the
client may reuse a daemon only when the protocol and required capability both match. Cross-language
golden fixtures keep the Rust request enum and TypeScript builders aligned.

## TDD slices

1. Protocol v2 capabilities and startup convergence.
2. TaskPool executor/clock seams, state invariants, shutdown and retained-byte budget.
3. Bounded IPC framing, deadlines, connection saturation and recovery.
4. WinCred RAII and UTF-16/NUL behavior.
5. Windows/Unix listener access control.
6. Concurrent stdout/stderr collection with a shared output budget.

## Validation note

The shared collector has deterministic unit coverage for its one-budget invariant. The real remote
SSH high-volume stdout/stderr test is present as an ignored integration test, but was not executed
in this review because authorization to use the configured remote credential/host was denied. This
is recorded as a conditional evidence gap, not represented as a passing test.

## Style and validation baseline

- Prefer concrete internal types and two small traits over a generic framework.
- Functions remain single-purpose; comments explain platform constraints and decisions.
- Rust: `cargo test`, release build, focused Clippy, `cargo fmt --check`.
- TypeScript: SSH-MCP broker tests and type check.
- Real boundaries: Windows Credential Manager and unique Windows named pipes.
