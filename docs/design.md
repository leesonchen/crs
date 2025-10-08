# Claude Relay Service - 技术架构设计文档 (TAD)

## 1. 系统架构概述

Claude Relay Service 采用分布式微服务架构，核心设计原则包括：

- **高可用性**: 多账户轮换、故障转移、负载均衡
- **高性能**: 缓存优化、异步处理、流式响应
- **可扩展性**: 模块化设计、插件化架构
- **可维护性**: 清晰的分层、完善的日志、监控告警

### 1.1 整体架构图

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web Frontend  │    │   Admin Panel   │    │   API Clients   │
│   (Vue.js SPA)  │    │   (Vue.js SPA)  │    │  (CLI/HTTP)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                  ┌─────────────────────────────┐
                  │      Load Balancer          │
                  │     (Nginx/Caddy)           │
                  └─────────────────────────────┘
                                 │
                  ┌─────────────────────────────┐
                  │    Application Server       │
                  │      (Node.js)              │
                  └─────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
┌────────┼─────────┐    ┌────────┼─────────┐    ┌────────┼─────────┐
│  API Routes      │    │  Service Layer   │    │   Data Layer     │
│                  │    │                  │    │                  │
│ • /api           │    │ • Account Mgmt   │    │ • Redis          │
│ • /claude        │    │ • Relay Services │    │ • File System    │
│ • /gemini        │    │ • Pricing Calc   │    │ • External APIs  │
│ • /openai        │    │ • Statistics     │    │                  │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

## 2. 系统分层设计

### 2.1 表现层 (Presentation Layer)

#### 2.1.1 Web管理界面
```
web/admin-spa/
├── src/
│   ├── components/          # Vue组件
│   │   ├── accounts/        # 账户管理组件
│   │   ├── apikeys/         # API密钥管理组件
│   │   ├── apistats/        # 统计组件
│   │   ├── dashboard/       # 仪表板组件
│   │   ├── user/            # 用户管理组件
│   │   └── common/          # 通用组件
│   ├── views/              # 页面视图
│   ├── router/             # 路由配置
│   ├── stores/             # 状态管理
│   └── utils/              # 工具函数
```

**主要功能**:
- 账户管理 (CRUD操作)
- API密钥管理 (创建、配置、监控)
- 实时统计仪表板
- 系统配置管理

### 2.2 应用层 (Application Layer)

#### 2.2.1 路由层
```
src/routes/
├── api.js                  # 主要API路由 (/api, /claude)
├── admin.js                # 管理路由 (/admin)
├── web.js                  # Web界面路由 (/web)
├── userRoutes.js           # 用户路由 (/users)
├── geminiRoutes.js         # Gemini路由 (/gemini)
├── openaiRoutes.js         # OpenAI兼容路由 (/openai)
└── azureOpenaiRoutes.js    # Azure OpenAI路由 (/azure)
```

#### 2.2.2 中间件层
```
src/middleware/
├── auth.js                 # 认证中间件
│   ├── authenticateApiKey  # API密钥认证
│   ├── authenticateAdmin   # 管理员认证
│   ├── clientRestriction   # 客户端限制
│   └── rateLimit           # 速率限制
├── browserFallback.js      # 浏览器兼容性
└── debugInterceptor.js     # 调试拦截器
```

### 2.3 服务层 (Service Layer)

#### 2.3.1 核心服务
```
src/services/
├── accountGroupService.js        # 账户分组服务
├── apiKeyService.js             # API密钥服务
├── pricingService.js            # 价格计算服务
├── costInitService.js           # 费用初始化服务
└── userService.js               # 用户管理服务
```

#### 2.3.2 AI服务集成
```
src/services/
├── bridgeService.js             # 桥接服务（NEW - 格式转换和账户标准化）
├── claudeAccountService.js      # Claude账户管理
├── claudeRelayService.js        # Claude中继服务
├── claudeConsoleAccountService.js # Console账户管理
├── claudeConsoleRelayService.js   # Console中继服务
├── bedrockAccountService.js     # Bedrock账户管理
├── bedrockRelayService.js       # Bedrock中继服务
├── ccrAccountService.js         # CCR账户管理
├── ccrRelayService.js           # CCR中继服务
├── geminiAccountService.js      # Gemini账户管理
├── geminiRelayService.js        # Gemini中继服务
├── openaiAccountService.js      # OpenAI账户管理
└── openaiRelayService.js        # OpenAI中继服务（重构，专注转发）
```

