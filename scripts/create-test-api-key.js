#!/usr/bin/env node

/**
 * 创建测试API Key的脚本
 */

const axios = require('axios')
const crypto = require('crypto')

const config = {
  baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
  adminUsername: 'admin',
  adminPassword: 'admin123'
}

const httpClient = axios.create({
  baseURL: config.baseURL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})

/**
 * 生成API Key
 */
function generateApiKey() {
  const timestamp = Date.now().toString()
  const randomBytes = crypto.randomBytes(16).toString('hex')
  return `cr_${timestamp}_${randomBytes}`
}

/**
 * 创建API Key
 */
async function createApiKey() {
  try {
    console.log('🔑 创建测试API Key...')

    // 生成新的API Key
    const newApiKey = generateApiKey()
    console.log(`📝 生成的API Key: ${newApiKey}`)

    // 尝试不同的端点来创建API Key
    const endpoints = ['/admin/api-keys', '/api/admin/keys', '/admin/keys/create', '/keys/create']

    let created = false

    for (const endpoint of endpoints) {
      try {
        console.log(`🔄 尝试端点: ${endpoint}`)

        const response = await httpClient.post(endpoint, {
          name: 'Bridge Test Key',
          key: newApiKey,
          limit: 1000,
          expiresIn: 24 // 24小时后过期
        })

        if (response.data && (response.data.success || response.data.id)) {
          console.log(`✅ API Key 创建成功!`)
          console.log(`  端点: ${endpoint}`)
          console.log(`  Key: ${newApiKey}`)
          console.log(`  响应:`, response.data)
          created = true
          return newApiKey
        }
      } catch (error) {
        console.log(
          `  ❌ 端点 ${endpoint} 失败: ${error.response?.status} ${error.response?.data?.message || error.message}`
        )
        continue
      }
    }

    if (!created) {
      console.log('❌ 无法通过API创建API Key，尝试直接写入Redis...')

      // 如果API方法失败，尝试使用Redis直接创建
      const Redis = require('ioredis')
      const config = require('../config/config')
      const redis = new Redis({
        host: 'localhost',
        port: 6379,
        db: 0
      })

      const keyId = `key_${Date.now()}`
      const hashedKey = crypto
        .createHash('sha256')
        .update(newApiKey + config.security.encryptionKey)
        .digest('hex')

      const keyData = {
        id: keyId,
        name: 'Bridge Test Key',
        apiKey: hashedKey, // 存储哈希值，不是原始key
        createdAt: new Date().toISOString(),
        isActive: 'true', // 字符串形式
        tokenLimit: '1000',
        concurrencyLimit: '0',
        rateLimitWindow: '0',
        rateLimitRequests: '0',
        rateLimitCost: '0',
        claudeAccountId: '',
        claudeConsoleAccountId: '',
        geminiAccountId: '',
        openaiAccountId: '',
        azureOpenaiAccountId: '',
        bedrockAccountId: '',
        permissions: 'all',
        enableModelRestriction: 'false',
        restrictedModels: '[]',
        enableClientRestriction: 'false',
        allowedClients: '[]',
        dailyCostLimit: '0',
        totalCostLimit: '0',
        weeklyOpusCostLimit: '0',
        tags: '[]',
        activationDays: '0',
        expirationMode: 'fixed',
        isActivated: 'true',
        activatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdBy: 'admin',
        userId: '',
        userUsername: '',
        icon: ''
      }

      // 使用正确的Redis API Key设置方法
      await redis.hset(`apikey:${keyId}`, keyData)
      await redis.hset('apikey:hash_map', hashedKey, keyId) // 建立哈希映射

      console.log(`✅ 通过Redis创建API Key成功!`)
      console.log(`  Key: ${newApiKey}`)
      console.log(`  ID: ${keyData.id}`)

      redis.disconnect()
      return newApiKey
    }
  } catch (error) {
    console.error('❌ 创建API Key失败:', error.message)
    throw error
  }
}

/**
 * 测试API Key
 */
async function testApiKey(apiKey) {
  try {
    console.log('\n🧪 测试API Key...')

    const response = await httpClient.get('/health', {
      headers: {
        'x-api-key': apiKey
      }
    })

    console.log('✅ API Key 测试成功!')
    return true
  } catch (error) {
    console.log(
      '❌ API Key 测试失败:',
      error.response?.status,
      error.response?.data?.message || error.message
    )
    return false
  }
}

// 主函数
async function main() {
  try {
    const apiKey = await createApiKey()

    const isValid = await testApiKey(apiKey)

    if (isValid) {
      console.log('\n🎉 API Key 创建并验证成功!')
      console.log(`请更新测试脚本中的 API Key: ${apiKey}`)
      console.log('或者设置环境变量:')
      console.log(`export TEST_API_KEY="${apiKey}"`)
    } else {
      console.log('\n⚠️  API Key 创建成功但验证失败')
      console.log('请检查服务配置或权限设置')
    }
  } catch (error) {
    console.error('❌ 脚本执行失败:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { createApiKey, testApiKey }
