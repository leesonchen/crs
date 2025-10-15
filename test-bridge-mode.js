#!/usr/bin/env node

/**
 * Comprehensive test script for Claude API bridge mode functionality
 * Tests both direct API calls and bridged responses
 */

const axios = require('axios')
const fs = require('fs')
const path = require('path')

// Test configuration
const config = {
  baseUrl: 'http://localhost:3000',
  apiKey: 'cr_f656ba569babc360a61823224ba69c4528a68a4f5db9ee48b5819e9ce1c995b9',
  timeout: 30000
}

// Test cases
const testCases = [
  {
    name: 'Direct Claude API Test (Non-Bridged)',
    endpoint: '/api/v1/messages',
    data: {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: 'Hello! Please respond with a simple greeting.'
        }
      ]
    },
    expectedBehavior: 'Direct Claude API call, should work normally'
  },
  {
    name: 'Bridged API Test - OpenAI to Claude (Standard)',
    endpoint: '/api/v1/chat/completions',
    data: {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: 'Hello! Please respond with a simple greeting.'
        }
      ],
      max_tokens: 100,
      stream: false
    },
    expectedBehavior: 'Should bridge to Claude API with OpenAI format'
  },
  {
    name: 'Bridged API Test - OpenAI to Claude (Streaming)',
    endpoint: '/api/v1/chat/completions',
    data: {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: 'Hello! Please respond with a simple greeting.'
        }
      ],
      max_tokens: 100,
      stream: true
    },
    expectedBehavior: 'Should bridge to Claude API with streaming OpenAI format'
  },
  {
    name: 'Bridged API Test - OpenAI Responses Format',
    endpoint: '/api/v1/responses',
    data: {
      model: 'gpt-4',
      input: [
        {
          role: 'user',
          content: 'Hello! Please respond with a simple greeting.'
        }
      ],
      max_output_tokens: 100
    },
    expectedBehavior: 'Should bridge using OpenAI Responses protocol'
  },
  {
    name: 'Bridged API Test - OpenAI Responses Format (Streaming)',
    endpoint: '/api/v1/responses',
    data: {
      model: 'gpt-4',
      input: [
        {
          role: 'user',
          content: 'Hello! Please respond with a simple greeting.'
        }
      ],
      max_output_tokens: 100,
      stream: true
    },
    expectedBehavior: 'Should bridge using OpenAI Responses protocol with streaming'
  }
]

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
}

function colorLog(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function logSuccess(message) {
  colorLog('green', `✅ ${message}`)
}

function logError(message) {
  colorLog('red', `❌ ${message}`)
}

function logInfo(message) {
  colorLog('blue', `ℹ️  ${message}`)
}

function logWarning(message) {
  colorLog('yellow', `⚠️  ${message}`)
}

function logTest(message) {
  colorLog('cyan', `🧪 ${message}`)
}

// Test functions
async function testDirectAPICall(testCase) {
  logInfo(`Testing: ${testCase.name}`)
  logInfo(`Expected: ${testCase.expectedBehavior}`)

  try {
    const response = await axios.post(
      `${config.baseUrl}${testCase.endpoint}`,
      testCase.data,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        timeout: config.timeout
      }
    )

    logSuccess(`Response received: ${response.status} ${response.statusText}`)
    logInfo(`Response data structure:`)

    // Analyze response structure
    if (response.data) {
      console.log(JSON.stringify(response.data, null, 2))

      // Check for common response fields
      if (response.data.id) logSuccess(`Response has ID: ${response.data.id}`)
      if (response.data.model) logInfo(`Model: ${response.data.model}`)
      if (response.data.choices) logInfo(`Choices array present: ${response.data.choices.length} items`)
      if (response.data.content) logInfo(`Content array present: ${response.data.content.length} items`)
      if (response.data.usage) logInfo(`Usage info: ${JSON.stringify(response.data.usage)}`)

      return { success: true, data: response.data, status: response.status }
    }
  } catch (error) {
    logError(`Request failed: ${error.message}`)
    if (error.response) {
      logError(`Response status: ${error.response.status}`)
      logError(`Response data: ${JSON.stringify(error.response.data, null, 2)}`)
      return { success: false, error: error.message, status: error.response.status, data: error.response.data }
    }
    return { success: false, error: error.message }
  }
}

