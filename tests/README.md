# Helix tests/ 验证脚本

独立的验证脚本目录：下次直接运行即可验证性能与稳定性，无需手动搭环境。

## 一键运行全部

```powershell
node tests/run-all.mjs
```

依次运行：基准 → 压力 → 极限。任一失败退出码非 0。

## 各脚本

| 脚本 | 验证内容 | 运行 |
| --- | --- | --- |
| `bench.mjs` | 基准：MCP 启动、IPC ping RTT、并发吞吐、task 往返、daemon 空闲 RSS | `node tests/bench.mjs` |
| `stress.mjs` | 压力：持续混合负载、慢客户端队头阻塞韧性、内存漂移 | `node tests/stress.mjs` |
| `max.mjs` | 极限：连接容量(64)、请求 4MiB 边界、突发 task 吞吐、饱和下关机 | `node tests/max.mjs` |

可选参数：`--bundle <path>`、`--helixd <path>`、`--workers <n>`，或环境变量 `HELIX_BUNDLE` / `HELIX_HELIXD`。

## SSH 阶段（bench，需可达主机）

```powershell
$env:HELIX_BENCH_SSH_HOST="<host>"
$env:HELIX_BENCH_SSH_USER="<user>"
node tests/bench.mjs --ssh
```

可选：`HELIX_BENCH_SSH_PORT`、`HELIX_BENCH_SSH_IDENTITY`、`HELIX_BENCH_SSH_ROUNDS`。

## 压力/极限可调参数

- `HELIX_STRESS_DURATION_MS`、`HELIX_STRESS_CLIENTS`、`HELIX_STRESS_SLOW_CLIENTS`、`HELIX_STRESS_PING_P99_MS`
- 极限项对应实现常量：`MAX_IPC_CONNECTIONS=64`、`MAX_REQUEST_BYTES=4MiB`（`apps/helixd/src/daemon.rs`）

## 前置条件

- `cargo build --release`（daemon 二进制）
- esbuild bundle：`npx esbuild apps/ssh-mcp/src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/helix-ssh-mcp.bundle.mjs --log-level=warning`（bench 的 MCP 启动与 SSH 阶段需要）