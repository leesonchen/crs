/**
 * Mock 服务
 * 模拟账户服务的行为
 */

const {
  mockOpenAIOAuthAccount,
  mockOpenAIResponsesAccount,
  mockClaudeOfficialAccount,
  mockClaudeConsoleAccount
} = require('./accounts')

// Mock 账户数据库
const accountDatabase = {
  'test-openai-oauth-id': mockOpenAIOAuthAccount,
  'test-openai-responses-id': mockOpenAIResponsesAccount,
  'test-claude-official-id': mockClaudeOfficialAccount,
  'test-claude-console-id': mockClaudeConsoleAccount
}

// Mock OpenAI Account Service
const mockOpenAIAccountService = {
  getAccount: async (accountId) => {
    const account = accountDatabase[accountId]
    if (!account || account.accountType !== 'openai') {
      return null
    }
    return account
  },

  decrypt: (encryptedText) => {
    // 简单模拟解密：移除加密标记，返回原始 token
    if (!encryptedText || !encryptedText.includes(':')) {
      return encryptedText
    }
    // 实际解密逻辑在真实服务中实现，这里简化处理
    return 'sk-test-openai-oauth-token'
  }
}

// Mock OpenAI-Responses Account Service
const mockOpenAIResponsesAccountService = {
  getAccount: async (accountId) => {
    const account = accountDatabase[accountId]
    if (!account || account.accountType !== 'openai-responses') {
      return null
    }
    return account
  }
}

// Mock Claude Account Service
const mockClaudeAccountService = {
  getAccount: async (accountId) => {
    const account = accountDatabase[accountId]
    if (!account || account.accountType !== 'claude-official') {
      return null
    }
    return account
  },

  decrypt: (encryptedText) => {
    return 'sk-ant-test-session-key'
  }
}

// Mock Claude Console Account Service
const mockClaudeConsoleAccountService = {
  getAccount: async (accountId) => {
    const account = accountDatabase[accountId]
    if (!account || account.accountType !== 'claude-console') {
      return null
    }
    return account
  }
}

// Mock Bedrock Account Service
const mockBedrockAccountService = {
  getAccount: async (accountId) => {
    if (accountId === 'test-bedrock-id') {
      return {
        success: true,
        data: {
          id: 'test-bedrock-id',
          name: 'Test Bedrock Account',
          accountType: 'bedrock',
          region: 'us-east-1',
          status: 'active'
        }
      }
    }
    return { success: false }
  }
}

// 重置所有 Mock（空函数，因为不再使用 jest.fn）
function resetAllMocks() {
  // Mock 函数已改为普通函数，不需要清理
}

module.exports = {
  mockOpenAIAccountService,
  mockOpenAIResponsesAccountService,
  mockClaudeAccountService,
  mockClaudeConsoleAccountService,
  mockBedrockAccountService,
  accountDatabase,
  resetAllMocks
}
