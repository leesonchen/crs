const logger = require('../utils/logger')

class OpenAIResponsesToClaudeConverter {
  constructor(options = {}) {
    this._resetStreamState()
    this.clientType = options.clientType || 'unknown'
    this.targetFormat = options.targetFormat || 'claude'
    logger.info('🔧 [Bridge] Initialized converter:', {
      clientType: this.clientType,
      targetFormat: this.targetFormat,
      isCodexCLI: this._isCodexClient()
    })
  }

  /**
   * 将 OpenAI Responses 请求格式转换为 Claude 格式
   * @param {Object} openaiRequest - OpenAI Responses 格式的请求
   * @returns {Object} Claude 格式的请求
   */
  convertRequest(openaiRequest) {
    logger.info('🔄 [Bridge] Starting OpenAI Responses → Claude request conversion:', {
      originalKeys: Object.keys(openaiRequest),
      hasInput: !!(openaiRequest.input && Array.isArray(openaiRequest.input)),
      hasMessages: !!(openaiRequest.messages && Array.isArray(openaiRequest.messages)),
      hasInstructions: !!openaiRequest.instructions,
      originalModel: openaiRequest.model,
      stream: Boolean(openaiRequest.stream)
    })

    const claudeRequest = {
      model: openaiRequest.model,
      max_tokens: openaiRequest.max_tokens || openaiRequest.max_output_tokens || 4096,
      stream: Boolean(openaiRequest.stream)
    }

    // 记录字段映射过程
    logger.debug('🔧 [Bridge] Field mapping:', {
      model: `${openaiRequest.model} → ${claudeRequest.model}`,
      max_tokens: `${openaiRequest.max_tokens}/${openaiRequest.max_output_tokens} → ${claudeRequest.max_tokens}`,
      stream: `${openaiRequest.stream} → ${claudeRequest.stream}`
    })

    // 处理 instructions → system
    if (openaiRequest.instructions) {
      claudeRequest.system = openaiRequest.instructions
      logger.info('📝 [Bridge] Mapped instructions → system:', {
        instructionsLength: openaiRequest.instructions.length,
        instructionsPreview: openaiRequest.instructions.substring(0, 100)
      })
    }

    // 处理 input → messages
    if (openaiRequest.input && Array.isArray(openaiRequest.input)) {
      logger.info('🔍 [Bridge] Processing OpenAI Responses input array:', {
        inputLength: openaiRequest.input.length,
        firstItemKeys: openaiRequest.input.length > 0 ? Object.keys(openaiRequest.input[0]) : [],
        firstItemPreview:
          openaiRequest.input.length > 0
            ? {
                hasType: !!openaiRequest.input[0].type,
                hasRole: !!openaiRequest.input[0].role,
                hasContent: openaiRequest.input[0].content !== undefined
              }
            : {}
      })
      claudeRequest.messages = this._convertInputToMessages(openaiRequest.input)
    } else if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
      // 兼容传统格式
      logger.info('🔧 [Bridge] Using legacy messages format compatibility mode:', {
        messageCount: openaiRequest.messages.length
      })
      claudeRequest.messages = openaiRequest.messages
    } else {
      logger.warn('⚠️ [Bridge] No input or messages array found, creating empty messages array')
      claudeRequest.messages = []
    }

    // 处理其他可选参数
    const optionalParams = ['temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty']
    for (const param of optionalParams) {
      if (openaiRequest[param] !== undefined) {
        claudeRequest[param] = openaiRequest[param]
        logger.debug(`🔧 [Bridge] Mapped optional parameter: ${param}`, {
          value: openaiRequest[param]
        })
      }
    }

