# Codex CLI → Claude 桥接实现方案

## 1. 概述

### 1.1 目标
使 Codex CLI 能够通过 `/openai/v1/responses` 端点使用 Claude 账户作为底层模型，实现完整的 OpenAI Responses → Claude 桥接。

### 1.2 核心原则
- **无侵入性**: 不影响现有 OpenAI / OpenAI-Responses 账户逻辑
- **复用现有基础设施**: 利用已实现的 `bridgeService` 和转换器
- **最小化代码重复**: 提取通用逻辑，消除重复代码
- **保持向后兼容**: 所有现有功能保持正常工作

## 2. 架构分析

### 2.1 已实现的基础设施

#### 2.1.1 bridgeService (`src/services/bridgeService.js`)
新实现的统一桥接服务，提供:

```javascript
// Claude → OpenAI 桥接 (已实现)
bridgeClaudeToOpenAI(claudeRequest, accountId, accountType)
  ├─ 获取并标准化 OpenAI 账户
  ├─ 模型映射配置
  ├─ 请求格式转换 (ClaudeToOpenAIResponses)
  ├─ Codex CLI instructions 注入
  └─ 返回: { request, account, bridgeInfo }

// OpenAI → Claude 桥接 (已实现但未使用)
bridgeOpenAIToClaude(openaiRequest, accountId, accountType)
  ├─ 获取并标准化 Claude 账户
  ├─ 模型映射配置
  ├─ 请求格式转换 (OpenAIToClaude)
  └─ 返回: { request, account, bridgeInfo }
```

**关键特性**:
- 账户标准化: 解密 token、补全字段、设置显式类型
- 模型映射: 全局配置 + 账户级覆盖
- 转换器缓存: 避免重复实例化
- 职责单一: 只做格式转换，不涉及网络请求

#### 2.1.2 转换器 (已存在)

```javascript
// OpenAI Responses → Claude (已实现)
OpenAIResponsesToClaudeConverter
  ├─ convertNonStream(responseData)      // 非流式响应转换
  ├─ convertStreamChunk(rawChunk)        // SSE 流式 chunk 转换
  └─ finalizeStream()                     // 流式响应结束

// Claude → OpenAI Responses (已实现)
ClaudeToOpenAIResponsesConverter
  └─ convertRequest(claudeRequest)        // 请求转换

// OpenAI Chat → Claude (已实现)
OpenAIToClaudeConverter
  └─ convertRequest(openaiRequest)        // 传统 Chat API 转换
```

#### 2.1.3 Relay Service 桥接支持

`openaiResponsesRelayService.js` 已支持桥接 hooks:

```javascript
// 流式响应 hooks (Lines 518-841)
req._bridgeStreamTransform = (chunkStr) => {...}  // 转换每个 chunk
req._bridgeStreamFinalize = () => {...}           // 结束时调用
req._bridgeForceNonStream = boolean               // 强制非流式缓冲

// 非流式响应 hooks (Lines 843-933)
req._bridgeNonStreamConvert = (responseData) => {...}
```

**动态账户类型支持** (Lines 9-18):
```javascript
function getAccountService(accountType) {
  if (accountType === 'openai') {
    return require('./openaiAccountService')
  } else if (accountType === 'openai-responses') {
    return require('./openaiResponsesAccountService')
  }
  return require('./openaiResponsesAccountService')
}
```

需要扩展支持 Claude 账户类型:
```javascript
if (accountType === 'claude-official') {
  return require('./claudeAccountService')
} else if (accountType === 'claude-console') {
  return require('./claudeConsoleAccountService')
}
```

### 2.2 现有实现参考: `/api/v1/messages` 中的 OpenAI 桥接

在 `src/routes/api.js` 中(Lines 527-550):

```javascript
} else if (accountType === 'openai' || accountType === 'openai-responses') {
  // 🌉 OpenAI 桥接：将 Claude 请求转换为 OpenAI 请求
  logger.info(`🌉 Using OpenAI bridge for Claude request`)

  // 🔄 使用统一的 prepareOpenAIBridge 函数
  const { fullAccount: bridgeAccount, openaiRequest } = await prepareOpenAIBridge(
    req, accountId, accountType
  )

  // 覆写请求体
  req.body = openaiRequest

  // 🚀 使用统一的 relay service 处理
  const relayService = require('../services/openaiResponsesRelayService')
  await relayService.handleRequest(req, res, bridgeAccount, req.apiKey)
}
```

