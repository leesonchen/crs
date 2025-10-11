#!/usr/bin/env node

/**
 * 桥接功能测试脚本
 * 专门测试 Codex CLI 格式请求到 Claude 账户的桥接功能
 */

const axios = require('axios')

// 测试配置
const config = {
  baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
  apiKey: process.env.TEST_API_KEY || 'cr_1760075813498_85d83bdde6bf673d24d53f8a46778be9',
  timeout: 30000
}

// 创建 axios 实例
const httpClient = axios.create({
  baseURL: config.baseURL,
  timeout: config.timeout,
  headers: {
    'Content-Type': 'application/json'
  }
})

/**
 * 测试 Codex CLI 格式请求（应该桥接到 Claude）
 */
async function testCodexToClaudeBridge() {
  console.log('🌉 测试 Codex CLI → Claude 桥接功能')
  console.log('='.repeat(60))

  try {
    console.log('📤 发送 Codex CLI 格式请求...')

    // Codex CLI 使用 OpenAI Responses 格式
    const requestBody = {
      model: 'gpt-5', // 这个模型应该桥接到 Claude
      input: [
        {
          role: 'user',
          content: 'Hello, this is a bridge test from Codex CLI to Claude. Please respond briefly.'
        }
      ],
      truncation: 'auto',
      tools: [
        {
          type: 'web_search'
        }
      ]
    }

    console.log('🔍 请求详情:')
    console.log(`  模型: ${requestBody.model}`)
    console.log(`  内容: ${requestBody.input[0].content}`)
    console.log(`  API Key: ${config.apiKey.substring(0, 10)}...`)

    // 发送请求到 OpenAI Responses 端点
    const response = await httpClient.post('/openai/responses', requestBody, {
      headers: {
        'x-api-key': config.apiKey
      }
    })

    console.log('✅ 请求成功!')
    console.log('📥 响应详情:')
    console.log(`  状态码: ${response.status}`)
    console.log(`  响应模型: ${response.data.model}`)
    console.log(`  响应ID: ${response.data.id}`)

    // 检查是否真正发生了桥接
    const isBridged =
      response.data.model &&
      (response.data.model.startsWith('claude-') || response.data.model.includes('claude'))

    if (isBridged) {
      console.log('🌉 桥接成功: 请求已从 OpenAI 格式桥接到 Claude 账户!')
      console.log(`  原始请求模型: gpt-5`)
      console.log(`  实际使用模型: ${response.data.model}`)
    } else {
      console.log('⚠️  可能未发生桥接:')
      console.log(`  响应模型: ${response.data.model}`)
    }

    // 显示响应内容
    if (response.data.output && response.data.output.length > 0) {
      console.log('💬 响应内容:')
      response.data.output.forEach((item) => {
        if (item.content) {
          console.log(`  ${item.content}`)
        }
      })
    }

    // 显示使用统计
    if (response.data.usage) {
      console.log('📊 使用统计:')
      console.log(`  输入 Token: ${response.data.usage.input_tokens || 'N/A'}`)
      console.log(`  输出 Token: ${response.data.usage.output_tokens || 'N/A'}`)
      console.log(`  总计 Token: ${response.data.usage.total_tokens || 'N/A'}`)
    }

    return {
      success: true,
      bridged: isBridged,
      model: response.data.model,
      usage: response.data.usage
    }
  } catch (error) {
    console.error('❌ 请求失败!')

    if (error.response) {
      console.error(`  状态码: ${error.response.status}`)
      console.error(
        `  错误信息: ${error.response.data?.error?.message || error.response.data?.message || JSON.stringify(error.response.data)}`
      )

      // 检查是否是原来的错误
      if (
        error.response.data?.error?.message?.includes(
          'No available OpenAI accounts support the requested model'
        )
      ) {
        console.error('🔴 原始错误仍存在: 桥接功能未正常工作')
        return {
          success: false,
          error: 'Bridge not working',
          details: error.response.data
        }
      }
    } else {
      console.error(`  网络错误: ${error.message}`)
    }

    return {
      success: false,
      error: error.message,
      details: error.response?.data || null
    }
  }
}

/**
 * 测试原生 Claude 格式请求（作为对照）
 */
async function testNativeClaude() {
  console.log('\n🧪 测试原生 Claude 格式请求（对照实验）')
  console.log('-'.repeat(60))

  try {
    const requestBody = {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: 'Hello, this is a native Claude request. Please respond briefly.'
        }
      ]
    }

    const response = await httpClient.post('/api/v1/messages', requestBody, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      }
    })

    console.log('✅ 原生 Claude 请求成功!')
    console.log(`  使用模型: ${response.data.model}`)

    return {
      success: true,
      model: response.data.model
    }
  } catch (error) {
    console.error('❌ 原生 Claude 请求失败!')
    console.error(`  错误: ${error.response?.data?.error?.message || error.message}`)

    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * 主测试函数
 */
async function runBridgeTest() {
  console.log('🚀 开始桥接功能测试')
  console.log('⏰ 测试时间:', new Date().toISOString())
  console.log('🔗 服务地址:', config.baseURL)
  console.log('')

  // 测试1: Codex CLI → Claude 桥接
  const bridgeResult = await testCodexToClaudeBridge()

  // 测试2: 原生 Claude 请求（对照）
  const claudeResult = await testNativeClaude()

  // 总结测试结果
  console.log('\n📋 测试结果总结')
  console.log('='.repeat(60))
  console.log(`桥接测试 (Codex → Claude): ${bridgeResult.success ? '✅ 成功' : '❌ 失败'}`)
  if (bridgeResult.bridged) {
    console.log(`  桥接状态: ✅ 已桥接到 ${bridgeResult.model}`)
  } else if (bridgeResult.success) {
    console.log(`  桥接状态: ⚠️  未检测到桥接`)
  } else {
    console.log(`  桥接状态: ❌ 桥接失败 - ${bridgeResult.error}`)
  }

  console.log(`原生 Claude 测试: ${claudeResult.success ? '✅ 成功' : '❌ 失败'}`)

  if (bridgeResult.success && bridgeResult.bridged) {
    console.log('\n🎉 桥接功能验证成功!')
    console.log('Codex CLI 格式的请求已能够正确桥接到 Claude 账户')
  } else if (bridgeResult.success && !bridgeResult.bridged) {
    console.log('\n⚠️  桥接功能可能未正常启用')
    console.log('请求成功了，但没有检测到桥换行为')
  } else {
    console.log('\n❌ 桥接功能验证失败')
    console.log('需要进一步检查桥接配置和实现')
  }
}

// 运行测试
if (require.main === module) {
  runBridgeTest().catch(console.error)
}

module.exports = { runBridgeTest, testCodexToClaudeBridge, testNativeClaude }
