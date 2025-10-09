# CLI Integration Guide

本文档详细介绍 Claude Code CLI 和 Codex CLI 与 Claude Relay Service 的集成方法、调用格式、桥接模式配置以及常见问题解决。

## 目录

- [概述](#概述)
- [Claude Code CLI](#claude-code-cli)
- [Codex CLI](#codex-cli)
- [桥接模式（Bridge Mode）](#桥接模式bridge-mode)
- [调用示例对比](#调用示例对比)
- [故障排查](#故障排查)

---

## 概述

Claude Relay Service 同时兼容 Anthropic 的 **Claude Code CLI** 与 OpenAI 风格的 **Codex CLI**。为方便运维，本指南按照“协议格式 → 交互矩阵 → 排错与工具”逐层拆解，帮助你快速确认每一条调用链是否工作正常。

- **Claude Code CLI** 使用 Anthropic 原生的 `messages` 协议，与 `/api/v1/messages` 通道直接通信，也可通过桥接模式转发到 OpenAI Responses。
- **Codex CLI** 采用 OpenAI Responses 的 `input` 协议，可直接访问 `/openai/responses`，亦可通过 OpenAI 兼容层访问 Claude `/openai/claude/v1/chat/completions`。
- **桥接模式** 则负责在两个协议之间转换，实现“Claude CLI → OpenAI Responses”与“Codex CLI → Claude”两个方向的互通。

后文给出了详细示例与自动化脚本，协助你验证四种常见组合：

1. Claude CLI → Claude 服务
2. Claude CLI → OpenAI Responses（Claude→OpenAI 桥接）
3. Codex CLI → OpenAI Responses
4. Codex CLI → Claude 服务（OpenAI→Claude 桥接）

> 📌 **术语约定**：文档中若提到 *Claude CLI 请求*，指 Anthropic `messages` 协议；提到 *Codex CLI 请求*，指 OpenAI Responses 协议。

---

## Claude Code CLI

### 版本差异

#### v1.0.110（旧版本）
- User-Agent: `claude-cli/1.0.110 (external, cli, browser-fallback)`
- 支持基本的文本内容和工具调用
- 内容类型: `text`, `tool_use`, `tool_result`

#### v2.0.1（新版本）
- User-Agent: `claude-cli/2.0.1 (external, cli)`
- 支持 Beta 功能（extended thinking）
- 新增内容类型: `thinking`, `document`
- URL 参数: `?beta=true`

### 调用格式

#### 端点
```
POST /api/v1/messages
```

#### 请求头
```http
POST /api/v1/messages?beta=true HTTP/1.1
Host: localhost:3000
Content-Type: application/json
Authorization: Bearer cr_YOUR_API_KEY_HERE
User-Agent: claude-cli/2.0.1 (external, cli)
```

#### 请求体结构
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Hello, Claude!"
        }
      ]
    }
  ],
  "stream": false,
  "max_tokens": 4096
}
```

#### 关键字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | Claude 官方模型 ID，例如 `claude-3-5-haiku-20241022`、`claude-sonnet-4-20250514` |
| `messages` | array | 对话消息数组，元素包含 `role` 与 `content` |
| `messages[].role` | enum | `system` / `user` / `assistant` |
| `messages[].content` | array | 内容块列表；详见下方“支持的内容类型” |
| `stream` | boolean | 是否开启 SSE 流式输出 |
| `max_tokens` | number | （可选）最大生成 token 数；留空由服务决定 |

常见做法：在会话开始时附加一个 `system` 块来设置语气，随后 `user` 与 `assistant` 交替出现。

#### 支持的内容类型

| 类型 | 描述 | 示例 |
|------|------|------|
| `text` | 普通文本内容 | `{"type": "text", "text": "Hello"}` |
| `tool_use` | 工具调用请求 | `{"type": "tool_use", "id": "...", "name": "...", "input": {...}}` |
| `tool_result` | 工具执行结果 | `{"type": "tool_result", "tool_use_id": "...", "content": [...]}` |
| `thinking` | 思维过程（v2.0.1+） | `{"type": "thinking", "thinking": "分析中..."}` |
| `document` | 文档内容（v2.0.1+） | `{"type": "document", "title": "...", "content": "..."}` |

### 流式响应

Claude Code CLI 支持 SSE（Server-Sent Events）流式响应：

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [...],
  "stream": true
}
```

**响应格式**:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_..."}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}

event: message_stop
data: {"type":"message_stop"}
```

事件通常以 `message_start → content_block_start → content_block_delta (×n) → content_block_stop → message_delta → message_stop` 收束。客户端在收到 `message_stop` 后应关闭连接并整合前面的增量数据。

### 非流式响应示例

```jsonc
{
  "id": "msg_01H0XYZ",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-20250514",
  "stop_reason": "end_turn",
  "content": [
    {
      "type": "text",
      "text": "Hello from Claude CLI protocol."
    }
  ],
  "usage": {
    "input_tokens": 120,
    "output_tokens": 32,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

> `usage` 字段用于记录真实 token 用量。官方 Claude 账户和桥接模式都会尽量填充该字段，便于后续账务与速率统计。

### 日志示例

**成功调用**:
```
🔗 🔓 API key validated successfully
🔗 🚀 Processing stream request for key: local
🎯 Using sticky session account: xxx (claude-console)
📡 Processing streaming Claude Console API request
🟢 POST /api/v1/messages - 200 (2163ms)
```

---

## Codex CLI

### 调用格式

#### 端点
```
POST /openai/responses
```

#### 请求头
```http
POST /openai/responses HTTP/1.1
Host: localhost:3000
Content-Type: application/json
Authorization: Bearer cr_YOUR_API_KEY_HERE
User-Agent: Mozilla/5.0 ... CherryStudio/1.5.11 ...
```

#### 请求体结构
```json
{
  "model": "gpt-5",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Hello, Codex!"
        }
      ]
    }
  ],
  "stream": true
}
```

#### 关键字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | OpenAI Responses 抽象模型名（常用：`gpt-5`、`gpt-5-mini` 等） |
| `input` | array | 消息数组，由 `role` 与 `content` 组成 |
| `input[].role` | enum | `system` / `user` / `assistant` |
| `input[].content` | array | 内容块列表，常用 `input_text` / `output_text` |
| `stream` | boolean | 是否请求 SSE 流 |

**内容块类型**：

| `type` | 方向 | 描述 |
|--------|------|------|
| `input_text` | user/system | Codex CLI 发送给服务的数据块 |
| `output_text` | assistant | 服务返回 Codex CLI 的文本（流式时逐块发送） |
| `refusal` | assistant | 拒绝响应（可选） |
| `tool_call` / `tool_output` | assistant / tool | 带工具调用的场景（尚为 Beta） |

#### 非流式响应示例

```jsonc
{
  "id": "resp_01J...",
  "model": "gpt-5",
  "output": [
    {
      "id": "msg_01T...",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Hello from Codex protocol."
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 110,
    "output_tokens": 25,
    "total_tokens": 135
  }
}
```

### OpenAI Codex API 格式

**关键差异**:
- 字段名: `input` (而非 `messages`)
- 内容类型: `input_text` / `output_text` (而非 `text`)
- 模型名: `gpt-5` (抽象名称，由 API 决定具体版本)

### 支持的账户类型

| 账户类型 | 说明 | baseApi 示例 |
|---------|------|-------------|
| `openai` | OpenAI OAuth 账户 | `https://chatgpt.com/backend-api/codex` |
| `openai-responses` | OpenAI API Key 账户 | `https://api.codemirror.codes/v1` |

### 日志示例

**成功调用**:
```
🎯 Selected account: codemirror转发codex (openai-responses)
🔀 Using OpenAI-Responses relay service
🎯 Forwarding to: https://api.codemirror.codes/v1/responses
📊 Successfully captured usage data from OpenAI-Responses
🟢 POST /openai/responses - 200 (2708ms)
```

---

## 桥接模式（Bridge Mode）

桥接模式允许 Claude Code CLI 通过 OpenAI 账户进行请求转发，实现 Claude API → OpenAI API 的协议转换。

### 工作原理

```
Claude Code CLI
    ↓ (Claude API 请求)
Claude Relay Service
    ↓ (桥接转换)
OpenAI-Responses Account
    ↓ (OpenAI API 请求)
Upstream API
```

### 配置要求

#### 1. 账户级配置

在 OpenAI/OpenAI-Responses 账户中启用桥接：

```json
{
  "name": "codemirror转发codex",
  "baseApi": "https://api.codemirror.codes/v1",
  "apiKey": "sk-xxx",
  "allowClaudeBridge": true,
  "claudeModelMapping": {
    "claude-3-5-haiku-20241022": "gpt-5",
    "claude-3-5-sonnet-20241022": "gpt-5",
    "claude-sonnet-4-5-20250929": "gpt-5"
  }
}
```

**字段说明**:
- `allowClaudeBridge`: 是否允许作为 Claude 桥接账户
- `claudeModelMapping`: Claude 模型到 OpenAI 模型的映射，映射值为 OpenAI Responses 模型名
- 留空则使用全局默认映射；你可以在 Admin → 账户管理 → 编辑 OpenAI 账户 中通过开关及映射表界面完成配置。

#### 2. 全局配置

`config/config.js`:
```javascript
claudeBridgeDefaults: {
  modelMapping: {
    // 全局模型映射（可选）
  },
  defaultModel: 'gpt-5' // 默认模型（使用抽象名称）
}
```

### 模型映射策略

**优先级**: 账户级映射 > 全局映射 > 默认模型

**最佳实践**:
```javascript
// ✅ 推荐：使用抽象模型名
defaultModel: 'gpt-5'

// ❌ 不推荐：使用具体版本名（可能不被上游支持）
defaultModel: 'gpt-5-codex-medium'
```

**原因**: 上游 API 通常支持抽象名称（如 `gpt-5`），由 API 自动选择最佳版本，但不一定支持具体版本名称。

### 桥接转换逻辑

#### 请求转换

**Claude 格式** → **OpenAI 格式**:

| Claude | OpenAI |
|--------|--------|
| `messages` | `input` |
| `{"type": "text", "text": "..."}` | `{"type": "input_text", "text": "..."}` |
| `model: "claude-xxx"` | `model: "gpt-5"` (映射后) |

#### 内容块转换

```javascript
// text 块
Claude: {"type": "text", "text": "Hello"}
OpenAI: {"type": "input_text", "text": "Hello"}

// thinking 块 (v2.0.1+)
Claude: {"type": "thinking", "thinking": "分析中..."}
OpenAI: {"type": "input_text", "text": "[Thinking: 分析中...]"}

// document 块
Claude: {"type": "document", "title": "Doc", "content": "..."}
OpenAI: {"type": "input_text", "text": "[Doc]\n..."}

// tool_use 块
Claude: {"type": "tool_use", "id": "123", "name": "search", "input": {...}}
OpenAI: {"type": "input_text", "text": "[tool_call name=search id=123] {...}"}
```

#### 响应转换

**OpenAI 格式** → **Claude 格式**:

```javascript
// 流式响应
OpenAI SSE → Claude SSE

// 非流式响应
OpenAI JSON → Claude JSON
```

### 调度逻辑

当 Claude Console 账户不可用时，自动启用桥接：

```javascript
// 1. 检查 Claude 账户
if (availableClaudeAccounts.length === 0) {
  // 2. 查找支持桥接的 OpenAI 账户
  const bridgeAccounts = openaiResponsesAccounts.filter(
    acc => acc.allowClaudeBridge === true && acc.schedulable === true
  )

  // 3. 添加到可用账户池
  availableAccounts.push(...bridgeAccounts)
}
```

### 日志示例

**桥接模式激活**:
```
🌉 No Claude accounts available, checking for OpenAI bridge-enabled accounts...
✅ Added OpenAI-Responses bridge account to pool: codemirror转发codex
🎯 Selected account: codemirror转发codex (openai-responses)
🌉 Using OpenAI bridge for Claude request
🔄 Model mapping: claude-sonnet-4-5-20250929 → gpt-5 (source: default)
🎬 Calling relay service with account type: openai-responses
🎯 Forwarding to: https://api.codemirror.codes/v1/responses
✅ Bridge completed: Claude request → openai-responses → Claude response
```

---

## 交互矩阵与自动化验证

| 序号 | 客户端协议 | 目标服务 | 入口端点 | 说明 |
|------|-----------|----------|----------|------|
| 1 | Claude CLI (`messages`) | Claude 官方 / Claude Console | `/api/v1/messages` | 默认路径，使用 Anthropic 协议 |
| 2 | Claude CLI (`messages`) | OpenAI Responses | `/claude/openai/v1/messages` | Claude→OpenAI 桥接；要求目标账户启用 `allowClaudeBridge` |
| 3 | Codex CLI (`responses`) | OpenAI Responses | `/openai/responses` | OpenAI Responses 协议原生路径 |
| 4 | Codex CLI (`responses`) | Claude 官方 / Claude Console | `/openai/claude/v1/chat/completions` | OpenAI→Claude 桥接，自动转换为 Claude `messages` 协议 |

### 自动化测试脚本

仓库提供 `scripts/test-cli-protocols.js` 来验证以上四类交互。脚本默认读取 `scripts/test-cli-protocols.config.json`（若不存在，可复制 `.config.example` 并按需填写），示例如下：

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "timeoutMs": 15000,
  "scenarios": {
    "claudeDirect": [
      { "name": "official-sonnet", "apiKey": "cr_xxx", "model": "claude-sonnet-4-20250514" }
    ],
    "claudeBridge": [
      { "name": "bridge-openai", "apiKey": "cr_bridge", "model": "claude-3-5-haiku-20241022" }
    ],
    "codexOpenAI": [
      { "name": "responses-account", "apiKey": "cr_codex", "model": "gpt-5" }
    ],
    "codexClaude": [
      { "name": "codex-to-claude", "apiKey": "cr_openai_compat", "model": "claude-sonnet-4-20250514" }
    ]
  }
}
```

运行方式：

```bash
node scripts/test-cli-protocols.js [path/to/config.json]
```

脚本会逐一发送非流式健康检查请求（默认超时 15 秒），对每个场景打印 `status`、`latency` 与响应摘要；若任意请求失败会以非零退出码结束，适用于部署后或 CI 验证。

---

## 调用示例对比

### 场景 1: 直接调用 Claude Console

```bash
# Claude Code CLI → Claude Console Account
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer cr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

**日志**:
```
🎯 Using sticky session account: 拼车转发cc0 (claude-console)
📡 Processing streaming Claude Console API request
🟢 POST /api/v1/messages - 200
```

### 场景 2: 桥接模式调用

```bash
# Claude Code CLI → OpenAI-Responses Account (桥接)
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer cr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

**日志**:
```
🌉 No Claude accounts available, checking for OpenAI bridge-enabled accounts...
🌉 Using OpenAI bridge for Claude request
🔄 Model mapping: claude-sonnet-4-5-20250929 → gpt-5 (source: default)
🎯 Forwarding to: https://api.codemirror.codes/v1/responses
✅ Bridge completed
```

### 场景 3: 直接调用 Codex

```bash
# Codex CLI → OpenAI-Responses Account
curl -X POST http://localhost:3000/openai/responses \
  -H "Authorization: Bearer cr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": [
      {"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}
    ],
    "stream": true
  }'
```

**日志**:
```
🎯 Selected account: codemirror转发codex (openai-responses)
🎯 Forwarding to: https://api.codemirror.codes/v1/responses
📊 Successfully captured usage data from OpenAI-Responses
🟢 POST /openai/responses - 200
```

---

## 故障排查

### 问题 1: "Non-text content is not supported"

**错误信息**:
```
Error: Non-text content is not supported in /claude/openai (phase 1)
```

**原因**: Claude Code CLI v2.0.1 发送了 `thinking` 或 `document` 类型内容，但转换器不支持。

**解决方案**: 已在 `src/services/claudeToOpenAIResponses.js` 中添加支持。

**修复内容**:
```javascript
// 支持的内容类型
const allowedTypes = new Set([
  'text',
  'tool_use',
  'tool_result',
  'thinking',   // ← 新增
  'document'    // ← 新增
])
```

### 问题 2: "No available OpenAI accounts support the requested model"

**错误信息**:
```
Error: No available OpenAI accounts support the requested model: gpt-5-codex-medium
```

**原因**: 上游 API 不支持具体的模型版本名称 `gpt-5-codex-medium`。

**解决方案**: 修改默认模型为抽象名称。

**修复前** (`config/config.js`):
```javascript
defaultModel: 'gpt-5-codex-medium'  // ❌
```

**修复后**:
```javascript
defaultModel: 'gpt-5'  // ✅
```

### 问题 3: URL 拼接错误 (404)

**错误现象**:
```
https://api.codemirror.codes/v1/v1/responses  // 重复 /v1
```

**原因**: baseApi 和 upstreamPath 拼接时未处理重复路径。

**解决方案**: 智能 URL 拼接逻辑（已实现）。

**代码位置**: `src/services/openaiResponsesRelayService.js:84-96`

```javascript
let targetUrl
const baseApi = fullAccount.baseApi.replace(/\/+$/, '')
if (baseApi.endsWith(upstreamPath)) {
  targetUrl = baseApi
} else if (baseApi.endsWith('/v1') && upstreamPath.startsWith('/v1/')) {
  targetUrl = `${baseApi}${upstreamPath.slice(3)}`
} else {
  targetUrl = `${baseApi}${upstreamPath}`
}
```

### 问题 4: "Mapped account is no longer available"

**警告信息**:
```
⚠️ Mapped account 4c0d7fbf-b197-4585-9a5e-f0e383db46be is no longer available
```

**原因**:
1. 账户的 `schedulable` 被设置为 `false`
2. 账户状态变为 `error` 或 `rateLimited`

**解决方案**:
1. 在 Web 界面检查账户状态
2. 启用 `schedulable` 开关
3. 检查账户是否处于限流状态

### 问题 5: accountType 识别错误

**错误信息**:
```
❌ Failed to mark account as rate limited: xxx (openai-responses) Account not found
```

**原因**: 硬编码了 `accountType` 为 `'openai-responses'`，但实际账户类型是 `'openai'`。

**解决方案**: 动态检测账户类型（已修复）。

**修复位置**: `src/services/openaiResponsesRelayService.js:55-67`

```javascript
let accountType = 'openai-responses'
if (account.apiKey && account.baseApi) {
  accountType = account.platform || account.accountType || 'openai-responses'
  logger.debug(`Using pre-configured account for bridge mode, type: ${accountType}`)
}
```

---

## 相关文件

- **桥接转换器**: `src/services/claudeToOpenAIResponses.js`
- **反向转换器**: `src/services/openaiResponsesToClaude.js`
- **OpenAI 中继服务**: `src/services/openaiResponsesRelayService.js`
- **统一调度器**: `src/services/unifiedClaudeScheduler.js`
- **主路由**: `src/routes/api.js`
- **OpenAI 路由**: `src/routes/openaiRoutes.js`
- **配置文件**: `config/config.js`

---

## 最佳实践

### 1. 模型配置

```javascript
// ✅ 推荐：账户级配置
{
  "claudeModelMapping": {
    "claude-3-5-haiku-20241022": "gpt-5",
    "claude-3-5-sonnet-20241022": "gpt-5-turbo",
    "claude-sonnet-4-5-20250929": "gpt-5"
  }
}

// ✅ 推荐：使用抽象模型名
defaultModel: 'gpt-5'

// ❌ 避免：使用不被上游支持的具体版本
defaultModel: 'gpt-5-codex-medium'
```

### 2. 调度配置

```javascript
// 账户设置
{
  "schedulable": true,        // 允许调度
  "allowClaudeBridge": true,  // 允许桥接
  "isActive": true,           // 账户激活
  "status": "active"          // 状态正常
}
```

### 3. 日志监控

关键日志标识：
- `🌉` - 桥接模式激活
- `🔄` - 模型映射
- `🎯` - 账户选择
- `✅` - 桥接完成
- `❌` - 错误发生

### 4. 错误处理

```javascript
// 转换器应该优雅处理不支持的内容类型
if (block.type === 'unknown_type') {
  logger.warn(`Unsupported content type: ${block.type}, skipping`)
  continue  // 跳过而非抛出错误
}
```

---

## 版本历史

### v1.1.156+
- ✅ 支持 Claude Code CLI v2.0.1
- ✅ 添加 `thinking` 和 `document` 内容类型支持
- ✅ 修复默认模型为 `gpt-5`
- ✅ 智能 URL 拼接避免路径重复
- ✅ 动态 accountType 检测

### 未来计划
- [ ] 支持图片内容（`image` 类型）
- [ ] 优化桥接转换性能
- [ ] 添加更多模型映射预设

---

**最后更新**: 2025-10-05
**维护者**: Claude Relay Service Team
