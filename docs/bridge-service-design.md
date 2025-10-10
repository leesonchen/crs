# Bridge Service 设计文档

## 概述

Bridge Service 是 Claude Relay Service 架构重构的核心组件，负责不同 AI API 格式之间的转换和账户对象标准化。

## 设计目标

1. **单一职责**：专注于格式转换和账户准备，不涉及实际的网络请求
2. **双向支持**：支持 Claude ↔ OpenAI 双向桥接
3. **可扩展**：易于添加新的桥接方向（Gemini、Azure等）
4. **类型安全**：显式的类型标识，避免隐式推断

## 架构定位

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Layer                           │
│  Claude Code CLI / Codex CLI / Cherry Studio / 其他客户端   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                      Route Layer                            │
│  src/routes/api.js, openaiRoutes.js                         │
│  - 接收请求                                                 │
│  - 选择桥接或直接转发                                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                   Bridge Service (NEW)                      │
│  src/services/bridgeService.js                              │
│  - 格式转换（使用 converter 类）                            │
│  - 账户标准化                                               │
│  - 返回标准化的 { request, account, bridgeInfo }           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                   Relay Service Layer                       │
│  openaiRelayService, claudeRelayService                     │
│  - 纯转发：构建 HTTP 请求 + 发送到上游                      │
│  - 不再查询账户                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                   Upstream AI APIs                          │
│  Claude API / OpenAI API / Codex API / Gemini API           │
└─────────────────────────────────────────────────────────────┘
```

## 核心接口设计

### 主接口

```javascript
class BridgeService {
  /**
   * Claude → OpenAI 桥接
   * @param {Object} claudeRequest - Claude API 格式请求
   * @param {String} accountId - 账户ID
   * @param {String} accountType - 账户类型 ('openai' | 'openai-responses')
   * @returns {Promise<BridgeResult>}
   */
  async bridgeClaudeToOpenAI(claudeRequest, accountId, accountType)

  /**
   * OpenAI → Claude 桥接（反向）
   * @param {Object} openaiRequest - OpenAI API 格式请求
   * @param {String} accountId - 账户ID
   * @param {String} accountType - 账户类型 ('claude-official' | 'claude-console' | 'bedrock')
   * @returns {Promise<BridgeResult>}
   */
  async bridgeOpenAIToClaude(openaiRequest, accountId, accountType)
}
```

### 返回对象结构

```javascript
/**
 * @typedef {Object} BridgeResult
 * @property {Object} request - 转换后的请求对象
 * @property {Object} account - 标准化的账户对象
 * @property {Object} bridgeInfo - 桥接元信息
 */

