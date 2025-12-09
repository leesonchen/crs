#!/usr/bin/env node

/**
 * 数据迁移脚本：修复错误存储的 Claude Console 账户
 *
 * 问题描述：
 * 由于导入导出脚本的 bug，Claude Console 账户被错误地存储到了 `claude:account:*` 键中，
 * 而不是正确的 `claude_console_account:*` 键中。
 *
 * 此脚本的作用：
 * 1. 扫描所有 `claude:account:*` 键
 * 2. 找出 platform 为 "claude-console" 的账户
 * 3. 将这些账户迁移到 `claude_console_account:*` 键中
 * 4. 删除原错误位置的键
 *
 * 使用方法：
 * node scripts/migrate-claude-console-accounts.js [--dry-run]
 *
 * --dry-run: 预览迁移结果，不实际执行数据修改
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
  db: process.env.REDIS_DB || config.redis?.db || 0,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000)
    return delay
  },
}

// 创建 Redis 连接
const redisClient = new Redis(redisConfig)

// 记录连接事件
redisClient.on('connect', () => {
  console.log('✅ 已连接到 Redis')
})

redisClient.on('error', (err) => {
  console.error('❌ Redis 连接错误:', err.message)
})

redisClient.on('ready', () => {
  console.log('🔄 Redis 已就绪')
})

/**
 * 主迁移函数
 */
async function migrateClaudeConsoleAccounts(dryRun = false) {
  console.log('\n============================================================')
  console.log('Claude Console 账户迁移工具')
  console.log('============================================================')
  console.log(`模式: ${dryRun ? '预览模式（不实际修改数据）' : '实际迁移模式'}`)
  console.log('============================================================\n')

  try {
    // 获取所有 claude:account:* 键
    const claudeAccountKeys = await redisClient.keys('claude:account:*')
    console.log(`📊 发现 ${claudeAccountKeys.length} 个 claude:account:* 键`)

    if (claudeAccountKeys.length === 0) {
      console.log('⚠️  没有发现需要迁移的账户')
      await cleanup()
      return
    }

    // 统计数据
    const stats = {
      total: claudeAccountKeys.length,
      claudeConsole: 0,
      claudeOfficial: 0,
      migrated: 0,
      skipped: 0,
      errors: 0,
    }

    // 迁移列表
    const accountsToMigrate = []
    const accountsToSkip = []

    // 分析每个账户
    console.log('\n🔍 分析账户类型...')
    for (const key of claudeAccountKeys) {
      try {
        const data = await redisClient.hgetall(key)
        const accountId = key.replace('claude:account:', '')
        const platform = data.platform || 'unknown'
        const name = data.name || 'unnamed'

        if (platform === 'claude-console') {
          accountsToMigrate.push({
            key,
            accountId,
            name,
            data,
          })
          stats.claudeConsole++
        } else if (platform === 'claude-official' || platform === '') {
          accountsToSkip.push({
            key,
            accountId,
            name,
            platform,
          })
          stats.claudeOfficial++
        } else {
          console.log(`  ⚪ 未知平台类型: ${platform} (${name})`)
          stats.skipped++
        }
      } catch (error) {
        console.error(`  ❌ 处理键 ${key} 时出错:`, error.message)
        stats.errors++
      }
    }

    // 显示分析结果
    console.log('\n============================================================')
    console.log('分析结果')
    console.log('============================================================')
    console.log(`总账户数: ${stats.total}`)
    console.log(`需要迁移的 Claude Console 账户: ${stats.claudeConsole}`)
    console.log(`保留的 Claude 官方账户: ${stats.claudeOfficial}`)
    console.log(`错误: ${stats.errors}`)

    // 显示需要迁移的账户列表
    if (accountsToMigrate.length > 0) {
      console.log('\n需要迁移的 Claude Console 账户:')
      for (const account of accountsToMigrate) {
        console.log(`  🔄 ${account.name} (ID: ${account.accountId})`)
      }
    }

    // 显示保留的账户列表
    if (accountsToSkip.length > 0) {
      console.log('\n保留的 Claude 官方账户:')
      for (const account of accountsToSkip) {
        console.log(`  ✅ ${account.name} (ID: ${account.accountId}, Platform: ${account.platform})`)
      }
    }

    // 执行迁移
    if (!dryRun && accountsToMigrate.length > 0) {
      console.log('\n============================================================')
      console.log('开始迁移')
      console.log('============================================================\n')

      for (const account of accountsToMigrate) {
        try {
          const sourceKey = account.key
          const targetKey = `claude_console_account:${account.accountId}`

          console.log(`  正在迁移: ${account.name}`)
          console.log(`    从: ${sourceKey}`)
          console.log(`    到: ${targetKey}`)

          // 开始迁移
          const pipeline = redisClient.pipeline()

          // 将所有字段写入新位置
          for (const [field, value] of Object.entries(account.data)) {
            pipeline.hset(targetKey, field, value)
          }

          // 执行 pipeline
          await pipeline.exec()
          console.log(`    ✓ 数据已迁移`)

          // 删除原键
          await redisClient.del(sourceKey)
          console.log(`    ✓ 原键已删除`)

          stats.migrated++
          console.log()
        } catch (error) {
          console.error(`  ❌ 迁移失败: ${account.name}`, error.message)
          stats.errors++
        }
      }
    }

    // 显示最终结果
    console.log('\n============================================================')
    console.log('迁移完成')
    console.log('============================================================')
    console.log(`总账户数: ${stats.total}`)
    console.log(`✅ 迁移成功: ${stats.migrated}`)
    console.log(`⏭️  保留账户: ${stats.claudeOfficial}`)
    console.log(`❌ 错误: ${stats.errors}`)
    console.log('============================================================\n')

    await cleanup()
  } catch (error) {
    console.error('\n❌ 迁移过程发生错误:', error.message)
    console.error(error.stack)
    await cleanup()
    process.exit(1)
  }
}

/**
 * 清理并关闭连接
 */
async function cleanup() {
  try {
    await redisClient.quit()
    console.log('👋 Redis 连接已关闭\n')
  } catch (error) {
    console.error('❌ 关闭 Redis 连接时出错:', error.message)
  }
}

/**
 * 主函数
 */
async function main() {
  // 解析命令行参数
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  if (args.includes('--help') || args.includes('-h')) {
    console.log('\nClaude Console 账户迁移工具')
    console.log('============================\n')
    console.log('使用方法:')
    console.log('  node scripts/migrate-claude-console-accounts.js [--dry-run]\n')
    console.log('参数:')
    console.log('  --dry-run    预览迁移结果，不实际执行数据修改')
    console.log('  --help, -h   显示帮助信息\n')
    process.exit(0)
  }

  // 执行迁移
  await migrateClaudeConsoleAccounts(dryRun)
}

// 运行主函数
main().catch((error) => {
  console.error('\n❌ 未处理的错误:', error.message)
  console.error(error.stack)
  process.exit(1)
})
