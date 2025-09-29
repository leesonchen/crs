jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const OpenAIResponsesToClaudeConverter = require('../src/services/openaiResponsesToClaude')

describe('OpenAIResponsesToClaudeConverter', () => {
  test('converts non-stream response into Claude message format', () => {
    const converter = new OpenAIResponsesToClaudeConverter()
    const openaiResponse = {
      response: {
        id: 'resp_123',
        model: 'gpt-5-preview',
        stop_reason: 'end_turn',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Hello from OpenAI responses'
              }
            ]
          }
        ]
      },
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30
      }
    }

    const claudeMessage = converter.convertNonStream(openaiResponse)

    expect(claudeMessage).toMatchObject({
      id: 'resp_123',
      type: 'message',
      role: 'assistant',
      model: 'gpt-5-preview',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Hello from OpenAI responses'
        }
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    })
  })

  test('falls back to plain text when output content is empty', () => {
    const converter = new OpenAIResponsesToClaudeConverter()
    const openaiResponse = {
      response: {
        id: 'resp_empty',
        model: 'gpt-5-preview',
        stop_reason: 'end_turn',
        output: [],
        output_text: 'fallback text'
      }
    }

    const claudeMessage = converter.convertNonStream(openaiResponse)

    expect(claudeMessage.content).toEqual([
      {
        type: 'text',
        text: 'fallback text'
      }
    ])
  })
})
