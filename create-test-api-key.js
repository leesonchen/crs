#!/usr/bin/env node

/**
 * Create a test API key for bridge testing
 */

const apiKeyService = require('./src/services/apiKeyService')
const redis = require('./src/models/redis')

async function createTestApiKey() {
  try {
    console.log('🔑 Connecting to Redis...')
    await redis.connect()
    console.log('✅ Redis connected')

    console.log('🔑 Creating test API key for bridge testing...')

    const result = await apiKeyService.generateApiKey({
      name: 'Bridge Test Key',
      description: 'API key for testing bridge mode functionality',
      permissions: 'all',
      isActive: true,
      tokenLimit: 10000,
      createdBy: 'system'
    })

    console.log('✅ API key created successfully!')
    console.log(`📋 Name: ${result.name}`)
    console.log(`🔑 API Key: ${result.apiKey}`)
    console.log(`🆔 ID: ${result.id}`)
    console.log(`📅 Created: ${result.createdAt}`)

    console.log(`\n🎯 Use this API key for testing: ${result.apiKey}`)
    return result.apiKey
  } catch (error) {
    console.error('❌ Failed to create API key:', error)
    return null
  }
}

createTestApiKey().then(async (apiKey) => {
  await redis.disconnect()
  if (apiKey) {
    console.log('\n🎉 Ready to test bridge mode!')
  } else {
    console.log('\n💥 Failed to create API key')
  }
  process.exit(0)
}).catch(async (error) => {
  await redis.disconnect()
  console.error('💥 Unexpected error:', error)
  process.exit(1)
})