**prepareOpenAIBridge 辅助函数** (Lines 20-49):
```javascript
async function prepareOpenAIBridge(req, accountId, accountType) {
  // 1. 使用 Bridge Service 桥接
  const bridgeResult = await bridgeService.bridgeClaudeToOpenAI(
    req.body, accountId, accountType
  )

  // 2. 设置上游路径
  req.headers['x-crs-upstream-path'] =
    accountType === 'openai' ? '/responses' : '/v1/responses'

  // 3. 设置响应转换器（OpenAI → Claude）
  const toClaude = new OpenAIResponsesToClaudeConverter()
  req._bridgeConverter = toClaude
  req._bridgeStreamTransform = (chunkStr) => toClaude.convertStreamChunk(chunkStr)
  req._bridgeStreamFinalize = () => toClaude.finalizeStream()
  req._bridgeNonStreamConvert = (responseData) =>
    toClaude.convertNonStream({ response: responseData })

  return {
    fullAccount: bridgeResult.account,
    openaiRequest: bridgeResult.request
  }
}
```

### 2.3 当前缺口: `/openai/v1/responses` 缺少 Claude 桥接

在 `src/routes/openaiRoutes.js` 的 `handleResponses()` 函数中:

**现有逻辑** (Lines 265-276):
```javascript
// 使用调度器选择账户
;({ accessToken, accountId, accountType, proxy, account } =
  await getOpenAIAuthToken(apiKeyData, sessionId, requestedModel))

// ✅ 已实现: OpenAI-Responses 账户
if (accountType === 'openai-responses') {
  logger.info(`🔀 Using OpenAI-Responses relay service`)
  return await openaiResponsesRelayService.handleRequest(req, res, account, apiKeyData)
}

// ⚠️ 缺少: Claude 桥接支持
// 继续往下是 OpenAI OAuth (accountType === 'openai') 的直接转发逻辑
```

## 3. 实现方案

### 3.1 Step 1: 扩展 unifiedClaudeScheduler 的 Reverse Fallback

**现有**: `unifiedClaudeScheduler` 有 OpenAI fallback (Lines 613-686):
```javascript
// 当没有 Claude 账户时，回退到启用 allowClaudeBridge 的 OpenAI 账户
if (availableAccounts.length === 0) {
  const openaiAccounts = await openaiAccountService.getAllAccounts()
  for (const account of openaiAccounts) {
    if (account.allowClaudeBridge === true) {
      availableAccounts.push({...account, accountType: 'openai'})
    }
  }
}
```

**新增**: 反向回退 —— `unifiedOpenAIScheduler` 检查 Claude 账户

在 `src/services/unifiedOpenAIScheduler.js` 的 `selectAccountForApiKey()` 方法中:

```javascript
// 在没有可用 OpenAI 账户时，检查启用了 OpenAI 桥接的 Claude 账户
if (availableAccounts.length === 0) {
  logger.info('🌉 No OpenAI accounts available, checking for Claude bridge-enabled accounts...')

  const claudeAccountService = require('./claudeAccountService')
  const claudeConsoleAccountService = require('./claudeConsoleAccountService')

  // 检查 Claude Official 账户
  const officialAccounts = await claudeAccountService.getAllAccounts()
  for (const account of officialAccounts) {
    const allowBridge = account.allowOpenAIBridge === true ||
                       account.allowOpenAIBridge === 'true'

    if (allowBridge && account.isActive && account.status !== 'error' &&
        this._isSchedulable(account.schedulable)) {
      availableAccounts.push({
        ...account,
        accountId: account.id,
        accountType: 'claude-official',
        priority: parseInt(account.priority) || 50,
        lastUsedAt: account.lastUsedAt || '0'
      })
    }
  }

  // 检查 Claude Console 账户
  const consoleAccounts = await claudeConsoleAccountService.getAllAccounts()
  for (const account of consoleAccounts) {
    const allowBridge = account.allowOpenAIBridge === true ||
                       account.allowOpenAIBridge === 'true'

    if (allowBridge && account.isActive && account.status !== 'error' &&
        this._isSchedulable(account.schedulable)) {
      availableAccounts.push({
        ...account,
        accountId: account.id,
        accountType: 'claude-console',
        priority: parseInt(account.priority) || 50,
        lastUsedAt: account.lastUsedAt || '0'
      })
    }
  }

  logger.info(`🌉 Found ${availableAccounts.length} Claude accounts with OpenAI bridge enabled`)
}
```

