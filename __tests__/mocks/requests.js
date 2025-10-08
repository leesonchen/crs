/**
 * Mock 请求数据
 * 用于测试格式转换
 */

// Mock Claude API 请求
const mockClaudeRequest = {
  model: 'claude-3-5-sonnet-20241022',
  messages: [
    {
      role: 'user',
      content: 'Hello, this is a test message.'
    }
  ],
  max_tokens: 100,
  temperature: 0.7,
  stream: false
}

// Mock Claude API 流式请求
const mockClaudeStreamRequest = {
  ...mockClaudeRequest,
  stream: true
}

// Mock OpenAI API 请求
const mockOpenAIRequest = {
  model: 'gpt-4',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Hello, this is a test message.'
        }
      ]
    }
  ],
  modalities: ['text'],
  max_output_tokens: 100,
  temperature: 0.7,
  stream: false
}

// Mock OpenAI API 响应
const mockOpenAIResponse = {
  id: 'chatcmpl-test-123',
  object: 'chat.completion',
  created: 1234567890,
  model: 'gpt-4',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'This is a test response.'
      },
      finish_reason: 'stop'
    }
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15
  }
}

// Mock Claude API 响应
const mockClaudeResponse = {
  id: 'msg_test_123',
  type: 'message',
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: 'This is a test response.'
    }
  ],
  model: 'claude-3-5-sonnet-20241022',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 5
  }
}

// Mock OpenAI Responses 格式请求（Codex CLI 使用）
const mockOpenAIResponsesRequest = {
  model: 'gpt-5',
  instructions: 'You are a coding agent running in the Codex CLI',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Write a function to calculate fibonacci numbers'
        }
      ]
    }
  ],
  stream: false,
  max_output_tokens: 4096
}

// Mock OpenAI Responses 流式请求
const mockOpenAIResponsesStreamRequest = {
  ...mockOpenAIResponsesRequest,
  stream: true
}

// Mock OpenAI Chat 格式请求（传统格式）
const mockOpenAIChatRequest = {
  model: 'gpt-4',
  messages: [
    {
      role: 'user',
      content: 'Hello, how are you?'
    }
  ],
  stream: false,
  max_tokens: 100
}

// Mock OpenAI Responses 响应（非流式）
const mockOpenAIResponsesResponse = {
  type: 'response',
  response: {
    id: 'resp_123',
    model: 'gpt-5',
    created: 1234567890,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Here is the fibonacci function...'
          }
        ]
      }
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 150,
      total_tokens: 170,
      input_tokens_details: {
        cached_tokens: 5
      }
    },
    stop_reason: 'stop'
  }
}

module.exports = {
  mockClaudeRequest,
  mockClaudeStreamRequest,
  mockOpenAIRequest,
  mockOpenAIResponse,
  mockClaudeResponse,
  mockOpenAIResponsesRequest,
  mockOpenAIResponsesStreamRequest,
  mockOpenAIChatRequest,
  mockOpenAIResponsesResponse
}
