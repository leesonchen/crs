#!/usr/bin/env node

const fetch = require('node-fetch')

async function testCompleteFlow() {
  console.log('🧪 测试完整的OpenAI Responses事件流程...')

  // 使用有效的API Key（从日志中找到的）
  const apiKey = 'cr_f656ba569babc360a61823224ba69c4528a68a4f5db9ee48b5819e9ce1c995b9'
  const baseUrl = 'http://localhost:3000'

  try {
    const response = await fetch(`${baseUrl}/openai/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5-codex',
        instructions: 'You are a helpful assistant. Keep responses brief.',
        input: [
          { type: 'user', content: 'Say hello' }
        ],
        stream: true
      })
    })

    if (response.ok) {
      console.log('✅ 请求成功，开始分析事件流...')

      let eventCount = 0
      let events = []

      response.body.on('data', (chunk) => {
        const data = chunk.toString()
        console.log(`📦 收到数据块 ${++eventCount}:`, data.substring(0, 100) + '...')

        // 解析SSE事件
        const lines = data.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.substring(6))
              events.push(eventData.type)
              console.log(`🎯 事件类型: ${eventData.type}`)
            } catch (e) {
              if (line.includes('[DONE]')) {
                events.push('[DONE]')
                console.log(`🏁 事件类型: [DONE]`)
              }
            }
          }
        }
      })

      response.body.on('end', () => {
        console.log('\n📊 事件流分析结果:')
        console.log(`总事件数: ${eventCount}`)
        console.log(`事件序列: ${events.join(' → ')}`)

        // 检查是否有标准OpenAI Responses事件
        const hasCreated = events.includes('response.created')
        const hasInProgress = events.includes('response.in_progress')
        const hasOutputItemAdded = events.includes('response.output_item.added')
        const hasOutputTextDelta = events.includes('response.output_text.delta')
        const hasCompleted = events.includes('response.completed')
        const hasDone = events.includes('[DONE]')

        console.log('\n🔍 事件完整性检查:')
        console.log(`response.created: ${hasCreated ? '✅' : '❌'}`)
        console.log(`response.in_progress: ${hasInProgress ? '✅' : '❌'}`)
        console.log(`response.output_item.added: ${hasOutputItemAdded ? '✅' : '❌'}`)
        console.log(`response.output_text.delta: ${hasOutputTextDelta ? '✅' : '❌'}`)
        console.log(`response.completed: ${hasCompleted ? '✅' : '❌'}`)
        console.log(`[DONE]: ${hasDone ? '✅' : '❌'}`)

        if (!hasCreated || !hasInProgress) {
          console.log('\n⚠️  问题诊断：缺少标准OpenAI Responses事件！')
          console.log('这可能导致客户端无法正确解析响应流。')
        }
      })

    } else {
      console.error('❌ 请求失败:', response.status, response.statusText)
      const errorText = await response.text()
      console.error('错误详情:', errorText)
    }
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
  }
}

testCompleteFlow()