### 3.2 Step 2: 在 openaiRoutes.js 中添加 Claude 桥接处理

#### 3.2.1 创建 prepareClaudeBridge 辅助函数

参考 `api.js` 中的 `prepareOpenAIBridge()` 模式，在 `openaiRoutes.js` 顶部添加:

```javascript
const bridgeService = require('../services/bridgeService')
const OpenAIResponsesToClaudeConverter = require('../services/openaiResponsesToClaude')
const claudeRelayService = require('../services/claudeRelayService')
const claudeConsoleRelayService = require('../services/claudeConsoleRelayService')

/**
 * 准备 OpenAI → Claude 桥接配置
 * @param {Object} req - Express 请求对象
 * @param {String} accountId - Claude 账户 ID
 * @param {String} accountType - 账户类型 ('claude-official' | 'claude-console')
 * @returns {Promise<{fullAccount, claudeRequest}>}
 */
async function prepareClaudeBridge(req, accountId, accountType) {
  // 1. 使用 Bridge Service 进行桥接（OpenAI Responses → Claude）
  const bridgeResult = await bridgeService.bridgeOpenAIToClaude(
    req.body,
    accountId,
    accountType
  )

  // 2. 设置响应转换器（Claude → OpenAI Responses）
  const toOpenAI = new ClaudeToOpenAIResponsesConverter({
    modelMapping: bridgeResult.account.openaiModelMapping || {},
    defaultModel: 'gpt-5'
  })

  req._bridgeConverter = toOpenAI
  req._bridgeStreamTransform = (chunkStr) => toOpenAI.convertStreamChunk(chunkStr)
  req._bridgeStreamFinalize = () => toOpenAI.finalizeStream()
  req._bridgeNonStreamConvert = (responseData) =>
    toOpenAI.convertNonStream(responseData)

  // 注意: Claude API 不支持 OpenAI 的 instructions 字段
  // 需要将 instructions 转换为 system 消息（bridgeService 已处理）

  logger.info(
    `✅ Bridge prepared: ${bridgeResult.bridgeInfo.source} → ${bridgeResult.bridgeInfo.target}`,
    {
      accountId: bridgeResult.account.id,
      accountName: bridgeResult.account.name,
      platform: bridgeResult.account.platform,
      originalModel: bridgeResult.bridgeInfo.modelMapping.original,
      mappedModel: bridgeResult.bridgeInfo.modelMapping.mapped,
      duration: `${bridgeResult.bridgeInfo.duration}ms`
    }
  )

  return {
    fullAccount: bridgeResult.account,
    claudeRequest: bridgeResult.request
  }
}
```

#### 3.2.2 修改 handleResponses() 添加桥接逻辑

在 `handleResponses()` 函数中，**在处理 OpenAI-Responses 之后、处理 OpenAI OAuth 之前**插入:

