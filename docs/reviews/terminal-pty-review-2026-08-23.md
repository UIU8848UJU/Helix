# Terminal / Persistent PTY Review - 2026-08-23

## Scope and baseline

- Review baseline: persistent terminal commits `e6966ce..1da9ed0` (`main`).
- Scope: `helix-core` terminal output/registry, `helix-transport-ssh` PTY session and
  drain thread, `helixd` terminal wiring, `ssh-mcp` `terminal_*` MCP tools.
- Clean baseline evidence: helix-core 34 passed, helix-transport-ssh 5 passed,
  helixd 14 passed / 7 real-SSH tests ignored; ssh-mcp 90 passed / 4 skipped,
  1 failure was sandbox-only (audit.jsonl EPERM, routing verified separately).

## Fixed in this pass (2026-08-23)

- `raw.log` is now bounded by the same `max_history_bytes` budget as `clean.log`,
  with hysteresis trimming (keep newest half when over budget).
- Per-terminal `idle_seconds` is now honored: `TerminalSession::idle_timeout_seconds`
  drives `TerminalRegistry::reap_idle`; 0 falls back to the daemon-wide default.
- New `TerminalCleaner` carries incomplete UTF-8 sequences, split CSI/OSC escapes
  and cross-chunk `\r\n` so the clean log no longer contains chunk-boundary corruption.
- `TerminalOutput::read` now rejects cursors beyond the current log size instead of
  silently clamping after a history trim.
- `open_terminal` uses the pooled connect retry path and enables a 30s SSH keepalive;
  the drain thread only records exit state via RUNNING->FINISHED compare-exchange,
  so an explicit close is no longer overwritten by FINISHED.
- `read` / `tail` / `search` now stream from the clean log (seek-based ranges and
  line-wise search) instead of loading the whole file into memory; log trimming
  copies only the retained tail.
- The daemon clamps `max_history_bytes` to 256 MiB server-side.
- `TerminalRegistry::open` reclaims Finished sessions on capacity pressure instead
  of rejecting new terminals while dead sessions wait for idle reap.
- Daemon startup sweeps orphaned `runtime/terminals/` directories (terminal state
  is in-memory only and single-instance startup is enforced).
- Log IO failures are recorded per session and surfaced as `logError` in
  `terminal_open` / `terminal_status` responses.
- `terminal_write` / `terminal_resize` reject Finished/Closed sessions with
  explicit semantic errors before touching the SSH channel.

Post-fix evidence: helix-core 44 passed, helix-transport-ssh 5 passed, helixd
14 passed / 7 ignored; ssh-mcp typecheck passed and tests were unchanged
(same sandbox-only failure).

## Remaining items (prioritized)

1. **Full-screen TUI redraws are not deduplicated** - `top`, `htop`, `vim` etc.
   flood `clean.log` with frame redraws (PLAAN2 calls for 去重复刷新). Requires
   either screen-state reconstruction or a documented limitation plus guidance to
   prefer non-interactive commands.
2. **PLAAN2 metadata files not implemented** - the design specifies per-terminal
   `meta.json` / `state.json`; today all state is in memory and dies with the daemon.
   Relevant only if crash recovery or daemon restart reattachment becomes a goal.

## Persistence semantics (for AI consumers)

The terminal is persistent across MCP requests for the lifetime of the `helixd`
daemon process: shell state (cwd, env vars, virtualenvs, background processes in
the session) survives between `terminal_write` calls until `terminal_close` or the
idle timeout. It is NOT persistent across daemon restarts, crashes, or network
disconnects: the remote process receives EOF and dies, and there is currently no
reattach/reconnect protocol. Treat it as a session-scoped interactive shell, not a
resumable job runtime; long-running work belongs to jobs or `tmux`/`screen` on the
remote host.
