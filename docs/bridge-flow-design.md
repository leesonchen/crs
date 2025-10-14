# 桥接模式流程重新设计技术文档

## 概述

本文档详细描述了 Claude Relay Service 桥接模式的流程重新设计，旨在解决 Codex CLI 在使用桥接模式时出现的 "stream disconnected" 错误问题。

## 问题背景

### 当前问题
- **错误现象**: Codex CLI 使用桥接模式访问 Claude API 时频繁出现流断开错误
- **用户体验**: 客户端需要多次重试，影响交互体验
- **根本原因**: Claude API 的简化事件序列与 OpenAI Responses 标准流程不匹配

### 技术挑战
1. **事件序列不匹配**: 9个简化事件 vs 45-86个标准事件
2. **时序问题**: 事件发送过于密集，缺少合理间隔
3. **功能缺失**: 缺少推理过程等关键中间事件

## 设计目标

### 核心目标
1. **完整性**: 提供与标准 OpenAI Responses 一致的完整事件序列
2. **兼容性**: 保持现有功能的向后兼容
3. **性能**: 控制额外延迟在合理范围内
4. **可靠性**: 彻底解决 stream disconnected 问题

### 验证指标
- stream disconnected 错误率 < 1%
- 事件序列完整性 > 95%
- 响应时间增幅 < 20%
- 现有功能 100% 兼容

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Bridge Flow System                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   Claude API    │  │  Flow Simulator │  │ Timing Controller│ │
│  │   Response      │→ │                 │→ │                 │ │
│  │   Data          │  │  (事件生成器)     │  │  (时序控制器)     │ │
│  └─────────────────┘  └─────────���───────┘  └─────────────────┘ │
│                                │                               │
│                                ▼                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ Event Generator │  │  Event Buffer   │  │  Stream Manager  │ │
│  │   (事件生成器)    │→ │    (事件缓冲)    │→ │   (流管理器)     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                │                               │
│                                ▼                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Codex CLI Client                        │   │
│  │         (标准 OpenAI Responses 体验)                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 核心组件

#### 1. OpenAI Responses Flow Simulator (流程模拟器)

**职责**: 生成完整的 OpenAI Responses 事件序列

**主要功能**:
- 分析 Claude 响应数据结构
- 生成标准 OpenAI 事件模板
- 智能填充事件数据
- 处理推理过程模拟

**接口设计**:
```javascript
class OpenAIResponsesFlowSimulator {
  // 构造函数
  constructor(options = {})

  // 主要方法
  simulateCompleteFlow(claudeResponse)           // 生成完整流程
  createResponseCreated(response)               // 创建响应开始事件
  createResponseInProgress(response)             // 创建处理中事件
  createReasoningFlow(response)                  // 创建推理流程
  createMainContentFlow(response)               // 创建主要内容流程
  createCompletionFlow(response)                // 创建完成流程

  // 工具方法
  shouldSimulateReasoning(response)             // 判断是否需要推理模拟
  extractReasoningContent(response)              // 提取推理内容
  extractMainContent(response)                   // 提取主要内容
  splitIntoDeltas(text, count)                   // 分割文本为增量
  generateId()                                   // 生成唯一ID
  mapClaudeModelToOpenAI(model)                 // 模型映射
}
```

#### 2. Flow Timing Controller (时序控制器)

**职责**: 控制事件发送的时序和节奏

**主要功能**:
- 计算事件间延迟
- 模拟真实的处理时间
- 优化发送节奏
- 支持可配置的时序策略

**接口设计**:
```javascript
class FlowTimingController {
  // 构造函数
  constructor(options = {})

  // 主要方法
  calculateEventDelay(eventType, index, total)   // 计算延迟
  sendEventsWithTiming(events, callback)        // 按时序发送事件

  // 配置方法
  setBaseDelay(delay)                           // 设置基础延迟
  setReasoningDelay(delay)                      // 设置推理延迟
  setContentDelay(delay)                        // 设置内容延迟

  // 工具方法
  sleep(ms)                                     // 异步延迟
}
```

