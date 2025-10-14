/**
 * 桥接服务集成测试
 *
 * 测试桥接服务是否正确集成了流程模拟功能
 * 验证 Codex CLI 桥接场景下的完整流程
 */

const fetch = require('node-fetch')
const { testFlowSimulator, mockClaudeResponse } = require('./flow-simulation-test')

// 测试配置
const TEST_CONFIG = {
  baseUrl: 'http://localhost:3000',
  apiKey: 'cr_f656ba569babc360a61823224ba69c4528a68a4f5db9ee48b5819e9ce1c995b9',
  testTimeout: 30000 // 30秒超时
}

async function testBridgeIntegration() {
  console.log('🌉 开始桥接服务集成测试...\n')

  try {
    // 1. 检查服务健康状态
    console.log('1️⃣ 检查服务健康状态')
    const healthResponse = await fetch(`${TEST_CONFIG.baseUrl}/health`)

    if (!healthResponse.ok) {
      throw new Error(`服务健康检查失败: ${healthResponse.status}`)
    }

    const healthData = await healthResponse.json()
    console.log('✅ 服务健康状态正常')
    console.log(`   Redis: ${healthData.redis ? '🟢 已连接' : '🔴 未连接'}`)
    console.log(`   运行时间: ${healthData.uptime || '未知'}`)

    // 2. 检查桥接配置
    console.log('\n2️⃣ 检查桥接配置')
    const bridgeConfigResponse = await fetch(`${TEST_CONFIG.baseUrl}/admin/bridge/config`)

    if (!bridgeConfigResponse.ok) {
      console.log('⚠️ 无法获取桥接配置，可能需要认证')
    } else {
      const bridgeConfig = await bridgeConfigResponse.json()
      console.log('✅ 桥接配置获取成功')
      console.log(`   Claude→OpenAI 启用: ${bridgeConfig.claudeToOpenai?.enabled || false}`)
      console.log(`   OpenAI→Claude 启用: ${bridgeConfig.openaiToClaude?.enabled || false}`)
    }

    // 3. 测试模型列表端点
    console.log('\n3️⃣ 测试模型列表端点')
    const modelsResponse = await fetch(`${TEST_CONFIG.baseUrl}/api/v1/models`, {
      headers: {
        'Authorization': `Bearer ${TEST_CONFIG.apiKey}`,
        'Content-Type': 'application/json'
      }
    })

    if (!modelsResponse.ok) {
      console.log(`⚠️ 模型列表请求失败: ${modelsResponse.status}`)
      console.log('可能原因：缺少Claude账户或API Key配置问题')
    } else {
      const modelsData = await modelsResponse.json()
      console.log('✅ 模型列表获取成功')
      console.log(`   可用模型数量: ${modelsData.data?.length || 0}`)
    }

    // 4. 创建测试请求（桥接模式）
    console.log('\n4️⃣ 测试桥接模式请求')
    console.log('发送测试请求到 Claude→OpenAI 桥接...')

    const testRequest = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        {
          role: 'user',
          content: '请简单分析一下系统架构设计的原则，用3-5个要点说明。'
        }
      ],
      max_tokens: 500,
      stream: true // 启用流式响应以测试流程模拟
    }

    const startTime = Date.now()
    let eventCount = 0
    let responseCompleted = false
    let receivedEvents = []

    const chatResponse = await fetch(`${TEST_CONFIG.baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_CONFIG.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testRequest)
    })

    if (!chatResponse.ok) {
      const errorText = await chatResponse.text()
      console.log(`❌ 桥接请求失败: ${chatResponse.status}`)
      console.log(`错误详情: ${errorText}`)
      return false
    }

    console.log('✅ 桥接请求已接受，开始接收流式响应...')
    console.log('📡 监听事件流:')

    // 处理流式响应
    const responseText = await chatResponse.text()
    const lines = responseText.split('\n').filter(line => line.trim())

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6)

        if (data === '[DONE]') {
          console.log(`🏁 事件流结束: ${eventCount} 个事件`)
          responseCompleted = true
          break
        }

        try {
          const event = JSON.parse(data)
          eventCount++
          receivedEvents.push(event.type)

          if (eventCount <= 10 || event.type.includes('created') || event.type.includes('completed')) {
            console.log(`   事件 ${eventCount}: ${event.type}`)
          }
        } catch (parseError) {
          console.log(`⚠️ 解析事件失败: ${data}`)
        }
      }
    }

    const duration = Date.now() - startTime

    // 5. 分析测试结果
    console.log('\n5️⃣ 分析测试结果')
    console.log(`✅ 请求完成`)
    console.log(`   总耗时: ${duration}ms`)
    console.log(`   接收事件: ${eventCount} 个`)
    console.log(`   响应完成: ${responseCompleted ? '✅' : '❌'}`)

    if (eventCount > 0) {
      console.log(`   事件类型分布:`)
      const eventTypes = {}
      receivedEvents.forEach(type => {
        eventTypes[type] = (eventTypes[type] || 0) + 1
      })

      Object.entries(eventTypes).forEach(([type, count]) => {
        console.log(`     ${type}: ${count} 次`)
      })

      // 检查是否有流程模拟的特征
      const hasReasoningEvents = receivedEvents.some(type => type.includes('reasoning'))
      const hasDeltaEvents = receivedEvents.some(type => type.includes('delta'))
      const hasCompletionEvents = receivedEvents.some(type => type.includes('completed'))

      console.log(`\n🎭 流程模拟特征检测:`)
      console.log(`   推理事件: ${hasReasoningEvents ? '✅ 检测到' : '❌ 未检测到'}`)
      console.log(`   增量事件: ${hasDeltaEvents ? '✅ 检测到' : '❌ 未检测到'}`)
      console.log(`   完成事件: ${hasCompletionEvents ? '✅ 检测到' : '❌ 未检测到'}`)

      if (eventCount >= 20) {
        console.log(`🎉 事件数量充足 (${eventCount} >= 20)，流程模拟可能已启用`)
      } else {
        console.log(`⚠️ 事件数量较少 (${eventCount} < 20)，可能使用的是简单映射模式`)
      }
    }

    return {
      success: true,
      eventCount,
      responseCompleted,
      duration,
      hasFlowSimulation: eventCount >= 20
    }

  } catch (error) {
    console.error('❌ 集成测试失败:', error.message)
    return {
      success: false,
      error: error.message
    }
  }
}

async function runIntegrationTest() {
  console.log('🚀 启动桥接服务集成测试')
  console.log('=' .repeat(60))

  const result = await testBridgeIntegration()

  console.log('=' .repeat(60))

  if (result.success) {
    console.log('✅ 集成测试完成')
    console.log(`📊 测试结果:`)
    console.log(`   • 事件数量: ${result.eventCount}`)
    console.log(`   • 响应完成: ${result.responseCompleted ? '是' : '否'}`)
    console.log(`   • 流程模拟: ${result.hasFlowSimulation ? '已启用' : '可能未启用'}`)
    console.log(`   • 响应时间: ${result.duration}ms`)

    if (result.hasFlowSimulation) {
      console.log('\n🎉 流程模拟功能正常工作！')
      console.log('💡 Codex CLI 应该能接收到完整的事件序列，不再出现 stream disconnected 错误。')
    } else {
      console.log('\n⚠️ 流程模拟可能未启用，需要检查配置。')
    }
  } else {
    console.log('❌ 集成测试失败')
    console.log(`错误: ${result.error}`)
    console.log('\n💡 可能的原因:')
    console.log('   • 服务未启动或端口不正确')
    console.log('   • API Key 无效或过期')
    console.log('   • 缺少可用的 Claude 账户')
    console.log('   • 网络连接问题')
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  runIntegrationTest().catch(console.error)
}

module.exports = { testBridgeIntegration, runIntegrationTest }