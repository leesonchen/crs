const express = require('express')
const openaiChatAccountService = require('../../services/openaiChatAccountService')
const apiKeyService = require('../../services/apiKeyService')
const accountGroupService = require('../../services/accountGroupService')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const { formatAccountExpiry, mapExpiryField } = require('./utils')

const router = express.Router()

router.get('/openai-chat-accounts', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    let accounts = await openaiChatAccountService.getAllAccounts(true)

    if (platform && platform !== 'openai-chat') {
      accounts = []
    }

    if (groupId) {
      const group = await accountGroupService.getGroup(groupId)
      if (group && group.platform === 'openai-chat') {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      } else {
        accounts = []
      }
    }

    const accountIds = accounts.map((a) => a.id)

    const [allApiKeys, allGroupInfosMap] = await Promise.all([
      apiKeyService.getAllApiKeysLite(),
      accountGroupService.batchGetAccountGroupsByIndex(accountIds, 'openai-chat')
    ])

    const bindingCountMap = new Map()
    for (const key of allApiKeys) {
      const binding = key.openaiAccountId
      if (!binding || typeof binding !== 'string') {
        continue
      }
      if (!binding.startsWith('chat:')) {
        continue
      }
      const accountId = binding.substring(5)
      bindingCountMap.set(accountId, (bindingCountMap.get(accountId) || 0) + 1)
    }

    const accountsWithStats = accounts.map((account) => {
      const groupInfos = allGroupInfosMap.get(account.id) || []
      const boundCount = bindingCountMap.get(account.id) || 0
      const formattedAccount = formatAccountExpiry(account)

      return {
        ...formattedAccount,
        groupInfos,
        boundApiKeysCount: boundCount
      }
    })

    res.json({ success: true, data: accountsWithStats })
  } catch (error) {
    logger.error('Failed to get OpenAI-Chat accounts:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.post('/openai-chat-accounts', authenticateAdmin, async (req, res) => {
  try {
    const account = await openaiChatAccountService.createAccount(req.body)
    const formattedAccount = formatAccountExpiry(account)
    res.json({ success: true, data: formattedAccount })
  } catch (error) {
    logger.error('Failed to create OpenAI-Chat account:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

router.put('/openai-chat-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const updates = req.body
    const mappedUpdates = mapExpiryField(updates, 'OpenAI-Chat', id)

    const result = await openaiChatAccountService.updateAccount(id, mappedUpdates)

    if (result && result.success !== false) {
      const account = await openaiChatAccountService.getAccount(id)
      const formattedAccount = formatAccountExpiry(account)
      res.json({ success: true, data: formattedAccount })
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to update OpenAI-Chat account'
      })
    }
  } catch (error) {
    logger.error('Failed to update OpenAI-Chat account:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

router.delete('/openai-chat-accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(id, 'openai-chat')

    await accountGroupService.removeAccountFromAllGroups(id, 'openai-chat')

    await openaiChatAccountService.deleteAccount(id)

    let message = 'OpenAI-Chat账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    res.json({
      success: true,
      message,
      unboundKeys: unboundCount
    })
  } catch (error) {
    logger.error('Failed to delete OpenAI-Chat account:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

router.put('/openai-chat-accounts/:id/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const result = await openaiChatAccountService.toggleSchedulable(id)
    res.json(result)
  } catch (error) {
    logger.error('Failed to toggle OpenAI-Chat account schedulable:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

router.put('/openai-chat-accounts/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { action } = req.body

    const updates = {}
    if (action === 'enable') {
      updates.isActive = 'true'
      updates.status = 'active'
    } else if (action === 'disable') {
      updates.isActive = 'false'
      updates.status = 'inactive'
    }

    await openaiChatAccountService.updateAccount(id, updates)
    const account = await openaiChatAccountService.getAccount(id)
    res.json({ success: true, data: account })
  } catch (error) {
    logger.error('Failed to toggle OpenAI-Chat account:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/openai-chat-accounts/:id/reset-status', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const result = await openaiChatAccountService.resetAccountStatus(id)
    res.json(result)
  } catch (error) {
    logger.error('Failed to reset OpenAI-Chat account status:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

router.post('/openai-chat-accounts/:id/reset-usage', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params

    await openaiChatAccountService.updateAccount(id, {
      totalUsedTokens: '0',
      lastUsedAt: ''
    })

    res.json({
      success: true,
      message: 'Usage statistics reset successfully'
    })
  } catch (error) {
    logger.error('Failed to reset OpenAI-Chat account usage:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

module.exports = router