#### 3. Stream Manager (流管理器)

**职责**: 管理流式响应的发送和生命周期

**主要功能**:
- 管理流式连接状态
- 处理客户端断开检测
- 协调事件发送流程
- 错误处理和恢复

## 详细技术实现

### 事件生成策略

#### 1. 基础事件结构

```javascript
// 标准事件结构模板
const eventTemplates = {
  responseCreated: {
    type: 'response.created',
    response: {
      id: null,
      model: null,
      created: null
    }
  },
  responseInProgress: {
    type: 'response.in_progress',
    response: {
      id: null,
      model: null,
      created: null
    }
  },
  reasoningSummaryPartAdded: {
    type: 'response.reasoning_summary_part.added',
    item_id: null,
    output_index: 0,
    part: null,
    sequence_number: null,
    summary_index: 0
  },
  // ... 更多事件模板
}
```

#### 2. 智能内容分析

```javascript
class ContentAnalyzer {
  /**
   * 分析 Claude 响应内容
   */
  analyzeClaudeResponse(claudeResponse) {
    return {
      hasReasoning: this.detectReasoning(claudeResponse),
      reasoningContent: this.extractReasoningContent(claudeResponse),
      mainContent: this.extractMainContent(claudeResponse),
      toolCalls: this.extractToolCalls(claudeResponse),
      usage: claudeResponse.usage,
      model: claudeResponse.model,
      stopReason: claudeResponse.stop_reason
    }
  }

  /**
   * 检测是否包含推理内容
   */
  detectReasoning(claudeResponse) {
    if (!claudeResponse.content) return false

    return claudeResponse.content.some(block =>
      block.type === 'thinking' ||
      (block.type === 'text' && block.text.includes('Thinking:'))
    )
  }

  /**
   * 提取推理内容
   */
  extractReasoningContent(claudeResponse) {
    if (!claudeResponse.content) return ''

    const reasoningBlocks = claudeResponse.content.filter(block =>
      block.type === 'thinking' ||
      (block.type === 'text' && block.text.includes('Thinking:'))
    )

    return reasoningBlocks.map(block => {
      if (block.type === 'thinking') {
        return block.thinking || block.text || ''
      } else if (block.type === 'text') {
        return block.text.replace(/\[Thinking:\s*/g, '')
      }
      return ''
    }).join('\n').trim()
  }

  /**
   * 提取主要内容
   */
  extractMainContent(claudeResponse) {
    if (!claudeResponse.content) return ''

    const textBlocks = claudeResponse.content.filter(block =>
      block.type === 'text' &&
      !block.text.includes('Thinking:')
    )

    return textBlocks.map(block => block.text).join('').trim()
  }
}
```

#### 3. 文本增量分割策略

```javascript
class TextDeltaSplitter {
  /**
   * 智能分割文本为增量事件
   */
  splitIntoDeltas(text, targetCount = 20) {
    if (!text || text.length <= 10) {
      return [text]
    }

    const textLength = text.length
    const avgDeltaLength = Math.max(10, Math.floor(textLength / targetCount))

    const deltas = []
    let currentPosition = 0

    while (currentPosition < textLength) {
      // 计算下一个增量的大小（添加一些随机性）
      const variance = 0.3 // 30% 的变化范围
      const minDelta = Math.max(5, avgDeltaLength * (1 - variance))
      const maxDelta = Math.min(100, avgDeltaLength * (1 + variance))
      const deltaLength = Math.floor(minDelta + Math.random() * (maxDelta - minDelta))

      // 确保在单词边界分割
      let endPosition = Math.min(currentPosition + deltaLength, textLength)
      if (endPosition < textLength) {
        // 尝试在最近的空格或句号处分割
        const lastSpace = text.lastIndexOf(' ', endPosition)
        const lastPeriod = text.lastIndexOf('.', endPosition)
        const lastNewline = text.lastIndexOf('\n', endPosition)

        const bestBreak = Math.max(lastSpace, lastPeriod, lastNewline)
        if (bestBreak > currentPosition + minDelta * 0.5) {
          endPosition = bestBreak + 1
        }
      }

      const delta = text.slice(currentPosition, endPosition)
      if (delta.trim()) {
        deltas.push(delta.trim())
      }

      currentPosition = endPosition
    }

    return deltas.length > 0 ? deltas : [text]
  }

  /**
   * 为推理内容生成增量（特殊处理）
   */
  splitReasoningDeltas(reasoningText) {
    if (!reasoningText) return []

    // 推理内容通常较少，生成 3-5 个增量
    const targetCount = Math.min(5, Math.max(3, Math.floor(reasoningText.length / 50)))
    return this.splitIntoDeltas(reasoningText, targetCount)
  }
}
```

