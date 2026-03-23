/**
 * OpenAI Chat Completions <-> OpenAI Responses bridge helper for providerEndpoint=completions.
 * Used when upstream only supports chat/completions while client expects responses.
 */
class OpenAICompletionsToResponsesConverter {
  constructor(options = {}) {
    this.requestedModel = options.requestedModel || 'gpt-5'
    this._sseBuffer = ''
    this._responseCreated = false
    this._responseCompleted = false
    this._responseId = `resp_${Date.now()}`
    this._createdAt = Math.floor(Date.now() / 1000)
    this._model = this.requestedModel
    this._textParts = []
    this._toolCalls = new Map()
    this._usage = null
  }

  buildChatRequestFromResponses(responsesBody = {}) {
    if (!responsesBody || typeof responsesBody !== 'object') {
      return {}
    }

    const chatBody = {
      model: responsesBody.model || this.requestedModel,
      stream: responsesBody.stream !== false
    }

    const messages = []

    if (typeof responsesBody.instructions === 'string' && responsesBody.instructions.trim()) {
      messages.push({
        role: 'system',
        content: responsesBody.instructions.trim()
      })
    }

    if (Array.isArray(responsesBody.input)) {
      for (const item of responsesBody.input) {
        if (!item || typeof item !== 'object') {
          continue
        }

        if (item.type === 'message') {
          messages.push({
            role: item.role || 'user',
            content: this._convertInputContent(item.content)
          })
        }
      }
    }

    if (messages.length === 0 && Array.isArray(responsesBody.messages)) {
      chatBody.messages = responsesBody.messages
    } else {
      chatBody.messages = messages
    }

    if (Array.isArray(responsesBody.tools) && responsesBody.tools.length > 0) {
      chatBody.tools = responsesBody.tools.map((tool) => this._mapToolToChat(tool)).filter(Boolean)
    }

    if (responsesBody.tool_choice !== undefined) {
      chatBody.tool_choice = responsesBody.tool_choice
    }

    if (responsesBody.parallel_tool_calls !== undefined) {
      chatBody.parallel_tool_calls = responsesBody.parallel_tool_calls
    }

    if (responsesBody.temperature !== undefined) {
      chatBody.temperature = responsesBody.temperature
    }
    if (responsesBody.top_p !== undefined) {
      chatBody.top_p = responsesBody.top_p
    }
    if (responsesBody.max_output_tokens !== undefined) {
      chatBody.max_tokens = responsesBody.max_output_tokens
    }
    if (responsesBody.user !== undefined) {
      chatBody.user = responsesBody.user
    }

    if (chatBody.stream) {
      chatBody.stream_options = { include_usage: true }
    }

    return chatBody
  }

  convertNonStream(chatResponse = {}) {
    if (
      chatResponse &&
      (chatResponse.type === 'response.completed' || chatResponse.object === 'response')
    ) {
      return chatResponse
    }

    const model = chatResponse?.model || this.requestedModel
    const responseId = this._toResponseId(chatResponse?.id)
    const createdAt = chatResponse?.created || Math.floor(Date.now() / 1000)

    const choices = Array.isArray(chatResponse?.choices) ? chatResponse.choices : []
    const first = choices[0] || {}
    const message = first.message || {}
    const text = this._extractMessageText(message.content)
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

    const output = []
    if (text) {
      output.push({
        type: 'message',
        id: `msg_${responseId}`,
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      })
    }

    for (const toolCall of toolCalls) {
      const fn = toolCall?.function || {}
      output.push({
        type: 'function_call',
        id: toolCall.id || `fc_${Date.now()}`,
        call_id: toolCall.id || `fc_${Date.now()}`,
        name: fn.name || 'function',
        arguments:
          typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
      })
    }

    const usage = this._mapUsage(chatResponse?.usage)

    return {
      id: responseId,
      object: 'response',
      status: 'completed',
      created_at: createdAt,
      model,
      output,
      ...(usage ? { usage } : {})
    }
  }

  convertStreamChunk(rawChunk = '') {
    const normalized = String(rawChunk).replace(/\r\n/g, '\n')
    this._sseBuffer += normalized
    let output = ''

    let idx = -1
    while ((idx = this._sseBuffer.indexOf('\n\n')) !== -1) {
      const eventBlock = this._sseBuffer.slice(0, idx)
      this._sseBuffer = this._sseBuffer.slice(idx + 2)
      output += this._convertEventBlock(eventBlock)
    }

    return output
  }

  finalizeStream() {
    let output = ''
    if (this._sseBuffer.trim()) {
      output += this._convertEventBlock(this._sseBuffer)
      this._sseBuffer = ''
    }

    if (!this._responseCompleted) {
      output += this._emitCompletedEvent()
    }

    return `${output}data: [DONE]\n\n`
  }

