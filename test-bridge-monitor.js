#!/usr/bin/env node

/**
 * 桥接模式监控脚本
 * 专门用于监控Codex CLI的桥接请求和流程模拟状态
 */

const fs = require('fs')
const path = require('path')

const logFile = path.join(__dirname, 'logs', `claude-relay-${new Date().toISOString().split('T')[0]}.log`)

console.log('🔍 开始监控桥接模式请求...')
console.log(`📁 日志文件: ${logFile}`)
console.log('⏰ 等待Codex CLI请求...\n')

// 监控关键词
const keywords = [
  'Bridge',
  'Flow',
  'Simulation',
  'Codex',
  'stream disconnected',
  'res unavailable',
  'destroyed',
  'response.created',
  'response.completed',
  'openai-to-claude',
  '流程模拟'
]

let lastSize = 0

function monitorLogs() {
  try {
    const stats = fs.statSync(logFile)
    const currentSize = stats.size

    if (currentSize > lastSize) {
      // 有新日志内容
      const content = fs.readFileSync(logFile, 'utf8')
      const newContent = content.substring(lastSize)
      lastSize = currentSize

      // 检查是否包含关键词
      const hasKeyword = keywords.some(keyword =>
        newContent.toLowerCase().includes(keyword.toLowerCase())
      )

      if (hasKeyword) {
        const lines = newContent.split('\n').filter(line => line.trim())

        lines.forEach(line => {
          const hasMatch = keywords.some(keyword =>
            line.toLowerCase().includes(keyword.toLowerCase())
          )

          if (hasMatch) {
            // 添加时间戳高亮
            const timestamp = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/)
            const level = line.match(/\[(ERROR|WARN|INFO|DEBUG)\]/)

            let output = line
            if (timestamp) {
              output = output.replace(timestamp[0], `\x1b[36m${timestamp[0]}\x1b[0m`)
            }
            if (level) {
              const color = level[1] === 'ERROR' ? '\x1b[31m' :
                           level[1] === 'WARN' ? '\x1b[33m' :
                           level[1] === 'INFO' ? '\x1b[32m' : '\x1b[37m'
              output = output.replace(level[0], `\x1b[1m${color}${level[0]}\x1b[0m`)
            }

            console.log(`🔍 ${output}`)
          }
        })
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`❌ 读取日志文件错误:`, error.message)
    }
  }
}

// 每秒检查一次
setInterval(monitorLogs, 1000)

// 处理退出
process.on('SIGINT', () => {
  console.log('\n\n👋 监控已停止')
  process.exit(0)
})

console.log('💡 使用 Ctrl+C 停止监控\n')