### 时序控制实现

#### 1. 延迟计算策略

```javascript
class DelayCalculator {
  constructor(options = {}) {
    this.baseDelay = options.baseDelay || 50
    this.reasoningDelay = options.reasoningDelay || 100
    this.contentDelay = options.contentDelay || 30
    this.completionDelay = options.completionDelay || 100
    this.variance = options.variance || 0.2
  }

  /**
   * 计算事件延迟
   */
  calculateDelay(eventType, eventIndex, totalEvents, eventContext = {}) {
    let baseDelay = this.getBaseDelayForEventType(eventType)

    // 添加上下文相关的延迟
    if (eventContext.isReasoningEvent) {
      baseDelay = Math.max(baseDelay, this.reasoningDelay)
    }

    if (eventContext.isCompletionEvent) {
      baseDelay = Math.max(baseDelay, this.completionDelay)
    }

    // 添加随机变化，避免过于规律
    const variance = baseDelay * this.variance
    const randomFactor = 1 + (Math.random() - 0.5) * 2 // [-0.5, 0.5] 范围
    const finalDelay = Math.max(10, baseDelay + variance * randomFactor)

    return Math.round(finalDelay)
  }

  getBaseDelayForEventType(eventType) {
    const delays = {
      'response.created': 0,
      'response.in_progress': this.baseDelay,
      'response.reasoning_summary_part.added': this.reasoningDelay,
      'response.reasoning_summary_text.delta': this.reasoningDelay / 2,
      'response.reasoning_summary_text.done': this.baseDelay,
      'response.reasoning_summary_part.done': this.baseDelay,
      'response.output_item.added': this.baseDelay,
      'response.content_part.added': this.contentDelay,
      'response.output_text.delta': this.contentDelay / 3,
      'response.output_text.done': this.baseDelay,
      'response.content_part.done': this.baseDelay,
      'response.completed': this.completionDelay
    }

    return delays[eventType] || this.baseDelay
  }
}
```

#### 2. 流程控制器

```javascript
class FlowController {
  constructor(options = {}) {
    this.delayCalculator = new DelayCalculator(options)
    this.isFlowActive = false
    this.abortController = null
  }

  /**
   * 启动流程控制
   */
  async startFlow(events, sendCallback, options = {}) {
    if (this.isFlowActive) {
      throw new Error('Flow already active')
    }

    this.isFlowActive = true
    this.abortController = new AbortController()

    try {
      await this.sendEventsWithFlowControl(events, sendCallback, options)
    } finally {
      this.isFlowActive = false
      this.abortController = null
    }
  }

  /**
   * 停止流程
   */
  stopFlow() {
    if (this.abortController) {
      this.abortController.abort()
    }
  }

  /**
   * 带流程控制的事件发送
   */
  async sendEventsWithFlowControl(events, sendCallback, options = {}) {
    const { enableLogging = true, flowId = this.generateFlowId() } = options

    for (let i = 0; i < events.length; i++) {
      // 检查是否被中止
      if (this.abortController?.signal.aborted) {
        if (enableLogging) {
          logger.info(`Flow ${flowId}: Aborted at event ${i}`)
        }
        break
      }

      const event = events[i]
      const eventContext = this.buildEventContext(event, i, events.length)
      const delay = this.delayCalculator.calculateDelay(
        event.type,
        i,
        events.length,
        eventContext
      )

      // 发送事件
      try {
        await sendCallback(event, { eventIndex: i, totalEvents: events.length })

        if (enableLogging) {
          logger.debug(`Flow ${flowId}: Sent event ${i}/${events.length} (${event.type})`)
        }
      } catch (error) {
        logger.error(`Flow ${flowId}: Failed to send event ${i}:`, error)
        throw error
      }

      // 等待延迟（除非是最后一个事件）
      if (i < events.length - 1 && delay > 0) {
        await this.sleep(delay)
      }
    }
  }

  buildEventContext(event, index, totalEvents) {
    return {
      isReasoningEvent: event.type.includes('reasoning_summary'),
      isCompletionEvent: event.type === 'response.completed',
      isContentEvent: event.type.includes('output_text.delta'),
      progress: index / totalEvents,
      eventIndex: index,
      totalEvents: totalEvents
    }
  }

  generateFlowId() {
    return `flow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
