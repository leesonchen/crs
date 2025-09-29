const express = require('express')
const request = require('supertest')

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const mockCreateAccount = jest.fn()
const mockUpdateAccount = jest.fn()
const mockGetAccount = jest.fn()
const mockRefreshAccountToken = jest.fn()
const mockDeleteAccount = jest.fn()

jest.mock('../src/services/openaiAccountService', () => ({
  createAccount: (...args) => mockCreateAccount(...args),
  updateAccount: (...args) => mockUpdateAccount(...args),
  getAccount: (...args) => mockGetAccount(...args),
  refreshAccountToken: (...args) => mockRefreshAccountToken(...args),
  deleteAccount: (...args) => mockDeleteAccount(...args)
}))

jest.mock('../src/services/accountGroupService', () => ({
  addAccountToGroup: jest.fn(),
  getAccountGroup: jest.fn(),
  removeAccountFromGroup: jest.fn(),
  getAccountGroups: jest.fn(),
  getGroupMembers: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  unbindAccountFromAllKeys: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getAccountUsageStats: jest.fn(async () => ({
    daily: { requests: 0, tokens: 0, allTokens: 0 },
    total: { requests: 0, tokens: 0, allTokens: 0 },
    monthly: { requests: 0, tokens: 0, allTokens: 0 }
  }))
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => {
    req.admin = { id: 'admin-test' }
    next()
  }
}))

const adminRouter = require('../src/routes/admin')

describe('Admin OpenAI account routes', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/', adminRouter)
    return app
  }

  beforeEach(() => {
    mockCreateAccount.mockReset()
    mockUpdateAccount.mockReset()
    mockGetAccount.mockReset()
    mockRefreshAccountToken.mockReset()
  })

  test('creates OpenAI account with Claude bridge fields', async () => {
    mockCreateAccount.mockResolvedValue({
      id: 'acc-1',
      allowClaudeBridge: 'true',
      claudeModelMapping: JSON.stringify({ 'claude-3-haiku': 'gpt-4.1-mini' })
    })

    const app = buildApp()

    const payload = {
      name: 'Bridge Account',
      allowClaudeBridge: true,
      claudeModelMapping: {
        'claude-3-haiku': 'gpt-4.1-mini'
      }
    }

    const res = await request(app).post('/openai-accounts').send(payload)

    expect(res.status).toBe(200)
    expect(mockCreateAccount).toHaveBeenCalledTimes(1)
    const accountData = mockCreateAccount.mock.calls[0][0]
    expect(accountData.allowClaudeBridge).toBe(true)
    expect(accountData.claudeModelMapping).toEqual({
      'claude-3-haiku': 'gpt-4.1-mini'
    })
  })

  test('updates OpenAI account with Claude bridge fields', async () => {
    mockGetAccount.mockResolvedValue({ id: 'acc-1', accountType: 'shared' })
    mockUpdateAccount.mockResolvedValue({ id: 'acc-1' })

    const app = buildApp()

    const payload = {
      allowClaudeBridge: false,
      claudeModelMapping: {
        'claude-3-sonnet': 'gpt-5'
      }
    }

    const res = await request(app).put('/openai-accounts/acc-1').send(payload)

    expect(res.status).toBe(200)
    expect(mockUpdateAccount).toHaveBeenCalledTimes(1)
    expect(mockUpdateAccount).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      allowClaudeBridge: false,
      claudeModelMapping: {
        'claude-3-sonnet': 'gpt-5'
      }
    }))
  })
})