```javascript
// 现有代码 (Line 265-276)
;({ accessToken, accountId, accountType, proxy, account } =
  await getOpenAIAuthToken(apiKeyData, sessionId, requestedModel))

// ✅ 已有: OpenAI-Responses 账户处理
if (accountType === 'openai-responses') {
  logger.info(`🔀 Using OpenAI-Responses relay service for account: ${account.name}`)
  return await openaiResponsesRelayService.handleRequest(req, res, account, apiKeyData)
}

// 🆕 新增: Claude 桥接处理
if (accountType === 'claude-official' || accountType === 'claude-console') {
  logger.info(
    `🌉 Using Claude bridge for OpenAI Responses request - Account: ${accountId}, Type: ${accountType}`
  )

  try {
    // 准备桥接配置
    const { fullAccount: claudeAccount, claudeRequest } = await prepareClaudeBridge(
      req, accountId, accountType
    )

    // 选择对应的 Claude relay service
    if (accountType === 'claude-official') {
      // 使用官方 Claude API
      logger.info(`📡 Forwarding to Claude Official API: ${claudeAccount.name}`)

      // 注意: claudeRelayService 需要适配桥接模式
      // 目前它期望 Claude 格式的响应，我们需要添加转换器支持

      // 方案A: 直接调用 axios + 手动处理（推荐，最灵活）
      // 方案B: 扩展 claudeRelayService 支持桥接 hooks

      // 这里采用方案B，需要修改 claudeRelayService
      await claudeRelayService.relayRequestWithBridge(
        claudeRequest,
        claudeAccount,
        req,
        res,
        req.apiKey,
        {
          bridgeMode: true,
          streamTransform: req._bridgeStreamTransform,
          streamFinalize: req._bridgeStreamFinalize,
          nonStreamConvert: req._bridgeNonStreamConvert
        }
      )
    } else {
      // 使用 Claude Console API
      logger.info(`📡 Forwarding to Claude Console API: ${claudeAccount.name}`)

      await claudeConsoleRelayService.relayRequestWithBridge(
        claudeRequest,
        claudeAccount,
        req,
        res,
        req.apiKey,
        {
          bridgeMode: true,
          streamTransform: req._bridgeStreamTransform,
          streamFinalize: req._bridgeStreamFinalize,
          nonStreamConvert: req._bridgeNonStreamConvert
        }
      )
    }

    return // 桥接处理完成
  } catch (bridgeError) {
    logger.error('❌ Claude bridge failed:', bridgeError)

    // 回退错误处理
    if (!res.headersSent) {
      return res.status(500).json({
        error: {
          type: 'bridge_error',
          message: `Claude bridge failed: ${bridgeError.message}`
        }
      })
    }
  }
}

// 现有代码继续: OpenAI OAuth 处理
// ...
```

### 3.3 Step 3: 扩展 ClaudeToOpenAIResponsesConverter 支持反向转换

**问题**: 当前只有请求转换 (`convertRequest`)，缺少响应转换

**解决方案**: 在 `src/services/claudeToOpenAIResponses.js` 中添加响应转换方法:

```javascript
class ClaudeToOpenAIResponsesConverter {
  // 现有: convertRequest() - 已实现

  /**
   * 转换 Claude 非流式响应为 OpenAI Responses 格式
   * @param {Object} claudeResponse - Claude API 响应
   * @returns {Object} OpenAI Responses 格式响应
   */
  convertNonStream(claudeResponse) {
    const openaiResponse = {
      type: 'response',
      response: {
        id: claudeResponse.id || 'resp_' + Date.now(),
        model: this._mapClaudeModelToOpenAI(claudeResponse.model),
        created: Math.floor(Date.now() / 1000),
        output: []
      }
    }

    // 转换内容
    if (claudeResponse.content && Array.isArray(claudeResponse.content)) {
      for (const block of claudeResponse.content) {
        if (block.type === 'text') {
          openaiResponse.response.output.push({
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'text',
              text: block.text
            }]
          })
        }
      }
    }

    // 转换 usage
    if (claudeResponse.usage) {
      openaiResponse.response.usage = {
        input_tokens: claudeResponse.usage.input_tokens || 0,
        output_tokens: claudeResponse.usage.output_tokens || 0,
        total_tokens:
          (claudeResponse.usage.input_tokens || 0) +
          (claudeResponse.usage.output_tokens || 0)
      }

      // 缓存 tokens 映射
      if (claudeResponse.usage.cache_read_input_tokens) {
        openaiResponse.response.usage.input_tokens_details = {
          cached_tokens: claudeResponse.usage.cache_read_input_tokens
        }
      }
    }

    return openaiResponse
  }

  /**
   * 转换 Claude SSE 流式 chunk 为 OpenAI Responses 格式
   * @param {String} claudeChunk - Claude SSE chunk
   * @returns {String|null} OpenAI Responses SSE chunk
   */
  convertStreamChunk(claudeChunk) {
    // 解析 Claude SSE 格式
    if (!claudeChunk.startsWith('data: ')) {
      return null
    }

    const jsonStr = claudeChunk.slice(6).trim()
    if (jsonStr === '[DONE]') {
      return 'data: [DONE]\n\n'
    }

    try {
      const claudeEvent = JSON.parse(jsonStr)

      // 根据 Claude 事件类型转换
      if (claudeEvent.type === 'content_block_delta') {
        // 文本增量
        const delta = claudeEvent.delta
        if (delta.type === 'text_delta') {
          const openaiEvent = {
            type: 'response.output_item.delta',
            delta: {
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'text',
                text: delta.text
              }]
            }
          }
          return `data: ${JSON.stringify(openaiEvent)}\n\n`
        }
      } else if (claudeEvent.type === 'message_stop') {
        // 消息结束
        return `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: claudeEvent.usage || {}
          }
        })}\n\n`
      }
    } catch (e) {
      logger.debug('Failed to parse Claude SSE chunk:', e)
    }

    return null
  }

  /**
   * 流式响应结束时调用
   */
  finalizeStream() {
    return 'data: [DONE]\n\n'
  }

  /**
   * 映射 Claude 模型到 OpenAI 模型
   * @private
   */
  _mapClaudeModelToOpenAI(claudeModel) {
    const mapping = this.modelMapping || {}

    // 反向查找
    for (const [openaiModel, mappedClaude] of Object.entries(mapping)) {
      if (mappedClaude === claudeModel) {
        return openaiModel
      }
    }

    // 默认映射
    if (claudeModel.includes('sonnet')) return 'gpt-5'
    if (claudeModel.includes('opus')) return 'gpt-5-plus'
    if (claudeModel.includes('haiku')) return 'gpt-5-mini'

    return this.defaultModel || 'gpt-5'
  }
}
```

