# CLI Quick Reference

快速参考卡片 - Claude Code CLI 和 Codex CLI 的常用配置和命令。

## 🚀 快速开始

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

---

## 📊 端点对照表

| CLI 工具 | 端点 | 请求格式 | 响应格式 |
|---------|------|---------|---------|
| Claude Code CLI | `/api/v1/messages` | Claude API | Claude API |
| Codex CLI | `/openai/responses` | OpenAI Codex | OpenAI Codex |
| 桥接模式 | `/api/v1/messages` | Claude API | Claude API |

---

## 🎯 模型映射快查

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

---

## 🔍 内容类型支持

| 类型 | Claude Code v1 | Claude Code v2 | 桥接支持 |
|------|----------------|----------------|---------|
| `text` | ✅ | ✅ | ✅ |
| `tool_use` | ✅ | ✅ | ✅ (转为文本) |
| `tool_result` | ✅ | ✅ | ✅ (转为文本) |
| `thinking` | ❌ | ✅ | ✅ (v1.1.156+) |
| `document` | ❌ | ��� | ✅ (v1.1.156+) |
| `image` | ❌ | ✅ | ❌ (未支持) |

---

## 🔧 账户配置检查清单

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

### OpenAI OAuth 账户

```javascript
{
  "name": "账户名称",
  "baseApi": "https://chatgpt.com/backend-api/codex",  // 默认值
  "accessToken": "encrypted_token",
  "refreshToken": "encrypted_token",
  "schedulable": true,
  "allowClaudeBridge": true,
  "isActive": true
}
```

---

## 📝 常用 curl 命令

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

---

## 🐛 故障排查速查

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

### 错误 5: accountType 识别错误
```
✅ 解决: 已自动修复（动态类型检测）
```

---

## 🔑 关键配置文件位置

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

---

## 📊 日志标识速查

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

---

## 🎨 Web 界面操作

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

---

## 🚦 服务健康检查

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

---

## 📌 版本兼容性

| 组件 | 版本 | 说明 |
|------|------|------|
| Claude Relay Service | v1.1.156+ | 支持桥接和新内容类型 |
| Claude Code CLI | v1.0.110 | 基础功能 |
| Claude Code CLI | v2.0.1+ | Extended thinking |
| Codex CLI | All | 完全兼容 |
| Node.js | 18+ | 推荐版本 |

---

**最后更新**: 2025-10-05
**相关文档**: [CLI Integration Guide](./cli-integration-guide.md)