```

### 集成到现有系统

#### 1. 修改 ClaudeToOpenAIResponsesConverter

```javascript
// 在现有的 claudeToOpenAIResponses.js 中添加
class ClaudeToOpenAIResponsesConverter {
  constructor(options = {}) {
    // 现有初始化代码...

    // 新增流程模拟器
    this.enableFlowSimulation = options.enableFlowSimulation !== false
    if (this.enableFlowSimulation) {
      this.flowSimulator = new OpenAIResponsesFlowSimulator({
        modelMapping: this.modelMapping,
        defaultModel: this.defaultModel,
        enableReasoningSimulation: options.enableReasoningSimulation !== false
      })

      this.flowController = new FlowController({
        baseDelay: options.baseDelay || 50,
        reasoningDelay: options.reasoningDelay || 100,
        contentDelay: options.contentDelay || 30,
        variance: options.delayVariance || 0.2
      })
    }
  }

  /**
   * 流式响应处理 - 新的主入口
   */
  async convertStreamChunkWithFlow(claudeChunk, context = {}) {
    if (!this.enableFlowSimulation) {
      // 使用原有的简单映射逻辑
      return this.convertStreamChunk(claudeChunk)
    }

    // 检查是否是需要开始流程的事件
    if (this.isFlowStartEvent(claudeChunk)) {
      return this.handleFlowStart(claudeChunk, context)
    }

    // 检查是否是需要结束流程的事件
    if (this.isFlowEndEvent(claudeChunk)) {
      return this.handleFlowEnd(claudeChunk, context)
    }

    // 流程中，忽略单个事件（由流程控制器统一处理）
    return null
  }

  /**
   * 处理流程开始
   */
  async handleFlowStart(claudeChunk, context) {
    try {
      // 解析 Claude 响应数据
      const claudeResponse = this.parseClaudeResponse(claudeChunk)

      // 生成完整的事件序列
      const events = this.flowSimulator.simulateCompleteFlow(claudeResponse)

      // 启动流程控制
      this.activeFlow = this.flowController.startFlow(
        events,
        (event, flowContext) => this.sendSimulatedEvent(event, flowContext),
        {
          enableLogging: context.enableLogging !== false,
          flowId: context.flowId
        }
      )

      logger.info(`Started flow simulation with ${events.length} events`)

      // 返回第一个事件（response.created）
      const firstEvent = events[0]
      return this.formatEventAsSSE(firstEvent)

    } catch (error) {
      logger.error('Failed to start flow simulation:', error)
      // 回退到原有逻辑
      return this.convertStreamChunk(claudeChunk)
    }
  }

  /**
   * 处理流程结束
   */
  async handleFlowEnd(claudeChunk, context) {
    if (this.activeFlow) {
      this.flowController.stopFlow()
      this.activeFlow = null
    }

    // 发送最终的 [DONE] 事件
    return 'data: [DONE]\n\n'
  }