#### 2.3.3 统一调度器
```
src/services/
├── unifiedClaudeScheduler.js    # Claude统一调度器
├── unifiedGeminiScheduler.js    # Gemini统一调度器
└── unifiedOpenAIScheduler.js    # OpenAI统一调度器
```

### 2.4 数据层 (Data Layer)

#### 2.4.1 Redis数据模型

**API密钥存储**:
```
apikey:{keyId} → Hash
{
  apiKey: "cr_xxx",           # 哈希后的API密钥
  name: "用户名称",
  createdAt: "2025-01-01T00:00:00Z",
  lastUsedAt: "2025-01-01T10:00:00Z",
  isActive: "true",
  rateLimit: { ... },
  modelRestrictions: [...],
  clientRestrictions: [...]
}
```

**使用统计存储**:
```
usage:{keyId} → Hash
{
  totalTokens: "150000",
  totalInputTokens: "50000",
  totalOutputTokens: "100000",
  totalCacheCreateTokens: "10000",
  totalCacheReadTokens: "5000",
  totalAllTokens: "160000",
  totalRequests: "500"
}

usage:daily:{keyId}:{date} → Hash
{
  tokens: "15000",
  inputTokens: "5000",
  outputTokens: "10000",
  requests: "50"
}
```

**账户存储**:
```
claude:account:{accountId} → Hash
{
  name: "账户名称",
  email: "user@example.com",
  status: "active",
  isActive: "true",
  subscriptionInfo: {...},
  lastUsedAt: "2025-01-01T10:00:00Z"
}
```

#### 2.4.2 缓存设计

**多级缓存策略**:

1. **内存缓存 (LRU Cache)**:
   - 账户信息缓存
   - 配置信息缓存
   - 价格信息缓存

2. **Redis缓存**:
   - API密钥验证结果
   - 使用统计聚合数据
   - 会话状态缓存

3. **文件缓存**:
   - 模型价格配置
   - 静态资源缓存

## 3. 核心流程设计

### 3.1 API请求处理流程

```
┌─────────┐    ┌────────────┐    ┌─────────────┐    ┌────────────┐
│  Client │───▶│ Load       │───▶│ Auth        │───▶│ Route      │
│  Request│    │ Balancer   │    │ Middleware  │    │ Handler    │
└─────────┘    └────────────┘    └─────────────┘    └────────────┘
                    │                     │              │
                    ▼                     ▼              ▼
            ┌───────────────┐    ┌──────────────┐ ┌──────────────┐
            │ Preprocessing │    │ API Key      │ │ Input        │
            │               │    │ Validation   │ │ Validation   │
            └───────────────┘    └──────────────┘ └──────────────┘
                    │                     │              │
                    ▼                     ▼              ▼
            ┌───────────────┐    ┌──────────────┐ ┌──────────────┐
            │ Client        │    │ Rate         │ │ Model        │
            │ Restriction   │    │ Limiting     │ │ Restriction  │
            │ Check         │    │              │ │ Check        │
            └───────────────┘    └──────────────┘ └──────────────┘
                    │                     │              │
                    ▼                     ▼              ▼
            ┌───────────────┐    ┌──────────────┐ ┌──────────────┐
            │ Session       │    │ Account      │ │ Account      │
            │ Hash          │    │ Selection    │ │ Validation   │
            │ Generation    │    │ Algorithm    │ │              │
            └───────────────┘    └──────────────┘ └──────────────┘
                    │                     │              │
                    ▼                     ▼              ▼
            ┌───────────────┐    ┌──────────────┐ ┌──────────────┐
            │ Request       │    │ Request      │ │ External API │
            │ Proxying      │    │ Execution    │ │ Call         │
            │               │    │              │ │              │
            └───────────────┘    └──────────────┘ └──────────────┘
                    │                     │              │
                    ▼                     ▼              ▼
            ┌───────────────┐    ┌──────────────┐ ┌──────────────┐
            │ Response      │    │ Usage        │ │ Response     │
            │ Streaming     │    │ Statistics   │ │ Processing   │
            │               │    │ Recording    │ │              │
            └───────────────┘    └──────────────┘ └──────────────┘
                    │                     │              │
                    ▼                     ▼              ▼
            ┌───────────────┐    ┌──────────────┐ ┌──────────────┐
            │ Error         │    │ Cost         │ │ Final        │
            │ Handling      │    │ Calculation  │ │ Response     │
            └───────────────┘    └──────────────┘ └──────────────┘
```

