/**
 * Flow Timing Controller
 *
 * 控制 OpenAI Responses 事件序列的发送时序和节奏
 * 确保事件按照合理的间隔发送，模拟真实的 OpenAI 响应时序
 */

const logger = require('../utils/logger')

class FlowTimingController {
  constructor(options = {}) {
    // 基础时序配置
    this.baseDelay = options.baseDelay || 50 // 基础延迟 50ms
    this.reasoningDelay = options.reasoningDelay || 100 // 推理延迟 100ms
    this.contentDelay = options.contentDelay || 30 // 内容延迟 30ms
    this.completionDelay = options.completionDelay || 80 // 完成延迟 80ms

    // 高级配置
    this.enableRandomization = options.enableRandomization !== false
    this.randomizationRange = options.randomizationRange || 0.2 // 20% 随机化
    this.adaptiveTiming = options.adaptiveTiming || true // 自适应时序

    // 性能配置
    this.maxDelay = options.maxDelay || 500 // 最大延迟 500ms
    this.minDelay = options.minDelay || 10 // 最小延迟 10ms

    logger.info(`⏱️ [TimingController] Initialized`, {
      baseDelay: this.baseDelay,
      reasoningDelay: this.reasoningDelay,
      contentDelay: this.contentDelay,
      enableRandomization: this.enableRandomization,
      adaptiveTiming: this.adaptiveTiming
    })
  }

  /**
   * 计算事件的发送延迟
   * @param {Object} event - 事件对象
   * @param {Number} eventIndex - 事件索引
   * @param {Number} totalEvents - 总事件数
   * @returns {Number} 延迟时间（毫秒）
   */
  calculateEventDelay(event, eventIndex, totalEvents) {
    let { baseDelay } = this

    switch (event.type) {
      case 'response.created':
        baseDelay = 0 // 第一个事件立即发送
        break

      case 'response.in_progress':
        baseDelay = this.baseDelay * 1.2
        break

      case 'response.reasoning_summary_part.added':
        baseDelay = this.reasoningDelay * 0.8
        break

      case 'response.reasoning_summary_text.delta':
        // 推理文本增量 - 稍慢的节奏，模拟思考过程
        baseDelay = this.reasoningDelay
        if (this.adaptiveTiming) {
          // 根据事件在推理序列中的位置调整延迟
          const reasoningProgress = eventIndex / totalEvents
          baseDelay *= 1 + reasoningProgress * 0.5 // 逐渐加快
        }
        break

      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary_part.done':
        baseDelay = this.reasoningDelay * 1.5
        break

      case 'response.output_item.done':
        baseDelay = this.baseDelay * 0.8
        break

      case 'response.output_item.added':
        baseDelay = this.baseDelay * 1.1
        break

      case 'response.content_part.added':
        baseDelay = this.contentDelay
        break

      case 'response.output_text.delta':
        // 主要内容文本增量 - 较快的节奏
        baseDelay = this.contentDelay
        if (this.adaptiveTiming) {
          // 根据总体进度调整节奏
          const overallProgress = eventIndex / totalEvents
          if (overallProgress > 0.8) {
            baseDelay *= 0.7 // 快速收尾
          } else if (overallProgress > 0.5) {
            baseDelay *= 0.9 // 稍微加快
          }
        }
        break

      case 'response.output_text.done':
      case 'response.content_part.done':
        baseDelay = this.contentDelay * 1.2
        break

      case 'response.completed':
        baseDelay = this.completionDelay
        break

      default:
        baseDelay = this.baseDelay
        break
    }

    // 应用随机化
    if (this.enableRandomization && baseDelay > 0) {
      baseDelay = this.applyRandomization(baseDelay)
    }

    // 确保延迟在合理范围内
    return Math.max(this.minDelay, Math.min(this.maxDelay, baseDelay))
  }

  /**
   * 应用随机化
   * @param {Number} delay - 基础延迟
   * @returns {Number} 随机化后的延迟
   */
  applyRandomization(delay) {
    const range = delay * this.randomizationRange
    const randomization = (Math.random() - 0.5) * 2 * range
    return Math.round(delay + randomization)
  }

