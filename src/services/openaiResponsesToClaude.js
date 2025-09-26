const logger = require('../utils/logger')

class OpenAIResponsesToClaudeConverter {
  constructor() {
    this._resetStreamState()
  }

  convertNonStream(responseData) {
    const resp = responseData?.response || responseData || {}
    this.finalResponse = resp
    const usage = this._extractUsage(responseData)
    const stopReason = this._mapStopReason(
      resp?.stop_reason || resp?.status || responseData?.stop_reason
    )

    const content = this._convertOutputContent(resp)
    if (content.length === 0) {
      const fallbackText = this._extractText(resp)
      if (fallbackText) {
        content.push({ type: 'text', text: fallbackText })
      }
    }

    return {
      id: resp?.id || this._generateId('msg'),
      type: 'message',
      role: 'assistant',
      model: resp?.model || 'unknown',
      stop_reason: stopReason,
      content,
      usage
    }
  }

  convertStreamChunk(rawChunk) {
    if (!rawChunk || typeof rawChunk !== 'string') {
      return ''
    }

    this.streamBuffer += rawChunk.replace(/\r\n/g, '\n')
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
      return []
    }

    if (this.debugEventCount < 5) {
      logger.info('Claude bridge收到 OpenAI-Responses 事件', {
        type: event.type,
        hasResponse: Boolean(event.response),
        itemType: event.item?.type,
        deltaType: event.delta?.type,
        keys: Object.keys(event || {})
      })
      this.debugEventCount += 1
    }

    switch (event.type) {
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
          content: []
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
          type: 'text'
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

    if (responsePayload) {
      this.finalResponse = responsePayload
    }

    this.streamFinished = true

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

    if (this.debugEmitCount >= 5) {
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
      logger.info('Claude bridge向客户端写出事件', {
        events: names,
        count: names.length
      })
      this.debugEmitCount += 1
    }
  }
}

module.exports = OpenAIResponsesToClaudeConverter
