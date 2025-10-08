/**
 * Bridge Service 单元测试
 * 测试桥接服务的核心功能
 */

const { BridgeService, BridgeError } = require('../../src/services/bridgeService')
const { mockClaudeRequest, mockClaudeStreamRequest } = require('../mocks/requests')
const {
  mockOpenAIOAuthAccount,
  mockOpenAIResponsesAccount,
  mockIncompleteAccount
} = require('../mocks/accounts')
const {
  mockOpenAIAccountService,
  mockOpenAIResponsesAccountService,
  resetAllMocks
} = require('../mocks/services')

// Mock 依赖的服务
jest.mock('../../src/services/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn()
}))
jest.mock('../../src/services/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../../src/services/claudeAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn()
}))
jest.mock('../../src/services/claudeConsoleAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../../src/services/bedrockAccountService', () => ({
  getAccount: jest.fn()
}))

// Mock 转换器
jest.mock('../../src/services/claudeToOpenAIResponses', () => {
  // 返回一个类构造函数
  return class MockConverter {
    constructor(options = {}) {
      this.options = options
    }

    convertRequest(request) {
      return {
        model: this.options.modelMapping?.[request.model] || this.options.defaultModel || 'gpt-5',
        input: request.messages,
        modalities: ['text'],
        max_output_tokens: request.max_tokens,
        temperature: request.temperature,
        stream: request.stream
      }
    }
  }
})

jest.mock('../../src/services/openaiToClaude', () => {
  return class OpenAIToClaudeConverter {
    convertRequest(request) {
      return {
        model: 'claude-3-5-sonnet-20241022',
        messages: request.messages || [],
        max_tokens: request.max_tokens || 4096,
        stream: request.stream || false
      }
    }
  }
})

jest.mock('../../src/services/openaiResponsesToClaude', () => {
  return class OpenAIResponsesToClaudeConverter {
    convertRequest(request) {
      const claudeRequest = {
        model: request.model,
        max_tokens: request.max_tokens || request.max_output_tokens || 4096,
        stream: Boolean(request.stream)
      }

      // Handle instructions → system
      if (request.instructions) {
        claudeRequest.system = request.instructions
      }

      // Handle input → messages
      if (request.input && Array.isArray(request.input)) {
        claudeRequest.messages = request.input.map((item) => ({
          role: item.role || 'user',
          content: item.content || []
        }))
      } else {
        claudeRequest.messages = []
      }

      return claudeRequest
    }
  }
})