### 3.4 Step 4: 修改 Relay Services 支持桥接模式

#### 3.4.1 选项A: 简化方案 —— 直接使用 openaiResponsesRelayService

**优势**: 复用现有基础设施，代码最少

在 `openaiRoutes.js` 中:

```javascript
if (accountType === 'claude-official' || accountType === 'claude-console') {
  logger.info(`🌉 Using Claude bridge for OpenAI Responses request`)

  // 准备桥接
  const { fullAccount: claudeAccount, claudeRequest } = await prepareClaudeBridge(
    req, accountId, accountType
  )

  // 覆写请求体为 Claude 格式
  req.body = claudeRequest

  // 设置 Claude API 端点路径
  req.headers['x-crs-upstream-path'] = '/v1/messages'

  // 标准化账户对象（确保有 baseApi 和 apiKey）
  const standardAccount = {
    ...claudeAccount,
    accountType: accountType, // 保留原始类型
    baseApi: claudeAccount.baseApi ||
      (accountType === 'claude-official'
        ? 'https://api.anthropic.com'
        : 'https://api.claude.ai'),
    apiKey: claudeAccount.apiKey || claudeAccount.sessionKey
  }

  // 🔑 关键: 使用 openaiResponsesRelayService，它会:
  // 1. 通过 getAccountService(accountType) 动态加载 Claude account service
  // 2. 使用 req._bridgeStreamTransform / _bridgeNonStreamConvert 转换响应
  logger.info(`📡 Forwarding to ${accountType} via unified relay service`)
  return await openaiResponsesRelayService.handleRequest(
    req, res, standardAccount, apiKeyData
  )
}
```

**需要修改**: `openaiResponsesRelayService.js` 的 `getAccountService()` 添加 Claude 支持

```javascript
// Line 9-18 修改为:
function getAccountService(accountType) {
  if (accountType === 'openai') {
    return require('./openaiAccountService')
  } else if (accountType === 'openai-responses') {
    return require('./openaiResponsesAccountService')
  } else if (accountType === 'claude-official') {
    return require('./claudeAccountService')
  } else if (accountType === 'claude-console') {
    return require('./claudeConsoleAccountService')
  }
  // 默认
  return require('./openaiResponsesAccountService')
}
```

#### 3.4.2 选项B: 扩展 Claude Relay Services

如果需要更精确控制，在 `claudeRelayService.js` 和 `claudeConsoleRelayService.js` 中添加桥接支持:

```javascript
/**
 * 桥接模式请求处理（支持响应格式转换）
 */
async relayRequestWithBridge(claudeRequest, account, req, res, apiKeyData, bridgeOptions) {
  const { streamTransform, streamFinalize, nonStreamConvert } = bridgeOptions

  // 设置桥接 hooks
  req._bridgeStreamTransform = streamTransform
  req._bridgeStreamFinalize = streamFinalize
  req._bridgeNonStreamConvert = nonStreamConvert
  req._bridgeForceNonStream = false // 保持原始流式设置

  // 复用现有 relayRequest / relayStreamRequest 逻辑
  if (claudeRequest.stream) {
    return await this.relayStreamRequestWithUsageCapture(
      claudeRequest,
      apiKeyData,
      res,
      req.headers,
      (usageData) => {
        // Usage callback - 记录使用统计
        // ...
      }
    )
  } else {
    return await this.relayRequest(claudeRequest, apiKeyData, req, res, req.headers)
  }
}
```