  /**
   * 发送模拟事件
   */
  async sendSimulatedEvent(event, flowContext) {
    const sseData = this.formatEventAsSSE(event)

    // 这里应该调用实际的发送函数
    // 在实际集成中，这会是写入响应流的地方
    if (flowContext.sendCallback) {
      await flowContext.sendCallback(sseData)
    }

    return sseData
  }

  /**
   * 格式化事件为 SSE 格式
   */
  formatEventAsSSE(event) {
    return `data: ${JSON.stringify(event)}\n\n`
  }

  /**
   * 检查是否是流程开始事件
   */
  isFlowStartEvent(claudeChunk) {
    return claudeChunk.includes('event: message_start') ||
           claudeChunk.includes('"type":"message_start"')
  }

  /**
   * 检查是否是流程结束事件
   */
  isFlowEndEvent(claudeChunk) {
    return claudeChunk.includes('event: message_stop') ||
           claudeChunk.includes('"type":"message_stop"')
  }

  /**
   * 解析 Claude 响应数据
   */
  parseClaudeResponse(claudeChunk) {
    // 从 Claude chunk 中提取响应数据
    // 这里需要根据实际的 Claude API 响应格式来实现
    const lines = claudeChunk.trim().split('\n')
    let jsonData = null

    for (const line of lines) {
      if (line.startsWith('data:')) {
        const jsonStr = line.slice(5).trim()
        if (jsonStr && jsonStr !== '[DONE]') {
          try {
            jsonData = JSON.parse(jsonStr)
            break
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    return jsonData || {}
  }
}
```

#### 2. 配置和启用选项

```javascript
// 在 bridgeService.js 中添加配置选项
class BridgeService {
  async bridgeOpenAIToClaude(openaiRequest, accountId, accountType, options = {}) {
    // 现有代码...

    // 检查是否启用流程模拟
    const enableFlowSimulation = options.enableFlowSimulation !== false

    if (enableFlowSimulation && options.clientType === 'codex_cli') {
      // 为 Codex CLI 启用完整的流程模拟
      converterOptions = {
        ...converterOptions,
        enableFlowSimulation: true,
        enableReasoningSimulation: true,
        baseDelay: 50,
        reasoningDelay: 100,
        contentDelay: 30,
        delayVariance: 0.2
      }
    }

    // 创建转换器
    const converter = this._getConverter('ClaudeToOpenAIResponses', converterOptions)

    // 其余代码...
  }
}
```

## 测试策略

### 1. 单元测试

```javascript
// tests/bridge-flow-simulator.test.js
describe('OpenAIResponsesFlowSimulator', () => {
  test('should generate complete event sequence', () => {
    const simulator = new OpenAIResponsesFlowSimulator()
    const claudeResponse = createMockClaudeResponse()

    const events = simulator.simulateCompleteFlow(claudeResponse)

    expect(events.length).toBeGreaterThan(40)
    expect(events[0].type).toBe('response.created')
    expect(events[events.length - 1].type).toBe('response.completed')
  })

  test('should handle reasoning content correctly', () => {
    const simulator = new OpenAIResponsesFlowSimulator()
    const claudeResponse = createMockClaudeResponseWithReasoning()

    const events = simulator.simulateCompleteFlow(claudeResponse)

    const reasoningEvents = events.filter(e =>
      e.type.includes('reasoning_summary')
    )
    expect(reasoningEvents.length).toBeGreaterThan(5)
  })
})

// tests/flow-timing-controller.test.js
describe('FlowTimingController', () => {
  test('should calculate appropriate delays', () => {
    const controller = new FlowTimingController()

    const reasoningDelay = controller.calculateDelay(
      'response.reasoning_summary_text.delta', 2, 10
    )
    const contentDelay = controller.calculateDelay(
      'response.output_text.delta', 5, 10
    )

    expect(reasoningDelay).toBeGreaterThan(contentDelay)
  })
})
```

### 2. 集成测试

```javascript
// tests/bridge-integration.test.js
describe('Bridge Integration', () => {
  test('should handle complete flow with Codex CLI', async () => {
    const mockRequest = createMockCodexRequest()
    const mockResponse = createMockClaudeResponse()

    const result = await bridgeService.bridgeOpenAIToClaude(
      mockRequest,
      'test-account-id',
      'claude-console',
      { clientType: 'codex_cli', enableFlowSimulation: true }
    )

    // 验证返回的事件序列
    expect(result.events.length).toBeGreaterThan(40)
    expect(result.events[0].type).toBe('response.created')
    expect(result.events[result.events.length - 1].type).toBe('response.completed')
  })
})
```

### 3. 端到端测试

```javascript
// tests/e2e/codex-cli-flow.test.js
describe('Codex CLI Flow E2E', () => {
  test('should complete without stream disconnected', async () => {
    // 启动测试服务器
    const server = await startTestServer()

    try {
      // 模拟 Codex CLI 请求
      const response = await fetch('http://localhost:3000/openai/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer cr_test_key'
        },
        body: JSON.stringify({
          model: 'gpt-5-codex',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
          stream: true
        })
      })

      // 验证响应流
      const reader = response.body.getReader()
      let eventCount = 0
      let hasCompleted = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = new TextDecoder().decode(value)
        eventCount++

        if (chunk.includes('response.completed')) {
          hasCompleted = true
        }
      }

      expect(eventCount).toBeGreaterThan(40)
      expect(hasCompleted).toBe(true)

    } finally {
      await server.close()
    }
  }, 30000) // 30秒超时
})
```

## 监控和调试

### 1. 关键指标监控

```javascript
// metrics/bridge-flow-metrics.js
class BridgeFlowMetrics {
  constructor() {
    this.metrics = {
      totalFlows: 0,
      successfulFlows: 0,
      failedFlows: 0,
      averageEventCount: 0,
      averageFlowDuration: 0,
      streamDisconnectedErrors: 0
    }
  }

