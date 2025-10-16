jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const OpenAIResponsesToClaudeConverter = require('../src/services/openaiResponsesToClaude')

describe('OpenAIResponsesToClaudeConverter', () => {
  const directiveLine1 = '请直接根据以上上下文完成用户任务，并一次性输出最终结果。'

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

  test('merges user messages and appends execution directive', () => {
    const converter = new OpenAIResponsesToClaudeConverter()

    const claudeRequest = converter.convertRequest({
      model: 'gpt-5-codex',
      stream: true,
      instructions: 'system prompt',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'First requirement'
            }
          ]
        },
        {
          type: 'message',
          role: 'user',
          content: 'Additional context'
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Previous answer'
            }
          ]
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Final request'
            }
          ]
        }
      ]
    })

    expect(claudeRequest.system).toBe('system prompt')
    expect(claudeRequest.messages).toHaveLength(2)

    const [userMessage, assistantMessage] = claudeRequest.messages

    expect(userMessage.role).toBe('user')
    expect(Array.isArray(userMessage.content)).toBe(true)
    const combinedUserText = userMessage.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    expect(combinedUserText).toContain('First requirement')
    expect(combinedUserText).toContain('Additional context')
    expect(combinedUserText).toContain('Final request')
    expect(combinedUserText).toContain(directiveLine1)

    expect(assistantMessage.role).toBe('assistant')
    expect(
      assistantMessage.content.some(
        (block) => block.type === 'text' && block.text.includes('Previous answer')
      )
    ).toBe(true)
  })

  test('normalizes object content blocks into text', () => {
    const converter = new OpenAIResponsesToClaudeConverter()

    const claudeRequest = converter.convertRequest({
      model: 'gpt-5-codex',
      stream: true,
      instructions: 'system prompt',
      input: [
        {
          type: 'message',
          role: 'user',
          content: {
            text: 'Primary text'
          }
        },
        {
          type: 'message',
          role: 'user',
          content: {
            parts: [
              {
                text: 'Extra part'
              }
            ]
          }
        }
      ]
    })

    expect(claudeRequest.messages).toHaveLength(1)
    const onlyMessage = claudeRequest.messages[0]
    const textBlocks = onlyMessage.content.filter((block) => block.type === 'text')
    const mergedText = textBlocks.map((block) => block.text).join('\n')

    expect(mergedText).toContain('Primary text')
    expect(mergedText).toContain('Extra part')
    expect(mergedText).toContain(directiveLine1)
  })
})
