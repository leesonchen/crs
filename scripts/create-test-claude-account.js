#!/usr/bin/env node

/**
 * 创建测试用Claude账户的脚本
 * 用于测试桥接功能
 */

const crypto = require('crypto')
const Redis = require('ioredis')

async function createTestClaudeAccount() {
  const redis = new Redis({
    host: 'localhost',
    port: 6379,
    db: 0
  })

  try {
    const accountId = `claude-test-${Date.now()}`

    // Claude OAuth账户数据结构
    const claudeAccountData = {
      id: accountId,
      name: 'Test Claude Bridge Account',
      description: 'Test account for bridge functionality with OpenAI model mapping',
      type: 'claude',
      isActive: 'true',
      createdAt: new Date().toISOString(),

      // OAuth数据 (模拟加密存储)
      claudeAiOauth: JSON.stringify({
        accessToken: `test-access-token-${Date.now()}`,
        refreshToken: `test-refresh-token-${Date.now()}`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        scopes: ['messages', 'models'],
        tokenType: 'Bearer'
      }),

      // 关键：配置OpenAI模型映射以支持桥接
      openaiModelMapping: JSON.stringify({
        'gpt-5': 'claude-sonnet-4-5-20250929',
        'gpt-5-mini': 'claude-3-5-haiku-20241022',
        'gpt-5-plus': 'claude-sonnet-4-20250514',
        'gpt-4': 'claude-3-5-sonnet-20241022',
        'gpt-4-turbo': 'claude-3-5-sonnet-20241022'
      }),

      // Claude模型映射
      modelMapping: JSON.stringify({
        'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-20250929',
        'claude-3-5-haiku-20241022': 'claude-3-5-haiku-20241022',
        'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022'
      }),

      // 优先级设置（桥接账户优先级为60，高于普通OpenAI账户的50）
      priority: '60',
      concurrencyLimit: '5',
      rateLimitWindow: '60',
      rateLimitRequests: '100',

      // 代理配置
      proxyType: 'none',
      proxyHost: '',
      proxyPort: '',
      proxyUsername: '',
      proxyPassword: '',

      // 统计信息
      totalRequests: '0',
      totalTokens: '0',
      lastUsed: '',

      // 其他必要字段
      permissions: 'all',
      enableModelRestriction: 'false',
      restrictedModels: '[]',
      dailyCostLimit: '10',
      weeklyOpusCostLimit: '50',
      tags: JSON.stringify(['test', 'bridge']),
      createdBy: 'admin',
      userId: '',
      userUsername: '',
      icon: ''
    }

    // 存储到Redis（使用正确的键格式：claude:account:*）
    await redis.hset(`claude:account:${accountId}`, claudeAccountData)

    console.log('✅ 测试Claude账户创建成功!')
    console.log(`  账户ID: ${accountId}`)
    console.log(`  账户名称: ${claudeAccountData.name}`)
    console.log(`  OpenAI模型映射: ${claudeAccountData.openaiModelMapping}`)
    console.log(`  优先级: ${claudeAccountData.priority}`)
    console.log(`  状态: ${claudeAccountData.isActive}`)

    // 验证创建是否成功
    const storedData = await redis.hgetall(`claude_account:${accountId}`)
    console.log(`  Redis验证: ${storedData.id ? '成功' : '失败'}`)

    return accountId
  } catch (error) {
    console.error('❌ 创建测试Claude账户失败:', error.message)
    throw error
  } finally {
    redis.disconnect()
  }
}

async function listClaudeAccounts() {
  const redis = new Redis({
    host: 'localhost',
    port: 6379,
    db: 0
  })

  try {
    const keys = await redis.keys('claude_account:*')
    console.log(`📋 找到 ${keys.length} 个Claude账户:`)

    for (const key of keys) {
      const data = await redis.hgetall(key)
      console.log(`  - ${data.id}: ${data.name} (${data.isActive === 'true' ? '激活' : '未激活'})`)
      if (data.openaiModelMapping) {
        const mapping = JSON.parse(data.openaiModelMapping)
        console.log(`    OpenAI映射: ${Object.keys(mapping).length} 个模型`)
      }
    }
  } catch (error) {
    console.error('❌ 列出Claude账户失败:', error.message)
  } finally {
    redis.disconnect()
  }
}

// 主函数
async function main() {
  try {
    console.log('🚀 开始创建测试Claude账户...')
    console.log('')

    // 先列出现有账户
    await listClaudeAccounts()
    console.log('')

    // 创建测试账户
    const accountId = await createTestClaudeAccount()
    console.log('')

    // 再次列出账户确认
    await listClaudeAccounts()
    console.log('')
    console.log('🎉 测试Claude账户创建完成!')
    console.log('现在可以运行桥接功能测试了:')
    console.log('  node scripts/test-bridge-functionality.js')
  } catch (error) {
    console.error('❌ 脚本执行失败:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { createTestClaudeAccount, listClaudeAccounts }