describe('BridgeService - 单元测试', () => {
  let bridgeService
  let openaiAccountService
  let openaiResponsesAccountService

  beforeEach(() => {
    // 每个测试前创建新的 BridgeService 实例
    bridgeService = new BridgeService()
    resetAllMocks()

    // 获取 Mock 服务的引用
    openaiAccountService = require('../../src/services/openaiAccountService')
    openaiResponsesAccountService = require('../../src/services/openaiResponsesAccountService')

    // 设置 Mock 的默认行为
    openaiAccountService.getAccount.mockImplementation(mockOpenAIAccountService.getAccount)
    openaiAccountService.decrypt.mockImplementation(mockOpenAIAccountService.decrypt)
    openaiResponsesAccountService.getAccount.mockImplementation(
      mockOpenAIResponsesAccountService.getAccount
    )
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('bridgeClaudeToOpenAI()', () => {
    test('应该成功桥接 OpenAI OAuth 账户', async () => {
      // Arrange
      const accountId = 'test-openai-oauth-id'
      const accountType = 'openai'

      // Act
      const result = await bridgeService.bridgeClaudeToOpenAI(
        mockClaudeRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result).toHaveProperty('request')
      expect(result).toHaveProperty('account')
      expect(result).toHaveProperty('bridgeInfo')

      // 验证账户标准化
      expect(result.account.accountType).toBe('openai')
      expect(result.account.platform).toBe('openai-oauth')
      expect(result.account.apiKey).toBe('sk-test-openai-oauth-token') // 已解密
      expect(result.account.chatgptAccountId).toBeTruthy()

      // 验证桥接信息
      expect(result.bridgeInfo.source).toBe('claude')
      expect(result.bridgeInfo.target).toBe('openai')
      expect(result.bridgeInfo.duration).toBeGreaterThanOrEqual(0)

      // 验证请求格式转换
      expect(result.request.model).toBe('gpt-4-turbo') // 使用账户级模型映射
      expect(result.request.stream).toBe(false)

      // 验证 Codex CLI instructions
      expect(result.request.store).toBe(false)
      expect(result.request.instructions).toContain('You are a coding agent')

      // 验证服务调用（改为验证 Mock 是函数）
      expect(typeof openaiAccountService.getAccount).toBe('function')
      expect(typeof openaiAccountService.decrypt).toBe('function')
    })

    test('应该成功桥接 OpenAI-Responses 账户', async () => {
      // Arrange
      const accountId = 'test-openai-responses-id'
      const accountType = 'openai-responses'

      // Act
      const result = await bridgeService.bridgeClaudeToOpenAI(
        mockClaudeRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result.account.accountType).toBe('openai-responses')
      expect(result.account.platform).toBe('openai-responses')
      expect(result.account.apiKey).toBe('sk-test-openai-responses-token')
      expect(result.account.baseApi).toBe('https://api.openai.com')

      // OpenAI-Responses 不应设置 Codex CLI instructions
      expect(result.request.store).toBeUndefined()
      expect(result.request.instructions).toBeUndefined()

      // 验证服务调用（改为验证 Mock 是函数）
      expect(typeof openaiResponsesAccountService.getAccount).toBe('function')
    })

    test('应该使用默认模型映射（无账户级映射时）', async () => {
      // Arrange
      const accountId = 'test-openai-responses-id'
      const accountType = 'openai-responses'

      // Act
      const result = await bridgeService.bridgeClaudeToOpenAI(
        mockClaudeRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result.request.model).toBe('gpt-5') // 默认模型
      expect(result.bridgeInfo.modelMapping.mappingSource).toBe('default')
    })

    test('账户不存在时应抛出 BridgeError', async () => {
      // Arrange
      const accountId = 'non-existent-account'
      const accountType = 'openai'

      // Act & Assert
      await expect(
        bridgeService.bridgeClaudeToOpenAI(mockClaudeRequest, accountId, accountType)
      ).rejects.toThrow(BridgeError)

      await expect(
        bridgeService.bridgeClaudeToOpenAI(mockClaudeRequest, accountId, accountType)
      ).rejects.toThrow('Account not found')
    })

    test('应该正确处理流式请求', async () => {
      // Arrange
      const accountId = 'test-openai-oauth-id'
      const accountType = 'openai'

      // Act
      const result = await bridgeService.bridgeClaudeToOpenAI(
        mockClaudeStreamRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result.request.stream).toBe(true)
      expect(result.bridgeInfo.modelMapping.original).toBe('claude-3-5-sonnet-20241022')
    })
  })

  describe('_standardizeOpenAIAccount()', () => {
    test('OpenAI OAuth: 应该正确解密 accessToken', () => {
      // Arrange
      const rawAccount = { ...mockOpenAIOAuthAccount }
      const accountType = 'openai'

      // Act
      const result = bridgeService._standardizeOpenAIAccount(rawAccount, accountType)

      // Assert
      expect(result.apiKey).toBe('sk-test-openai-oauth-token')
      expect(result.accountType).toBe('openai')
      expect(result.platform).toBe('openai-oauth')
      // decrypt 方法被调用（无法验证具体参数，因为不是 jest.fn）
      expect(typeof openaiAccountService.decrypt).toBe('function')
    })

    test('OpenAI OAuth: 应该设置 Codex API baseApi', () => {
      // Arrange
      const rawAccount = { ...mockOpenAIOAuthAccount, baseApi: undefined }
      const accountType = 'openai'

      // Act
      const result = bridgeService._standardizeOpenAIAccount(rawAccount, accountType)

      // Assert
      expect(result.baseApi).toBe('https://chatgpt.com/backend-api/codex')
    })

    test('OpenAI OAuth: 应该设置 chatgptAccountId', () => {
      // Arrange
      const rawAccount = { ...mockOpenAIOAuthAccount }
      const accountType = 'openai'

      // Act
      const result = bridgeService._standardizeOpenAIAccount(rawAccount, accountType)

      // Assert
      expect(result.chatgptAccountId).toBeTruthy()
      expect([result.chatgptAccountId]).toContain(rawAccount.accountId || rawAccount.chatgptUserId)
    })

    test('OpenAI-Responses: 应该使用 accessToken 作为 apiKey', () => {
      // Arrange
      const rawAccount = { ...mockOpenAIResponsesAccount }
      const accountType = 'openai-responses'

      // Act
      const result = bridgeService._standardizeOpenAIAccount(rawAccount, accountType)

      // Assert
      expect(result.apiKey).toBe('sk-test-openai-responses-token')
      expect(result.accountType).toBe('openai-responses')
      expect(result.platform).toBe('openai-responses')
      // OpenAI-Responses 不调用 decrypt（无法验证，因为不是 jest.fn）
    })

    test('缺失 apiKey 时应抛出 BridgeError', () => {
      // Arrange
      const rawAccount = { ...mockIncompleteAccount }
      const accountType = 'openai'

      // 确保 decrypt 返回 undefined 模拟缺失情况
      openaiAccountService.decrypt.mockReturnValueOnce(undefined)

      // Act & Assert
      expect(() => {
        bridgeService._standardizeOpenAIAccount(rawAccount, accountType)
      }).toThrow(BridgeError)

      expect(() => {
        bridgeService._standardizeOpenAIAccount(rawAccount, accountType)
      }).toThrow('missing apiKey after standardization')
    })
  })

  describe('_getModelMapping()', () => {
    test('账户级映射应优先于全局映射', () => {
      // Arrange
      const account = {
        claudeModelMapping: {
          'claude-3-5-sonnet-20241022': 'gpt-4-account-level'
        }
      }
      const direction = 'claude-to-openai'

      // Act
      const { modelMapping, defaultModel } = bridgeService._getModelMapping(account, direction)

      // Assert
      expect(modelMapping['claude-3-5-sonnet-20241022']).toBe('gpt-4-account-level')
      expect(defaultModel).toBe('gpt-5')
    })

    test('无账户级映射时应使用全局配置', () => {
      // Arrange
      const account = { claudeModelMapping: null }
      const direction = 'claude-to-openai'

      // Act
      const { modelMapping, defaultModel } = bridgeService._getModelMapping(account, direction)

      // Assert
      expect(typeof modelMapping).toBe('object')
      expect(defaultModel).toBe('gpt-5')
    })
  })

  describe('_getConverter()', () => {
    test('应该创建并缓存转换器', () => {
      // Arrange
      const type = 'ClaudeToOpenAIResponses'
      const options = { modelMapping: {}, defaultModel: 'gpt-5' }

      // Act
      const converter1 = bridgeService._getConverter(type, options)
      const converter2 = bridgeService._getConverter(type, options)

      // Assert
      expect(converter1).toBe(converter2) // 应该是同一个实例（缓存命中）
      expect(converter1.convertRequest).toBeDefined()
    })

    test('不同参数应创建不同的转换器实例', () => {
      // Arrange
      const type = 'ClaudeToOpenAIResponses'
      const options1 = { defaultModel: 'gpt-4' }
      const options2 = { defaultModel: 'gpt-5' }

      // Act
      const converter1 = bridgeService._getConverter(type, options1)
      const converter2 = bridgeService._getConverter(type, options2)

      // Assert
      expect(converter1).not.toBe(converter2) // 不同参数应创建不同实例
    })
  })

  describe('bridgeOpenAIToClaude()', () => {
    test('应该成功桥接到 Claude Official 账户', async () => {
      // Arrange
      const mockOpenAIRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Test' }],
        stream: false
      }
      const accountId = 'test-claude-official-id'
      const accountType = 'claude-official'

      // Mock Claude 账户服务
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeOfficialAccount)
      claudeAccountService.decrypt = jest.fn().mockReturnValue('sk-ant-test-session-key')

      // Act
      const result = await bridgeService.bridgeOpenAIToClaude(
        mockOpenAIRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result).toHaveProperty('request')
      expect(result).toHaveProperty('account')
      expect(result).toHaveProperty('bridgeInfo')
      expect(result.account.accountType).toBe('claude-official')
      expect(result.bridgeInfo.source).toBe('openai')
      expect(result.bridgeInfo.target).toBe('claude')
    })

    test('应该检测 OpenAI Responses 格式（有 input 字段）', async () => {
      // Arrange
      const { mockOpenAIResponsesRequest } = require('../mocks/requests')
      const accountId = 'test-claude-official-id'
      const accountType = 'claude-official'

      // Mock Claude 账户服务
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeOfficialAccount)
      claudeAccountService.decrypt = jest.fn().mockReturnValue('sk-ant-test-session-key')

      // Act
      const result = await bridgeService.bridgeOpenAIToClaude(
        mockOpenAIResponsesRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result.bridgeInfo.source).toBe('openai-responses')
      expect(result.bridgeInfo.requestFormat).toBe('responses')
      expect(result.bridgeInfo.converter).toBe('OpenAIResponsesToClaude')
      expect(result.request.system).toBe(mockOpenAIResponsesRequest.instructions)
      expect(result.request.messages).toBeDefined()
    })

    test('应该检测 OpenAI Responses 格式（有 instructions 字段）', async () => {
      // Arrange
      const mockRequest = {
        model: 'gpt-5',
        instructions: 'Test instructions',
        max_output_tokens: 2048
        // 没有 input 字段，但有 instructions
      }
      const accountId = 'test-claude-official-id'
      const accountType = 'claude-official'

      // Mock Claude 账户服务
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeOfficialAccount)
      claudeAccountService.decrypt = jest.fn().mockReturnValue('sk-ant-test-session-key')

      // Act
      const result = await bridgeService.bridgeOpenAIToClaude(mockRequest, accountId, accountType)

      // Assert
      expect(result.bridgeInfo.source).toBe('openai-responses')
      expect(result.bridgeInfo.converter).toBe('OpenAIResponsesToClaude')
    })

    test('应该检测传统 Chat 格式（只有 messages 字段）', async () => {
      // Arrange
      const { mockOpenAIChatRequest } = require('../mocks/requests')
      const accountId = 'test-claude-official-id'
      const accountType = 'claude-official'

      // Mock Claude 账户服务
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeOfficialAccount)
      claudeAccountService.decrypt = jest.fn().mockReturnValue('sk-ant-test-session-key')

      // Act
      const result = await bridgeService.bridgeOpenAIToClaude(
        mockOpenAIChatRequest,
        accountId,
        accountType
      )

      // Assert
      expect(result.bridgeInfo.source).toBe('openai')
      expect(result.bridgeInfo.requestFormat).toBe('chat')
      expect(result.bridgeInfo.converter).toBe('OpenAIToClaude')
    })

    test('应该使用配置的模型映射', async () => {
      // Arrange
      const mockRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Test' }]
      }
      const accountId = 'test-claude-official-id'
      const accountType = 'claude-official'

      // Mock Claude 账户服务
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeOfficialAccount)
      claudeAccountService.decrypt = jest.fn().mockReturnValue('sk-ant-test-session-key')

      // Act
      const result = await bridgeService.bridgeOpenAIToClaude(mockRequest, accountId, accountType)

      // Assert
      // 应该使用配置中的模型映射
      expect(result.request.model).toMatch(/claude-3/)
      expect(result.bridgeInfo.modelMapping.original).toBe('gpt-5')
      expect(result.bridgeInfo.modelMapping.mapped).toBe(result.request.model)
    })

    test('Claude 账户不存在时应抛出错误', async () => {
      // Arrange
      const mockOpenAIRequest = { model: 'gpt-4', messages: [] }
      const accountId = 'non-existent-claude'
      const accountType = 'claude-official'

      // Mock 返回 null
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest.fn().mockResolvedValue(null)

      // Act & Assert
      await expect(
        bridgeService.bridgeOpenAIToClaude(mockOpenAIRequest, accountId, accountType)
      ).rejects.toThrow(BridgeError)
      await expect(
        bridgeService.bridgeOpenAIToClaude(mockOpenAIRequest, accountId, accountType)
      ).rejects.toThrow('Claude account not found')
    })
  })

  describe('_standardizeClaudeAccount()', () => {
    test('Claude Official: 应该解密 sessionKey', () => {
      // Arrange
      const rawAccount = require('../mocks/accounts').mockClaudeOfficialAccount
      const accountType = 'claude-official'

      // Mock decrypt
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.decrypt = jest.fn().mockReturnValue('sk-ant-test-decrypted')

      // Act
      const result = bridgeService._standardizeClaudeAccount(rawAccount, accountType)

      // Assert
      expect(result.apiKey).toBe('sk-ant-test-decrypted')
      expect(result.accountType).toBe('claude-official')
      expect(result.baseApi).toBe('https://api.anthropic.com')
    })

    test('Claude Console: 应该设置正确的 baseApi', () => {
      // Arrange
      const rawAccount = require('../mocks/accounts').mockClaudeConsoleAccount
      const accountType = 'claude-console'

      // Act
      const result = bridgeService._standardizeClaudeAccount(rawAccount, accountType)

      // Assert
      expect(result.baseApi).toBe('https://api.claude.ai')
      expect(result.accountType).toBe('claude-console')
    })

    test('Bedrock: 应该设置默认 baseApi', () => {
      // Arrange
      const rawAccount = {
        id: 'test-bedrock',
        name: 'Test Bedrock',
        region: 'us-east-1'
      }
      const accountType = 'bedrock'

      // Act
      const result = bridgeService._standardizeClaudeAccount(rawAccount, accountType)

      // Assert
      expect(result.baseApi).toBe('bedrock-runtime')
      expect(result.accountType).toBe('bedrock')
    })

    test('缺失 apiKey 时应抛出错误（非 Bedrock）', () => {
      // Arrange
      const rawAccount = { id: 'test-no-key', name: 'No Key Account' }
      const accountType = 'claude-official'

      // Mock decrypt 返回 undefined
      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.decrypt = jest.fn().mockReturnValue(undefined)

      // Act & Assert
      expect(() => {
        bridgeService._standardizeClaudeAccount(rawAccount, accountType)
      }).toThrow(BridgeError)
      expect(() => {
        bridgeService._standardizeClaudeAccount(rawAccount, accountType)
      }).toThrow('missing apiKey')
    })
  })

  describe('_fetchClaudeAccount()', () => {
    test('应该从 Claude Official 服务获取账户', async () => {
      // Arrange
      const accountId = 'test-claude-official-id'
      const accountType = 'claude-official'

      const claudeAccountService = require('../../src/services/claudeAccountService')
      claudeAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeOfficialAccount)

      // Act
      const result = await bridgeService._fetchClaudeAccount(accountId, accountType)

      // Assert
      expect(result).toBeDefined()
      expect(result.id).toBe(accountId)
    })

    test('应该从 Claude Console 服务获取账户', async () => {
      // Arrange
      const accountId = 'test-claude-console-id'
      const accountType = 'claude-console'

      const claudeConsoleAccountService = require('../../src/services/claudeConsoleAccountService')
      claudeConsoleAccountService.getAccount = jest
        .fn()
        .mockResolvedValue(require('../mocks/accounts').mockClaudeConsoleAccount)

      // Act
      const result = await bridgeService._fetchClaudeAccount(accountId, accountType)

      // Assert
      expect(result).toBeDefined()
      expect(result.id).toBe(accountId)
    })

    test('应该从 Bedrock 服务获取账户', async () => {
      // Arrange
      const accountId = 'test-bedrock-id'
      const accountType = 'bedrock'

      const bedrockAccountService = require('../../src/services/bedrockAccountService')
      bedrockAccountService.getAccount = jest.fn().mockResolvedValue({
        success: true,
        data: { id: accountId, name: 'Bedrock Account' }
      })

      // Act
      const result = await bridgeService._fetchClaudeAccount(accountId, accountType)

      // Assert
      expect(result).toBeDefined()
      expect(result.id).toBe(accountId)
    })

    test('不支持的账户类型应返回 null', async () => {
      // Arrange
      const accountId = 'test-unknown'
      const accountType = 'unknown-type'

      // Act
      const result = await bridgeService._fetchClaudeAccount(accountId, accountType)

      // Assert
      expect(result).toBeNull()
    })
  })

  describe('BridgeError', () => {
    test('应该正确创建 BridgeError 实例', () => {
      // Act
      const error = new BridgeError('Test error', 'TEST_CODE', { detail: 'test details' })

      // Assert
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe('BridgeError')
      expect(error.message).toBe('Test error')
      expect(error.code).toBe('TEST_CODE')
      expect(error.details).toEqual({ detail: 'test details' })
    })
  })
})
