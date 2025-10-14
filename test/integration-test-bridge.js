/**
 * 集成测试：验证修复后的桥接功能
 * 测试实际的服务端到端功能
 */

const http = require('http')

async function testBridgeWithRealRequest() {
  console.log('🧪 开始集成测试：验证修复后的桥接功能\n')

  const testData = {
    model: 'claude-3-5-haiku-20241022',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '请简单回答：什么是人工智能？用一句话回答。'
          }
        ]
      }
    ],
    stream: true,
    max_output_tokens: 100
  }

  const postData = JSON.stringify(testData)

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/openai/responses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer cr_f656ba569babc360a61823224ba69c4528a68a4f5db9ee48b5819e9ce1c995b9',
      'Content-Length': Buffer.byteLength(postData),
      'User-Agent': 'codex_cli_rs/0.46.0 (Ubuntu 22.4.0; x86_64) xterm-256color'
    }
  }

  return new Promise((resolve, reject) => {
    console.log('📡 发送测试请求到桥接服务...')

    const req = http.request(options, (res) => {
      console.log(`✅ 收到响应，状态码: ${res.statusCode}`)

      let eventData = []
      let eventCount = 0
      let responseStarted = false
      let responseCompleted = false
      let hasError = false

      res.on('data', (chunk) => {
        const data = chunk.toString()
        process.stdout.write('.') // 显示进度

        // 解析 SSE 事件
        const lines = data.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            if (dataStr === '[DONE]') {
              responseCompleted = true
              continue
            }

            try {
              const event = JSON.parse(dataStr)
              eventCount++
              eventData.push(event.type)

              if (event.type === 'response.created') {
                responseStarted = true
              } else if (event.type === 'response.completed') {
                responseCompleted = true
              } else if (event.type && event.type.includes('error')) {
                hasError = true
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      })

      res.on('end', () => {
        console.log('\n\n📊 测试结果分析:')
        console.log(`   响应状态码: ${res.statusCode}`)
        console.log(`   接收事件数量: ${eventCount}`)
        console.log(`   响应开始: ${responseStarted ? '✅' : '❌'}`)
        console.log(`   响应完成: ${responseCompleted ? '✅' : '❌'}`)
        console.log(`   有错误: ${hasError ? '❌' : '✅'}`)

        if (eventData.length > 0) {
          console.log('\n📋 事件类型分布:')
          const eventTypes = {}
          eventData.forEach(type => {
            eventTypes[type] = (eventTypes[type] || 0) + 1
          })

          Object.entries(eventTypes).forEach(([type, count]) => {
            console.log(`   ${type}: ${count} 次`)
          })
        }

        // 判断测试是否成功
        const isSuccess = res.statusCode === 200 && responseStarted && responseCompleted && !hasError

        if (isSuccess) {
          console.log('\n🎉 集成测试通过！桥接功能正常工作')
          if (eventCount >= 10) {
            console.log('✅ 事件数量充足，流程模拟可能已启用')
          } else {
            console.log('⚠️ 事件数量较少，可能使用的是传统模式')
          }
        } else {
          console.log('\n❌ 集成测试失败')
          if (res.statusCode !== 200) {
            console.log(`   HTTP 状态码错误: ${res.statusCode}`)
          }
          if (!responseStarted) {
            console.log('   缺少 response.created 事件')
          }
          if (!responseCompleted) {
            console.log('   缺少 response.completed 事件')
          }
          if (hasError) {
            console.log('   响应中包含错误事件')
          }
        }

        resolve({
          success: isSuccess,
          statusCode: res.statusCode,
          eventCount,
          responseStarted,
          responseCompleted,
          hasError,
          eventData
        })
      })
    })

    req.on('error', (error) => {
      console.error('❌ 请求错误:', error.message)
      reject(error)
    })

    // 发送请求数据
    req.write(postData)
    req.end()
  })
}

async function runIntegrationTest() {
  console.log('🚀 启动桥接功能集成测试')
  console.log('=' .repeat(60))

  try {
    const result = await testBridgeWithRealRequest()

    console.log('=' .repeat(60))
    console.log('📋 测试总结:')

    if (result.success) {
      console.log('✅ 集成测试成功 - 桥接功能工作正常')
      console.log(`   事件数量: ${result.eventCount}`)
      console.log('   预期效果: Codex CLI 应该能正常接收响应')
    } else {
      console.log('❌ 集成测试失败 - 需要进一步调试')
      console.log('   可能原因: 服务配置问题或 Claude 账户不可用')
    }
  } catch (error) {
    console.error('❌ 集成测试异常:', error.message)
    console.log('\n💡 可能的原因:')
    console.log('   • 服务未启动或端口不正确')
    console.log('   • 网络连接问题')
    console.log('   • API Key 或账户配置问题')
  }
}

// 运行测试
if (require.main === module) {
  runIntegrationTest()
}

module.exports = { testBridgeWithRealRequest, runIntegrationTest }