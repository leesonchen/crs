/**
 * Mock 响应数据
 * 用于测试响应格式转换
 */

// Mock Claude 非流式响应（完整）
const mockClaudeNonStreamResponse = {
  id: 'msg_01ABC123',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-20241022',
  content: [
    {
      type: 'text',
      text: 'Hello! How can I help you today?'
    }
  ],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 8,
    cache_read_input_tokens: 2
  }
}

// Mock Claude 响应（含 tool_use）
const mockClaudeResponseWithTool = {
  id: 'msg_02ABC456',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-20241022',
  content: [
    {
      type: 'text',
      text: 'Let me search for that information.'
    },
    {
      type: 'tool_use',
      id: 'toolu_123',
      name: 'web_search',
      input: {
        query: 'latest AI news'
      }
    }
  ],
  stop_reason: 'tool_use',
  usage: {
    input_tokens: 15,
    output_tokens: 25
  }
}

// Mock Claude 流式事件（SSE 格式）
const mockClaudeStreamChunks = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world!"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
]

// Mock Claude 流式事件（带 usage 的完整响应）
const mockClaudeStreamWithUsage = {
  type: 'message_stop',
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2
  },
  'amazon-bedrock-invocationMetrics': {
    inputTokenCount: 10,
    outputTokenCount: 5
  }
}

// Mock OpenAI Responses SSE 流式响应
const mockOpenAIResponsesStreamChunks = [
  'data: {"type":"response.started","response":{"id":"resp_123","model":"gpt-5"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":{"type":"text","text":"Hello"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":{"type":"text","text":" world!"}}\n\n',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":2}}}}\n\n',
  'data: [DONE]\n\n'
]

// Mock Claude 流式事件（tool use）
const mockClaudeStreamWithTool = [
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"web_search"}}\n\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\""}}\n\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":": \\"test\\"}"}}\n\n',
  'data: {"type":"content_block_stop","index":1}\n\n'
]

module.exports = {
  mockClaudeNonStreamResponse,
  mockClaudeResponseWithTool,
  mockClaudeStreamChunks,
  mockClaudeStreamWithUsage,
  mockOpenAIResponsesStreamChunks,
  mockClaudeStreamWithTool
}
