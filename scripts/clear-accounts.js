#!/usr/bin/env node

/**
 * Redis 账户清空脚本
 *
 * 功能：安全清空 Redis 中的各类账户数据
 *
 * 使用方法：
 *   node scripts/clear-accounts.js --dry-run        # 预览将要清空的账户
 *   node scripts/clear-accounts.js                  # 实际清空账户
 *
 * 支持清空的账户类型：
 *   - Claude 官方账户 (claude:account:*)
 *   - Claude Console 账户 (claude_console_account:*)
 *   - OpenAI 账户 (openai:account:*)
 *   - OpenAI Responses 账户 (openai_responses_account:*)
 *   - OpenAI Chat 账户 (openai_chat_account:*)
 *   - Gemini 账户 (gemini_account:*)
 *   - AWS Bedrock 账户 (bedrock_account:*)
 *   - Azure OpenAI 账户 (azure_openai_account:*)
 *   - Droid 账户 (droid_account:*)
 *   - CCR 账户 (ccr_account:*)
 *
 * 注意：此操作不可逆，请谨慎使用！
 */

require('dotenv').config()
const Redis = require('ioredis')
const path = require('path')

// 加载配置
const configPath = path.join(__dirname, '../config/config')
let config
try {
  config = require(configPath)
} catch (error) {
  console.error('❌ 无法加载配置文件')
  process.exit(1)
}

// Redis 配置
const redisConfig = {
  host: process.env.REDIS_HOST || config.redis?.host || 'localhost',
  port: process.env.REDIS_PORT || config.redis?.port || 6379,
  password: process.env.REDIS_PASSWORD || config.redis?.password || undefined,
  db: process.env.REDIS_DB || config.redis?.db || 0
}

// 创建 Redis 连接
const redisClient = new Redis(redisConfig)

redisClient.on('connect', () => {
  console.log('✅ 已连接到 Redis')
})

redisClient.on('error', (err) => {
  console.error('❌ Redis 连接错误:', err.message)
})

redisClient.on('ready', () => {
  console.log('🔄 Redis 已就绪')
})

// Redis SCAN 辅助函数（可配置的 COUNT 参数）
async function scanKeys(pattern, count = 1000) {
  const keys = []
  let cursor = '0'
  let scannedKeys = 0

  do {
    try {
      const result = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', count)
      cursor = result[0]
      const batchKeys = result[1]

      if (batchKeys.length > 0) {
        keys.push(...batchKeys)
        scannedKeys += batchKeys.length

        // 显示进度（每扫描 1000 个键）
        if (scannedKeys % 1000 === 0) {
          console.log(`  已扫描 ${scannedKeys} 个键...`)
        }
      }
    } catch (error) {
      console.error(`  ❌ SCAN 操作失败 (${pattern}): ${error.message}`)
      throw error
    }
  } while (cursor !== '0')

  return keys
}

// 账户类型配置
const ACCOUNT_TYPES = [
  {
    name: 'Claude 官方账户',
    pattern: 'claude:account:*',
    checkFirst: true
  },
  {
    name: 'Claude Console 账户',
    pattern: 'claude_console_account:*',
    checkFirst: true
  },
  {
    name: 'OpenAI 常规账户',
    pattern: 'openai:account:*',
    checkFirst: true
  },
  {
    name: 'OpenAI Responses 账户',
    pattern: 'openai_responses_account:*',
    checkFirst: true
  },
  {
    name: 'OpenAI Chat 账户',
    pattern: 'openai_chat_account:*',
    checkFirst: true
  },
  {
    name: 'Gemini 账户',
    pattern: 'gemini_account:*',
    checkFirst: true
  },
  {
    name: 'AWS Bedrock 账户',
    pattern: 'bedrock_account:*',
    checkFirst: true
  },
  {
    name: 'Azure OpenAI 账户',
    pattern: 'azure_openai_account:*',
    checkFirst: true
  },
  {
    name: 'Droid 账户',
    pattern: 'droid_account:*',
    checkFirst: true
  },
  {
    name: 'CCR 账户',
    pattern: 'ccr_account:*',
    checkFirst: true
  },
  {
    name: '共享账户集合',
    pattern: 'shared_*_accounts',
    checkFirst: false
  }
]

