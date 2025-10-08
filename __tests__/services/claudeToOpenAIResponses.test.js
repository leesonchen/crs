/**
 * ClaudeToOpenAIResponsesConverter 单元测试
 * 测试 Claude 格式 → OpenAI Responses 格式的响应转换
 */

const ClaudeToOpenAIResponsesConverter = require('../../src/services/claudeToOpenAIResponses')
const {
  mockClaudeNonStreamResponse,
  mockClaudeResponseWithTool,
  mockClaudeStreamChunks
} = require('../mocks/responses')

describe('ClaudeToOpenAIResponsesConverter', () => {
  let converter

  beforeEach(() => {
    converter = new ClaudeToOpenAIResponsesConverter({
      modelMapping: {
        'gpt-5': 'claude-3-5-sonnet-20241022',
        'gpt-5-plus': 'claude-opus-4-20250514'
      },
      defaultModel: 'gpt-5'
    })
  })

  describe('convertNonStream() - 非流式转换', () => {
    test('应该生成正确的 OpenAI Responses 响应结构', () => {
      // Arrange
      const claudeResponse = mockClaudeNonStreamResponse

      // Act
      const result = converter.convertNonStream(claudeResponse)

      // Assert
      expect(result).toHaveProperty('type', 'response')
      expect(result).toHaveProperty('response')
      expect(result.response).toHaveProperty('id')
      expect(result.response).toHaveProperty('model')
      expect(result.response).toHaveProperty('created')
      expect(result.response).toHaveProperty('output')
      expect(Array.isArray(result.response.output)).toBe(true)
    })

    test('应该将 Claude text 块转换为 message 格式', () => {
      // Arrange
      const claudeResponse = mockClaudeNonStreamResponse

      // Act
      const result = converter.convertNonStream(claudeResponse)

      // Assert
      const output = result.response.output[0]
      expect(output.type).toBe('message')
      expect(output.role).toBe('assistant')
      expect(Array.isArray(output.content)).toBe(true)
      expect(output.content[0].type).toBe('text')
      expect(output.content[0].text).toBeTruthy()
    })

    test('应该将 tool_use 块转换为 function_call', () => {
      // Arrange
      const claudeResponse = mockClaudeResponseWithTool

      // Act
      const result = converter.convertNonStream(claudeResponse)

      // Assert
      const functionCall = result.response.output.find((item) => item.type === 'function_call')
      expect(functionCall).toBeDefined()
      expect(functionCall.name).toBe('web_search')
      expect(functionCall.call_id).toBe('toolu_123')
      expect(typeof functionCall.arguments).toBe('string')
      const args = JSON.parse(functionCall.arguments)
      expect(args).toEqual({ query: 'latest AI news' })
    })

    test('应该正确映射 usage 数据', () => {
      // Arrange
      const claudeResponse = mockClaudeNonStreamResponse

      // Act
      const result = converter.convertNonStream(claudeResponse)

      // Assert
      expect(result.response.usage).toBeDefined()
      expect(result.response.usage.input_tokens).toBe(10)
      expect(result.response.usage.output_tokens).toBe(8)
      expect(result.response.usage.total_tokens).toBe(18)
    })

    test('应该映射缓存 tokens 到 input_tokens_details', () => {
      // Arrange
      const claudeResponse = mockClaudeNonStreamResponse

      // Act
      const result = converter.convertNonStream(claudeResponse)

      // Assert
      expect(result.response.usage.input_tokens_details).toBeDefined()
      expect(result.response.usage.input_tokens_details.cached_tokens).toBe(2)
    })

    test('应该映射 Claude stop_reason 到 OpenAI 格式', () => {
      // Test 1: end_turn → stop
      const response1 = { ...mockClaudeNonStreamResponse, stop_reason: 'end_turn' }
      expect(converter.convertNonStream(response1).response.stop_reason).toBe('stop')

      // Test 2: max_tokens → length
      const response2 = { ...mockClaudeNonStreamResponse, stop_reason: 'max_tokens' }
      expect(converter.convertNonStream(response2).response.stop_reason).toBe('length')

      // Test 3: tool_use → tool_calls
      const response3 = { ...mockClaudeNonStreamResponse, stop_reason: 'tool_use' }
      expect(converter.convertNonStream(response3).response.stop_reason).toBe('tool_calls')
    })

    test('应该处理空 content 数组', () => {
      // Arrange
      const claudeResponse = {
        id: 'msg_empty',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn'
      }

      // Act
      const result = converter.convertNonStream(claudeResponse)

      // Assert
      expect(result.response.output).toEqual([])
    })
  })

  describe('convertStreamChunk() - 流式转换', () => {
    test('应该转换 message_start 为 response.started', () => {
      // Arrange
      const chunk =
        'data: {"type":"message_start","message":{"id":"msg_123","model":"claude-3-5-sonnet-20241022"}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.started')
      const data = JSON.parse(result.match(/data: (.+)/)[1])
      expect(data.type).toBe('response.started')
      expect(data.response.id).toBe('msg_123')
      expect(data.response.model).toBe('gpt-5')
    })

    test('应该转换文本增量为 output_text.delta', () => {
      // Arrange
      const chunk =
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.output_text.delta')
      const data = JSON.parse(result.match(/data: (.+)/)[1])
      expect(data.type).toBe('response.output_text.delta')
      expect(data.delta.type).toBe('text')
      expect(data.delta.text).toBe('Hello')
    })

    test('应该转换工具调用参数增量', () => {
      // Arrange
      const chunk =
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"key\\""}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.function_call_arguments.delta')
      const data = JSON.parse(result.match(/data: (.+)/)[1])
      expect(data.type).toBe('response.function_call_arguments.delta')
      expect(data.delta).toBe('{"key"')
      expect(data.index).toBe(1)
    })

    test('应该转换 message_delta 中的 stop_reason', () => {
      // Arrange
      const chunk =
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.delta')
      const data = JSON.parse(result.match(/data: (.+)/)[1])
      expect(data.type).toBe('response.delta')
      expect(data.delta.stop_reason).toBe('stop')
    })

    test('应该转换 message_stop 为 response.completed + [DONE]', () => {
      // Arrange
      const chunk =
        'data: {"type":"message_stop","usage":{"input_tokens":10,"output_tokens":5}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.completed')
      expect(result).toContain('[DONE]')
      expect(result.split('\n\n').length).toBeGreaterThan(1) // 多个事件
    })

    test('message_stop 应包含 usage 数据', () => {
      // Arrange
      const chunk =
        'data: {"type":"message_stop","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.completed')
      expect(result).toContain('[DONE]')

      // Extract the response.completed event (first event before [DONE])
      const lines = result.split('\n\n')
      const completedLine = lines.find(line => line.includes('response.completed'))
      const jsonStr = completedLine.replace('data: ', '')
      const data = JSON.parse(jsonStr)

      expect(data.response.usage.input_tokens).toBe(10)
      expect(data.response.usage.output_tokens).toBe(5)
      expect(data.response.usage.total_tokens).toBe(15)
      expect(data.response.usage.input_tokens_details.cached_tokens).toBe(2)
    })

    test('应该转换 tool_use 开始事件', () => {
      // Arrange
      const chunk =
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"web_search"}}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.output_item.added')
      const data = JSON.parse(result.match(/data: (.+)/)[1])
      expect(data.item.type).toBe('function_call')
      expect(data.item.name).toBe('web_search')
      expect(data.item.call_id).toBe('toolu_123')
    })

    test('应该转换内容块结束事件', () => {
      // Arrange
      const chunk = 'data: {"type":"content_block_stop","index":0}\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeTruthy()
      expect(result).toContain('response.output_item.done')
      const data = JSON.parse(result.match(/data: (.+)/)[1])
      expect(data.type).toBe('response.output_item.done')
      expect(data.index).toBe(0)
    })

    test('应该保留 [DONE] 标记', () => {
      // Arrange
      const chunk = 'data: [DONE]\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBe('data: [DONE]\n\n')
    })

    test('应该优雅处理无效的 JSON', () => {
      // Arrange
      const chunk = 'data: {invalid json\n\n'

      // Act
      const result = converter.convertStreamChunk(chunk)

      // Assert
      expect(result).toBeNull() // 不抛出异常，返回 null
    })
  })

  describe('辅助方法', () => {
    test('_mapClaudeModelToOpenAI 应执行反向查找', () => {
      // Arrange & Act
      const result1 = converter._mapClaudeModelToOpenAI('claude-3-5-sonnet-20241022')
      const result2 = converter._mapClaudeModelToOpenAI('claude-opus-4-20250514')

      // Assert
      expect(result1).toBe('gpt-5')
      expect(result2).toBe('gpt-5-plus')
    })

    test('应使用默认映射规则', () => {
      // Test 1: sonnet → gpt-5
      const result1 = converter._mapClaudeModelToOpenAI('claude-3-sonnet-20240229')
      expect(result1).toBe('gpt-5')

      // Test 2: opus → gpt-5-plus
      const result2 = converter._mapClaudeModelToOpenAI('claude-opus-20240229')
      expect(result2).toBe('gpt-5-plus')

      // Test 3: haiku → gpt-5-mini
      const result3 = converter._mapClaudeModelToOpenAI('claude-haiku-20240307')
      expect(result3).toBe('gpt-5-mini')
    })

    test('_mapStopReason 应正确映射所有原因', () => {
      // Act & Assert
      expect(converter._mapStopReason('end_turn')).toBe('stop')
      expect(converter._mapStopReason('max_tokens')).toBe('length')
      expect(converter._mapStopReason('stop_sequence')).toBe('stop')
      expect(converter._mapStopReason('tool_use')).toBe('tool_calls')
      expect(converter._mapStopReason('unknown_reason')).toBe('stop') // 未知原因回退
    })

    test('finalizeStream 应返回 [DONE] 标记', () => {
      // Act
      const result = converter.finalizeStream()

      // Assert
      expect(result).toBe('data: [DONE]\n\n')
    })
  })
})
