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

Claude Relay Service 支持两种主要的 CLI 工具集成：

1. **Claude Code CLI** - Anthropic 官方 CLI 工具，用于与 Claude API 交互
2. **Codex CLI** - 用于与 OpenAI Codex API 兼容的服务交互

此外，服务支持**桥接模式（Bridge Mode）**，允许 Claude Code CLI 通过 OpenAI 账户进行请求转发。

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

在 OpenAI-Responses 账户中启用桥接：

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
- `claudeModelMapping`: Claude 模型到 OpenAI 模型的映射
- 留空则使用全局默认映射

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
