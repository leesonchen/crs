#!/usr/bin/env node

/**
 * Simple bridge mode test script
 */

const Redis = require('ioredis')
const config = require('./config/config.js')
const axios = require('axios')

// Create Redis client
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  db: config.redis.db
})

async function getApiKeys() {
  try {
    const keys = await redis.keys('api_key:*')
    const apiKeys = []

    for (const key of keys) {
      if (!key.includes(':hash:')) {
        const data = await redis.get(key)
        if (data) {
          const keyData = JSON.parse(data)
          apiKeys.push({
            id: key.replace('api_key:', ''),
            name: keyData.name || 'Unknown',
            key: keyData.key || 'Unknown',
            permissions: keyData.permissions || 'all'
          })
        }
      }
    }

    return apiKeys
  } catch (error) {
    console.error('Error getting API keys:', error)
    return []
  }
}

async function testBridgeEndpoint(apiKey, endpoint, data, description) {
  console.log(`\n🧪 Testing: ${description}`)
  console.log(`🔗 Endpoint: ${endpoint}`)
  console.log(`📤 Data:`, JSON.stringify(data, null, 2))

  try {
    const response = await axios.post(`http://localhost:3000${endpoint}`, data, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 15000
    })

    console.log(`✅ Success: ${response.status} ${response.statusText}`)
    console.log('📥 Response:', JSON.stringify(response.data, null, 2))
    return { success: true, data: response.data, status: response.status }
  } catch (error) {
    console.log(`❌ Failed: ${error.message}`)
    if (error.response) {
      console.log(`📊 Status: ${error.response.status}`)
      console.log('📥 Error Response:', JSON.stringify(error.response.data, null, 2))
      return { success: false, error: error.message, status: error.response.status, data: error.response.data }
    }
    return { success: false, error: error.message }
  }
}

async function testStreamingEndpoint(apiKey, endpoint, data, description) {
  console.log(`\n🌊 Testing streaming: ${description}`)
  console.log(`🔗 Endpoint: ${endpoint}`)
  console.log(`📤 Data:`, JSON.stringify(data, null, 2))

  try {
    const response = await axios.post(`http://localhost:3000${endpoint}`, data, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream'
      },
      timeout: 15000,
      responseType: 'stream'
    })

    console.log(`✅ Stream initiated: ${response.status} ${response.statusText}`)

    return new Promise((resolve, reject) => {
      const chunks = []
      const events = []

      const timeout = setTimeout(() => {
        console.log('⏰ Stream timeout reached, analyzing what we received...')
        resolve({
          success: chunks.length > 0,
          chunks,
          events,
          partial: true,
          totalChunks: chunks.length
        })
      }, 10000)

      response.data.on('data', (chunk) => {
        const chunkStr = chunk.toString()
        chunks.push(chunkStr)
        console.log(`📦 Chunk: ${chunkStr.substring(0, 100)}${chunkStr.length > 100 ? '...' : ''}`)

        // Parse SSE events
        const lines = chunkStr.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6)
            if (data === '[DONE]') {
              events.push({ type: 'DONE' })
              console.log('🏁 Received [DONE] event')
            } else {
              try {
                const parsed = JSON.parse(data)
                events.push({ type: 'data', data: parsed })
                console.log(`📊 Event: ${parsed.type || 'unknown'}`)
              } catch (e) {
                console.log(`⚠️  Invalid JSON: ${data}`)
              }
            }
          }
        }
      })

      response.data.on('end', () => {
        clearTimeout(timeout)
        console.log(`🏁 Stream completed: ${chunks.length} chunks, ${events.length} events`)
        resolve({
          success: true,
          chunks,
          events,
          totalChunks: chunks.length
        })
      })

      response.data.on('error', (error) => {
        clearTimeout(timeout)
        console.log(`❌ Stream error: ${error.message}`)
        reject(error)
      })
    })
  } catch (error) {
    console.log(`❌ Stream failed: ${error.message}`)
    if (error.response) {
      console.log(`📊 Status: ${error.response.status}`)
      console.log('📥 Error Response:', JSON.stringify(error.response.data, null, 2))
    }
    return { success: false, error: error.message }
  }
}

async function runTests() {
  console.log('🚀 Starting Simple Bridge Mode Test')
  console.log('=====================================')

  // Use the newly created test API key
  const testApiKey = 'cr_3615631dfa327737d3881a508b2aae25f9b6f09bbe5d18d59051e9983a5b68d4'
  console.log(`\n🔧 Using API key: ${testApiKey.substring(0, 20)}...`)

  const results = []

  // Test 1: Direct Claude API
  const test1 = await testBridgeEndpoint(
    testApiKey,
    '/api/v1/messages',
    {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 50,
      messages: [
        { role: 'user', content: 'Say hello' }
      ]
    },
    'Direct Claude API (non-bridge)'
  )
  results.push({ name: 'Direct Claude API', ...test1 })

  // Test 2: OpenAI to Claude Bridge (non-streaming)
  const test2 = await testBridgeEndpoint(
    testApiKey,
    '/openai/claude/v1/chat/completions',
    {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Say hello' }
      ],
      max_tokens: 50,
      stream: false
    },
    'OpenAI to Claude Bridge (non-streaming)'
  )
  results.push({ name: 'OpenAI→Claude Bridge', ...test2 })

  // Test 3: OpenAI to Claude Bridge (streaming)
  const test3 = await testStreamingEndpoint(
    testApiKey,
    '/openai/claude/v1/chat/completions',
    {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'Say hello' }
      ],
      max_tokens: 50,
      stream: true
    },
    'OpenAI to Claude Bridge (streaming)'
  )
  results.push({ name: 'OpenAI→Claude Bridge (streaming)', ...test3 })

  // Test 4: OpenAI Responses to Claude Bridge (non-streaming)
  const test4 = await testBridgeEndpoint(
    testApiKey,
    '/api/v1/responses',
    {
      model: 'gpt-4',
      input: [
        { role: 'user', content: 'Say hello' }
      ],
      max_output_tokens: 50,
      stream: false
    },
    'OpenAI Responses to Claude Bridge (non-streaming)'
  )
  results.push({ name: 'OpenAI Responses→Claude Bridge', ...test4 })

  // Test 5: OpenAI Responses to Claude Bridge (streaming)
  const test5 = await testStreamingEndpoint(
    testApiKey,
    '/api/v1/responses',
    {
      model: 'gpt-4',
      input: [
        { role: 'user', content: 'Say hello' }
      ],
      max_output_tokens: 50,
      stream: true
    },
    'OpenAI Responses to Claude Bridge (streaming)'
  )
  results.push({ name: 'OpenAI Responses→Claude Bridge (streaming)', ...test5 })

  // Summary
  console.log('\n🏁 Test Results Summary')
  console.log('=======================')
  results.forEach((result, index) => {
    const status = result.success ? '✅' : '❌'
    const details = result.totalChunks ? ` (${result.totalChunks} chunks)` : ''
    console.log(`${status} ${index + 1}. ${result.name}${details}`)
    if (!result.success && result.error) {
      console.log(`    Error: ${result.error}`)
    }
  })

  const passed = results.filter(r => r.success).length
  console.log(`\n📊 Overall: ${passed}/${results.length} tests passed`)

  // Close Redis connection
  await redis.quit().catch(() => {}) // Ignore errors
}

runTests().catch(console.error)