/**
 * OpenAI Responses Flow Simulator
 *
 * 完整模拟 OpenAI Responses API 的事件序列，解决 Codex CLI 流断开问题
 *
 * 核心功能：
 * 1. 生成完整的 45-86 个事件序列
 * 2. 智能数据填充和时序控制
 * 3. 推理过程模拟
 * 4. 使用统计和完成事件处理
 */

const logger = require('../utils/logger')

class OpenAIResponsesFlowSimulator {
  constructor(options = {}) {
    this.modelMapping = options.modelMapping || {}
    this.clientType = options.clientType || 'unknown'
    this.enableReasoningSimulation = options.enableReasoningSimulation !== false

    // 配置参数
    this.config = {
      reasoningChunkCount: options.reasoningChunkCount || 5,
      contentChunkCount: options.contentChunkCount || 30,
      baseDelay: options.baseDelay || 50,
      reasoningDelay: options.reasoningDelay || 100,
      contentDelay: options.contentDelay || 30
    }

    logger.info(`🎭 [FlowSimulator] Initialized`, {
      clientType: this.clientType,
      enableReasoningSimulation: this.enableReasoningSimulation,
      config: this.config
    })
  }

  /**
   * 生成完整的 OpenAI Responses 事件序列
   * @param {Object} claudeResponse - Claude API 响应数据
   * @returns {Array} OpenAI Responses 事件序列
   */
  simulateCompleteFlow(claudeResponse) {
    const events = []
    const startTime = Date.now()

    logger.info(`🎬 [FlowSimulator] Starting complete flow simulation`, {
      claudeModel: claudeResponse.model,
      hasContent: !!claudeResponse.content,
      contentLength: claudeResponse.content?.length || 0
    })

    try {
      // 1. response.created
      events.push(this.createResponseCreated(claudeResponse))

      // 2. response.in_progress
      events.push(this.createResponseInProgress(claudeResponse))

      let currentSequenceNumber = 2

      // 3-7. 推理过程模拟（如果适用）
      if (this.shouldSimulateReasoning(claudeResponse)) {
        const reasoningEvents = this.createReasoningFlow(claudeResponse)
        events.push(...reasoningEvents)
        currentSequenceNumber = Math.max(...reasoningEvents.map((e) => e.sequence_number))
      }

      // 8-10. 主要内容输出项
      const mainContentResult = this.createMainContentFlow(claudeResponse, currentSequenceNumber)
      events.push(...mainContentResult.events)
      currentSequenceNumber = mainContentResult.finalSequenceNumber

      // 11-12. 完成事件
      const completionEvents = this.createCompletionFlow(claudeResponse, currentSequenceNumber)
      events.push(...completionEvents)

      const duration = Date.now() - startTime
      logger.info(`✅ [FlowSimulator] Complete flow simulation finished`, {
        totalEvents: events.length,
        duration: `${duration}ms`,
        hasReasoning: this.shouldSimulateReasoning(claudeResponse)
      })

      return events
    } catch (error) {
      logger.error(`❌ [FlowSimulator] Flow simulation failed:`, error)
      throw error
    }
  }

  /**
   * 创建 response.created 事件
   */
  createResponseCreated(claudeResponse) {
    return {
      type: 'response.created',
      response: {
        id: claudeResponse.id || this.generateResponseId(),
        created: Math.floor(Date.now() / 1000),
        model: this.mapClaudeModelToOpenAI(claudeResponse.model),
        object: 'response',
        status: 'in_progress'
      },
      sequence_number: 1
    }
  }

  /**
   * 创建 response.in_progress 事件
   */
  createResponseInProgress(claudeResponse) {
    return {
      type: 'response.in_progress',
      response: {
        id: claudeResponse.id || this.generateResponseId(),
        created: Math.floor(Date.now() / 1000),
        model: this.mapClaudeModelToOpenAI(claudeResponse.model),
        object: 'response',
        status: 'in_progress'
      },
      sequence_number: 2
    }
  }

  /**
   * 判断是否需要模拟推理过程
   */
  shouldSimulateReasoning(claudeResponse) {
    if (!this.enableReasoningSimulation) {
      return false
    }

    // 检查是否是复杂任务或包含推理内容
    const content = this.extractMainContent(claudeResponse)
    const hasComplexity =
      content.length > 500 ||
      content.includes('因为') ||
      content.includes('首先') ||
      content.includes('分析') ||
      content.includes('考虑')

    logger.debug(`🤔 [FlowSimulator] Reasoning simulation check`, {
      contentLength: content.length,
      hasComplexity,
      willSimulate: hasComplexity && this.enableReasoningSimulation
    })

    return hasComplexity && this.enableReasoningSimulation
  }