### 3.2 统一调度算法

#### 3.2.1 账号选择策略

**多优先级队列**:
```
优先级 1: 健康账户 + 低负载 + 支持目标模型
优先级 2: 健康账户 + 支持目标模型
优先级 3: 健康账户
优先级 4: 可恢复账户 (临时错误)
优先级 5: 备用账户池
```

**负载均衡算法**:
- **轮询 (Round Robin)**: 基础的循环选择
- **加权轮询**: 基于账户权重进行选择
- **最少连接**: 选择当前活跃请求最少的账户
- **响应时间**: 选择响应时间最快的账户

#### 3.2.2 会话粘性管理

**粘性会话机制**:
```
Session Hash = hash(request_body + api_key)
Account Mapping: session_hash → account_id
TTL: 可配置 (默认1小时)
续期阈值: 可配置 (默认5分钟)
```

### 3.3 API转发逻辑差异分析

#### 3.3.1 Claude Code API转发逻辑

**特殊请求识别机制**:

```javascript
// Claude Code请求识别逻辑
isRealClaudeCodeRequest(requestBody, clientHeaders) {
  // 1. 检查User-Agent是否匹配Claude Code格式
  const userAgent = clientHeaders?.['user-agent'] || ''
  const isClaudeCodeUserAgent = /^claude-cli\/[\d.]+\s+\(/i.test(userAgent)

  // 2. 检查系统提示词是否包含Claude Code标识
  const hasClaudeCodeSystemPrompt = this._hasClaudeCodeSystemPrompt(requestBody)

  return isClaudeCodeUserAgent && hasClaudeCodeSystemPrompt
}
```

**请求体处理逻辑**:

```javascript
// 处理请求体 - 根据客户端类型设置不同的系统提示词
_processRequestBody(requestBody, clientHeaders, account) {
  const isRealClaudeCode = this.isRealClaudeCodeRequest(requestBody, clientHeaders)

  if (isRealClaudeCode) {
    // 真实的Claude Code请求：使用Claude Code专用系统提示词
    requestBody.system = this.claudeCodeSystemPrompt
  } else {
    // 其他请求：使用账户的默认系统提示词
    if (account && account.systemPrompt) {
      requestBody.system = account.systemPrompt
    }
  }

  return requestBody
}
```

**日志记录特性**:
```javascript
// 详细的请求处理日志
logger.api(`🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${apiKeyData.name}`)
logger.info(`📤 Processing API request for key: ${apiKeyData.name}, account: ${accountId}`)

// 使用统计记录（包含完整的Token使用详情）
apiKeyService.recordUsageWithDetails(req.apiKey.id, usageObject, model, usageAccountId, 'claude')
```

#### 3.3.2 Codex API转发逻辑

**Codex CLI请求识别**:

```javascript
// 判断是否为Codex CLI的请求
const isCodexCLI = req.body?.instructions?.startsWith(
  'You are a coding agent running in the Codex CLI'
)
```

**请求适配处理**:

```javascript
// 非Codex CLI请求的适配
if (!isCodexCLI) {
  // 移除OpenAI特有的参数
  const fieldsToRemove = [
    'temperature', 'top_p', 'max_output_tokens',
    'user', 'text_formatting', 'truncation',
    'text', 'service_tier'
  ]
  fieldsToRemove.forEach(field => delete req.body[field])

  // 设置固定的Codex CLI instructions
  req.body.instructions = 'You are a coding agent running in the Codex CLI...'
}

// 请求格式转换：OpenAI → Claude
const claudeRequest = openaiToClaudeConverter.convertRequest(req.body)
```

**响应格式转换**:

```javascript
// Claude响应 → OpenAI响应格式转换
const openaiResponse = openaiToClaudeConverter.convertResponse(claudeResponse, requestModel)

// 流式响应转换
const openaiChunk = openaiToClaudeConverter.convertStreamChunk(chunk, requestModel, sessionId)
```

