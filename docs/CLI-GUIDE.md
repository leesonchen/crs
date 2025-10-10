# CLI Integration Guide

综合指南 - Claude Code CLI 和 Codex CLI 与 Claude Relay Service 的完整集成方法、桥接模式配置和故障排除。

## 目录

- [概述](#概述)
- [Claude Code CLI](#claude-code-cli)
- [Codex CLI](#codex-cli)
- [桥接模式](#桥接模式)
- [快速参考](#快速参考)
- [版本历史](#版本历史)
- [故障排查](#故障排查)

---

## 概述

Claude Relay Service 同时兼容 Anthropic 的 **Claude Code CLI** 与 OpenAI 风格的 **Codex CLI**，提供双向桥接功能：

- **Claude Code CLI** 使用 Anthropic 原生的 `messages` 协议，与 `/api/v1/messages` 通道直接通信，也可通过桥接模式转发到 OpenAI Responses
- **Codex CLI** 采用 OpenAI Responses 的 `input` 协议，可直接访问 `/openai/responses`，亦可通过 OpenAI 兼容层访问 Claude
- **桥接模式** 实现两个方向的互通：Claude CLI → OpenAI Responses 与 Codex CLI → Claude

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

**响应格式**:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_..."}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}

event: message_stop
data: {"type":"message_stop"}
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

### 支持的账户类型

| 账户类型 | 说明 | baseApi 示例 |
|---------|------|-------------|
| `openai` | OpenAI OAuth 账户 | `https://chatgpt.com/backend-api/codex` |
| `openai-responses` | OpenAI API Key 账户 | `https://api.codemirror.codes/v1` |

---

## 桥接模式

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

## 快速参考

### 🚀 快速开始

### Claude Code CLI → Claude Console
```bash
export ANTHROPIC_API_KEY="cr_YOUR_API_KEY"
export ANTHROPIC_BASE_URL="http://localhost:3000"

# 使用 Claude Code
claude "Hello, Claude!"
```

### Codex CLI → OpenAI-Responses
```bash
# 配置在客户端中设置
Base URL: http://localhost:3000/openai
API Key: cr_YOUR_API_KEY
Model: gpt-5
```

### 📊 端点对照表

| CLI 工具 | 端点 | 请求格式 | 响应格式 |
|---------|------|---------|---------|
| Claude Code CLI | `/api/v1/messages` | Claude API | Claude API |
| Codex CLI | `/openai/responses` | OpenAI Codex | OpenAI Codex |
| 桥接模式 | `/api/v1/messages` | Claude API | Claude API |

### 🎯 模型映射快查

### 推荐配置

```json
{
  "claudeModelMapping": {
    "claude-3-5-haiku-20241022": "gpt-5",
    "claude-3-5-sonnet-20241022": "gpt-5",
    "claude-sonnet-4-5-20250929": "gpt-5"
  }
}
```

### 模型名称规则

| ✅ 推荐 | ❌ 避免 |
|--------|--------|
| `gpt-5` | `gpt-5-codex-medium` |
| `gpt-4` | `gpt-4-0314` |
| `gpt-3.5-turbo` | `gpt-3.5-turbo-0125` |

**原因**: 使用抽象名称，让上游 API 选择最佳版本。

### 🔍 内容类型支持

| 类型 | Claude Code v1 | Claude Code v2 | 桥接支持 |
|------|----------------|----------------|---------|
| `text` | ✅ | ✅ | ✅ |
| `tool_use` | ✅ | ✅ | ✅ (转为文本) |
| `tool_result` | ✅ | ✅ | ✅ (转为文本) |
| `thinking` | ❌ | ✅ | ✅ (v1.1.156+) |
| `document` | ❌ | ✅ | ✅ (v1.1.156+) |
| `image` | ❌ | ✅ | ❌ (未支持) |

### 🔧 账户配置检查清单

### OpenAI-Responses 账户（桥接模式）

```javascript
{
  "name": "账户名称",
  "baseApi": "https://api.example.com/v1",  // ✅ 末尾不带 /v1/responses
  "apiKey": "sk-xxx",
  "schedulable": true,                       // ✅ 必须启用
  "allowClaudeBridge": true,                 // ✅ 启用桥接
  "isActive": true,                          // ✅ 账户激活
  "status": "active",                        // ✅ 状态正常
  "claudeModelMapping": {                    // ⚡ 可选（建议配置）
    "claude-sonnet-4-5-20250929": "gpt-5"
  }
}
```

### 📝 常用 curl 命令

### 测试 Claude 端点
```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer cr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "messages": [
      {"role": "user", "content": "测试消息"}
    ],
    "stream": false
  }'
```

### 测试 Codex 端点
```bash
curl -X POST http://localhost:3000/openai/responses \
  -H "Authorization: Bearer cr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": [
      {
        "role": "user",
        "content": [{"type": "input_text", "text": "测试消息"}]
      }
    ],
    "stream": true
  }'
```

### 测试桥接模式
```bash
# 确保没有可用的 Claude Console 账户，系统会自动启用桥接
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer cr_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{"role": "user", "content": "测试桥接"}],
    "stream": false
  }'
```

### 🐛 故障排查速查

### 错误 1: "Non-text content is not supported"
```
✅ 解决: 更新到 v1.1.156+（已支持 thinking/document）
```

### 错误 2: "No available OpenAI accounts support the requested model"
```
✅ 解决: 修改 config.js 中 defaultModel 为 'gpt-5'
```

### 错误 3: URL 重复 `/v1/v1/responses`
```
✅ 解决: 已自动修复（智能 URL 拼接）
```

### 错误 4: "Mapped account is no longer available"
```
✅ 检查:
  1. schedulable = true
  2. isActive = true
  3. status = "active"
  4. 未处于限流状态
```

### 🔑 关键配置文件位置

```
config/
  └── config.js                          # 全局配置
      └── claudeBridgeDefaults           # 桥接默认配置
          └── defaultModel: 'gpt-5'      # ← 重要！

src/services/
  ├── claudeToOpenAIResponses.js         # Claude → OpenAI 转换器
  ├── openaiResponsesToClaude.js         # OpenAI → Claude 转换器
  ├── openaiResponsesRelayService.js     # OpenAI 中继服务
  └── unifiedClaudeScheduler.js          # 统一调度器（桥接逻辑）

src/routes/
  ├── api.js                             # Claude API 路由
  └── openaiRoutes.js                    # OpenAI API 路由
```

### 📊 日志标识速查

| 标识 | 含义 |
|------|------|
| `🌉` | 桥接模式激活 |
| `🔄` | 模型映射 |
| `🎯` | 账户选择 |
| `✅` | 操作成功 |
| `❌` | 错误发生 |
| `⚠️` | 警告信息 |
| `🎬` | 调用中继服务 |
| `📡` | 处理流式请求 |
| `📊` | 捕获使用数据 |
| `🔗` | API Key 验证 |

### 🎨 Web 界面操作

### 启用桥接功能

1. **账户管理** → 选择 OpenAI-Responses 账户
2. 点击 **编辑**
3. 启用 **"允许 Claude 桥接"** 开关
4. （可选）配置 **Claude 模型映射**
5. 保存

### 查看日志

1. **系统日志** → 实时日志查看
2. 过滤级别: `info`, `warn`, `error`
3. 搜索关键词: `bridge`, `mapping`, 账户名称

### 检查账户状态

1. **账户管理** → 账户列表
2. 查看状态指示器:
   - 🟢 正常
   - 🟡 限流
   - 🔴 错误

### 🚦 服务健康检查

```bash
# 检查服务状态
curl http://localhost:3000/health

# 查看实时日志
tail -f logs/claude-relay-$(date +%Y-%m-%d).log

# 搜索桥接相关日志
grep "🌉" logs/claude-relay-$(date +%Y-%m-%d).log

# 搜索错误
grep "❌" logs/claude-relay-$(date +%Y-%m-%d).log
```

### 📌 版本兼容性

| 组件 | 版本 | 说明 |
|------|------|------|
| Claude Relay Service | v1.1.156+ | 支持桥接和新内容类型 |
| Claude Code CLI | v1.0.110 | 基础功能 |
| Claude Code CLI | v2.0.1+ | Extended thinking |
| Codex CLI | All | 完全兼容 |
| Node.js | 18+ | 推荐版本 |

---

## 版本历史

### 2025-10-05 - v1.1.156+

#### ✨ 新增功能

1. **支持 Claude Code CLI v2.0.1**
   - 支持 `thinking` 内容类型（extended thinking）
   - 支持 `document` 内容类型
   - 兼容 `?beta=true` 参数

2. **桥接模式增强**
   - 优化模型映射逻辑
   - 支持账户级和全局级模型映射
   - 自动内容类型转换

3. **完整文档体系**
   - CLI Integration Guide（完整集成指南）
   - CLI Quick Reference（快速参考卡片）

#### 🐛 Bug 修复

1. **修复默认模型配置**
   - 从 `gpt-5-codex-medium` 改为 `gpt-5`
   - 提升上游 API 兼容性

2. **修复 URL 拼接问题**
   - 智能处理 baseApi 和 upstreamPath
   - 避免路径重复（如 `/v1/v1/responses`）

3. **修复 accountType 识别**
   - 动态检测账户类型
   - 正确传递给调度器和限流逻辑

4. **修复非文本内容支持**
   - 转换器支持 5 种内容类型
   - 优雅处理 thinking 和 document

#### 🔧 改进优化

1. **代码位置**
   - `config/config.js:89` - 默认模型配置
   - `src/services/claudeToOpenAIResponses.js:92-93` - 允许类型列表
   - `src/services/claudeToOpenAIResponses.js:179-193` - thinking/document 处理
   - `src/services/claudeToOpenAIResponses.js:273-285` - document 辅助方法
   - `src/services/openaiResponsesRelayService.js:55-67` - 账户类型检测
   - `src/services/openaiResponsesRelayService.js:84-96` - 智能 URL 拼接

2. **日志增强**
   - 添加桥接模式标识 🌉
   - 模型映射来源标记
   - 账户选择详细信息

### 历史版本

### v1.1.155 及之前
- 基础 Claude Code CLI v1.0.110 支持
- 基础桥接模式实现
- 只支持 text/tool_use/tool_result 内容类型

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

## 相关文件

- **桥接转换器**: `src/services/claudeToOpenAIResponses.js`
- **反向转换器**: `src/services/openaiResponsesToClaude.js`
- **OpenAI 中继服务**: `src/services/openaiResponsesRelayService.js`
- **统一调度器**: `src/services/unifiedClaudeScheduler.js`
- **主路由**: `src/routes/api.js`
- **OpenAI 路由**: `src/routes/openaiRoutes.js`
- **配置文件**: `config/config.js`

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

**最后更新**: 2025-10-05
**维护者**: Claude Relay Service Team