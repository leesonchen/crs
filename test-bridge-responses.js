#!/usr/bin/env node

const http = require('http')

// Test OpenAI Responses to Claude bridge
function testBridge() {
  const data = JSON.stringify({
    model: 'gpt-5-codex',
    input: [
      {
        role: 'user',
        content: 'Say hello world'
      }
    ],
    max_output_tokens: 20,
    stream: true
  })

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/openai/responses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Authorization': 'Bearer cr_d212c6f20e77641fb690af22040ced636f6373c0fd0df37c11565755d72b7c04'
    }
  }

  console.log('🧪 Testing OpenAI Responses → Claude bridge (streaming)')
  console.log('📤 Request data:', data)

  const req = http.request(options, (res) => {
    console.log(`✅ Response status: ${res.statusCode}`)
    console.log(`📋 Response headers:`, res.headers)

    let responseText = ''
    let eventCount = 0

    res.on('data', (chunk) => {
      responseText += chunk.toString()
      eventCount++
      console.log(`📡 Chunk ${eventCount}:`, chunk.toString())
    })

    res.on('end', () => {
      console.log(`🏁 Response completed (${eventCount} chunks)`)
      console.log('📥 Full response:', responseText)
    })
  })

  req.on('error', (error) => {
    console.error('❌ Request error:', error.message)
  })

  req.write(data)
  req.end()
}

testBridge()