**日志记录特性**:
```javascript
// 请求适配日志
logger.info('📝 Non-Codex CLI request detected, applying Codex CLI adaptation')
logger.info('✅ Codex CLI request detected, forwarding as-is')

// 转换过程日志
logger.debug('📝 Converted OpenAI request to Claude format:', {
  model: claudeRequest.model,
  messageCount: claudeRequest.messages.length
})
```

#### 3.3.3 日志记录策略对比

**Claude Code API日志记录**:

```javascript
// 1. 请求开始日志
logger.api(`🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${apiKeyData.name}`)

// 2. 账户选择日志
logger.info(`📤 Processing API request for key: ${apiKeyData.name}, account: ${accountId}`)

// 3. 使用统计日志（详细）
logger.api(`📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache: ${cacheTokens}, Total: ${totalTokens}`)

// 4. 错误处理日志
logger.error('❌ Failed to record stream usage:', error)
```

**Codex API日志记录**:

```javascript
// 1. 请求适配日志
logger.info('📝 Non-Codex CLI request detected, applying Codex CLI adaptation')

// 2. 格式转换日志
logger.debug('📝 Converted OpenAI request to Claude format:', {
  model: claudeRequest.model,
  messageCount: claudeRequest.messages.length
})

// 3. 响应转换日志
logger.debug('📝 Converted Claude response to OpenAI format:', {
  responseId: openaiResponse.id,
  finishReason: openaiResponse.choices[0].finish_reason,
  usage: openaiResponse.usage
})

// 4. 账户选择日志
logger.info(`Selected OpenAI-Responses account: ${account.name} (${accountId})`)
```

#### 3.3.4 转发内容记录策略

**敏感信息处理**:

```javascript
// 使用安全的JSON序列化函数处理日志中的敏感数据
const safeStringify = (obj, maxDepth = 3) => {
  // 处理循环引用
  // 移除控制字符
  // 限制字符串长度
  // 过滤敏感信息
  return JSON.stringify(processed, null, 2)
}

// 日志中避免记录完整的API密钥和认证信息
logger.info('🔍 API Key data received:', {
  apiKeyName: apiKeyData.name, // 只记录名称，不记录密钥
  enableModelRestriction: apiKeyData.enableModelRestriction,
  requestedModel: requestBody.model // 只记录模型信息
})
```

**请求响应记录策略**:

```javascript
// 1. 记录请求元信息（不记录完整请求体）
logger.api('📤 Processing API request metadata:', {
  model: requestBody.model,
  stream: requestBody.stream,
  messageCount: requestBody.messages?.length,
  userAgent: clientHeaders['user-agent']?.substring(0, 50) // 只记录前50个字符
})

// 2. 记录响应元信息
logger.api('📥 Response metadata:', {
  statusCode: response.statusCode,
  contentType: response.headers['content-type'],
  duration: Date.now() - startTime
})

// 3. 详细的统计数据记录
logger.api(`📊 Detailed usage statistics:`, {
  inputTokens: usageData.input_tokens,
  outputTokens: usageData.output_tokens,
  cacheTokens: usageData.cache_creation_input_tokens,
  model: usageData.model,
  accountId: usageData.accountId
})
```

**安全日志记录器**:

```javascript
// 专门的安全日志记录器
const securityLogger = winston.createLogger({
  level: 'warn',
  format: logFormat,
  transports: [createRotateTransport('claude-relay-security-%DATE%.log', 'warn')]
})

// 认证详细日志记录器
const authDetailLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, data }) => {
      const jsonData = data ? JSON.stringify(data, null, 2) : '{}'
      return `[${timestamp}] ${level.toUpperCase()}: ${message}\n${jsonData}`
    })
  ),
  transports: [createRotateTransport('claude-relay-auth-detail-%DATE%.log', 'info')]
})
```

## 4. 关键技术实现

### 4.1 分布式缓存设计

#### 4.1.1 缓存层次结构

```
┌─────────────────┐
│   Application   │
│   Memory Cache  │  ← 进程内缓存 (LRU)
└─────────────────┘
         │
┌─────────────────┐
│    Redis        │  ← 分布式缓存
│   Cluster       │    • API Key验证
└─────────────────┘    • 使用统计
         │              • 会话状态
┌─────────────────┐
│ External Cache  │  ← 外部缓存服务
│ (Optional)      │
└─────────────────┘
```

#### 4.1.2 缓存失效策略

- **主动失效**: 数据更新时主动清理相关缓存
- **被动失效**: TTL过期自动清理
- **事件驱动**: 通过Redis发布订阅实现缓存同步

