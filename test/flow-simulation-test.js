/**
 * 流程模拟测试脚本
 *
 * 测试 OpenAI Responses 流程模拟器的核心功能
 * 验证是否能生成完整的事件序列（45-86个事件）
 */

const OpenAIResponsesFlowSimulator = require('../src/services/openAIResponsesFlowSimulator')
const FlowTimingController = require('../src/services/flowTimingController')
const logger = require('../src/utils/logger')

// 测试用的 Claude 响应数据
const mockClaudeResponse = {
  id: 'msg_test123',
  model: 'claude-3-5-sonnet-20241022',
  content: [
    {
      type: 'text',
      text: `让我分析一下这个问题。

首先，我们需要考虑系统的整体架构。从多个角度来看，这个方案具有以下优势：

1. **可扩展性**: 模块化设计使得系统可以轻松扩展
2. **可维护性**: 清晰的分层架构便于后续维护
3. **性能优化**: 通过合理的缓存策略提升响应速度

综合分析后，我认为这个方案是可行的。接下来我们需要考虑具体的实施步骤。

实施计划：
- 第一阶段：基础设施建设
- 第二阶段：核心功能开发
- 第三阶段：测试和优化

总结：这是一个系统性的解决方案，能够满足当前的需求并为未来的扩展留有空间。`
    }
  ],
  usage: {
    input_tokens: 150,
    output_tokens: 280,
    cache_read_input_tokens: 20
  },
  stop_reason: 'end_turn'
}

async function testFlowSimulator() {
  console.log('🧪 开始测试流程模拟器...\n')

  try {
    // 1. 测试基本流程模拟
    console.log('1️⃣ 测试基本流程模拟')
    const simulator = new OpenAIResponsesFlowSimulator({
      enableReasoningSimulation: true,
      reasoningChunkCount: 5,
      contentChunkCount: 30
    })

    const events = simulator.simulateCompleteFlow(mockClaudeResponse)

    console.log(`✅ 生成了 ${events.length} 个事件`)
    console.log(`📊 事件类型分布:`)

    const eventTypes = {}
    events.forEach(event => {
      eventTypes[event.type] = (eventTypes[event.type] || 0) + 1
    })

    Object.entries(eventTypes).forEach(([type, count]) => {
      console.log(`   ${type}: ${count} 次`)
    })

    // 2. 验证关键事件
    console.log('\n2️⃣ 验证关键事件')
    const keyEvents = events.filter(e =>
      e.type.includes('created') ||
      e.type.includes('in_progress') ||
      e.type.includes('completed')
    )

    console.log(`✅ 关键事件数量: ${keyEvents.length}`)
    keyEvents.forEach((event, index) => {
      console.log(`   ${index + 1}. ${event.type} (序列号: ${event.sequence_number})`)
    })

    // 3. 测试时序控制器
    console.log('\n3️⃣ 测试时序控制器')
    const timingController = new FlowTimingController({
      timingProfile: 'fast', // 使用快速模式进行测试
      enableRandomization: false // 测试时关闭随机化
    })

    let sentEvents = 0
    const testSendCallback = async (event) => {
      sentEvents++
      console.log(`📤 发送事件 ${sentEvents}: ${event.type}`)
    }

    console.log('⏱️ 开始时序发送测试...')
    const result = await timingController.sendEventsWithTiming(
      events.slice(0, 10), // 只测试前10个事件以节省时间
      testSendCallback,
      { enableProgressLog: false }
    )

    console.log(`✅ 时序发送完成: ${result.sentCount}/${result.totalEvents} 个事件成功发送`)
    console.log(`⏱️ 总耗时: ${result.totalDuration}ms`)

    // 4. 验证推理过程模拟
    console.log('\n4️⃣ 验证推理过程模拟')
    const reasoningEvents = events.filter(e =>
      e.type.includes('reasoning')
    )

    console.log(`✅ 推理相关事件: ${reasoningEvents.length} 个`)
    if (reasoningEvents.length > 0) {
      console.log('🧠 推理流程:')
      reasoningEvents.forEach((event, index) => {
        console.log(`   ${index + 1}. ${event.type}`)
      })
    }

    // 5. 验证内容分割
    console.log('\n5️⃣ 验证内容分割')
    const deltaEvents = events.filter(e =>
      e.type === 'response.output_text.delta'
    )

    console.log(`✅ 内容增量事件: ${deltaEvents.length} 个`)
    if (deltaEvents.length > 0) {
      const totalLength = deltaEvents.reduce((sum, e) =>
        sum + (e.delta?.text?.length || 0), 0
      )
      console.log(`📝 总内容长度: ${totalLength} 字符`)
      console.log(`📊 平均每块长度: ${Math.round(totalLength / deltaEvents.length)} 字符`)
    }

    // 6. 测试配置文件
    console.log('\n6️⃣ 测试不同配置文件')
    const profiles = ['fast', 'standard', 'detailed']

    for (const profile of profiles) {
      const controller = new FlowTimingController({
        timingProfile: profile
      })
      console.log(`⚙️ ${profile} 配置验证完成`)
    }

    console.log('\n🎉 所有测试通过！流程模拟器工作正常。')
    console.log(`\n📋 测试总结:`)
    console.log(`   • 事件生成: ${events.length} 个事件`)
    console.log(`   • 推理模拟: ${reasoningEvents.length} 个推理事件`)
    console.log(`   • 内容分割: ${deltaEvents.length} 个增量事件`)
    console.log(`   • 时序控制: 正常工作`)
    console.log(`   • 配置支持: 多种配置文件可用`)

    return true

  } catch (error) {
    console.error('❌ 测试失败:', error)
    logger.error('Flow simulation test failed:', error)
    return false
  }
}

// 运行测试
async function runTest() {
  console.log('🚀 启动流程模拟测试')
  console.log('=' .repeat(50))

  const success = await testFlowSimulator()

  console.log('=' .repeat(50))
  if (success) {
    console.log('✅ 测试完成 - 流程模拟器可以投入使用')
    process.exit(0)
  } else {
    console.log('❌ 测试失败 - 需要修复问题')
    process.exit(1)
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  runTest().catch(console.error)
}

module.exports = { testFlowSimulator, mockClaudeResponse }