**推荐**: 使用**选项A**，因为 `openaiResponsesRelayService` 已经有完整的桥接 hooks 支持。

### 3.5 Step 5: 配置和特性标志

#### 3.5.1 Claude 账户添加 allowOpenAIBridge 字段

在 Web 管理界面和数据模型中添加:

```javascript
// Claude Official Account Schema
{
  id: string,
  name: string,
  sessionKey: string,  // 加密存储
  allowOpenAIBridge: boolean,  // 🆕 新增: 是否允许作为 OpenAI 桥接后端
  openaiModelMapping: object,   // 🆕 新增: OpenAI → Claude 模型映射
  // ... 其他字段
}

// Claude Console Account Schema (同样添加)
{
  allowOpenAIBridge: boolean,
  openaiModelMapping: object
}
```

#### 3.5.2 全局配置 (config/config.js)

```javascript
module.exports = {
  // ... 现有配置

  // OpenAI → Claude 桥接默认配置
  openaiToClaudeBridge: {
    enabled: true,  // 全局开关
    defaultModel: 'claude-3-5-sonnet-20241022',
    modelMapping: {
      'gpt-5': 'claude-sonnet-4-20250514',
      'gpt-5-plus': 'claude-3-opus-20240229',
      'gpt-5-mini': 'claude-3-5-haiku-20241022'
    }
  }
}
```

## 4. 数据流

### 4.1 完整请求流程

```
Codex CLI (OpenAI Responses 格式)
  ↓
POST /openai/v1/responses
  ↓
authenticateApiKey (验证 API Key)
  ↓
handleResponses()
  ↓
unifiedOpenAIScheduler.selectAccountForApiKey()
  ├─ 查找 OpenAI / OpenAI-Responses 账户
  └─ 🆕 fallback: 查找 allowOpenAIBridge=true 的 Claude 账户
  ↓
检测到 accountType = 'claude-official' 或 'claude-console'
  ↓
prepareClaudeBridge()
  ├─ bridgeService.bridgeOpenAIToClaude()
  │   ├─ 获取并标准化 Claude 账户
  │   ├─ OpenAI Responses → Claude 请求转换
  │   └─ 返回 { request, account, bridgeInfo }
  ├─ 设置响应转换器 (Claude → OpenAI Responses)
  │   ├─ _bridgeStreamTransform
  │   ├─ _bridgeStreamFinalize
  │   └─ _bridgeNonStreamConvert
  └─ 返回 { fullAccount, claudeRequest }
  ↓
openaiResponsesRelayService.handleRequest()
  ├─ 通过 getAccountService(accountType) 获取 claudeAccountService
  ├─ 发送到 Claude API (https://api.anthropic.com/v1/messages)
  ├─ 接收 Claude 响应 (SSE 流式或 JSON)
  └─ 通过 _bridgeStreamTransform / _bridgeNonStreamConvert 转换回 OpenAI Responses 格式
  ↓
返回给 Codex CLI (OpenAI Responses 格式)
```

### 4.2 格式转换示例

#### 请求转换 (OpenAI Responses → Claude)

**输入** (Codex CLI):
```json
{
  "model": "gpt-5",
  "instructions": "You are a coding agent running in the Codex CLI...",
  "input": [
    {"type": "message", "role": "user", "content": [{"type": "text", "text": "Write a hello world"}]}
  ],
  "stream": true
}
```

**转换后** (Claude API):
```json
{
  "model": "claude-sonnet-4-20250514",
  "system": "You are a coding agent running in the Codex CLI...",
  "messages": [
    {"role": "user", "content": "Write a hello world"}
  ],
  "stream": true,
  "max_tokens": 4096
}
```

#### 响应转换 (Claude → OpenAI Responses)

**Claude SSE 流**:
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_123","role":"assistant"}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}

event: message_stop
data: {"type":"message_stop","usage":{"input_tokens":10,"output_tokens":5}}
```

**转换为 OpenAI Responses SSE**:
```
data: {"type":"response.output_item.delta","delta":{"type":"message","role":"assistant","content":[{"type":"text","text":"Hello"}]}}

