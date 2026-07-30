# Helix

Helix 是面向 AI Agent 的基础设施（AI Infra）仓库。首个模块是受控的 SSH MCP，用于主机管理、远程命令、文件传输、sudo、Docker/Compose 和环境探测。

## 当前结构

```text
apps/ssh-mcp/                 SSH MCP Server
docs/architecture/           技术设计
examples/                     配置示例
scripts/                      安装脚本
```

网页抓取和浏览器自动化不会与 SSH MCP 放在同一个进程中。后续 Web Research MCP 将独立部署，避免不可信网页内容直接获得远程执行权限。

## SSH MCP 功能

- 主机配置：列出、读取、添加、修改、删除
- SSH 连通性检查
- 普通命令执行，支持 cwd、环境变量和 source 脚本
- scp 上传和下载文件/目录
- 主机级 sudo allowlist
- Docker 容器列表与容器内执行
- Docker Compose 状态和服务内执行
- OS、架构、工具链、容器和环境脚本探测
- 超时、输出上限、并发控制和 JSONL 审计

## 安装

### Linux/macOS

```bash
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
./scripts/install.sh
```

### Windows PowerShell

```powershell
git clone https://github.com/UIU8848UJU/Helix.git
cd Helix
.\scripts\install.ps1
```

要求：

- Node.js 20+
- npm
- OpenSSH Client（`ssh`、`scp`）

默认配置会创建在：

- Linux/macOS：`~/.config/helix/ssh-mcp.json`
- Windows：`%APPDATA%\Helix\ssh-mcp.json`

可使用 `HELIX_SSH_CONFIG` 指定其他路径。

## 开发

```bash
npm install
npm run build
npm test
```

启动 stdio MCP Server：

```bash
node apps/ssh-mcp/build/index.js
```

## MCP 客户端配置

```json
{
  "mcpServers": {
    "helix-ssh": {
      "command": "node",
      "args": ["/absolute/path/to/Helix/apps/ssh-mcp/build/index.js"],
      "env": {
        "HELIX_SSH_CONFIG": "/absolute/path/to/ssh-mcp.json"
      }
    }
  }
}
```

## 主机配置写操作

为了避免模型静默修改主机列表，`host_add`、`host_update`、`host_remove` 默认关闭。开启方式：

```bash
export HELIX_ALLOW_HOST_MUTATION=1
```

也可以在配置中设置 `settings.allowHostMutation=true`。

配置中不保存 SSH 密码、sudo 密码或私钥内容。推荐使用 SSH Agent、OpenSSH config 和密钥文件。

## sudo

`sudo_exec` 仅使用 `sudo -n`，要求远程 sudoers 已配置 NOPASSWD，并且命令完整匹配主机配置中的锚定正则 allowlist。Helix 不接受 sudo 密码，也不暴露任意 root shell。

完整设计和验收标准见 [SSH MCP v1 技术设计](docs/architecture/ssh-mcp-v1.md)。
