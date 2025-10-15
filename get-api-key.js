#!/usr/bin/env node

/**
 * Simple script to get the actual API key from Redis
 */

const Redis = require('ioredis')
const config = require('./config/config.js')

async function getApiKeys() {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db
  })

  try {
    console.log('🔍 Looking for API keys in Redis...')

    // Get all API key data keys
    const keys = await redis.keys('api_key:*')
    console.log(`📋 Found ${keys.length} keys matching 'api_key:*'`)

    // Filter out hash keys and get actual API key entries
    const dataKeys = keys.filter(key => !key.includes(':hash:'))
    console.log(`📋 Found ${dataKeys.length} data keys`)

    for (const key of dataKeys) {
      try {
        const data = await redis.get(key)
        if (data) {
          const keyData = JSON.parse(data)
          console.log(`\n🔑 Key: ${key}`)
          console.log(`   Name: ${keyData.name || 'Unknown'}`)
          console.log(`   API Key: ${keyData.key || 'MISSING'}`)
          console.log(`   Active: ${keyData.isActive ? 'Yes' : 'No'}`)
          console.log(`   Permissions: ${keyData.permissions || 'all'}`)
          console.log(`   ID: ${keyData.id || 'Unknown'}`)

          // If this is the x13 key, use it
          if (keyData.name === 'x13' && keyData.key) {
            console.log(`\n✅ Found x13 API key: ${keyData.key}`)
            await redis.quit()
            return keyData.key
          }
        }
      } catch (error) {
        console.log(`❌ Error reading key ${key}: ${error.message}`)
      }
    }

    console.log('\n❌ No suitable API key found')
    await redis.quit()
    return null
  } catch (error) {
    console.error('❌ Redis error:', error)
    await redis.quit()
    return null
  }
}

getApiKeys().then(apiKey => {
  if (apiKey) {
    console.log(`\n🎉 Use this API key for testing: ${apiKey}`)
  } else {
    console.log('\n💥 Could not find a valid API key')
  }
}).catch(console.error)