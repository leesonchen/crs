/**
 * OpenAIResponsesToClaudeConverter 单元测试
 * 测试 OpenAI Responses 格式 → Claude 格式的请求转换
 */

const OpenAIResponsesToClaudeConverter = require('../../src/services/openaiResponsesToClaude')
const {
  mockOpenAIResponsesRequest,
  mockOpenAIChatRequest
} = require('../mocks/requests')

describe('OpenAIResponsesToClaudeConverter', () => {
  let converter

  beforeEach(() => {
    converter = new OpenAIResponsesToClaudeConverter()
  })

  describe('convertRequest() - 基础转换', () => {
    test('应该正确转换完整的 OpenAI Responses 请求', () => {
      // Arrange
      const openaiRequest = mockOpenAIResponsesRequest

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result).toHaveProperty('model', 'gpt-5')
      expect(result).toHaveProperty('max_tokens', 4096)
      expect(result).toHaveProperty('stream', false)
      expect(result).toHaveProperty('system')
      expect(result).toHaveProperty('messages')
      expect(Array.isArray(result.messages)).toBe(true)
    })

    test('应该将 instructions 字段映射为 system', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        instructions: 'You are a helpful assistant',
        max_output_tokens: 2048
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.system).toBe('You are a helpful assistant')
    })

    test('应该优先使用 max_tokens，回退到 max_output_tokens', () => {
      // Test 1: 有 max_tokens
      const request1 = { model: 'gpt-5', max_tokens: 1000 }
      expect(converter.convertRequest(request1).max_tokens).toBe(1000)

      // Test 2: 只有 max_output_tokens
      const request2 = { model: 'gpt-5', max_output_tokens: 2000 }
      expect(converter.convertRequest(request2).max_tokens).toBe(2000)

      // Test 3: 都没有（使用默认值）
      const request3 = { model: 'gpt-5' }
      expect(converter.convertRequest(request3).max_tokens).toBe(4096)
    })

    test('应该将 stream 转换为布尔值', () => {
      // Test 1: undefined → false
      const request1 = { model: 'gpt-5' }
      expect(converter.convertRequest(request1).stream).toBe(false)

      // Test 2: true → true
      const request2 = { model: 'gpt-5', stream: true }
      expect(converter.convertRequest(request2).stream).toBe(true)

      // Test 3: 假值 → false
      const request3 = { model: 'gpt-5', stream: 0 }
      expect(converter.convertRequest(request3).stream).toBe(false)
    })

    test('应该正确处理 temperature 和 top_p', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        temperature: 0.7,
        top_p: 0.9
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.temperature).toBe(0.7)
      expect(result.top_p).toBe(0.9)
    })
  })

  describe('convertRequest() - input → messages 转换', () => {
    test('应该将 input 数组转换为 messages', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Hello' }]
          }
        ]
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(Array.isArray(result.messages)).toBe(true)
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].role).toBe('user')
    })

    test('应该将单个 text 块简化为字符串', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Single text block' }]
          }
        ]
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(typeof result.messages[0].content).toBe('string')
      expect(result.messages[0].content).toBe('Single text block')
    })

    test('应该保持多个 content 块为数组格式', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'First block' },
              { type: 'text', text: 'Second block' }
            ]
          }
        ]
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(Array.isArray(result.messages[0].content)).toBe(true)
      expect(result.messages[0].content.length).toBe(2)
    })

    test('应该正确处理图片 content', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image' },
              { type: 'image', source: { url: 'https://example.com/image.jpg' } }
            ]
          }
        ]
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.messages[0].content[1].type).toBe('image')
      expect(result.messages[0].content[1].source).toBeDefined()
    })

    test('应该处理字符串类型的 content', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'Plain string content'
          }
        ]
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.messages[0].content).toBe('Plain string content')
    })

    test('应该处理空的 input 数组', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5',
        input: []
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.messages).toEqual([])
    })
  })

  describe('convertRequest() - 边界和错误情况', () => {
    test('应该兼容传统的 messages 字段', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Traditional format' }]
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.messages).toEqual([{ role: 'user', content: 'Traditional format' }])
    })

    test('缺失 input 和 messages 时应返回空数组', () => {
      // Arrange
      const openaiRequest = {
        model: 'gpt-5'
        // 没有 input 也没有 messages
      }

      // Act
      const result = converter.convertRequest(openaiRequest)

      // Assert
      expect(result.messages).toEqual([])
    })
  })
})
