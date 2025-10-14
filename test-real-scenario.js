#!/usr/bin/env node

/**
 * 测试真实场景中的问题
 * 模拟监控日志中看到的实际数据流
 */

const ClaudeToOpenAIResponsesConverter = require('./src/services/claudeToOpenAIResponses')

// 创建转换器实例
const converter = new ClaudeToOpenAIResponsesConverter({
  clientType: 'codex_cli',
  modelMapping: {
    'gpt-5-codex': 'claude-3-5-haiku-20241022'
  }
})

console.log('🧪 测试真实场景中的问题\n')

// 模拟第一个请求（成功）的数据
console.log('📦 测试1: 第一个请求成功的 message_start')
const firstRequestMessageStart = `event: message_start
data: {"type": "message_start", "message": {"id": "msg_2025101307553744a5998b9a", "type": "message", "role": "assistant", "content": [], "model": "claude-3-5-haiku-20241022", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 311, "output_tokens": 0}}}`

console.log('输入 chunk (部分):', firstRequestMessageStart.substring(0, 100) + '...')
const result1 = converter.convertStreamChunk(firstRequestMessageStart)
console.log('转换结果:', result1 ? '✅ 成功' : '❌ 失败 (null)')
if (result1) {
  console.log('结果长度:', result1.length)
  console.log('包含 response.created:', result1.includes('response.created'))
  console.log('包含 response.in_progress:', result1.includes('response.in_progress'))
}

console.log('\n' + '='.repeat(60) + '\n')

// 模拟第二个请求（失败）的数据 - 基于监控日志中的实际数据
console.log('📦 测试2: 第二个请求失败的 message_start')
const secondRequestMessageStart = `event: message_start
data: {"type": "message_start", "message": {"id": "msg_202510130755398c970c7179", "type": "message", "role": "assistant", "content": [], "model": "claude-3-5-haiku-20241022", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 311, "output_tokens": 0}}}`

console.log('输入 chunk (部分):', secondRequestMessageStart.substring(0, 100) + '...')
const result2 = converter.convertStreamChunk(secondRequestMessageStart)
console.log('转换结果:', result2 ? '✅ 成功' : '❌ 失败 (null)')
if (result2) {
  console.log('结果长度:', result2.length)
  console.log('包含 response.created:', result2.includes('response.created'))
  console.log('包含 response.in_progress:', result2.includes('response.in_progress'))
}

console.log('\n' + '='.repeat(60) + '\n')

// 测试多事件 chunk 的问题
console.log('📦 测试3: 多事件 chunk (可能导致解析问题)')
const multiEventChunk = `event: message_start
data: {"type": "message_start", "message": {"id": "msg_123", "model": "claude-3-5-haiku-20241022"}}
event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}`

console.log('输入 chunk (包含多个事件):')
console.log(multiEventChunk)
const result3 = converter.convertStreamChunk(multiEventChunk)
console.log('转换结果:', result3 ? '✅ 成功' : '❌ 失败 (null)')
if (result3) {
  console.log('结果长度:', result3.length)
} else {
  console.log('这可能是因为多事件 chunk 解析有问题')
}

console.log('\n🎯 问题分析:')
console.log('1. 如果第一个请求成功，第二个请求失败，说明问题可能与请求状态有关')
console.log('2. 如果多事件 chunk 解析失败，说明我们的事件解析修复还有问题')
console.log('3. 需要检查转换器实例的状态是否在多个请求之间被污染')