  _convertEventBlock(eventBlock) {
    if (!eventBlock || !eventBlock.trim()) {
      return ''
    }

    let output = ''
    const lines = eventBlock.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ')) {
        continue
      }

      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') {
        continue
      }

      let chunk = null
      try {
        chunk = JSON.parse(payload)
      } catch (_) {
        continue
      }

      output += this._convertChatChunk(chunk)
    }

    return output
  }

  _convertChatChunk(chunk) {
    if (chunk?.error) {
      return `data: ${JSON.stringify(chunk)}\n\n`
    }

    const model = chunk?.model || this.requestedModel
    if (model) {
      this._model = model
    }
    if (chunk?.created) {
      this._createdAt = chunk.created
    }
    if (chunk?.id) {
      this._responseId = this._toResponseId(chunk.id)
    }

    let output = ''
    if (!this._responseCreated) {
      output += this._emitCreatedEvent()
      this._responseCreated = true
    }

    if (chunk?.usage) {
      this._usage = this._mapUsage(chunk.usage)
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null
    if (!choice) {
      return output
    }

    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content) {
      this._textParts.push(delta.content)
      output += `data: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: delta.content
      })}\n\n`
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const toolCall of toolCalls) {
      const idx = Number.isInteger(toolCall.index) ? toolCall.index : 0
      const existing = this._toolCalls.get(idx)
      const callId = toolCall.id || existing?.call_id || `call_${idx}`
      const fn = toolCall.function || {}
      const name = fn.name || existing?.name || 'function'
      const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''

      if (!existing) {
        this._toolCalls.set(idx, { call_id: callId, name, arguments: argsDelta || '' })
        output += `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: idx,
          item: {
            type: 'function_call',
            id: callId,
            call_id: callId,
            name,
            arguments: ''
          }
        })}\n\n`
      } else {
        existing.name = name || existing.name
        existing.arguments += argsDelta
      }

      if (argsDelta) {
        const current = this._toolCalls.get(idx)
        output += `data: ${JSON.stringify({
          type: 'response.function_call_arguments.delta',
          output_index: idx,
          item_id: current.call_id,
          delta: argsDelta
        })}\n\n`
      }
    }

    if (choice.finish_reason) {
      output += this._emitCompletedEvent()
    }

    return output
  }

  _emitCreatedEvent() {
    return `data: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: this._responseId,
        object: 'response',
        created_at: this._createdAt,
        status: 'in_progress',
        model: this._model
      }
    })}\n\n`
  }

  _emitCompletedEvent() {
    this._responseCompleted = true

    const output = []
    const text = this._textParts.join('')
    if (text) {
      output.push({
        type: 'message',
        id: `msg_${this._responseId}`,
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      })
    }

    const toolCallItems = [...this._toolCalls.keys()]
      .sort((a, b) => a - b)
      .map((idx) => this._toolCalls.get(idx))
    for (const call of toolCallItems) {
      output.push({
        type: 'function_call',
        id: call.call_id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments || ''
      })
    }

    return `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: this._responseId,
        object: 'response',
        created_at: this._createdAt,
        status: 'completed',
        model: this._model,
        output,
        ...(this._usage ? { usage: this._usage } : {})
      }
    })}\n\n`
  }

  _convertInputContent(content) {
    if (typeof content === 'string') {
      return content
    }

    if (!Array.isArray(content)) {
      return ''
    }

    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        if (part && part.type === 'input_text' && typeof part.text === 'string') {
          return part.text
        }
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return part.text
        }
        return ''
      })
      .join('')

    return text
  }

  _extractMessageText(content) {
    if (typeof content === 'string') {
      return content
    }

    if (!Array.isArray(content)) {
      return ''
    }

    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        if (part && typeof part.text === 'string') {
          return part.text
        }
        return ''
      })
      .join('')
  }

  _mapToolToChat(tool) {
    if (!tool || typeof tool !== 'object') {
      return null
    }

    if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
      return tool
    }

    if (tool.type === 'function' && tool.name) {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || {}
        }
      }
    }

    return null
  }

  _mapUsage(usage) {
    if (!usage || typeof usage !== 'object') {
      return null
    }

    const inputTokens = usage.input_tokens ?? usage.prompt_tokens
    const outputTokens = usage.output_tokens ?? usage.completion_tokens
    const totalTokens = usage.total_tokens ?? (inputTokens || 0) + (outputTokens || 0)

    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      usage.prompt_tokens === undefined &&
      usage.completion_tokens === undefined
    ) {
      return null
    }

    return {
      input_tokens: Number(inputTokens || 0),
      output_tokens: Number(outputTokens || 0),
      total_tokens: Number(totalTokens || 0)
    }
  }

  _toResponseId(id) {
    if (typeof id !== 'string' || !id.trim()) {
      return this._responseId
    }
    return id.startsWith('resp_') ? id : `resp_${id}`
  }
}

module.exports = OpenAICompletionsToResponsesConverter
