jest.mock('uuid', () => ({
  v4: jest.fn(() => 'acc-123')
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/models/redis', () => {
  const store = new Map()
  const setStore = new Map()
  const kvStore = new Map()

  const client = {
    hset: jest.fn(async (key, values) => {
      const existing = store.get(key) || {}
      store.set(key, { ...existing, ...values })
    }),
    hgetall: jest.fn(async (key) => {
      const value = store.get(key)
      return value ? { ...value } : {}
    }),
    sadd: jest.fn(async (key, value) => {
      const set = setStore.get(key) || new Set()
      set.add(value)
      setStore.set(key, set)
    }),
    srem: jest.fn(async (key, value) => {
      const set = setStore.get(key)
      if (set) {
        set.delete(value)
      }
    }),
    keys: jest.fn(async (pattern) => {
      if (!pattern.endsWith('*')) {
        return store.has(pattern) ? [pattern] : []
      }
      const prefix = pattern.slice(0, -1)
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix))
    }),
    del: jest.fn(async (key) => {
      const existed = store.delete(key)
      setStore.delete(key)
      kvStore.delete(key)
      return existed ? 1 : 0
    }),
    get: jest.fn(async (key) => kvStore.get(key)),
    set: jest.fn(async (key, value) => {
      kvStore.set(key, value)
      return 'OK'
    })
  }

  return {
    getClientSafe: () => client,
    getClient: () => client,
    getDateStringInTimezone: jest.fn(() => '2025-09-25'),
    __store: store,
    __setStore: setStore,
    __kvStore: kvStore,
    __reset: () => {
      store.clear()
      setStore.clear()
      kvStore.clear()
    }
  }
})

const redisMock = require('../src/models/redis')
const openaiAccountService = require('../src/services/openaiAccountService')

const baseAccountPayload = {
  name: 'Test OpenAI',
  description: 'demo',
  accountType: 'shared',
  priority: 10,
  rateLimitDuration: 45,
  openaiOauth: {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expires_in: 3600
  },
  accountInfo: {
    email: 'user@example.com'
  },
  proxy: null,
  isActive: true,
  schedulable: true
}

describe('openaiAccountService Claude bridge fields', () => {
  beforeEach(() => {
    redisMock.__reset()
  })

  test('createAccount sets default Claude bridge flags', async () => {
    const account = await openaiAccountService.createAccount(baseAccountPayload)

    expect(account.allowClaudeBridge).toBe('false')
    expect(account.claudeModelMapping).toBe('')

    const stored = await openaiAccountService.getAccount(account.id)
    expect(stored.allowClaudeBridge).toBe(false)
    expect(stored.claudeModelMapping).toEqual({})
  })

  test('updateAccount persists Claude bridge configuration', async () => {
    await openaiAccountService.createAccount(baseAccountPayload)

    await openaiAccountService.updateAccount('acc-123', {
      allowClaudeBridge: true,
      claudeModelMapping: {
        'claude-3-haiku': 'gpt-4.1-mini',
        'claude-3-sonnet': 'gpt-5'
      }
    })

    const updated = await openaiAccountService.getAccount('acc-123')
    expect(updated.allowClaudeBridge).toBe(true)
    expect(updated.claudeModelMapping).toEqual({
      'claude-3-haiku': 'gpt-4.1-mini',
      'claude-3-sonnet': 'gpt-5'
    })
  })
})