  /**
   * 按时序发送事件流
   * @param {Array} events - 事件数组
   * @param {Function} sendCallback - 发送回调函数
   * @param {Object} options - 选项
   * @returns {Promise} 发送完成的 Promise
   */
  async sendEventsWithTiming(events, sendCallback, options = {}) {
    const {
      enableProgressLog = true,
      progressInterval = 10, // 每 N 个事件记录一次进度
      onProgress = null,
      onError = null
    } = options

    logger.info(`🚀 [TimingController] Starting timed event stream`, {
      totalEvents: events.length,
      enableProgressLog,
      adaptiveTiming: this.adaptiveTiming
    })

    const startTime = Date.now()
    let sentCount = 0
    let errorCount = 0

    try {
      for (let i = 0; i < events.length; i++) {
        const event = events[i]
        const delay = this.calculateEventDelay(event, i, events.length)

        try {
          // 发送事件
          await sendCallback(event)
          sentCount++

          // 进度日志
          if (enableProgressLog && (i % progressInterval === 0 || i === events.length - 1)) {
            const progress = (((i + 1) / events.length) * 100).toFixed(1)
            const elapsed = Date.now() - startTime
            const rate = (i + 1) / (elapsed / 1000).toFixed(1)

            logger.debug(
              `📊 [TimingController] Progress: ${progress}% (${i + 1}/${events.length})`,
              {
                event: event.type,
                delay: `${delay}ms`,
                elapsed: `${elapsed}ms`,
                rate: `${rate} events/sec`
              }
            )
          }

          // 进度回调
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: events.length,
              event,
              progress: (((i + 1) / events.length) * 100).toFixed(1)
            })
          }

          // 等待延迟（除非是最后一个事件）
          if (i < events.length - 1 && delay > 0) {
            await this.sleep(delay)
          }
        } catch (sendError) {
          errorCount++
          logger.error(`❌ [TimingController] Failed to send event:`, {
            eventIndex: i,
            eventType: event.type,
            error: sendError.message
          })

          if (onError) {
            const shouldContinue = await onError(sendError, event, i)
            if (!shouldContinue) {
              logger.warn(`⏹️ [TimingController] Stopping event stream due to error`)
              break
            }
          }
        }
      }

      const totalDuration = Date.now() - startTime
      const averageRate = (sentCount / (totalDuration / 1000)).toFixed(1)

      logger.info(`✅ [TimingController] Event stream completed`, {
        totalEvents: events.length,
        sentEvents: sentCount,
        failedEvents: errorCount,
        totalDuration: `${totalDuration}ms`,
        averageRate: `${averageRate} events/sec`
      })

      return {
        success: true,
        sentCount,
        errorCount,
        totalDuration
      }
    } catch (error) {
      logger.error(`❌ [TimingController] Event stream failed:`, error)
      throw error
    }
  }

  /**
   * 批量发送事件（用于调试或快速模式）
   * @param {Array} events - 事件数组
   * @param {Function} sendCallback - 发送回调函数
   * @param {Number} batchSize - 批次大小
   * @returns {Promise} 发送完成的 Promise
   */
  async sendEventsBatch(events, sendCallback, batchSize = 5) {
    logger.info(`📦 [TimingController] Starting batch event stream`, {
      totalEvents: events.length,
      batchSize
    })

    const startTime = Date.now()
    let sentCount = 0

    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize)

      await Promise.all(
        batch.map(async (event) => {
          try {
            await sendCallback(event)
            sentCount++
          } catch (error) {
            logger.error(`❌ [TimingController] Batch send failed:`, {
              eventType: event.type,
              error: error.message
            })
          }
        })
      )

      // 批次间短暂延迟
      if (i + batchSize < events.length) {
        await this.sleep(this.baseDelay)
      }
    }

    const totalDuration = Date.now() - startTime
    logger.info(`✅ [TimingController] Batch stream completed`, {
      totalEvents: events.length,
      sentEvents: sentCount,
      totalDuration: `${totalDuration}ms`
    })

    return { sentCount, totalDuration }
  }

  /**
   * 创建时序配置文件
   * @param {String} profile - 配置文件名称
   * @returns {Object} 时序配置
   */
  static createProfile(profile) {
    const profiles = {
      // 快速模式 - 用于测试
      fast: {
        baseDelay: 20,
        reasoningDelay: 30,
        contentDelay: 15,
        completionDelay: 25,
        enableRandomization: false,
        adaptiveTiming: false
      },

      // 标准模式 - 默认配置
      standard: {
        baseDelay: 50,
        reasoningDelay: 100,
        contentDelay: 30,
        completionDelay: 80,
        enableRandomization: true,
        adaptiveTiming: true
      },

      // 详细模式 - 更真实的时序
      detailed: {
        baseDelay: 80,
        reasoningDelay: 150,
        contentDelay: 45,
        completionDelay: 120,
        enableRandomization: true,
        adaptiveTiming: true,
        randomizationRange: 0.3
      },

      // 调试模式 - 慢速，便于观察
      debug: {
        baseDelay: 200,
        reasoningDelay: 300,
        contentDelay: 150,
        completionDelay: 250,
        enableRandomization: false,
        adaptiveTiming: false
      }
    }

    return profiles[profile] || profiles.standard
  }

  /**
   * 睡眠函数
   * @param {Number} ms - 毫秒数
   * @returns {Promise} Promise
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 验证时序配置
   * @returns {Object} 验证结果
   */
  validateConfiguration() {
    const issues = []

    if (this.minDelay >= this.maxDelay) {
      issues.push('minDelay should be less than maxDelay')
    }

    if (this.baseDelay > this.maxDelay) {
      issues.push('baseDelay should not exceed maxDelay')
    }

    if (this.randomizationRange < 0 || this.randomizationRange > 1) {
      issues.push('randomizationRange should be between 0 and 1')
    }

    const valid = issues.length === 0
    if (!valid) {
      logger.warn(`⚠️ [TimingController] Configuration issues found:`, issues)
    }

    return { valid, issues }
  }
}

module.exports = FlowTimingController