event: response.completed
data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}

data: [DONE]
```

## 5. Usage 统计处理

### 5.1 挑战

OpenAI Responses 和 Claude API 的 usage 格式不同:

**OpenAI Responses**:
```json
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "total_tokens": 150,
    "input_tokens_details": {
      "cached_tokens": 20
    }
  }
}
```

**Claude API**:
```json
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_read_input_tokens": 20,
    "cache_creation_input_tokens": 10
  }
}
```

### 5.2 解决方案

在 `openaiResponsesRelayService.js` 中已有统一处理:

```javascript
// Lines 680-732: 流式响应 usage 记录
if (usageData) {
  const totalInputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
  const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0
  const cacheReadTokens = usageData.input_tokens_details?.cached_tokens ||
                          usageData.cache_read_input_tokens || 0
  const cacheCreateTokens = extractCacheCreationTokens(usageData)
  const actualInputTokens = Math.max(0, totalInputTokens - cacheReadTokens)

  await apiKeyService.recordUsage(
    apiKeyData.id,
    actualInputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    modelToRecord,
    account.id
  )
}
```

**注意**: 需要确保 `extractCacheCreationTokens()` 也支持 Claude 格式:

```javascript
function extractCacheCreationTokens(usageData) {
  if (!usageData || typeof usageData !== 'object') {
    return 0
  }

  // Claude 格式
  if (usageData.cache_creation_input_tokens !== undefined) {
    return Number(usageData.cache_creation_input_tokens) || 0
  }

  // OpenAI Responses 格式
  const details = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
  const candidates = [
    details.cache_creation_input_tokens,
    details.cache_creation_tokens,
    usageData.cache_creation_input_tokens,
    usageData.cache_creation_tokens
  ]

  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }

  return 0
}
```

## 6. 代码复用和重构

### 6.1 已消除的重复

通过 `bridgeService` 统一:
- ✅ 账户获取和标准化逻辑
- ✅ 模型映射配置管理
- ✅ 格式转换器实例化和缓存
- ✅ 桥接元数据跟踪

### 6.2 进一步复用机会

#### 6.2.1 统一 Relay Service 接口

当前各个 relay service 有相似但不同的接口。可以定义统一接口:

```javascript
// src/interfaces/RelayServiceInterface.js
class RelayServiceInterface {
  /**
   * 处理请求（自动检测流式/非流式）
   * @param {Object} req - Express request
   * @param {Object} res - Express response
   * @param {Object} account - 标准化账户对象
   * @param {Object} apiKeyData - API Key 数据
   * @param {Object} options - 可选配置
   */
  async handleRequest(req, res, account, apiKeyData, options = {}) {
    throw new Error('Not implemented')
  }
}
```

#### 6.2.2 抽取通用错误处理

创建 `src/utils/errorHandler.js`:

```javascript
class ErrorHandler {
  static async handle429RateLimit(account, accountType, sessionHash, errorData) {
    // 统一处理 429 错误
  }

  static async handle401Unauthorized(account, accountType, sessionHash, reason) {
    // 统一处理 401 错误
  }

  static async handle502BadGateway(account, accountType) {
    // 统一处理 502 错误
  }
}
```

## 7. 测试计划

### 7.1 单元测试

```javascript
// tests/services/bridgeService.test.js
describe('BridgeService - OpenAI to Claude', () => {
  test('should convert OpenAI Responses request to Claude format', async () => {
    const openaiRequest = {
      model: 'gpt-5',
      instructions: 'You are a helpful assistant',
      input: [...]
    }

    const result = await bridgeService.bridgeOpenAIToClaude(
      openaiRequest, 'claude-account-1', 'claude-official'
    )

    expect(result.request.model).toBe('claude-sonnet-4-20250514')
    expect(result.request.system).toContain('helpful assistant')
    expect(result.request.messages).toBeDefined()
  })
})