async function testStreamingAPICall(testCase) {
  logInfo(`Testing streaming: ${testCase.name}`)
  logInfo(`Expected: ${testCase.expectedBehavior}`)

  try {
    const response = await axios.post(
      `${config.baseUrl}${testCase.endpoint}`,
      testCase.data,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'Accept': 'text/event-stream'
        },
        timeout: config.timeout,
        responseType: 'stream'
      }
    )

    logSuccess(`Streaming response initiated: ${response.status} ${response.statusText}`)

    return new Promise((resolve, reject) => {
      const chunks = []
      const events = []
      let responseComplete = false

      const timeout = setTimeout(() => {
        if (!responseComplete) {
          logWarning('Streaming test timeout - analyzing received chunks')
          resolve({
            success: chunks.length > 0,
            chunks,
            events,
            partial: true,
            totalChunks: chunks.length
          })
        }
      }, config.timeout)

      response.data.on('data', (chunk) => {
        const chunkStr = chunk.toString()
        chunks.push(chunkStr)

        // Parse SSE events
        const lines = chunkStr.split('\n')
        let currentEvent = {}

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6)
            if (data === '[DONE]') {
              events.push({ type: 'DONE', data })
              logSuccess('Received [DONE] event')
            } else {
              try {
                const parsed = JSON.parse(data)
                events.push({ type: 'data', data: parsed })

                // Log important events
                if (parsed.type) {
                  logInfo(`Event type: ${parsed.type}`)
                }
                if (parsed.choices && parsed.choices[0]?.delta?.content) {
                  logInfo(`Content delta: ${parsed.choices[0].delta.content}`)
                }
                if (parsed.delta && parsed.delta.type === 'text_delta') {
                  logInfo(`Text delta: ${parsed.delta.delta}`)
                }
              } catch (e) {
                logWarning(`Failed to parse JSON: ${data}`)
              }
            }
          } else if (line.startsWith('event: ')) {
            currentEvent.event = line.substring(7)
          }
        }
      })

      response.data.on('end', () => {
        clearTimeout(timeout)
        responseComplete = true

        logSuccess(`Streaming completed with ${chunks.length} chunks and ${events.length} events`)

        // Analyze received events
        const eventTypes = events.map(e => e.type || e.data?.type || 'unknown')
        logInfo(`Event sequence: ${eventTypes.join(' → ')}`)

        if (events.some(e => e.data?.type === 'response.completed' || e.data?.choices?.[0]?.finish_reason)) {
          logSuccess('Response completion event received')
        }

        if (events.some(e => e.type === 'DONE')) {
          logSuccess('[DONE] marker received')
        }

        resolve({
          success: true,
          chunks,
          events,
          totalChunks: chunks.length,
          totalEvents: events.length
        })
      })

      response.data.on('error', (error) => {
        clearTimeout(timeout)
        logError(`Stream error: ${error.message}`)
        reject(error)
      })
    })
  } catch (error) {
    logError(`Streaming request failed: ${error.message}`)
    if (error.response) {
      logError(`Response status: ${error.response.status}`)
      logError(`Response data: ${JSON.stringify(error.response.data, null, 2)}`)
    }
    return { success: false, error: error.message }
  }
}

async function runAllTests() {
  logTest('🚀 Starting Claude API Bridge Mode Test Suite')
  logInfo(`Target server: ${config.baseUrl}`)
  logInfo(`Using API key: ${config.apiKey.substring(0, 20)}...`)

  const results = []

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i]
    console.log(`\n${'='.repeat(80)}`)
    logTest(`Test ${i + 1}/${testCases.length}: ${testCase.name}`)
    console.log(`${'='.repeat(80)}`)

    let result
    if (testCase.data.stream) {
      result = await testStreamingAPICall(testCase)
    } else {
      result = await testDirectAPICall(testCase)
    }

    results.push({
      name: testCase.name,
      endpoint: testCase.endpoint,
      success: result.success,
      result
    })

    // Add delay between tests
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  // Summary
  console.log(`\n${'='.repeat(80)}`)
  logTest('🏁 Test Suite Summary')
  console.log(`${'='.repeat(80)}`)

  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  logSuccess(`Passed: ${passed}/${results.length}`)
  if (failed > 0) {
    logError(`Failed: ${failed}/${results.length}`)
  }

  console.log('\nDetailed Results:')
  results.forEach((result, index) => {
    const status = result.success ? '✅' : '❌'
    console.log(`${status} ${index + 1}. ${result.name}`)
    console.log(`   Endpoint: ${result.endpoint}`)
    if (!result.success) {
      console.log(`   Error: ${result.result.error}`)
    }
  })

  // Save results to file
  const reportPath = path.join(__dirname, `bridge-test-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config,
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      successRate: (passed / results.length * 100).toFixed(2) + '%'
    }
  }, null, 2))

  logInfo(`Detailed report saved to: ${reportPath}`)

  return results
}

// Main execution
if (require.main === module) {
  runAllTests().catch(error => {
    logError(`Test suite failed: ${error.message}`)
    console.error(error)
    process.exit(1)
  })
}

module.exports = { runAllTests, testCases, config }