### 4.2 异步处理架构

#### 4.2.1 统计数据处理

```javascript
// 使用Redis Pipeline批量处理
const pipeline = redis.pipeline();

// 批量更新使用统计
pipeline.hincrby(`usage:${keyId}`, 'totalTokens', tokens);
pipeline.hincrby(`usage:${keyId}`, 'totalRequests', 1);
pipeline.hincrby(`usage:daily:${keyId}:${today}`, 'tokens', tokens);

// 批量更新账户统计
pipeline.hincrby(`account_usage:${accountId}`, 'totalTokens', tokens);
pipeline.hincrby(`account_usage:daily:${accountId}:${today}`, 'tokens', tokens);

// 批量更新模型统计
pipeline.hincrby(`usage:model:daily:${model}:${today}`, 'tokens', tokens);

await pipeline.exec();
```

#### 4.2.2 费用计算

- **实时计算**: 请求完成后立即计算费用
- **批量处理**: 定期批量计算历史费用
- **缓存优化**: 频繁使用的价格信息缓存

### 4.3 容错和恢复机制

#### 4.3.1 账户健康检查

```javascript
// 健康检查状态机
const AccountStates = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',      // 性能下降
  UNHEALTHY: 'unhealthy',    // 功能异常
  RECOVERING: 'recovering',  // 恢复中
  DISABLED: 'disabled'       // 手动禁用
};
```

#### 4.3.2 故障转移策略

- **即时切换**: 单个请求失败立即切换账户
- **熔断机制**: 连续失败达到阈值时暂时禁用账户
- **恢复机制**: 定期尝试恢复暂时禁用的账户

## 5. 安全设计

### 5.1 认证体系

#### 5.1.1 API密钥认证

```javascript
// 双重哈希机制
const authHeader = req.headers.authorization;
const apiKey = authHeader.replace('Bearer ', '');

// 第一级：API Key前缀快速匹配
if (!apiKey.startsWith('cr_')) {
  return res.status(401).json({ error: 'Invalid API key format' });
}

// 第二级：Redis哈希映射快速查找
const hashedKey = hash(apiKey);
const keyData = await redis.findApiKeyByHash(hashedKey);

if (!keyData) {
  return res.status(401).json({ error: 'Invalid API key' });
}
```

#### 5.1.2 客户端限制

```javascript
// User-Agent模式匹配
const clientPatterns = {
  claude_code: /^claude-cli\/[\d.]+\s+\(/i,
  gemini_cli: /^GeminiCLI\/v?[\d.]+\s+\(/i,
  custom_client: /^MyClient\/[\d\.]+/i
};

const userAgent = req.headers['user-agent'];
const isAllowed = apiKey.allowedClients.some(pattern =>
  clientPatterns[pattern].test(userAgent)
);
```

### 5.2 数据加密

- **API密钥**: bcrypt哈希存储
- **账户凭据**: AES加密存储
- **传输数据**: HTTPS/TLS加密

## 6. 监控和可观测性

### 6.1 指标收集

#### 6.1.1 系统指标

```javascript
// 实时指标收集
const systemMetrics = {
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  cpu: process.cpuUsage(),
  activeConnections: server.getConnections(),
  requestRate: calculateRequestRate(),
  errorRate: calculateErrorRate()
};
```

#### 6.1.2 业务指标

```javascript
// 业务指标收集
const businessMetrics = {
  totalRequests: await redis.getTotalRequests(),
  totalTokens: await redis.getTotalTokens(),
  activeApiKeys: await redis.getActiveApiKeys(),
  accountHealth: await getAccountHealthStatus(),
  costMetrics: await getCostMetrics()
};
```

### 6.2 日志系统

#### 6.2.1 分层日志

```javascript
const logger = require('./utils/logger');

// 不同级别的日志记录
logger.debug('Debug information');      // 调试信息
logger.info('General information');     // 一般信息
logger.warn('Warning message');         // 警告信息
logger.error('Error message');          // 错误信息
logger.api('API request details');      // API相关日志
logger.auth('Authentication events');   // 认证相关日志
```

#### 6.2.2 结构化日志