// tests/services/claudeToOpenAIResponses.test.js
describe('ClaudeToOpenAIResponsesConverter - Response Conversion', () => {
  test('should convert Claude non-stream response', () => {
    const converter = new ClaudeToOpenAIResponsesConverter()
    const claudeResponse = {
      id: 'msg_123',
      model: 'claude-sonnet-4-20250514',
      content: [{type: 'text', text: 'Hello'}],
      usage: {input_tokens: 10, output_tokens: 5}
    }

    const result = converter.convertNonStream(claudeResponse)

    expect(result.type).toBe('response')
    expect(result.response.model).toBe('gpt-5')
    expect(result.response.usage.total_tokens).toBe(15)
  })
})
```

### 7.2 集成测试

```bash
# 测试 Codex CLI → Claude Official 桥接
curl -X POST http://localhost:8848/openai/v1/responses \
  -H "Authorization: Bearer cr_test_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "instructions": "You are a coding assistant",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [{"type": "text", "text": "Hello"}]
      }
    ],
    "stream": true
  }'

# 验证响应是 OpenAI Responses SSE 格式
# 验证后端日志显示 Claude API 调用
# 验证 usage 统计正确记录
```

### 7.3 E2E 测试（Codex CLI）

```bash
# 配置 Codex CLI
export CRS_OAI_KEY="cr_test_key"

# 运行 Codex
codex "Write a hello world in Python"

# 预期:
# 1. Codex CLI 发送 OpenAI Responses 格式请求
# 2. 中继服务桥接到 Claude API
# 3. 响应转换回 OpenAI Responses 格式
# 4. Codex CLI 正常工作
```

## 8. 部署检查清单

- [ ] **数据库迁移**: 为 Claude 账户添加 `allowOpenAIBridge` 和 `openaiModelMapping` 字段
- [ ] **配置更新**: 添加 `openaiToClaudeBridge` 配置项
- [ ] **依赖检查**: 确认所有转换器文件存在
- [ ] **日志验证**: 检查桥接流程的日志输出
- [ ] **监控告警**: 添加桥接失败率监控
- [ ] **文档更新**: 更新用户文档和 API 说明
- [ ] **性能测试**: 测试桥接模式下的延迟和吞吐量
- [ ] **回滚计划**: 准备快速禁用桥接功能的方案

## 9. 风险和缓解

### 9.1 潜在风险

1. **格式转换不完整**
   - 风险: OpenAI Responses 和 Claude API 有微妙差异
   - 缓解: 详尽的单元测试 + E2E 测试覆盖边缘情况

2. **Usage 统计不准确**
   - 风险: 不同 API 的 token 计数方式可能不同
   - 缓解: 记录原始 usage 数据，定期审计

3. **性能下降**
   - 风险: 额外的格式转换增加延迟
   - 缓解: 转换器缓存、异步处理、性能监控

4. **账户调度混乱**
   - 风险: fallback 逻辑可能导致非预期账户选择
   - 缓解: 详细日志、优先级配置、sticky session 支持

### 9.2 回滚策略

如果出现问题:

1. **快速禁用**: 设置 `config.openaiToClaudeBridge.enabled = false`
2. **账户级禁用**: 将问题账户的 `allowOpenAIBridge` 设为 false
3. **路由级回滚**: 注释 `openaiRoutes.js` 中的 Claude 桥接代码块
4. **完全回滚**: Git revert 到上一个稳定版本

## 10. 后续优化

### 10.1 Phase 1 (MVP)
- ✅ 基本桥接功能（本方案）
- ✅ Claude Official 和 Console 支持
- ✅ 流式和非流式响应

### 10.2 Phase 2
- [ ] Bedrock 账户桥接支持
- [ ] CCR (Gemini) 账户桥接支持
- [ ] 响应缓存优化
- [ ] 智能模型映射（基于负载）

### 10.3 Phase 3
- [ ] 多模型并发请求（投票机制）
- [ ] 自动故障切换
- [ ] 成本优化策略（根据 token 价格选择模型）
- [ ] A/B 测试支持

## 11. 总结

本方案实现了完整的 Codex CLI → Claude 桥接支持:

- **复用现有基础设施**: `bridgeService`, `OpenAIResponsesToClaudeConverter`, `openaiResponsesRelayService`
- **最小化代码改动**: 主要修改集中在 `openaiRoutes.js` 和 `unifiedOpenAIScheduler.js`
- **向后兼容**: 不影响现有 OpenAI / OpenAI-Responses 账户逻辑
- **可扩展**: 统一的桥接模式易于添加新的后端支持

**核心优势**:
1. 利用 `bridgeService` 的统一桥接接口
2. 复用 `openaiResponsesRelayService` 的请求处理逻辑
3. 动态 account service 加载避免硬编码依赖
4. 转换器分离关注点，易于测试和维护
