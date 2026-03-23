const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const apiKeyService = require('../apiKeyService')

const MIGRATION_KEY = 'system:migration:openai_chat_cleanup_v1'
const GROUPS_KEY = 'account_groups'
const GROUP_PREFIX = 'account_group:'
const GROUP_MEMBERS_PREFIX = 'account_group_members:'
const REVERSE_INDEX_PREFIX = 'account_groups_reverse:'

async function runOpenAIChatCleanupMigration() {
  const client = redis.getClientSafe()
  if (!client) {
    return { success: false, skipped: true, reason: 'redis_unavailable' }
  }

  const migrated = await client.get(MIGRATION_KEY)
  if (migrated) {
    return { success: true, skipped: true, reason: 'already_migrated' }
  }

  const stats = {
    chatAccountKeysDeleted: 0,
    sharedSetsDeleted: 0,
    apiKeysUnbound: 0,
    groupBindingsCleared: 0,
    groupsDeleted: 0,
    reverseIndexesDeleted: 0
  }

  logger.info('🧹 Starting one-time openai-chat cleanup migration...')

  try {
    const apiKeys = await apiKeyService.getAllApiKeysFast()
    const allGroupIds = await client.smembers(GROUPS_KEY)
    const openaiChatGroupIds = []
    const openaiChatMembers = new Set()

    for (const groupId of allGroupIds) {
      const group = await client.hgetall(`${GROUP_PREFIX}${groupId}`)
      if (!group || group.platform !== 'openai-chat') {
        continue
      }

      openaiChatGroupIds.push(groupId)
      const members = await client.smembers(`${GROUP_MEMBERS_PREFIX}${groupId}`)
      for (const memberId of members) {
        openaiChatMembers.add(memberId)
      }
    }

    for (const key of apiKeys) {
      const binding = key.openaiAccountId
      if (!binding || typeof binding !== 'string') {
        continue
      }

      if (binding.startsWith('chat:')) {
        await apiKeyService.updateApiKey(key.id, { openaiAccountId: null })
        stats.apiKeysUnbound += 1
        continue
      }

      if (binding.startsWith('group:')) {
        const groupId = binding.slice(6)
        if (openaiChatGroupIds.includes(groupId)) {
          await apiKeyService.updateApiKey(key.id, { openaiAccountId: null })
          stats.groupBindingsCleared += 1
        }
      }
    }

    if (openaiChatGroupIds.length > 0) {
      const pipeline = client.pipeline()
      for (const groupId of openaiChatGroupIds) {
        pipeline.del(`${GROUP_PREFIX}${groupId}`)
        pipeline.del(`${GROUP_MEMBERS_PREFIX}${groupId}`)
        pipeline.srem(GROUPS_KEY, groupId)
      }
      await pipeline.exec()
      stats.groupsDeleted = openaiChatGroupIds.length
    }

    const reverseKeys = await client.keys(`${REVERSE_INDEX_PREFIX}openai-chat:*`)
    if (reverseKeys.length > 0) {
      await client.del(...reverseKeys)
      stats.reverseIndexesDeleted += reverseKeys.length
    }

    if (openaiChatMembers.size > 0) {
      const memberReverseKeys = [...openaiChatMembers].map(
        (accountId) => `${REVERSE_INDEX_PREFIX}openai-chat:${accountId}`
      )
      if (memberReverseKeys.length > 0) {
        await client.del(...memberReverseKeys)
      }
    }

    const chatAccountKeys = await client.keys('openai_chat_account:*')
    if (chatAccountKeys.length > 0) {
      await client.del(...chatAccountKeys)
      stats.chatAccountKeysDeleted = chatAccountKeys.length
    }

    const deletedShared = await client.del('shared_openai_chat_accounts', 'openai_chat_account:index')
    stats.sharedSetsDeleted = deletedShared

    await client.set(
      MIGRATION_KEY,
      JSON.stringify({
        completedAt: new Date().toISOString(),
        stats
      })
    )

    logger.success('✅ openai-chat cleanup migration completed', stats)
    return { success: true, skipped: false, stats }
  } catch (error) {
    logger.error('❌ openai-chat cleanup migration failed:', error)
    throw error
  }
}

module.exports = {
  runOpenAIChatCleanupMigration,
  MIGRATION_KEY
}
