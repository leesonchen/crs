#!/usr/bin/env node

/**
 * Check Redis data types and content
 */

const Redis = require('ioredis')
const config = require('./config/config.js')

async function checkRedis() {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db
  })

  try {
    console.log('🔍 Checking Redis content...')

    // Get all keys
    const keys = await redis.keys('*')
    console.log(`📋 Found ${keys.length} total keys:`)
    keys.forEach(key => console.log(`   - ${key}`))

    // Check the specific API key
    const apiKeyKeys = await redis.keys('api_key:*')
    console.log(`\n🔑 API Key related keys: ${apiKeyKeys.length}`)

    for (const key of apiKeyKeys) {
      const type = await redis.type(key)
      console.log(`   ${key}: ${type}`)

      if (type === 'hash') {
        const hashData = await redis.hgetall(key)
        console.log(`     Hash data:`, Object.keys(hashData))
        if (hashData.key) {
          console.log(`     ✅ Found API key in hash: ${hashData.key.substring(0, 20)}...`)
          return hashData.key
        }
      } else if (type === 'string') {
        try {
          const data = await redis.get(key)
          const parsed = JSON.parse(data)
          if (parsed.key) {
            console.log(`     ✅ Found API key in string: ${parsed.key.substring(0, 20)}...`)
            return parsed.key
          }
        } catch (e) {
          console.log(`     String data (first 100 chars): ${data.substring(0, 100)}...`)
        }
      }
    }

    console.log('\n❌ No API key found')
    return null
  } catch (error) {
    console.error('❌ Error:', error)
    return null
  } finally {
    await redis.quit()
  }
}

checkRedis().then(apiKey => {
  if (apiKey) {
    console.log(`\n🎉 Found API key: ${apiKey}`)
  }
}).catch(console.error)