    logger.info('📝 [Bridge] OpenAI Responses → Claude conversion complete:', {
      originalModel: openaiRequest.model,
      convertedModel: claudeRequest.model,
      hasSystem: !!claudeRequest.system,
      originalMessageCount: (openaiRequest.input || openaiRequest.messages || []).length,
      convertedMessageCount: claudeRequest.messages.length,
      stream: claudeRequest.stream,
      convertedKeys: Object.keys(claudeRequest),
      messagesPreview: claudeRequest.messages.slice(0, 2).map((m) => ({
        role: m.role,
        contentType: typeof m.content,
        contentLength:
          typeof m.content === 'string'
            ? m.content.length
            : Array.isArray(m.content)
              ? m.content.length
              : 0,
        contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) :
                         Array.isArray(m.content) ? `[${m.content.length} blocks]` :
                         'non-standard content'
      }))
    })

    return claudeRequest
  }

  /**
   * 转换 OpenAI Responses 的 input 数组为 Claude 的 messages
   * @private
   */
  _convertInputToMessages(input) {
    const messages = []

    for (const item of input) {
      // 兼容两种格式：
      // 1. 标准格式：{ type: 'message', role: 'user', content: '...' }
      // 2. 兼容格式：{ role: 'user', content: '...' } (缺少 type 字段)

      let isMessageItem = false
      let formatType = 'unknown'

      if (item.type === 'message') {
        // 标准格式
        isMessageItem = true
        formatType = 'standard'
      } else if (item.role && item.content !== undefined) {
        // 兼容格式：有 role 和 content 字段，但没有 type 字段
        isMessageItem = true
        formatType = 'compat'
        logger.info('🔧 [Bridge] Converting item without type field to message format:', {
          role: item.role,
          contentType: typeof item.content,
          hasContent: item.content !== undefined
        })
      }

      if (isMessageItem) {
        const message = {
          role: item.role || 'user',
          content: []
        }

        // 转换 content - 增强的内容解析逻辑
        logger.debug('🔍 [Bridge] Processing content field:', {
          contentType: typeof item.content,
          contentValue: item.content,
          contentPreview: typeof item.content === 'string' ? item.content.substring(0, 100) :
                         typeof item.content === 'object' ? JSON.stringify(item.content, null, 2).substring(0, 100) :
                         String(item.content).substring(0, 100)
        })

        if (Array.isArray(item.content)) {
          // 处理数组格式的内容
          for (const contentBlock of item.content) {
            if (contentBlock.type === 'text') {
              message.content.push({
                type: 'text',
                text: contentBlock.text || ''
              })
            } else if (contentBlock.type === 'image') {
              // 处理图片（如果需要）
              message.content.push(contentBlock)
            } else {
              // 处理其他类型的内容块
              logger.debug('🔧 [Bridge] Processing unknown content block type:', {
                type: contentBlock.type,
                hasText: !!contentBlock.text,
                hasContent: !!contentBlock.content
              })

              // 回退处理：尝试提取文本内容
              if (contentBlock.text) {
                message.content.push({
                  type: 'text',
                  text: contentBlock.text
                })
              } else if (contentBlock.content && typeof contentBlock.content === 'string') {
                message.content.push({
                  type: 'text',
                  text: contentBlock.content
                })
              }
            }
          }
        } else if (typeof item.content === 'string') {
          // 字符串内容直接使用
          message.content = item.content
        } else if (typeof item.content === 'object' && item.content !== null) {
          // 处理对象格式的内容 - 新增的回退逻辑
          logger.info('🔧 [Bridge] Processing object content with fallback logic:', {
            contentKeys: Object.keys(item.content),
            hasText: !!item.content.text,
            hasContent: !!item.content.content,
            hasMessage: !!item.content.message
          })

          // 尝试多种方式提取文本内容
          let extractedText = ''

          if (item.content.text && typeof item.content.text === 'string') {
            extractedText = item.content.text
          } else if (item.content.content && typeof item.content.content === 'string') {
            extractedText = item.content.content
          } else if (item.content.message && typeof item.content.message === 'string') {
            extractedText = item.content.message
          } else if (item.content.input && typeof item.content.input === 'string') {
            extractedText = item.content.input
          } else if (item.content.prompt && typeof item.content.prompt === 'string') {
            extractedText = item.content.prompt
          }

          if (extractedText) {
            message.content = extractedText
            logger.info('✅ [Bridge] Successfully extracted text from object content:', {
              extractedLength: extractedText.length,
              extractedPreview: extractedText.substring(0, 50)
            })
          } else {
            // 最后的回退：将对象转换为JSON字符串
            try {
              const jsonString = JSON.stringify(item.content)
              if (jsonString && jsonString !== '{}') {
                message.content = jsonString
                logger.warn('⚠️ [Bridge] Fallback: Using JSON string for object content:', {
                  jsonStringLength: jsonString.length,
                  jsonStringPreview: jsonString.substring(0, 50)
                })
              } else {
                // 如果对象为空，使用默认内容
                message.content = ''
                logger.warn('⚠️ [Bridge] Empty object content, using empty string')
              }
            } catch (error) {
              message.content = String(item.content)
              logger.error('❌ [Bridge] Failed to stringify object content, using toString fallback:', error)
            }
          }
        } else {
          // 处理其他类型（null、undefined等）
          message.content = String(item.content || '')
          logger.warn('⚠️ [Bridge] Fallback: Converting non-standard content type to string:', {
            originalType: typeof item.content,
            originalValue: item.content,
            convertedValue: message.content
          })
        }

        // 如果 content 只有一个文本块，可以简化为字符串
        if (
          Array.isArray(message.content) &&
          message.content.length === 1 &&
          message.content[0].type === 'text'
        ) {
          message.content = message.content[0].text
        }

        // 验证最终内容不为空
        if (!message.content || (typeof message.content === 'string' && message.content.trim() === '')) {
          logger.warn('⚠️ [Bridge] Content is empty after processing, using fallback')
          message.content = '' // 确保有默认值
        }

        messages.push(message)

        logger.info('✅ [Bridge] Successfully converted message item:', {
          formatType,
          role: message.role,
          contentType: typeof message.content,
          contentLength:
            typeof message.content === 'string'
              ? message.content.length
              : Array.isArray(message.content)
                ? message.content.length
                : 0
        })
      } else {
        logger.warn('⚠️ [Bridge] Skipping non-message item in input array:', {
          itemType: item.type,
          hasRole: !!item.role,
          hasContent: item.content !== undefined,
          allKeys: Object.keys(item)
        })
      }
    }

    logger.info('📊 [Bridge] Input to messages conversion complete:', {
      inputItemsCount: input.length,
      outputMessagesCount: messages.length,
      skippedItemsCount: input.length - messages.length
    })

    return messages
  }

  convertNonStream(responseData) {
    logger.info('🔄 [Bridge] Starting non-stream response conversion (OpenAI Responses → Claude):', {
      responseDataKeys: Object.keys(responseData || {}),
      hasResponse: !!(responseData?.response),
      responseKeys: responseData?.response ? Object.keys(responseData.response) : [],
      originalType: responseData?.type || 'unknown'
    })

    const resp = responseData?.response || responseData || {}
    this.finalResponse = resp
    const usage = this._extractUsage(responseData)
    const stopReason = this._mapStopReason(
      resp?.stop_reason || resp?.status || responseData?.stop_reason
    )

    logger.debug('🔧 [Bridge] Extracted response metadata:', {
      originalStopReason: resp?.stop_reason || resp?.status || responseData?.stop_reason,
      mappedStopReason: stopReason,
      hasUsage: !!(usage && (usage.input_tokens > 0 || usage.output_tokens > 0)),
      usage,
      model: resp?.model || 'unknown'
    })

    const content = this._convertOutputContent(resp)
    if (content.length === 0) {
      logger.warn('⚠️ [Bridge] No content found in response, attempting fallback text extraction')
      const fallbackText = this._extractText(resp)
      if (fallbackText) {
        content.push({ type: 'text', text: fallbackText })
        logger.info('✅ [Bridge] Successfully extracted fallback text:', {
          textLength: fallbackText.length,
          textPreview: fallbackText.substring(0, 100)
        })
      } else {
        logger.error('❌ [Bridge] Failed to extract any content from response')
      }
    }

    const claudeResponse = {
      id: resp?.id || this._generateId('msg'),
      type: 'message',
      role: 'assistant',
      model: resp?.model || 'unknown',
      stop_reason: stopReason,
      content,
      usage
    }

    logger.info('📝 [Bridge] Non-stream conversion complete:', {
      claudeId: claudeResponse.id,
      model: claudeResponse.model,
      stopReason: claudeResponse.stop_reason,
      contentBlockCount: claudeResponse.content.length,
      totalContentLength: claudeResponse.content.reduce((sum, block) =>
        sum + (block.text ? block.text.length : 0), 0),
      hasUsage: !!(claudeResponse.usage && (claudeResponse.usage.input_tokens > 0 || claudeResponse.usage.output_tokens > 0)),
      usage: claudeResponse.usage
    })

    return claudeResponse
  }

  convertStreamChunk(rawChunk) {
    if (!rawChunk || typeof rawChunk !== 'string') {
      logger.warn('⚠️ [Bridge] Invalid stream chunk received:', {
        chunkType: typeof rawChunk,
        chunkValue: rawChunk
      })
      return ''
    }

    this.streamBuffer += rawChunk.replace(/\r\n/g, '\n')

    logger.debug('🔄 [Bridge] Received stream chunk:', {
      chunkLength: rawChunk.length,
      chunkPreview: rawChunk.length > 200 ? `${rawChunk.substring(0, 200)}...` : rawChunk,
      bufferLength: this.streamBuffer.length,
      hasCompleteEvents: rawChunk.includes('\n\n'),
      streamState: {
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted,
        streamFinished: this.streamFinished
      }
    })

    return this._drainBuffer(false)
  }

  finalizeStream() {
    return this._drainBuffer(true)
  }

  _drainBuffer(force) {
    const output = []

    let drained = false

    while (!drained) {
      const separatorIndex = this.streamBuffer.indexOf('\n\n')
      if (separatorIndex === -1) {
        if (force && this.streamBuffer.trim()) {
          output.push(...this._processBlock(this.streamBuffer))
          this.streamBuffer = ''
        }
        drained = true
        continue
      }

      const block = this.streamBuffer.slice(0, separatorIndex)
      this.streamBuffer = this.streamBuffer.slice(separatorIndex + 2)
      output.push(...this._processBlock(block))
    }

    if (force && !this.streamFinished && this.messageStarted) {
      output.push(...this._emitCompletion(null))
    }

    this._logEmittedEvents(output)

    return output.join('')
  }

  _processBlock(block) {
    const events = []
    const lines = block.split('\n')

    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue
      }

      const payload = line.slice(6).trim()
      if (!payload) {
        continue
      }

      if (payload === '[DONE]') {
        events.push(...this._emitCompletion(null))
        continue
      }

      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch (error) {
        this.streamBuffer = `${block}\n\n${this.streamBuffer}`
        break
      }

      events.push(...this._handleEvent(parsed))
    }

    return events
  }

  _handleEvent(event) {
    if (!event || this.streamFinished) {
      if (this.streamFinished) {
        logger.debug('🚫 [Bridge] Ignoring event - stream already finished:', {
          eventType: event?.type,
          streamFinished: this.streamFinished
        })
      }
      return []
    }

    // 记录所有接收到的事件（移除5事件限制）
    logger.info('📥 [Bridge] Received SSE event:', {
      eventNumber: this.debugEventCount + 1,
      type: event.type,
      hasResponse: Boolean(event.response),
      hasMessage: Boolean(event.message),
      hasDelta: Boolean(event.delta),
      hasItem: Boolean(event.item),
      hasContent: Boolean(event.content),
      hasUsage: Boolean(event.usage),
      keys: Object.keys(event || {}),
      streamState: {
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted,
        streamFinished: this.streamFinished
      },
      // 记录关键内容预览
      contentPreview: event.content ?
        (event.content.text ? event.content.text.substring(0, 50) + '...' : 'present') :
        'none',
      deltaPreview: event.delta ?
        (typeof event.delta === 'string' ? event.delta.substring(0, 50) + '...' :
         event.delta.text ? event.delta.text.substring(0, 50) + '...' :
         JSON.stringify(event.delta).substring(0, 50) + '...') :
        'none'
    })
    this.debugEventCount += 1

    // 处理智谱AI/标准Claude格式事件
    switch (event.type) {
      // 智谱AI/Claude格式事件
      case 'message_start':
        if (event.message) {
          this.messageId = event.message.id
          return this._emitMessageStart()
        }
        return this._emitMessageStart()

      case 'content_block':
        // 智谱AI的content_block事件需要转换为start+delta
        if (event.content && event.content.type === 'text' && event.content.text) {
          const events = []
          events.push(...this._emitMessageStart())
          events.push(...this._ensureTextBlock())
          events.push(
            this._sse({
              type: 'content_block_delta',
              index: event.index || 0,
              delta: {
                type: 'text_delta',
                text: event.content.text
              }
            })
          )
          return events
        }
        return this._ensureTextBlock()

      case 'content_block_stop':
        return [
          this._sse({
            type: 'content_block_stop',
            index: event.index || 0
          })
        ]

      case 'message_delta':
        const events = []

        // 累积使用数据（智谱AI格式的usage通常在message_delta事件中）
        if (event.usage) {
          logger.info('📊 [Bridge] Accumulating usage from message_delta:', {
            usage: event.usage,
            currentAccumulated: this.accumulatedUsage
          })

          if (event.usage.input_tokens) {
            this.accumulatedUsage.input_tokens += event.usage.input_tokens
          }
          if (event.usage.output_tokens) {
            this.accumulatedUsage.output_tokens += event.usage.output_tokens
          }
        }

        if (event.delta && event.delta.stop_reason) {
          events.push(
            this._sse({
              type: 'message_delta',
              delta: {
                stop_reason: this._mapStopReason(event.delta.stop_reason)
              },
              usage: event.usage || {}
            })
          )
        }
        return events

      case 'message_stop':
        logger.info('📥 [Bridge] Processing message_stop event for completion:', {
          isCodexClient: this._isCodexClient(),
          clientType: this.clientType,
          eventType: 'message_stop',
          streamState: {
            messageStarted: this.messageStarted,
            contentBlockStarted: this.contentBlockStarted,
            streamFinished: this.streamFinished
          }
        })

        // 对于智谱AI格式的message_stop事件，如果是Codex CLI，也需要发送双完成事件
        // 这里使用��积的usage数据（如果有）
        const accumulatedUsage = this._extractUsage({ usage: null })
        const completionPayload = {
          id: this.messageId,
          usage: accumulatedUsage,
          stop_reason: 'end_turn'
        }

        return this._emitCompletion(completionPayload)

      // OpenAI Responses格式事件
      case 'response.started':
        return this._emitMessageStart()
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          return this._emitTextDelta(event.delta)
        }
        if (event.delta && typeof event.delta.text === 'string') {
          return this._emitTextDelta(event.delta.text)
        }
        return []
      case 'response.output_text.delta.appended':
        if (typeof event.delta === 'string' && event.delta) {
          return this._emitTextDelta(event.delta)
        }
        return []
      case 'response.output_text.done':
        if (Array.isArray(event.output)) {
          const text = this._collectOutputText(event.output)
          if (text) {
            return this._emitTextDelta(text)
          }
        }
        return []
      case 'response.output_item.added':
        return this._handleOutputItemAdded(event)
      case 'response.function_call_arguments.delta':
        return this._handleFunctionCallArgumentsDelta(event)
      case 'response.function_call_arguments.done':
        return this._handleFunctionCallArgumentsDone(event)
      case 'response.output_item.done':
        return this._handleOutputItemDone(event)
      case 'response.completed':
        return this._emitCompletion(event.response)
      case 'response.error':
        return this._emitError(event.error || event)
      case 'response.delta':
        return this._handleResponseDelta(event)
      default:
        // 未知事件类型，记录日志但不抛出错误
        if (this.debugEventCount < 5) {
          logger.warn('⚠️ 未知的SSE事件类型:', {
            type: event.type,
            data: event
          })
        }
        return []
    }
  }

  _handleResponseDelta(event) {
    if (!event?.delta || this.streamFinished) {
      return []
    }

    const fragments = []
    if (typeof event.delta === 'string') {
      fragments.push(event.delta)
    } else if (Array.isArray(event.delta?.output_text)) {
      for (const piece of event.delta.output_text) {
        if (typeof piece === 'string') {
          fragments.push(piece)
        }
      }
    } else if (typeof event.delta?.output_text === 'string') {
      fragments.push(event.delta.output_text)
    }

    if (fragments.length === 0) {
      return []
    }

    return this._emitTextDelta(fragments.join(''))
  }

  _emitMessageStart() {
    if (this.messageStarted) {
      return []
    }

    this.messageStarted = true
    this.messageId = this.messageId || this._generateId('msg')

    return [
      this._sse({
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 0,
            output_tokens: 0
          }
        }
      })
    ]
  }

  _ensureTextBlock() {
    if (this.contentBlockStarted) {
      return []
    }

    this.contentBlockStarted = true
    this.contentBlockId = this._generateId('cb')

    return [
      this._sse({
        type: 'content_block_start',
        index: 0,
        content_block: {
          id: this.contentBlockId,
          type: 'text',
          text: ''
        }
      })
    ]
  }

  _emitTextDelta(deltaText) {
    if (!deltaText) {
      return []
    }

    const events = []
    events.push(...this._emitMessageStart())
    events.push(...this._ensureTextBlock())

    events.push(
      this._sse({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: deltaText
        }
      })
    )

    return events
  }

  _emitCompletion(responsePayload) {
    if (this.streamFinished) {
      return []
    }

    logger.info('🎯 [Bridge] Emitting completion event:', {
      isCodexClient: this._isCodexClient(),
      clientType: this.clientType,
      targetFormat: this.targetFormat,
      hasResponsePayload: !!responsePayload,
      streamState: {
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted,
        streamFinished: this.streamFinished
      }
    })

    // 如果是 Codex CLI，发送 OpenAI Responses 格式的完成事件
    if (this._isCodexClient()) {
      const completionEvents = this._emitOpenAIResponsesCompletion(responsePayload)

      // 也要发送标准的Claude格式事件以确保兼容性
      const claudeEvents = this._emitClaudeCompletion(responsePayload)

      this.streamFinished = true

      if (responsePayload) {
        this.finalResponse = responsePayload
      }

      logger.info('📤 [Bridge] Sent dual completion events for Codex CLI:', {
        openAIEventsCount: completionEvents.length,
        claudeEventsCount: claudeEvents.length,
        totalEvents: completionEvents.length + claudeEvents.length
      })

      return [...completionEvents, ...claudeEvents]
    }

    // 非Codex客户端，只发送标准Claude格式完成事件
    const events = this._emitClaudeCompletion(responsePayload)

    this.streamFinished = true

    if (responsePayload) {
      this.finalResponse = responsePayload
    }

    return events
  }

  /**
   * 发送标准Claude格式的完成事件
   * @private
   */
  _emitClaudeCompletion(responsePayload) {
    const events = []
    events.push(...this._emitMessageStart())

    if (this.contentBlockStarted) {
      events.push(
        this._sse({
          type: 'content_block_stop',
          index: 0
        })
      )
      this.contentBlockStarted = false
      this.contentBlockId = null
    }

    if (this.toolBlock) {
      events.push(
        this._sse({
          type: 'content_block_stop',
          index: this.toolBlock.index
        })
      )
      this.toolBlock = null
    }

    const usage = this._extractUsage({ usage: responsePayload?.usage })
    const stopReason = this._mapStopReason(responsePayload?.stop_reason || responsePayload?.status)

    events.push(
      this._sse({
        type: 'message_delta',
        delta: {
          stop_reason: stopReason
        },
        usage
      })
    )

    events.push(this._sse({ type: 'message_stop' }))

    return events
  }

  _emitError(errorPayload) {
    this._resetStreamState()
    this.streamFinished = true
    return [
      this._sse({
        type: 'error',
        error: errorPayload || { message: 'Unknown error' }
      })
    ]
  }

  _handleOutputItemAdded(event) {
    const { item } = event
    if (!item || item.type !== 'function_call') {
      return []
    }

    const blockId = item.id || this._generateId('tool')
    this.toolBlock = {
      id: blockId,
      name: item.name || 'tool',
      args: '',
      index: 1
    }

    return [
      this._sse({
        type: 'content_block_start',
        index: 1,
        content_block: {
          id: blockId,
          type: 'tool_use',
          name: this.toolBlock.name,
          input: {}
        }
      })
    ]
  }

  _handleFunctionCallArgumentsDelta(event) {
    if (!this.toolBlock || event.item_id !== this.toolBlock.id) {
      return []
    }

    let chunk = ''
    if (typeof event.delta === 'string') {
      chunk = event.delta
    } else if (event.delta && typeof event.delta.partial_json === 'string') {
      chunk = event.delta.partial_json
    }

    if (!chunk) {
      return []
    }

    this.toolBlock.args += chunk

    logger.info('Claude bridge接收 tool arguments delta', {
      itemId: event.item_id,
      chunkPreview: chunk.length > 120 ? `${chunk.slice(0, 120)}…` : chunk,
      chunkLength: chunk.length
    })

    return []
  }

  _handleFunctionCallArgumentsDone(event) {
    if (!this.toolBlock || event.item_id !== this.toolBlock.id) {
      return []
    }

    if (typeof event.arguments !== 'string' || !event.arguments) {
      return []
    }

    this.toolBlock.args = this._sanitizeToolArguments(event.arguments)

    logger.info('Claude bridge完成 tool arguments', {
      itemId: event.item_id,
      argumentLength: this.toolBlock.args.length
    })

    return [
      this._sse({
        type: 'content_block_delta',
        index: this.toolBlock.index,
        delta: {
          type: 'input_json',
          partial_json: this.toolBlock.args
        }
      })
    ]
  }

  _handleOutputItemDone(event) {
    if (!this.toolBlock || event.item?.id !== this.toolBlock.id) {
      return []
    }

    const events = [
      this._sse({
        type: 'content_block_stop',
        index: this.toolBlock.index
      })
    ]

    this.toolBlock = null
    return events
  }

  _collectOutputText(output) {
    if (!output) {
      return ''
    }

    if (typeof output === 'string') {
      return output
    }

    if (!Array.isArray(output)) {
      return ''
    }

    const fragments = []

    for (const part of output) {
      if (!part) {
        continue
      }

      if (typeof part === 'string') {
        fragments.push(part)
      } else if (part.type === 'output_text' && typeof part.text === 'string') {
        fragments.push(part.text)
      }
    }

    return fragments.join('')
  }

  _convertOutputContent(resp) {
    if (!resp || !Array.isArray(resp.output)) {
      return []
    }

    const content = []

    for (const item of resp.output) {
      if (!item || typeof item !== 'object') {
        continue
      }

      if (item.type === 'message' && Array.isArray(item.content)) {
        const text = this._collectOutputText(item.content)
        if (text) {
          content.push({ type: 'text', text })
        }
        continue
      }

      if (item.type === 'function_call') {
        let parsedArgs = {}
        if (typeof item.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(item.arguments)
          } catch (error) {
            logger.warn('Failed to parse function_call arguments for Claude bridge', {
              error: error.message
            })
            parsedArgs = { raw: item.arguments }
          }
        }

        content.push({
          type: 'tool_use',
          id: item.id || this._generateId('tool'),
          name: item.name || 'tool',
          input: parsedArgs
        })
      }
    }

    return content
  }

  _extractText(resp) {
    if (!resp) {
      return ''
    }

    if (typeof resp.output_text === 'string') {
      return resp.output_text
    }

    if (Array.isArray(resp.output)) {
      const texts = []
      for (const seg of resp.output) {
        if (typeof seg === 'string') {
          texts.push(seg)
        } else if (seg?.content) {
          texts.push(String(seg.content))
        } else if (seg?.text) {
          texts.push(String(seg.text))
        }
      }
      if (texts.length > 0) {
        return texts.join('')
      }
    }

    if (typeof resp.content === 'string') {
      return resp.content
    }

    return ''
  }

  _extractUsage(data) {
    // 如果有累积的使用数据，优先使用累积数据
    if (this.accumulatedUsage && (this.accumulatedUsage.input_tokens > 0 || this.accumulatedUsage.output_tokens > 0)) {
      logger.info('📊 [Bridge] Using accumulated usage data:', {
        accumulatedUsage: this.accumulatedUsage,
        fallbackUsage: data?.usage || data?.response?.usage || {}
      })
      return {
        input_tokens: this.accumulatedUsage.input_tokens,
        output_tokens: this.accumulatedUsage.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }

    const usage = data?.usage || data?.response?.usage || {}
    return {
      input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      output_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0
    }
  }

  _mapStopReason(reason) {
    if (!reason) {
      return 'end_turn'
    }

    const normalized = String(reason).toLowerCase()

    if (['stop', 'completed', 'end_turn', 'normal'].includes(normalized)) {
      return 'end_turn'
    }

    if (['length', 'max_tokens'].includes(normalized)) {
      return 'max_tokens'
    }

    if (['tool_use', 'tool_calls', 'function_call'].includes(normalized)) {
      return 'tool_use'
    }

    if (['cancelled', 'canceled', 'abort', 'aborted'].includes(normalized)) {
      return 'stop_sequence'
    }

    return 'end_turn'
  }

  _sse(payload) {
    return `event: ${payload.type || 'event'}\n` + `data: ${JSON.stringify(payload)}\n\n`
  }

  _generateId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  }

  _resetStreamState() {
    this.streamBuffer = ''
    this.messageStarted = false
    this.contentBlockStarted = false
    this.streamFinished = false
    this.messageId = null
    this.contentBlockId = null
    this.toolBlock = null
    this.debugEventCount = 0
    this.debugEmitCount = 0
    this.finalResponse = null
    this.accumulatedUsage = null // 新增：累积的usage数据
  }

  /**
   * 检测是否为 Codex CLI 客户端
   * @private
   */
  _isCodexClient() {
    return this.clientType === 'codex_cli' ||
           (this.clientType === 'unknown' && this.targetFormat === 'openai-responses')
  }

  /**
   * 为 Codex CLI 生成 OpenAI Responses 格式的完成事件
   * @private
   */
  _emitOpenAIResponsesCompletion(responsePayload) {
    const usage = this._extractUsage({ usage: responsePayload?.usage })
    const stopReason = this._mapStopReason(responsePayload?.stop_reason || responsePayload?.status)

    logger.info('🎯 [Bridge] Emitting OpenAI Responses completion for Codex CLI:', {
      hasUsage: !!(usage && (usage.input_tokens > 0 || usage.output_tokens > 0)),
      stopReason,
      usage,
      clientType: this.clientType
    })

    const events = []

    // 发送 response.completed 事件（Codex CLI 期望的格式）
    events.push(
      this._sse({
        type: 'response.completed',
        response: {
          id: this.messageId || this._generateId('resp'),
          status: 'completed',
          status_details: {
            type: 'content_filter',
            stop_reason: stopReason
          },
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens
          },
          model: 'gpt-5-codex' // Codex CLI 期望的模型名称
        }
      })
    )

    return events
  }

  _sanitizeToolArguments(rawArguments) {
    try {
      const parsed = JSON.parse(rawArguments)

      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.allowed_domains)) {
          const filteredAllowed = parsed.allowed_domains.filter(
            (item) => typeof item === 'string' && item.trim()
          )
          if (filteredAllowed.length > 0) {
            parsed.allowed_domains = filteredAllowed
          } else {
            delete parsed.allowed_domains
          }
        } else if (parsed.allowed_domains !== null && parsed.allowed_domains !== undefined) {
          delete parsed.allowed_domains
        }

        if (Array.isArray(parsed.blocked_domains)) {
          const filteredBlocked = parsed.blocked_domains.filter(
            (item) => typeof item === 'string' && item.trim()
          )
          if (filteredBlocked.length > 0) {
            parsed.blocked_domains = filteredBlocked
          } else {
            delete parsed.blocked_domains
          }
        } else if (parsed.blocked_domains !== null && parsed.blocked_domains !== undefined) {
          delete parsed.blocked_domains
        }

        if (parsed.allowed_domains && parsed.blocked_domains) {
          // Claude CLI 不允许同时指定，优先保留 allow 列表
          delete parsed.blocked_domains
        }

        return JSON.stringify(parsed)
      }
    } catch (error) {
      logger.warn('Failed to sanitize tool arguments JSON', { message: error.message })
    }

    return rawArguments
  }

  getFinalResponse() {
    return this.finalResponse
  }

  _logEmittedEvents(events) {
    if (!events || events.length === 0) {
      return
    }

    if (this.debugEmitCount >= 10) {
      return
    }

    const names = []
    for (const evt of events) {
      const match = evt.match(/event: ([^\n]+)/)
      if (match && match[1]) {
        names.push(match[1])
      }
    }

    if (names.length > 0) {
      logger.info('📤 [Bridge] 向客户端写出事件', {
        events: names,
        count: names.length,
        streamFinished: this.streamFinished,
        messageStarted: this.messageStarted,
        contentBlockStarted: this.contentBlockStarted
      })
      this.debugEmitCount += 1
    }
  }
}

module.exports = OpenAIResponsesToClaudeConverter