async function cleanup() {
  try {
    await redisClient.quit()
    console.log('👋 Redis 连接已关闭')
  } catch (error) {
    console.error('❌ 关闭 Redis 连接时出错:', error.message)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--force')

  if (args.includes('--help') || args.includes('-h')) {
    console.log('\nRedis 账户清空工具')
    console.log('===================\n')
    console.log('使用方法:')
    console.log('  node scripts/clear-accounts.js [选项]\n')
    console.log('选项:')
    console.log('  --dry-run    预览将要清空的账户（推荐先运行此命令）')
    console.log('  --force      跳过确认提示（危险！）')
    console.log('  --help, -h   显示帮助信息\n')
    process.exit(0)
  }

  console.log('\n========================================')
  console.log('Redis 账户清空工具')
  console.log(`模式: ${dryRun ? '预览模式' : force ? '强制模式' : '正常模式'}`)
  console.log('========================================\n')

  try {
    // 扫描所有账户
    const results = []
    let totalKeys = 0

    console.log('🔍 扫描账户数据...\n')

    for (const accountType of ACCOUNT_TYPES) {
      const keys = await scanKeys(accountType.pattern)
      totalKeys += keys.length

      if (keys.length > 0) {
        console.log(`  📊 ${accountType.name}: ${keys.length} 个`)

        // 显示前几个键名作为示例
        if (keys.length > 0) {
          const examples = keys
            .slice(0, 3)
            .map((k) => `    ${k}`)
            .join('\n')
          if (keys.length > 3) {
            console.log(`${examples}\n    ... 还有 ${keys.length - 3} 个`)
          } else {
            console.log(examples)
          }
        }

        results.push({
          type: accountType,
          keys
        })
      }
    }

    console.log(`\n========================================`)
    console.log(`总计发现: ${totalKeys} 个账户键`)
    console.log(`========================================\n`)

    if (totalKeys === 0) {
      console.log('✅ Redis 中没有任何账户数据，无需清理')
      await cleanup()
      return
    }

    // 预览模式
    if (dryRun) {
      console.log('🔍 预览完成！以下是将要清空的账户列表：')
      console.log('ℹ️  使用 --force 参数可跳过确认提示执行清空')
      console.log('ℹ️  直接运行（不加任何参数）可执行实际清空\n')
      await cleanup()
      return
    }

    // 实际清空
    console.log('⚠️  警告：此操作将永久删除上述所有账户数据！')
    console.log('⚠️  此操作不可逆，请确保已备份重要数据！\n')

    // 备份数据（强制模式下更需要备份）
    if (force && totalKeys > 0) {
      console.log('📦 强制模式：正在创建备份数据...')
      const backupFile = `backup-before-clear-${Date.now()}.json`
      const fs = require('fs')
      const backupData = {
        metadata: {
          backupTime: new Date().toISOString(),
          reason: 'force-clear-accounts',
          totalKeys
        },
        data: {}
      }

      for (const result of results) {
        const { type, keys } = result
        if (keys.length > 0) {
          backupData.data[type.name] = []
          console.log(`  正在备份 ${type.name}: ${keys.length} 个`)

          for (const key of keys) {
            try {
              const data = await redisClient.hgetall(key)
              if (data && Object.keys(data).length > 0) {
                backupData.data[type.name].push({
                  key,
                  data
                })
              }
            } catch (error) {
              console.error(`    ❌ 备份键 ${key} 失败: ${error.message}`)
            }
          }
        }
      }

      try {
        fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2))
        console.log(`\n✅ 备份完成: ${backupFile}`)
        console.log('ℹ️  如果删除出错，可以手动恢复数据\n')
      } catch (error) {
        console.error(`❌ 备份失败: ${error.message}`)
        const confirmed = await new Promise((resolve) => {
          const readline = require('readline')
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          })
          rl.question('备份失败，是否继续清空？输入 "CONTINUE" 继续: ', (answer) => {
            rl.close()
            resolve(answer === 'CONTINUE')
          })
        })
        if (!confirmed) {
          console.log('\n❌ 操作已取消（备份失败）')
          await cleanup()
          return
        }
      }
    }

    // 确认操作（强制模式需要输入更复杂的确认词）
    if (!force) {
      const readline = require('readline')
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      const confirmed = await new Promise((resolve) => {
        rl.question('确认清空所有账户？输入 "YES" 继续: ', (answer) => {
          rl.close()
          resolve(answer === 'YES')
        })
      })

      if (!confirmed) {
        console.log('\n❌ 操作已取消')
        await cleanup()
        return
      }
    } else {
      // 强制模式下的二次确认（要求输入更复杂的文本）
      console.log('\n⚠️  强制模式：需要额外确认')
      const readline = require('readline')
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      const confirmed = await new Promise((resolve) => {
        rl.question('请输入 "DELETE ALL ACCOUNTS" 确认: ', (answer) => {
          rl.close()
          resolve(answer === 'DELETE ALL ACCOUNTS')
        })
      })

      if (!confirmed) {
        console.log('\n❌ 操作已取消（强制模式确认失败）')
        await cleanup()
        return
      }
    }

    console.log('\n🗑️  开始清空账户...\n')

    let deletedCount = 0
    let failedCount = 0
    const failures = []

    for (const item of results) {
      const { type, keys } = item

      if (keys.length > 0) {
        console.log(`  🗑️  正在清空: ${type.name}`)
        console.log(`     数量: ${keys.length}`)

        // 使用 pipeline 删除，提高性能
        try {
          const pipeline = redisClient.pipeline()
          keys.forEach((key) => pipeline.del(key))
          const deleteResults = await pipeline.exec()

          // 检查哪些键删除成功/失败
          let successCount = 0
          let typeFailedCount = 0

          deleteResults.forEach((deleteResult, index) => {
            if (deleteResult[1] === 0) {
              // 键不存在或删除失败
              typeFailedCount++
              failures.push({
                type: type.name,
                key: keys[index],
                error: '删除失败或键不存在'
              })
            } else if (deleteResult[1] === 1) {
              successCount++
            }
          })

          deletedCount += successCount
          failedCount += typeFailedCount

          if (typeFailedCount === 0) {
            console.log(`     ✓ 已清空 (${successCount}/${keys.length})`)
          } else {
            console.log(`     ⚠️  部分清空 (${successCount} 成功, ${typeFailedCount} 失败)`)
          }
        } catch (error) {
          console.error(`     ❌ 批量删除失败: ${error.message}`)
          failedCount += keys.length
          keys.forEach((key) =>
            failures.push({
              type: type.name,
              key,
              error: error.message
            })
          )
        }
      }
    }

    console.log(`\n========================================`)
    if (failedCount === 0) {
      console.log(`✅ 清空完成！共删除 ${deletedCount} 个账户键`)
    } else {
      console.log(`✅ 清空完成！共删除 ${deletedCount} 个账户键`)
      console.log(`❌ ${failedCount} 个键删除失败`)
      console.log(`\n失败详情：`)
      const failureByType = {}
      failures.forEach((f) => {
        if (!failureByType[f.type]) {
          failureByType[f.type] = []
        }
        failureByType[f.type].push(f)
      })
      Object.entries(failureByType).forEach(([type, list]) => {
        console.log(`  ${type}: ${list.length} 个`)
        list.slice(0, 3).forEach((f) => console.log(`    ${f.key}: ${f.error}`))
        if (list.length > 3) {
          console.log(`    ... 还有 ${list.length - 3} 个`)
        }
      })
    }
    console.log(`========================================\n`)

    await cleanup()
  } catch (error) {
    console.error('\n❌ 执行过程中发生错误:', error.message)
    console.error(error.stack)
    await cleanup()
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n❌ 未处理的错误:', error.message)
  console.error(error.stack)
  cleanup().then(() => process.exit(1))
})