```json
{
  "timestamp": "2025-01-01T10:00:00.000Z",
  "level": "info",
  "category": "api",
  "message": "API request processed",
  "metadata": {
    "keyId": "cr_123",
    "model": "claude-3-sonnet-20240229",
    "tokens": 1500,
    "duration": 1200,
    "accountId": "account_456"
  }
}
```

## 7. 部署架构

### 7.1 单实例部署

```
┌─────────────────────────────────────┐
│           Docker Container          │
│                                     │
│  ┌─────────┐  ┌─────────┐  ┌────────┐ │
│  │  App    │  │  Redis  │  │  Logs  │ │
│  │ Server  │  │ Server  │  │ Dir    │ │
│  └─────────┘  └─────────┘  └────────┘ │
│                                     │
└─────────────────────────────────────┘
```

### 7.2 多实例部署

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│   LB    │    │   App   │    │   App   │
│         │    │ Server  │    │ Server  │
│         │    │   #1    │    │   #2    │
└─────────┘    └─────────┘    └─────────┘
     │              │              │
     └──────────────┼──────────────┘
                    │
            ┌───────────────┐
            │   Redis       │
            │   Cluster     │
            └───────────────┘
```

### 7.3 高可用部署

```
┌─────────────────┐    ┌─────────────────┐
│   External LB   │    │   External LB   │
│   (Region A)    │    │   (Region B)    │
└─────────────────┘    └─────────────────┘
         │                      │
┌────────┼─────────┐    ┌────────┼─────────┐
│   App  │  Redis   │    │   App  │  Redis   │
│ Server │ Cluster  │    │ Server │ Cluster  │
│   #1   │          │    │   #3   │          │
│   App  │   DB     │    │   App  │   DB     │
│ Server │ Replica  │    │ Server │ Replica  │
│   #2   │          │    │   #4   │          │
└────────┴──────────┘    └────────┴──────────┘
```

## 8. 性能优化

### 8.1 数据库优化

#### 8.1.1 Redis优化策略

- **连接池**: 复用Redis连接减少开销
- **Pipeline**: 批量操作减少网络往返
- **数据结构**: 选择合适的Redis数据结构
- **过期策略**: 合理设置TTL避免内存泄露

#### 8.1.2 查询优化

```javascript
// 使用Pipeline批量查询
const pipeline = redis.pipeline();
const keys = await redis.keys('usage:daily:*');
keys.forEach(key => pipeline.hgetall(key));
const results = await pipeline.exec();

// 使用Lua脚本原子操作
const script = `
  local key = KEYS[1]
  local increment = ARGV[1]
  return redis.call('incrby', key, increment)
`;
await redis.eval(script, 1, 'counter', 1);
```

### 8.2 缓存优化

#### 8.2.1 多级缓存

```javascript
// 缓存查找策略
async function getCachedData(key) {
  // 1. 内存缓存
  let data = memoryCache.get(key);
  if (data) return data;

  // 2. Redis缓存
  data = await redis.get(key);
  if (data) {
    memoryCache.set(key, data); // 回写内存缓存
    return data;
  }

  // 3. 源数据
  data = await fetchFromSource(key);
  memoryCache.set(key, data);
  redis.setex(key, 3600, data); // 写入Redis缓存

  return data;
}
```

#### 8.2.2 缓存失效策略

```javascript
// 主动失效
async function invalidateCache(key) {
  memoryCache.del(key);
  await redis.del(key);

  // 发布缓存失效事件
  await redis.publish('cache:invalidated', key);
}

// 订阅缓存失效事件
redis.subscribe('cache:invalidated', (key) => {
  memoryCache.del(key);
});
```

### 8.3 并发控制

#### 8.3.1 连接池管理

```javascript
// HTTP客户端连接池
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000
});

// Redis连接池
const redisClient = new Redis({
  ...redisConfig,
  lazyConnect: true,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3
});
```

#### 8.3.2 异步处理

```javascript
// 使用Promise.all并发处理
const results = await Promise.all([
  updateUsageStats(keyId, tokens),
  calculateCost(keyId, tokens),
  updateAccountStats(accountId, tokens),
  logApiRequest(req, res)
]);

// 使用事件驱动的异步处理
eventEmitter.on('api:request:complete', async (data) => {
  // 异步处理统计更新，不阻塞主响应
  await updateUsageStats(data.keyId, data.tokens);
});
```

## 9. 扩展性设计

### 9.1 模块化架构

#### 9.1.1 服务接口定义

```javascript
// 统一的AI服务接口
class BaseAIService {
  async validateAccount(accountId) {}
  async selectAccountForRequest(request) {}
  async proxyRequest(request, account) {}
  async handleStreamResponse(response, account) {}
  async calculateUsage(response) {}
}

