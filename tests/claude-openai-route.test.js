const express = require('express')
const request = require('supertest')

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const mockSelectAccountForApiKey = jest.fn()
jest.mock('../src/services/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: (...args) => mockSelectAccountForApiKey(...args)
}))

const mockGetAccount = jest.fn()
jest.mock('../src/services/openaiResponsesAccountService', () => ({
  getAccount: (...args) => mockGetAccount(...args)
}))

const mockHandleRequest = jest.fn()
jest.mock('../src/services/openaiResponsesRelayService', () => ({
  handleRequest: (...args) => mockHandleRequest(...args)
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (req, res, next) => {
    req.apiKey = { name: 'local', permissions: 'claude' }
    req.requestId = 'test-request-id'
    next()
  }
}))

const router = require('../src/routes/claudeOpenaiBridge')

describe('POST /claude/openai/v1/messages', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/claude/openai', router)
    return app
  }

  beforeEach(() => {
    mockSelectAccountForApiKey.mockReset()
    mockGetAccount.mockReset()
    mockHandleRequest.mockReset()
  })

  test('forwards converted request to relay service with forced stream', async () => {
    mockSelectAccountForApiKey.mockResolvedValue({
      accountType: 'openai-responses',
      accountId: 'account-1'
    })
    mockGetAccount.mockResolvedValue({ id: 'account-1', name: 'test-account' })
    mockHandleRequest.mockImplementation(async (req, res) => {
      res.status(200).json({ ok: true })
    })

    const app = buildApp()

    const response = await request(app)
      .post('/claude/openai/v1/messages')
      .send({
        model: 'claude-3-sonnet',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'ping'
              }
            ]
          }
        ]
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })

    expect(mockSelectAccountForApiKey).toHaveBeenCalledWith(
      { name: 'local', permissions: 'claude' },
      null,
      'gpt-5'
    )
    expect(mockGetAccount).toHaveBeenCalledWith('account-1')
    expect(mockHandleRequest).toHaveBeenCalledTimes(1)

    const forwardedReq = mockHandleRequest.mock.calls[0][0]
    expect(forwardedReq._bridgeForceNonStream).toBe(true)
    expect(forwardedReq._bridgeNonStreamConvert).toEqual(expect.any(Function))
    expect(forwardedReq.body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      input: expect.any(Array)
    })
    expect(forwardedReq.headers['x-crs-upstream-path']).toBe('/v1/responses')
  })

  test('returns 503 when no openai-responses account available', async () => {
    mockSelectAccountForApiKey.mockResolvedValue(null)

    const app = buildApp()

    const response = await request(app)
      .post('/claude/openai/v1/messages')
      .send({
        model: 'claude-3-sonnet',
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'ping'
              }
            ]
          }
        ]
      })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: { message: 'No OpenAI-Responses account available for bridge' }
    })
  })
})