  recordFlowStart(flowId, context) {
    this.metrics.totalFlows++
    this.activeFlows = this.activeFlows || new Map()
    this.activeFlows.set(flowId, {
      startTime: Date.now(),
      context
    })
  }

  recordFlowEnd(flowId, success, eventCount) {
    const flow = this.activeFlows?.get(flowId)
    if (flow) {
      const duration = Date.now() - flow.startTime

      if (success) {
        this.metrics.successfulFlows++
        this.updateAverageEventCount(eventCount)
        this.updateAverageFlowDuration(duration)
      } else {
        this.metrics.failedFlows++
      }

      this.activeFlows.delete(flowId)
    }
  }

  recordStreamDisconnected() {
    this.metrics.streamDisconnectedErrors++
  }

  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalFlows > 0
        ? this.metrics.successfulFlows / this.metrics.totalFlows
        : 0,
      errorRate: this.metrics.totalFlows > 0
        ? this.metrics.streamDisconnectedErrors / this.metrics.totalFlows
        : 0
    }
  }
}
```

### 2. 调试日志增强

```javascript
// utils/bridge-logger.js
class BridgeLogger {
  static logFlowStart(flowId, claudeResponse, eventCount) {
    logger.info(`🌊 [Flow ${flowId}] Started`, {
      eventCount,
      hasReasoning: !!claudeResponse.content?.some(c => c.type === 'thinking'),
      model: claudeResponse.model,
      usage: claudeResponse.usage
    })
  }

  static logFlowEvent(flowId, eventIndex, eventType, totalEvents) {
    logger.debug(`🌊 [Flow ${flowId}] Event ${eventIndex}/${totalEvents}`, {
      type: eventType,
      progress: Math.round((eventIndex / totalEvents) * 100) + '%'
    })
  }

  static logFlowEnd(flowId, success, duration) {
    logger.info(`🌊 [Flow ${flowId}] ${success ? 'Completed' : 'Failed'}`, {
      duration: `${duration}ms`,
      success
    })
  }

