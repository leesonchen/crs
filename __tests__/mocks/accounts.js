/**
 * Mock 账户数据
 * 用于 BridgeService 测试
 */

const crypto = require('crypto')

// 简单的加密函数模拟（与实际服务保持一致）
function encrypt(text) {
  const algorithm = 'aes-256-cbc'
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '12345678901234567890123456789012', 'utf8')
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

// Mock OpenAI OAuth 账户（加密的 accessToken）
const mockOpenAIOAuthAccount = {
  id: 'test-openai-oauth-id',
  name: 'Test OpenAI OAuth Account',
  accountType: 'openai',
  accessToken: encrypt('sk-test-openai-oauth-token'), // 加密存储
  accountId: 'chatgpt-account-123',
  chatgptUserId: 'chatgpt-user-456',
  baseApi: 'https://chatgpt.com/backend-api/codex',
  proxy: null,
  status: 'active',
  claudeModelMapping: {
    'claude-3-5-sonnet-20241022': 'gpt-4-turbo'
  }
}

// Mock OpenAI-Responses 账户（未加密的 API Key）
const mockOpenAIResponsesAccount = {
  id: 'test-openai-responses-id',
  name: 'Test OpenAI-Responses Account',
  accountType: 'openai-responses',
  accessToken: 'sk-test-openai-responses-token', // 直接存储
  apiKey: 'sk-test-openai-responses-token',
  baseApi: 'https://api.openai.com',
  proxy: 'socks5://127.0.0.1:1080',
  status: 'active',
  claudeModelMapping: null
}

// Mock Claude 官方账户
const mockClaudeOfficialAccount = {
  id: 'test-claude-official-id',
  name: 'Test Claude Official Account',
  accountType: 'claude-official',
  sessionKey: encrypt('sk-ant-test-session-key'),
  baseApi: 'https://api.anthropic.com',
  status: 'active'
}

// Mock Claude Console 账户
const mockClaudeConsoleAccount = {
  id: 'test-claude-console-id',
  name: 'Test Claude Console Account',
  accountType: 'claude-console',
  sessionKey: 'claude-console-session-key',
  apiKey: 'sk-ant-console-api-key', // Claude Console 需要 apiKey
  baseApi: 'https://api.claude.ai',
  status: 'active'
}

// Mock 不完整账户（缺失 accessToken）
const mockIncompleteAccount = {
  id: 'test-incomplete-id',
  name: 'Incomplete Account',
  accountType: 'openai',
  baseApi: 'https://chatgpt.com/backend-api/codex',
  status: 'active'
  // accessToken 缺失
}

module.exports = {
  mockOpenAIOAuthAccount,
  mockOpenAIResponsesAccount,
  mockClaudeOfficialAccount,
  mockClaudeConsoleAccount,
  mockIncompleteAccount,
  encrypt
}