  /**
   * 创建推理流程事件序列
   */
  createReasoningFlow(claudeResponse) {
    const events = []
    const reasoningText = this.extractReasoningContent(claudeResponse)

    if (!reasoningText || reasoningText.length < 10) {
      logger.debug(`⏭️ [FlowSimulator] Skipping reasoning flow - insufficient content`)
      return events
    }

    logger.info(`🧠 [FlowSimulator] Creating reasoning flow`, {
      reasoningLength: reasoningText.length,
      chunkCount: this.config.reasoningChunkCount
    })

    // 3. response.reasoning_summary_part.added
    const reasoningPartId = this.generatePartId()
    events.push({
      type: 'response.reasoning_summary_part.added',
      item_id: this.generateItemId(),
      output_index: 0,
      part: reasoningPartId,
      sequence_number: 3,
      summary_index: 0
    })

    // 4-6. response.reasoning_summary_text.delta (多个增量)
    const reasoningDeltas = this.splitIntoDeltas(reasoningText, this.config.reasoningChunkCount)

    reasoningDeltas.forEach((delta, index) => {
      events.push({
        type: 'response.reasoning_summary_text.delta',
        delta: { type: 'text', text: delta },
        item_id: events[0].item_id,
        output_index: 0,
        sequence_number: 4 + index,
        summary_index: 0
      })
    })

    // 7. reasoning 完成事件
    events.push({
      type: 'response.reasoning_summary_text.done',
      item_id: events[0].item_id,
      output_index: 0,
      sequence_number: 4 + reasoningDeltas.length,
      summary_index: 0,
      text: reasoningText
    })

    events.push({
      type: 'response.reasoning_summary_part.done',
      item_id: events[0].item_id,
      output_index: 0,
      sequence_number: 5 + reasoningDeltas.length,
      summary_index: 0
    })

    logger.debug(`✅ [FlowSimulator] Reasoning flow created`, {
      eventCount: events.length,
      deltaCount: reasoningDeltas.length
    })

    return events
  }

