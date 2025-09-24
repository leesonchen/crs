class OpenAIResponsesToClaudeConverter {
  constructor() {
    this._resetStreamState()
  }

  convertNonStream(responseData) {
    const resp = responseData?.response || responseData || {}
    const text = this._extractText(resp)
    const usage = this._extractUsage(responseData)
    const stopReason = this._mapStopReason(
      resp?.stop_reason || resp?.status || responseData?.stop_reason
    )

    return {
      id: resp?.id || this._generateId('msg'),
      type: 'message',
      role: 'assistant',
      model: resp?.model || 'unknown',
      stop_reason: stopReason,
      content: text ? [{ type: 'text', text }] : [],
      usage
    }
  }

  convertStreamChunk(rawChunk) {
    if (!rawChunk || typeof rawChunk !== 'string') return ''
    this.streamBuffer += rawChunk
    return this._drainBuffer(false)
  }

  finalizeStream() {
    return this._drainBuffer(true)
  }

  _drainBuffer(force) {
    const output = []

    while (true) {
      const separatorIndex = this.streamBuffer.indexOf('\n\n')
      if (separatorIndex === -1) {
        if (force && this.streamBuffer.trim()) {
          output.push(...this._processBlock(this.streamBuffer))
          this.streamBuffer = ''
        }
        break
      }

      const block = this.streamBuffer.slice(0, separatorIndex)
      this.streamBuffer = this.streamBuffer.slice(separatorIndex + 2)
      output.push(...this._processBlock(block))
    }

    if (force && !this.streamFinished && this.messageStarted) {
      output.push(...this._emitCompletion(null))
    }

    return output.join('')
  }

  _processBlock(block) {
    const events = []
    const lines = block.split('\n')

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload) continue

      if (payload === '[DONE]') {
        events.push(...this._emitCompletion(null))
        continue
      }

      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch (error) {
        // JSON 还不完整，放回缓冲区等待下一个 chunk
        this.streamBuffer = `${block}\n\n${this.streamBuffer}`
        break
      }

      events.push(...this._handleEvent(parsed))
    }

    return events
  }

  _handleEvent(event) {
    if (!event || this.streamFinished) return []

    switch (event.type) {
      case 'response.started':
        return this._emitMessageStart()
      case 'response.output_text.delta':
        if (typeof event.delta !== 'string' || !event.delta) return []
        return this._emitTextDelta(event.delta)
      case 'response.completed':
        return this._emitCompletion(event.response)
      case 'response.error':
        return this._emitError(event.error || event)
      default:
        return []
    }
  }

  _emitMessageStart() {
    if (this.messageStarted) return []

    this.messageStarted = true
    this.messageId = this.messageId || this._generateId('msg')
    this.contentBlockId = this.contentBlockId || this._generateId('cb')

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

  _ensureContentBlockStart() {
    if (this.contentBlockStarted) return []

    this.contentBlockStarted = true
    this.contentBlockId = this.contentBlockId || this._generateId('cb')

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
    const events = []
    events.push(...this._emitMessageStart())
    events.push(...this._ensureContentBlockStart())

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
    if (this.streamFinished) return []

    const events = []
    events.push(...this._emitMessageStart())

    if (this.contentBlockStarted) {
      events.push(
        this._sse({
          type: 'content_block_stop',
          index: 0
        })
      )
    }

    const usage = this._extractUsage({ usage: responsePayload?.usage })
    const stopReason = this._mapStopReason(
      responsePayload?.stop_reason || responsePayload?.status
    )

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

    this.streamFinished = true

    return events
  }

  _emitError(errorPayload) {
    this.streamFinished = true
    return [
      this._sse({
        type: 'error',
        error: errorPayload || { message: 'Unknown error' }
      })
    ]
  }

  _extractText(resp) {
    if (!resp) return ''
    if (typeof resp.output_text === 'string') return resp.output_text
    if (Array.isArray(resp.output)) {
      const texts = []
      for (const seg of resp.output) {
        if (typeof seg === 'string') texts.push(seg)
        else if (seg?.content) texts.push(String(seg.content))
        else if (seg?.text) texts.push(String(seg.text))
      }
      if (texts.length > 0) return texts.join('')
    }
    if (typeof resp.content === 'string') return resp.content
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
    if (!reason) return 'end_turn'
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
    const eventType = payload && payload.type ? payload.type : 'event'
    return `event: ${eventType}\n` + `data: ${JSON.stringify(payload)}\n\n`
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
  }
}

module.exports = OpenAIResponsesToClaudeConverter
