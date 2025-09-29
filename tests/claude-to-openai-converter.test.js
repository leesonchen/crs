jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const ClaudeToOpenAIResponsesConverter = require('../src/services/claudeToOpenAIResponses')

describe('ClaudeToOpenAIResponsesConverter', () => {
  const buildConverter = (options = {}) => new ClaudeToOpenAIResponsesConverter(options)

  test('converts minimal Claude request into OpenAI Responses payload', () => {
    const converter = buildConverter({ modelMapping: { 'claude-3-haiku': 'gpt-4.1-mini' } })

    const claudeRequest = {
      model: 'claude-3-haiku',
      stream: false,
      system: 'You are Claude.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello'
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'search',
              input: { query: 'claude relay service' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: [
                {
                  type: 'text',
                  text: 'Result payload'
                }
              ]
            }
          ]
        }
      ]
    }

    const result = converter.convertRequest(claudeRequest)

    expect(result).toEqual({
      model: 'gpt-4.1-mini',
      stream: false,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'You are Claude.'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Hello'
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '[tool_call name=search id=call-1] {"query":"claude relay service"}'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[tool_result] id=call-1 Result payload'
            }
          ]
        }
      ]
    })
  })

  test('throws error when non-text content is provided', () => {
    const converter = buildConverter()

    expect(() =>
      converter.convertRequest({
        model: 'claude-3-sonnet',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: '...' }
              }
            ]
          }
        ]
      })
    ).toThrow(/Non-text content is not supported/)
  })

  test('sanitizes tool domain lists when both allowed and blocked provided', () => {
    const converter = buildConverter()

    const response = converter.convertRequest({
      model: 'claude-3-haiku',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hi'
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'web_search',
              input: {
                allowed_domains: ['openai.com', '', 'anthropic.com'],
                blocked_domains: ['example.com']
              }
            }
          ]
        }
      ],
      tools: [
        {
          name: 'web_search',
          input_schema: {
            type: 'object'
          }
        }
      ]
    })

    expect(response.tools).toHaveLength(1)

    const assistantMessages = response.input.filter((item) => item.role === 'assistant')
    expect(assistantMessages.length).toBeGreaterThan(0)

    const toolSummary = assistantMessages[0].content[0].text
    expect(toolSummary).toContain('allowed_domains')
    expect(toolSummary).not.toContain('blocked_domains')
  })
})
