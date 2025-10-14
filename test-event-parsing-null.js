#!/usr/bin/env node

/**
 * 测试事件解析修复效果 - 专门针对 null 返回值问题
 */

const ClaudeToOpenAIResponsesConverter = require('./src/services/claudeToOpenAIResponses')

// 创建转换器实例
const converter = new ClaudeToOpenAIResponsesConverter({
  clientType: 'codex_cli',
  modelMapping: {
    'gpt-5-codex': 'claude-3-5-haiku-20241022'
  }
})

console.log('🧪 测试事件解析修复效果 - 专门针对 null 返回值问题\n')

// 测试 message_start 事件
console.log('📦 测试1: message_start 事件')
const messageStartChunk = `event: message_start
data: {"type": "message_start", "message": {"id": "msg_12345", "model": "claude-3-5-haiku-20241022"}}`

console.log('输入 chunk:')
console.log(messageStartChunk)
console.log('')

const result1 = converter.convertStreamChunk(messageStartChunk)
console.log('转换结果:')
if (result1) {
  console.log('✅ 成功:', result1.substring(0, 100) + '...')
  console.log('完整结果长度:', result1.length)
} else {
  console.log('❌ 失败: 返回 null')
}

console.log('\n' + '='.repeat(60) + '\n')

// 测试 content_block_start 事件（text类型）
console.log('📦 测试2: content_block_start 事件（text类型）')
const contentBlockStartChunk = `event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}`

console.log('输入 chunk:')
console.log(contentBlockStartChunk)
console.log('')

const result2 = converter.convertStreamChunk(contentBlockStartChunk)
console.log('转换结果:')
if (result2) {
  console.log('✅ 成功:', result2)
  console.log('完整结果长度:', result2.length)
} else {
  console.log('❌ 失败: 返回 null')
}

console.log('\n' + '='.repeat(60) + '\n')

// 测试 content_block_start 事件（非text类型）
console.log('📦 测试3: content_block_start 事件（非text类型）')
const contentBlockStartNonTextChunk = `event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "name": "test_tool"}}`

console.log('输入 chunk:')
console.log(contentBlockStartNonTextChunk)
console.log('')

const result3 = converter.convertStreamChunk(contentBlockStartNonTextChunk)
console.log('转换结果:')
if (result3) {
  console.log('✅ 成功:', result3)
  console.log('完整结果长度:', result3.length)
} else {
  console.log('❌ 失败: 返回 null')
}

console.log('\n' + '='.repeat(60) + '\n')

// 测试 content_block_start 事件（缺少content_block字段）
console.log('📦 测试4: content_block_start 事件（缺少content_block字段）')
const contentBlockStartMissingChunk = `event: content_block_start
data: {"type": "content_block_start", "index": 0}`

console.log('输入 chunk:')
console.log(contentBlockStartMissingChunk)
console.log('')

const result4 = converter.convertStreamChunk(contentBlockStartMissingChunk)
console.log('转换结果:')
if (result4) {
  console.log('✅ 成功:', result4)
  console.log('完整结果长度:', result4.length)
} else {
  console.log('❌ 失败: 返回 null')
}

console.log('\n🎯 测试总结:')
console.log('- 如果 message_start 返回 null，说明事件解析有问题')
console.log('- 如果 content_block_start（text类型）返回 null，说明条件判断有问题')
console.log('- 如果 content_block_start（非text类型）返回 null，这是正常的')
console.log('- 如果 content_block_start（缺少字段）返回 null，说明数据有问题')