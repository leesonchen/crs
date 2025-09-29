# Codex CLI - Playwright MCP 安装指南

## 背景

Codex CLI 在 0.38.0 起原生支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 工具。通过安装 Playwright MCP，可以让 Codex 在终端内直接驱动浏览器执行端到端测试、抓取页面信息或生成可复用的脚本。本指南面向已经接入 Claude Relay Service (CRS) 的用户，帮助你在本地完成 Playwright MCP 的安装与配置，使 Codex CLI 可以无缝调用浏览器能力。

> 提醒：Playwright MCP 以本地进程形式运行，所有浏览器操作都会在你的本地机器上执行，请在可信环境下使用。

## 环境准备

- Node.js 18 及以上版本
- npm 10 及以上版本（建议使用 `corepack enable` 以获得最新 npm）
- Codex CLI ≥ 0.38.0（可通过 `codex --version` 查看）
- 可访问 GitHub/NPM 的网络（首次安装依赖时需要）

在 macOS/Linux 上建议预先安装 Playwright 运行所需依赖：

```bash
npx playwright install-deps
```

Windows 环境无需运行上述命令。

## 安装步骤

### 1. 安装 Playwright 及浏览器

```bash
# 全局安装 Playwright CLI
npm install -g playwright

# 安装需使用的浏览器内核（以 Chromium 为例）
playwright install chromium
```

如希望按需安装其它内核（如 `firefox`/`webkit`），重复执行 `playwright install <browser>` 即可。

> 📌 Playwright MCP Server 暂未发布到 npm 官方仓库。如果未来提供 `@modelcontextprotocol/server-playwright` 包，再改为直接安装即可。

### 2. 在 Codex CLI 中注册 MCP Server

编辑 `~/.codex/config.toml`，在现有配置末尾追加以下内容（与 CRS 的 `model_providers` 配置平行）：

```toml
[[mcp_servers]]
name = "playwright"
transport = "stdio"
command = "npx"
args = ["--yes", "github:modelcontextprotocol/servers/playwright"]

[mcp_servers.env]
# Playwright 默认会自动下载浏览器，可按需覆写缓存目录
PLAYWRIGHT_BROWSERS_PATH = "~/.cache/ms-playwright"
```

保存后重新启动 Codex CLI。上述 `args` 通过 `npx` 直接运行官方 `modelcontextprotocol/servers` 仓库中的 Playwright 子项目，跳过了 npm 包发布环节。若后续官方发布了独立 npm 包，可将 `args` 改回 `"@modelcontextprotocol/server-playwright@latest"` 并移除 `--yes`。

### 3. 验证安装

1. 运行 `codex`，打开任意项目会话。
2. 输入 `:tools`（或使用 `Ctrl/Cmd + Shift + P` 搜索 “MCP: 列出工具”）确认列表中出现 `playwright`。
3. 运行示例指令 `:tool playwright.open url=https://example.com`，观察浏览器是否正常启动并返回页面标题。
4. 若需要关闭浏览器，使用 `:tool playwright.close_all`。

如工具未出现，请执行 `codex doctor` 并检查 `~/.codex/logs/latest.log` 中的 MCP 启动日志，确认路径与权限配置是否正确。

## 常见问题与排查

- **NPM 安装失败**：请确认代理或镜像设置，必要时使用 `npm config set registry https://registry.npmmirror.com`。
- **浏览器无法启动**：在 Linux 服务器上需确保已安装 Playwright 依赖，可重新运行 `npx playwright install-deps`。
- **Codex 无法连接 MCP**：确认 `config.toml` 中 `transport` 为 `stdio`，且 `command` 指向可执行文件；同时检查是否存在多个 `[[mcp_servers]]` 条目导致 TOML 语法错误。
- **权限相关错误**：Playwright 默认会写入用户目录缓存，可通过 `PLAYWRIGHT_BROWSERS_PATH` 指向具备读写权限的位置。

完成以上步骤后，Codex CLI 即可通过 MCP 与 Playwright 协同工作，实现自动化浏览器调试与测试能力。