  /**
   * 创建主要内容流程事件序列
   */
  createMainContentFlow(claudeResponse, currentSequenceNumber = 2) {
    const events = []
    const contentText = this.extractMainContent(claudeResponse)

    logger.info(`📝 [FlowSimulator] Creating main content flow`, {
      contentLength: contentText.length,
      targetChunkCount: this.config.contentChunkCount,
      currentSequenceNumber
    })

    // 如果有推理流程，添加推理项目完成事件
    let nextSequence = currentSequenceNumber + 1
    if (this.shouldSimulateReasoning(claudeResponse)) {
      events.push({
        type: 'response.output_item.done',
        item: { type: 'reasoning_summary' },
        output_index: 0,
        sequence_number: nextSequence++
      })
    }

    // 主要内容项
    const mainItemId = this.generateItemId()
    events.push({
      type: 'response.output_item.added',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '' }] // 初始为空
      },
      item_id: mainItemId,
      output_index: 1,
      sequence_number: nextSequence++
    })

    // 内容部件
    const contentPartId = this.generatePartId()
    events.push({
      type: 'response.content_part.added',
      content_index: 0,
      item_id: mainItemId,
      output_index: 1,
      part: contentPartId,
      sequence_number: nextSequence++
    })

    // 文本增量事件
    const textDeltas = this.splitIntoDeltas(contentText, this.config.contentChunkCount)

    textDeltas.forEach((delta, index) => {
      events.push({
        type: 'response.output_text.delta',
        delta: { type: 'text', text: delta },
        content_index: 0,
        item_id: mainItemId,
        output_index: 1,
        sequence_number: nextSequence++
      })
    })

    // 文本完成事件
    events.push({
      type: 'response.output_text.done',
      content_index: 0,
      item_id: mainItemId,
      output_index: 1,
      sequence_number: nextSequence++,
      text: contentText
    })

    // 内容部件完成事件
    events.push({
      type: 'response.content_part.done',
      content_index: 0,
      item_id: mainItemId,
      output_index: 1,
      part: contentPartId,
      sequence_number: nextSequence++
    })

    logger.debug(`✅ [FlowSimulator] Main content flow created`, {
      eventCount: events.length,
      deltaCount: textDeltas.length,
      finalSequenceNumber: nextSequence - 1
    })

    return { events, finalSequenceNumber: nextSequence - 1 }
  }

  /**
   * 创建完成流程事件序列
   */
  createCompletionFlow(claudeResponse, currentSequenceNumber) {
    const events = []
    const usage = this.extractUsageData(claudeResponse)

    // 主要内容项完成事件
    events.push({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant' },
      output_index: 1,
      sequence_number: currentSequenceNumber + 1
    })

    // 最终完成事件
    events.push({
      type: 'response.completed',
      response: {
        id: claudeResponse.id || this.generateResponseId(),
        model: this.mapClaudeModelToOpenAI(claudeResponse.model),
        created: Math.floor(Date.now() / 1000),
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          input_tokens_details: usage.cache_read_input_tokens
            ? { cached_tokens: usage.cache_read_input_tokens }
            : undefined,
          output_tokens_details: usage.output_tokens_details || {}
        },
        stop_reason: this.mapStopReason(claudeResponse.stop_reason)
      },
      sequence_number: currentSequenceNumber + 2
    })

    logger.debug(`✅ [FlowSimulator] Completion flow created`, {
      eventCount: events.length,
      finalSequenceNumber: currentSequenceNumber + 2,
      usage
    })

    return events
  }

  // ========== 辅助方法 ==========

  /**
   * 从 Claude 响应中提取推理内容
   */
  extractReasoningContent(claudeResponse) {
    // 尝试从不同字段提取推理内容
    if (claudeResponse.reasoning) {
      return claudeResponse.reasoning
    }

    if (claudeResponse.thinking) {
      return claudeResponse.thinking
    }

    // 从主要内容中分析出推理部分
    const mainContent = this.extractMainContent(claudeResponse)
    return this.analyzeReasoningFromContent(mainContent)
  }

  /**
   * 从主要内容中分析推理内容
   */
  analyzeReasoningFromContent(content) {
    // 简单的推理内容识别逻辑
    const reasoningMarkers = [
      '让我分析一下',
      '首先考虑',
      '从多个角度来看',
      '综合分析',
      '我的思路是',
      '推理过程',
      '需要权衡'
    ]

    const lines = content.split('\n')
    const reasoningLines = []

    let inReasoningMode = false
    for (const line of lines) {
      const hasMarker = reasoningMarkers.some((marker) => line.includes(marker))

      if (hasMarker) {
        inReasoningMode = true
      }

      if (inReasoningMode) {
        reasoningLines.push(line)

        // 简单的推理结束判断
        if (line.includes('结论') || line.includes('总结') || line.includes('最终')) {
          break
        }
      }
    }

    return reasoningLines.join('\n').trim()
  }

  /**
   * 提取主要内容
   */
  extractMainContent(claudeResponse) {
    if (claudeResponse.content) {
      if (Array.isArray(claudeResponse.content)) {
        return claudeResponse.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n')
      } else if (typeof claudeResponse.content === 'string') {
        return claudeResponse.content
      }
    }

    if (claudeResponse.message?.content) {
      return this.extractMainContent(claudeResponse.message)
    }

    return ''
  }

  /**
   * 提取使用数据
   */
  extractUsageData(claudeResponse) {
    if (claudeResponse.usage) {
      return claudeResponse.usage
    }

    // 从不同可能的字段提取使用数据
    return {
      input_tokens: claudeResponse.input_tokens || 0,
      output_tokens: claudeResponse.output_tokens || 0
    }
  }

  /**
   * 将文本分割为增量块
   */
  splitIntoDeltas(text, targetChunkCount) {
    if (!text || text.length === 0) {
      return []
    }

    const targetLength = Math.ceil(text.length / targetChunkCount)
    const chunks = []

    for (let i = 0; i < text.length; i += targetLength) {
      chunks.push(text.slice(i, i + targetLength))
    }

    logger.debug(`🔢 [FlowSimulator] Split text into chunks`, {
      originalLength: text.length,
      targetChunkCount,
      actualChunkCount: chunks.length,
      averageChunkLength: Math.round(text.length / chunks.length)
    })

    return chunks
  }

  /**
   * 映射 Claude 模型到 OpenAI 模型
   */
  mapClaudeModelToOpenAI(claudeModel) {
    if (!claudeModel) {
      return 'gpt-5'
    }

    // 使用系统级映射
    return this.modelMapping[claudeModel] || 'gpt-5'
  }

  /**
   * 映射停止原因
   */
  mapStopReason(claudeStopReason) {
    const mapping = {
      end_turn: 'end_turn',
      max_tokens: 'max_tokens',
      stop_sequence: 'stop_sequence',
      tool_use: 'tool_use'
    }

    return mapping[claudeStopReason] || 'end_turn'
  }

  /**
   * 生成响应 ID
   */
  generateResponseId() {
    return `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * 生成项目 ID
   */
  generateItemId() {
    return `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * 生成部件 ID
   */
  generatePartId() {
    return `part_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * 获取最后一个序列号
   */
  getLastSequenceNumber() {
    // 在实际实现中，这应该从当前事件序列中获取
    return 50 // 默认值
  }
}

module.exports = OpenAIResponsesFlowSimulator