// 示例
{
  request: {
    model: "gpt-5",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    stream: true,
    store: false,
    instructions: "..."
  },
  account: {
    id: "df68ba74-6780-4423-a08a-5f449a2fbad1",
    name: "openai-codex",
    accountType: "openai",
    platform: "openai-oauth",
    apiKey: "<decrypted-token>",
    baseApi: "https://chatgpt.com/backend-api/codex",
    chatgptAccountId: "user-xxx",
    proxy: { ... }
  },
  bridgeInfo: {
    source: "claude",
    target: "openai",
    accountType: "openai",
    converter: "ClaudeToOpenAIResponses",
    modelMapping: {
      original: "claude-3-5-sonnet-20241022",
      mapped: "gpt-5",
      mappingSource: "default"
    }
  }
}
```

## 账户标准化规范

### 标准账户对象字段

所有账户对象在标准化后必须包含以下字段：

```javascript
{
  // 必需字段
  id: String,              // 账户唯一标识
  name: String,            // 账户名称
  accountType: String,     // 账户类型（显式）
  platform: String,        // 平台标识（显式）
  apiKey: String,          // 已解密的 API Key 或 Token
  baseApi: String,         // API 基础地址

  // 可选字段
  proxy: Object,           // 代理配置
  userAgent: String,       // User-Agent
  chatgptAccountId: String, // Codex API 特殊字段（仅 OpenAI OAuth）

  // 原始字段（保留）
  ...otherFields
}
```

### OpenAI 账户标准化

```javascript
_standardizeOpenAIAccount(rawAccount, accountType) {
  const account = { ...rawAccount }

  // 1. 设置显式类型
  account.accountType = accountType
  account.platform = accountType === 'openai' ? 'openai-oauth' : 'openai-responses'

  // 2. 处理认证信息
  if (accountType === 'openai') {
    // OAuth 账户：accessToken 加密存储，需解密
    if (account.accessToken) {
      const { decrypt } = require('./openaiAccountService')
      account.apiKey = decrypt(account.accessToken)
    }
    // Codex API 特殊字段
    account.baseApi = account.baseApi || 'https://chatgpt.com/backend-api/codex'
    account.chatgptAccountId = account.accountId || account.chatgptUserId
  } else {
    // API Key 账户：已解密
    account.apiKey = account.accessToken || account.apiKey
    account.baseApi = account.baseApi || 'https://api.openai.com'
  }

  // 3. 验证必需字段
  if (!account.apiKey) {
    throw new Error(`Account ${account.id} missing apiKey after standardization`)
  }

  return account
}
```

### Claude 账户标准化

```javascript
_standardizeClaudeAccount(rawAccount, accountType) {
  const account = { ...rawAccount }

  // 1. 设置显式类型
  account.accountType = accountType
  account.platform = accountType // 'claude-official' | 'claude-console' | 'bedrock'

  // 2. 处理认证信息
  if (accountType === 'claude-official') {
    // OAuth 账户
    if (account.sessionKey) {
      const { decrypt } = require('./claudeAccountService')
      account.apiKey = decrypt(account.sessionKey)
    }
    account.baseApi = 'https://api.anthropic.com'
  } else if (accountType === 'claude-console') {
    // Console 账户
    account.baseApi = 'https://console.anthropic.com'
  } else if (accountType === 'bedrock') {
    // Bedrock
    account.baseApi = account.baseApi || 'bedrock-runtime'
  }

  // 3. 验证必需字段
  if (!account.apiKey && accountType !== 'bedrock') {
    throw new Error(`Account ${account.id} missing apiKey`)
  }

  return account
}
```

## 转换器集成

Bridge Service 使用现有的转换器类，不重新实现转换逻辑：

### 使用的转换器

1. **ClaudeToOpenAIResponsesConverter** - Claude → OpenAI Responses 格式
2. **OpenAIResponsesToClaudeConverter** - OpenAI Responses → Claude 格式（流式）
3. **OpenAIToClaudeConverter** - OpenAI → Claude 格式

### 集成方式

```javascript
// Claude → OpenAI
const ClaudeToOpenAIResponsesConverter = require('./claudeToOpenAIResponses')
const converter = new ClaudeToOpenAIResponsesConverter({
  modelMapping: combinedMapping,
  defaultModel: defaultModel
})
const openaiRequest = converter.convertRequest(claudeRequest)

// OpenAI → Claude
const OpenAIToClaudeConverter = require('./openaiToClaude')
const converter = new OpenAIToClaudeConverter()
const claudeRequest = converter.convertRequest(openaiRequest)
```

## 模型映射策略

### 映射优先级

```
1. 账户级映射（account.claudeModelMapping）
   ↓ 未命中
2. 全局映射（config.claudeBridgeDefaults.modelMapping）
   ↓ 未命中