// 具体的服务实现
class ClaudeService extends BaseAIService {
  // Claude特有的实现
}

class BedrockService extends BaseAIService {
  // Bedrock特有的实现
}
```

#### 9.1.2 插件系统

```javascript
// 插件接口
class BasePlugin {
  async preProcess(request) {}
  async postProcess(response) {}
  async onError(error) {}
}

// 插件注册
pluginManager.register('rate-limit', new RateLimitPlugin());
pluginManager.register('logging', new LoggingPlugin());
pluginManager.register('caching', new CachingPlugin());
```

### 9.2 API扩展机制

#### 9.2.1 动态路由注册

```javascript
// 动态路由注册器
class RouteRegistry {
  static registerService(serviceName, routes) {
    const router = express.Router();

    routes.forEach(route => {
      const { method, path, handler } = route;
      router[method](path, handler);
    });

    app.use(`/${serviceName}`, router);
  }
}

// 注册新服务
RouteRegistry.registerService('custom-ai', [
  { method: 'POST', path: '/chat', handler: customChatHandler },
  { method: 'GET', path: '/models', handler: customModelsHandler }
]);
```

#### 9.2.2 配置驱动的扩展

```javascript
// 基于配置的动态扩展
const extensions = config.extensions || [];

extensions.forEach(extension => {
  const ExtensionClass = require(extension.path);
  const instance = new ExtensionClass(extension.config);
  instance.initialize(app);
});
```

## 10. 测试策略

### 10.1 单元测试

- **服务层测试**: 独立测试各个服务模块
- **工具函数测试**: 测试缓存、日志等工具函数
- **数据模型测试**: 测试Redis数据操作

### 10.2 集成测试

- **API端到端测试**: 完整的API请求流程测试
- **服务集成测试**: 多服务间的集成测试
- **缓存测试**: 缓存机制的正确性测试

### 10.3 性能测试

- **负载测试**: 高并发请求下的性能表现
- **压力测试**: 极限负载下的系统稳定性
- **基准测试**: 不同配置下的性能基准

## 11. 部署和运维

### 11.1 容器化部署

#### 11.1.1 Docker配置

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build:web

EXPOSE 3000
CMD ["npm", "start"]
```

#### 11.1.2 Docker Compose配置

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      - redis
    environment:
      - REDIS_HOST=redis

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

volumes:
  redis_data:
```

### 11.2 健康检查

#### 11.2.1 应用健康检查

```javascript
// 健康检查端点
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    components: {
      redis: await checkRedisHealth(),
      logger: logger.healthCheck()
    }
  };
  res.json(health);
});
```

#### 11.2.2 监控指标暴露

```javascript
// Prometheus指标暴露
app.get('/metrics', async (req, res) => {
  const metrics = await collectMetrics();
  res.set('Content-Type', 'text/plain');
  res.send(metrics);
});
```

### 11.3 日志管理

#### 11.3.1 结构化日志

```javascript
// 结构化日志格式
const logData = {
  timestamp: new Date().toISOString(),
  level: 'info',
  category: 'api',
  message: 'Request processed successfully',
  request: {
    method: req.method,
    url: req.url,
    userAgent: req.headers['user-agent']
  },
  response: {
    statusCode: res.statusCode,
    duration: Date.now() - startTime
  }
};

logger.info(logData);
```

#### 11.3.2 日志轮转

```javascript
// Winston日志轮转配置
const transport = new DailyRotateFile({
  filename: 'logs/application-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '10m',
  maxFiles: '30d'
});
```

## 12. 风险评估和缓解策略

### 12.1 性能风险

- **风险**: 高并发下的性能下降
- **缓解**: 连接池、缓存优化、异步处理

### 12.2 可用性风险

- **风险**: 单点故障导致服务不可用
- **缓解**: 多账户轮换、故障转移、健康检查

### 12.3 安全风险

- **风险**: API密钥泄露或滥用
- **缓解**: 加密存储、访问控制、审计日志

### 12.4 扩展性风险

- **风险**: 业务增长导致性能瓶颈
- **缓解**: 水平扩展、微服务架构、容器化部署
