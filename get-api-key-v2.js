#!/usr/bin/env node

/**
 * Enhanced script to get API key from Redis
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
    console.log('🔍 Enhanced API key search...')

    // Check the hash structure
    console.log('\n📋 Checking api_key:test-key-001 hash:')
    const hashData = await redis.hgetall('api_key:test-key-001')
    console.log('Hash fields:', Object.keys(hashData))
    for (const [field, value] of Object.entries(hashData)) {
      console.log(`  ${field}: ${value}`)
    }

    // Check the apikey:11388794-259a-4309-b9e4-12b01b2d80c6 key
    console.log('\n📋 Checking apikey:11388794-259a-4309-b9e4-12b01b2d80c6:')
    const type = await redis.type('apikey:11388794-259a-4309-b9e4-12b01b2d80c6')
    console.log(`Type: ${type}`)

    if (type === 'string') {
      const data = await redis.get('apikey:11388794-259a-4309-b9e4-12b01b2d80c6')
      console.log('Data (first 200 chars):', data.substring(0, 200))
      try {
        const parsed = JSON.parse(data)
        console.log('Parsed fields:', Object.keys(parsed))
        if (parsed.key) {
          console.log(`✅ Found API key: ${parsed.key}`)
          return parsed.key
        }
      } catch (e) {
        console.log('Failed to parse as JSON')
      }
    } else if (type === 'hash') {
      const hash = await redis.hgetall('apikey:11388794-259a-4309-b9e4-12b01b2d80c6')
      console.log('Hash fields:', Object.keys(hash))
      for (const [field, value] of Object.entries(hash)) {
        if (field === 'key') {
          console.log(`✅ Found API key: ${value}`)
          return value
        }
        console.log(`  ${field}: ${value}`)
      }
    }

    // Check hash map structure
    console.log('\n📋 Checking apikey:hash_map:')
    const hashMapType = await redis.type('apikey:hash_map')
    console.log(`Hash map type: ${hashMapType}`)

    if (hashMapType === 'hash') {
      const hashMapData = await redis.hgetall('apikey:hash_map')
      console.log('Hash map fields:', Object.keys(hashMapData))
      for (const [field, value] of Object.entries(hashMapData)) {
        if (field.includes('cr_')) {
          console.log(`✅ Found API key in hash map: ${value}`)
          return field // The field name is the API key
        }
        console.log(`  ${field}: ${value}`)
      }
    }

    console.log('\n❌ No API key found in any location')
    return null
  } catch (error) {
    console.error('❌ Error:', error)
    return null
  } finally {
    await redis.quit()
  }
}

getApiKeys().then(apiKey => {
  if (apiKey) {
    console.log(`\n🎉 SUCCESS! Found API key: ${apiKey}`)
  } else {
    console.log('\n💥 Failed to find API key')
  }
}).catch(console.error)