3. 默认模型（config.claudeBridgeDefaults.defaultModel）
```

### 配置示例

```javascript
// config/config.js
{
  claudeBridgeDefaults: {
    modelMapping: {
      'claude-3-5-sonnet-20241022': 'gpt-5',
      'claude-3-5-haiku-20241022': 'gpt-4-turbo',
      'claude-3-opus-20240229': 'gpt-4'
    },
    defaultModel: 'gpt-5'
  },

  openaiToClaudeBridge: {
    modelMapping: {
      'gpt-4': 'claude-3-5-sonnet-20241022',
      'gpt-3.5-turbo': 'claude-3-5-haiku-20241022'
    },
    defaultModel: 'claude-3-5-sonnet-20241022'
  }
}
```

## 错误处理

### 错误类型

```javascript
class BridgeError extends Error {
  constructor(message, code, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

// 错误码
const ERROR_CODES = {
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ACCOUNT_STANDARDIZATION_FAILED: 'ACCOUNT_STANDARDIZATION_FAILED',
  CONVERSION_FAILED: 'CONVERSION_FAILED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS'
}
```

### 错误处理示例

```javascript
async bridgeClaudeToOpenAI(claudeRequest, accountId, accountType) {
  try {
    // 1. 获取账户
    const rawAccount = await this._fetchAccount(accountId, accountType)
    if (!rawAccount) {
      throw new BridgeError(
        `Account not found: ${accountId}`,
        ERROR_CODES.ACCOUNT_NOT_FOUND,
        { accountId, accountType }
      )
    }

    // 2. 标准化
    const standardAccount = this._standardizeAccount(rawAccount, accountType)

    // 3. 转换
    const openaiRequest = this._convertClaudeToOpenAI(claudeRequest, standardAccount)

    return { request: openaiRequest, account: standardAccount, bridgeInfo: {...} }
  } catch (error) {
    logger.error('Bridge service error:', error)
    throw error
  }
}
```

## 日志规范

### 日志级别使用

- **INFO**: 正常的桥接操作（模型映射、账户选择）
- **DEBUG**: 详细的转换过程、字段处理
- **WARN**: 使用默认值、映射未命中
- **ERROR**: 桥接失败、账户问题

### 日志示例

```javascript
logger.info('🌉 Bridge: Claude → OpenAI', {
  accountId,
  accountType,
  accountName: account.name,
  originalModel: claudeRequest.model,
  mappedModel: openaiRequest.model,
  mappingSource: bridgeInfo.modelMapping.mappingSource
})

logger.debug('🔧 Account standardized', {
  accountId: account.id,
  platform: account.platform,
  hasApiKey: !!account.apiKey,
  hasProxy: !!account.proxy,
  baseApi: account.baseApi
})
```

## 性能优化

### 缓存策略

1. **转换器实例缓存**：避免重复创建
2. **解密结果缓存**：利用现有的 LRU Cache
3. **配置缓存**：模型映射表缓存

```javascript
class BridgeService {
  constructor() {
    this._converterCache = new Map()
    this._configCache = null
    this._configCacheTime = 0
  }

  _getConverter(type, options) {
    const key = `${type}-${JSON.stringify(options)}`
    if (!this._converterCache.has(key)) {
      const Converter = this._getConverterClass(type)
      this._converterCache.set(key, new Converter(options))
    }
    return this._converterCache.get(key)
  }
}
```

## 测试策略

### 单元测试覆盖

1. 账户标准化测试
   - OpenAI OAuth 账户
   - OpenAI API Key 账户
   - 缺失字段处理
   - 解密失败处理

2. 转换测试
   - Claude → OpenAI 完整请求
   - 模型映射逻辑
   - 特殊字段处理（instructions, store）

3. 错误处理测试
   - 账户不存在
   - 认证信息缺失
   - 转换失败

### 集成测试场景

1. Claude Code CLI → OpenAI OAuth 桥接
2. Claude Code CLI → OpenAI API Key 桥接
3. Codex CLI → Claude 桥接（反向）
4. 双向桥接共存测试

## 未来扩展

### 支持更多桥接方向

```javascript
// Gemini ↔ Claude
async bridgeGeminiToClaude(geminiRequest, accountId, accountType)
async bridgeClaudeToGemini(claudeRequest, accountId, accountType)

// Azure ↔ Claude
async bridgeAzureToClaude(azureRequest, accountId, accountType)
async bridgeClaudeToAzure(claudeRequest, accountId, accountType)
```

### 工具调用支持

当前转换器支持基本的文本对话，未来需要增强：
- Function calling 转换
- Tool use 转换
- 多模态内容转换（图片、文件）

## 相关文档

- [架构图](./architecture.md) - 系统整体架构
- [设计文档](./design.md) - 技术架构设计
- [OpenAI Bridge 计划](./CLI-GUIDE.md#桥接模式) - 桥接模式使用指南
