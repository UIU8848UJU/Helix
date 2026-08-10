# SSH-MCP 待办分析与优先级（P0-1 先行）

- schema_version: "2.1"
- work_item_id: SSH-MCP-TODO-001
- date: 2026-08-08
- status: PLANNED — P0-1 已批准实施

## 背景

F:\AI_infra\TODO 列出的 ssh-mcp 优化项。用户确认优先级与取舍：

- P0-1 常驻工作目录路径：值得做，第一个做
- p1-2 危险命令加固（rm 等）：顺手做（后续）
- P0-2 CPU 绑定：需用户确认“任务大小”定义后再做
- P0-3 负载均衡：先做单机准入

## P0-1：常驻工作目录路径

### 目标

每个 host 在配置中保存 defaultWorkingDir；AI 调用 ssh_exec / job_start /
docker_exec / compose_exec 时省略 cwd 自动落到该目录，避免每次输入长路径。

### 设计

- HostConfig 增加可选字段 defaultWorkingDir（绝对路径）
- 配置校验：值必须在 allowedRemotePaths 内（复用 assertRemotePathAllowed）
- 回退语义：显式 cwd 优先；省略时回退 defaultWorkingDir
- 新增 get_working_dir / set_working_dir 两个 MCP 工具用于查看/设置
- host_add / host_update / host_onboard 增加 defaultWorkingDir 可选参数

### 安全约束

- 路径必须绝对，且不得逃逸 allowedRemotePaths
- job_* 输出形状不变
- 不降低现有安全策略

## P1 项（暂缓）

- 命令行挂起：是否可做成 CLI 挂起，需要操作时输入挂起负载
- sudo 保持现状；rm 等危险命令必须谨慎（p1-2 加固）

## 待办补充：超时时限可配置（PLANNED）

- 需求：各远端工具的超时上限目前写死在工具定义里（`ssh_check` 120s、`docker_list` / `compose_ps` 300s、`environment_probe` 600s、其余 3600s），希望超时时限可配置，便于高延迟网络与大文件传输场景调整。
- 方案方向：settings 增加统一超时上限配置（如 `maxTimeoutSeconds`），各工具校验 `timeoutSeconds ≤ 上限`；或允许按 host 覆盖默认超时。
- 状态：PLANNED，本次 win→win 修复不实施。

## 后续

P0-1 完成并合并到 main 后，启动 mcp-browser 技术预研。