  static logStreamError(flowId, error) {
    logger.error(`🌊 [Flow ${flowId}] Stream error:`, error)
  }
}
```

## 部署和回滚策略

### 1. 渐进式部署

```javascript
// config/feature-flags.js
const FEATURE_FLAGS = {
  BRIDGE_FLOW_SIMULATION: {
    enabled: false,
    rolloutPercentage: 0, // 0-100
    clientTypes: ['codex_cli'], // 限制客户端类型
    models: ['*'], // 限制模型
    accounts: ['*'] // 限制账户
  }
}

function shouldEnableFlowSimulation(request) {
  const flag = FEATURE_FLAGS.BRIDGE_FLOW_SIMULATION

  if (!flag.enabled) return false

  // 检查客户端类型
  if (!flag.clientTypes.includes('*') &&
      !flag.clientTypes.includes(request.clientType)) {
    return false
  }

  // 检查模型
  if (!flag.models.includes('*') &&
      !flag.models.includes(request.model)) {
    return false
  }

  // 检查账户
  if (!flag.accounts.includes('*') &&
      !flag.accounts.includes(request.accountId)) {
    return false
  }

  // 检查滚动百分比
  if (flag.rolloutPercentage < 100) {
    const hash = this.hashRequest(request)
    return (hash % 100) < flag.rolloutPercentage
  }

  return true
}
```

### 2. 监控和告警

```javascript
// monitoring/bridge-alerts.js
class BridgeAlerts {
  constructor() {
    this.alertThresholds = {
      streamDisconnectedErrorRate: 0.05, // 5%
      flowFailureRate: 0.1, // 10%
      averageFlowDurationIncrease: 1.5, // 50% 增加
      eventSequenceIncompleteness: 0.1 // 10% 不完整
    }
  }

  checkMetrics(metrics) {
    const alerts = []

    // 检查流断开错误率
    if (metrics.errorRate > this.alertThresholds.streamDisconnectedErrorRate) {
      alerts.push({
        type: 'HIGH_STREAM_DISCONNECTED_RATE',
        severity: 'HIGH',
        message: `Stream disconnected error rate: ${(metrics.errorRate * 100).toFixed(2)}%`,
        threshold: `${(this.alertThresholds.streamDisconnectedErrorRate * 100).toFixed(2)}%`
      })
    }

    // 检查流失败率
    const failureRate = 1 - metrics.successRate
    if (failureRate > this.alertThresholds.flowFailureRate) {
      alerts.push({
        type: 'HIGH_FLOW_FAILURE_RATE',
        severity: 'MEDIUM',
        message: `Flow failure rate: ${(failureRate * 100).toFixed(2)}%`,
        threshold: `${(this.alertThresholds.flowFailureRate * 100).toFixed(2)}%`
      })
    }

    return alerts
  }

  sendAlert(alert) {
    // 发送到监控系统（如 Prometheus、Grafana 等）
    logger.warn(`🚨 Bridge Alert [${alert.type}]: ${alert.message}`)

    // 这里可以集成实际的告警系统
    // await this.alertingSystem.sendAlert(alert)
  }
}
```

## 总结

本文档详细描述了桥接模式流程重新设计的技术方案，包括：

1. **问题分析**: 深入分析了 stream disconnected 错误的根本原因
2. **架构设计**: 提出了完整的流程模拟器架构
3. **技术实现**: 提供了详细的代码实现方案
4. **测试策略**: 制定了全面的测试计划
5. **监控部署**: 设计了渐进式部署和监控方案

通过这个重新设计，我们将能够：

- **彻底解决** Codex CLI 的 stream disconnected 问题
- **提供** 与原生 OpenAI 一致的用户体验
- **保持** 现有功能的兼容性和稳定性
- **建立** 可扩展的桥接模式架构

---

*文档版本: v1.0*
*创建日期: 2025-10-13*
*作者: Claude Code Assistant*