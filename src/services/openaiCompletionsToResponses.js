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
    this._messageOutputIndex = 0
    this._messageItemId = `item_${Date.now()}`
    this._messagePartId = `part_${Date.now()}`
    this._messageInitialized = false
    this._messageCompleted = false
    this._responseInProgressSent = false
    this._stopReason = 'stop'
    this._sequenceNumber = 1
    this._reasoningParts = []
    this._reasoningOutputIndex = 0
    this._reasoningItemId = `reason_${Date.now()}`
    this._reasoningPartId = `reason_part_${Date.now()}`
    this._reasoningInitialized = false
    this._reasoningCompleted = false
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

    if (typeof responsesBody.input === 'string' && responsesBody.input) {
      messages.push({
        role: 'user',
        content: responsesBody.input
      })
    } else if (Array.isArray(responsesBody.input)) {
      for (const item of responsesBody.input) {
        if (!item || typeof item !== 'object') {
          continue
        }

        const mappedMessages = this._mapInputItemToChatMessages(item)
        if (mappedMessages.length > 0) {
          messages.push(...mappedMessages)
        }
      }
    } else if (responsesBody.input && typeof responsesBody.input === 'object') {
      const mappedMessages = this._mapInputItemToChatMessages(responsesBody.input)
      if (mappedMessages.length > 0) {
        messages.push(...mappedMessages)
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
      created: createdAt,
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
    if (!this._responseInProgressSent) {
      output += this._emitInProgressEvent()
      this._responseInProgressSent = true
    }

    if (chunk?.usage) {
      this._usage = this._mapUsage(chunk.usage)
      output += this._formatEvents([
        {
          type: 'response.delta',
          delta: {
            usage: this._usage
          }
        }
      ])
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null
    if (!choice) {
      return output
    }

    const delta = choice.delta || {}
    const reasoningDelta = this._extractDeltaText(delta.reasoning_content)
    if (reasoningDelta) {
      output += this._emitReasoningStartEvents()
      this._reasoningParts.push(reasoningDelta)
      output += this._formatEvents([
        {
          type: 'response.reasoning_summary_text.delta',
          delta: reasoningDelta,
          item_id: this._reasoningItemId,
          part: this._reasoningPartId,
          summary_index: 0,
          output_index: this._reasoningOutputIndex
        }
      ])
    }

    const textDelta = this._extractDeltaText(delta.content)
    if (textDelta) {
      output += this._emitMessageStartEvents()
      this._textParts.push(textDelta)
      output += this._formatEvents([
        {
          type: 'response.output_text.delta',
          delta: textDelta,
          item_id: this._messageItemId,
          content_index: 0,
          output_index: this._messageOutputIndex
        }
      ])
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
        const outputIndex = idx + 1
        const itemId = `fn_${callId}`
        this._toolCalls.set(idx, {
          call_id: callId,
          name,
          arguments: argsDelta || '',
          item_id: itemId,
          output_index: outputIndex
        })
        output += this._formatEvents([
          {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: {
              type: 'function_call',
              id: itemId,
              status: 'in_progress',
              call_id: callId,
              name,
              arguments: ''
            }
          }
        ])
      } else {
        existing.name = name || existing.name
        existing.arguments += argsDelta
      }

      if (argsDelta) {
        const current = this._toolCalls.get(idx)
        output += this._formatEvents([
          {
            type: 'response.function_call_arguments.delta',
            output_index: current.output_index,
            item_id: current.item_id,
            delta: argsDelta
          }
        ])
      }
    }

    if (choice.finish_reason) {
      this._stopReason = this._mapFinishReason(choice.finish_reason)
      output += this._emitCompletedEvent()
    }

    return output
  }

  _emitCreatedEvent() {
    return this._formatEvents([
      {
        type: 'response.created',
        response: {
          id: this._responseId,
          object: 'response',
          created: this._createdAt,
          model: this._model,
          status: 'in_progress'
        }
      }
    ])
  }

  _emitReasoningDoneEvents() {
    if (!this._reasoningInitialized || this._reasoningCompleted) {
      return ''
    }

    this._reasoningCompleted = true
    const text = this._reasoningParts.join('')
    return this._formatEvents([
      {
        type: 'response.reasoning_summary_text.done',
        item_id: this._reasoningItemId,
        part: this._reasoningPartId,
        summary_index: 0,
        output_index: this._reasoningOutputIndex,
        text
      },
      {
        type: 'response.reasoning_summary_part.done',
        item_id: this._reasoningItemId,
        part: this._reasoningPartId,
        summary_index: 0,
        output_index: this._reasoningOutputIndex
      },
      {
        type: 'response.output_item.done',
        item: {
          id: this._reasoningItemId,
          type: 'reasoning',
          status: 'completed'
        },
        output_index: this._reasoningOutputIndex
      }
    ])
  }

  _emitInProgressEvent() {
    return this._formatEvents([
      {
        type: 'response.in_progress',
        response: {
          id: this._responseId,
          object: 'response',
          created: this._createdAt,
          model: this._model,
          status: 'in_progress'
        }
      }
    ])
  }

  _emitMessageStartEvents() {
    if (this._messageInitialized) {
      return ''
    }

    if (this._reasoningInitialized && this._messageOutputIndex === this._reasoningOutputIndex) {
      this._messageOutputIndex = this._reasoningOutputIndex + 1
    }

    this._messageInitialized = true
    return this._formatEvents([
      {
        type: 'response.output_item.added',
        item: {
          id: this._messageItemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: []
        },
        output_index: this._messageOutputIndex
      },
      {
        type: 'response.content_part.added',
        item_id: this._messageItemId,
        part: {
          type: 'output_text',
          text: ''
        },
        content_index: 0,
        output_index: this._messageOutputIndex
      }
    ])
  }

  _emitReasoningStartEvents() {
    if (this._reasoningInitialized) {
      return ''
    }

    this._reasoningInitialized = true
    return this._formatEvents([
      {
        type: 'response.output_item.added',
        item: {
          id: this._reasoningItemId,
          type: 'reasoning',
          status: 'in_progress'
        },
        output_index: this._reasoningOutputIndex
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: this._reasoningItemId,
        part: this._reasoningPartId,
        summary_index: 0,
        output_index: this._reasoningOutputIndex
      }
    ])
  }

  _emitCompletedEvent() {
    if (this._responseCompleted) {
      return ''
    }

    this._responseCompleted = true

    let outputEvents = ''
    outputEvents += this._emitReasoningDoneEvents()
    outputEvents += this._emitMessageDoneEvents()
    outputEvents += this._emitToolDoneEvents()

    const output = []
    const reasoningText = this._reasoningParts.join('')
    if (reasoningText) {
      output.push({
        type: 'reasoning',
        id: this._reasoningItemId,
        status: 'completed',
        summary: [{ type: 'summary_text', text: reasoningText }]
      })
    }

    const text = this._textParts.join('')
    if (text) {
      output.push({
        type: 'message',
        id: this._messageItemId,
        status: 'completed',
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
        id: call.item_id,
        call_id: call.call_id,
        status: 'completed',
        name: call.name,
        arguments: call.arguments || ''
      })
    }

    outputEvents += this._formatEvents([
      {
        type: 'response.delta',
        delta: {
          stop_reason: this._stopReason
        }
      },
      {
        type: 'response.completed',
        response: {
          id: this._responseId,
          object: 'response',
          created: this._createdAt,
          status: 'completed',
          model: this._model,
          stop_reason: this._stopReason,
          output,
          ...(this._usage ? { usage: this._usage } : {})
        }
      }
    ])

    return outputEvents
  }

  _emitMessageDoneEvents() {
    if (!this._messageInitialized || this._messageCompleted) {
      return ''
    }

    this._messageCompleted = true
    const text = this._textParts.join('')
    return this._formatEvents([
      {
        type: 'response.output_text.done',
        item_id: this._messageItemId,
        content_index: 0,
        output_index: this._messageOutputIndex,
        text
      },
      {
        type: 'response.content_part.done',
        item_id: this._messageItemId,
        part: {
          type: 'output_text',
          text
        },
        content_index: 0,
        output_index: this._messageOutputIndex
      },
      {
        type: 'response.output_item.done',
        item: {
          id: this._messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        },
        output_index: this._messageOutputIndex
      }
    ])
  }

  _emitToolDoneEvents() {
    const events = []

    for (const call of this._toolCalls.values()) {
      if (call.completed) {
        continue
      }

      events.push(
        {
          type: 'response.function_call_arguments.done',
          item_id: call.item_id,
          arguments: call.arguments || '',
          output_index: call.output_index
        },
        {
          type: 'response.output_item.done',
          item: {
            id: call.item_id,
            type: 'function_call',
            status: 'completed',
            call_id: call.call_id,
            name: call.name,
            arguments: call.arguments || ''
          },
          output_index: call.output_index
        }
      )

      call.completed = true
    }

    return this._formatEvents(events)
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

  _mapInputItemToChatMessages(item) {
    if (!item || typeof item !== 'object') {
      return []
    }

    if (item.type === 'function_call_output') {
      return [
        {
          role: 'tool',
          tool_call_id: item.call_id,
          content: this._convertToolOutputToChatContent(item.output)
        }
      ]
    }

    if (item.type === 'function_call') {
      return [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: item.call_id || item.id || `call_${Date.now()}`,
              type: 'function',
              function: {
                name: item.name || 'function',
                arguments:
                  typeof item.arguments === 'string'
                    ? item.arguments
                    : JSON.stringify(item.arguments || {})
              }
            }
          ]
        }
      ]
    }

    if (item.type === 'message' || item.role) {
      return [
        {
          role: this._normalizeInputRole(item.role),
          content: this._convertInputContent(item.content)
        }
      ]
    }

    return []
  }

  _normalizeInputRole(role) {
    if (role === 'developer') {
      return 'system'
    }
    if (role === 'system' || role === 'assistant' || role === 'tool') {
      return role
    }
    return 'user'
  }

  _convertToolOutputToChatContent(output) {
    if (typeof output === 'string') {
      return output
    }

    if (!Array.isArray(output)) {
      return JSON.stringify(output ?? '')
    }

    return output
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        if (part && typeof part.text === 'string') {
          return part.text
        }
        if (part && typeof part.output_text === 'string') {
          return part.output_text
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

  _mapFinishReason(reason) {
    if (!reason) {
      return 'stop'
    }

    if (reason === 'tool_calls' || reason === 'function_call') {
      return 'tool_calls'
    }

    if (reason === 'length') {
      return 'max_output_tokens'
    }

    if (reason === 'content_filter') {
      return 'content_filter'
    }

    return 'stop'
  }

  _extractDeltaText(content) {
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

  _formatEvents(events = []) {
    if (!Array.isArray(events) || events.length === 0) {
      return ''
    }

    return events
      .map((event) => {
        if (!event.sequence_number) {
          event.sequence_number = this._sequenceNumber++
        }
        return `data: ${JSON.stringify(event)}\n\n`
      })
      .join('')
  }

  _toResponseId(id) {
    if (typeof id !== 'string' || !id.trim()) {
      return this._responseId
    }
    return id.startsWith('resp_') ? id : `resp_${id}`
  }
}

module.exports = OpenAICompletionsToResponsesConverter
