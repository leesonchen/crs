/**
 * 账户管理测试工具函数
 * 用于测试账户启用/停用功能
 */

const axios = require('axios')
const fs = require('fs').promises
const path = require('path')

class AccountTestUtils {
  constructor(config) {
    this.config = config
    this.baseURL = config.baseURL
    this.adminToken = config.adminToken
    this.apiKey = config.apiKey
    this.timeout = config.timeout || 30000

    // 创建axios实例
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    })
  }

  /**
   * 获取管理员JWT token
   */
  async getAdminToken() {
    try {
      const response = await this.httpClient.post('/auth/login', {
        username: this.config.adminUsername,
        password: this.config.adminPassword
      })

      if (response.data && response.data.token) {
        return response.data.token
      }
      throw new Error('Failed to get admin token from response')
    } catch (error) {
      console.error('❌ Failed to get admin token:', error.message)
      throw error
    }
  }

  /**
   * 获取所有类型的账户列表
   */
  async getAllAccounts() {
    const token = await this.getAdminToken()

    // 并行获取所有账户类型
    const [
      claudeAccounts,
      claudeConsoleAccounts,
      openaiAccounts,
      openaiResponsesAccounts,
      geminiAccounts,
      azureOpenaiAccounts
    ] = await Promise.allSettled([
      this._getAccounts('/admin/claude-accounts', token),
      this._getAccounts('/admin/claude-console-accounts', token),
      this._getAccounts('/admin/openai-accounts', token),
      this._getAccounts('/admin/openai-responses-accounts', token),
      this._getAccounts('/admin/gemini-accounts', token),
      this._getAccounts('/admin/azure-openai-accounts', token)
    ])

    return {
      claude: claudeAccounts.status === 'fulfilled' ? claudeAccounts.value : [],
      claudeConsole:
        claudeConsoleAccounts.status === 'fulfilled' ? claudeConsoleAccounts.value : [],
      openai: openaiAccounts.status === 'fulfilled' ? openaiAccounts.value : [],
      openaiResponses:
        openaiResponsesAccounts.status === 'fulfilled' ? openaiResponsesAccounts.value : [],
      gemini: geminiAccounts.status === 'fulfilled' ? geminiAccounts.value : [],
      azureOpenai: azureOpenaiAccounts.status === 'fulfilled' ? azureOpenaiAccounts.value : []
    }
  }

  /**
   * 内部方法：获取特定类型的账户
   */
  async _getAccounts(endpoint, token) {
    try {
      const response = await this.httpClient.get(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
      return response.data.data || response.data || []
    } catch (error) {
      console.error(`❌ Failed to get accounts from ${endpoint}:`, error.message)
      return []
    }
  }

  /**
   * 停用账户
   */
  async disableAccount(accountType, accountId) {
    const token = await this.getAdminToken()
    const endpoint = this._getToggleEndpoint(accountType, accountId)

    try {
      const response = await this.httpClient.put(
        endpoint,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )

      return {
        success: true,
        accountType,
        accountId,
        schedulable: response.data.schedulable,
        message: `Account ${accountId} disabled successfully`
      }
    } catch (error) {
      console.error(`❌ Failed to disable ${accountType} account ${accountId}:`, error.message)
      return {
        success: false,
        accountType,
        accountId,
        error: error.message
      }
    }
  }

  /**
   * 启用账户
   */
  async enableAccount(accountType, accountId) {
    const token = await this.getAdminToken()
    const endpoint = this._getToggleEndpoint(accountType, accountId)

    try {
      const response = await this.httpClient.put(
        endpoint,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      )

      return {
        success: true,
        accountType,
        accountId,
        schedulable: response.data.schedulable,
        message: `Account ${accountId} enabled successfully`
      }
    } catch (error) {
      console.error(`❌ Failed to enable ${accountType} account ${accountId}:`, error.message)
      return {
        success: false,
        accountType,
        accountId,
        error: error.message
      }
    }
  }

  /**
   * 获取账户切换端点
   */
  _getToggleEndpoint(accountType, accountId) {
    const endpoints = {
      claude: `/admin/claude-accounts/${accountId}/toggle-schedulable`,
      claudeConsole: `/admin/claude-console-accounts/${accountId}/toggle-schedulable`,
      openai: `/admin/openai-accounts/${accountId}/toggle-schedulable`,
      openaiResponses: `/admin/openai-responses-accounts/${accountId}/toggle-schedulable`,
      gemini: `/admin/gemini-accounts/${accountId}/toggle-schedulable`,
      azureOpenai: `/admin/azure-openai-accounts/${accountId}/toggle-schedulable`
    }

    const endpoint = endpoints[accountType]
    if (!endpoint) {
      throw new Error(`Unknown account type: ${accountType}`)
    }

    return endpoint
  }

  /**
   * 批量停用所有账户
   */
  async disableAllAccounts() {
    console.log('🔄 Disabling all accounts...')
    const accounts = await this.getAllAccounts()
    const results = []

    // 遍历所有账户类型
    for (const [accountType, accountList] of Object.entries(accounts)) {
      for (const account of accountList) {
        const result = await this.disableAccount(accountType, account.id)
        results.push(result)

        // 添加延迟避免API限制
        await this._sleep(100)
      }
    }

    const successful = results.filter((r) => r.success).length
    const failed = results.filter((r) => !r.success).length

    console.log(`✅ Disabled ${successful} accounts, ${failed} failed`)
    return results
  }

  /**
   * 启用单个账户并测试
   */
  async enableAndTestAccount(accountType, account) {
    console.log(`🧪 Testing ${accountType} account: ${account.name || account.id}`)

    // 1. 启用账户
    const enableResult = await this.enableAccount(accountType, account.id)
    if (!enableResult.success) {
      return {
        accountType,
        account,
        enableResult,
        apiTests: [],
        bridgeTests: [],
        error: 'Failed to enable account'
      }
    }

    // 等待状态同步
    await this._sleep(500)

    // 2. 测试API调用
    const apiTests = await this._testAPICalls(accountType, account)

    // 3. 测试桥接调用（如果支持）
    const bridgeTests = await this._testBridgeCalls(accountType, account)

    return {
      accountType,
      account,
      enableResult,
      apiTests,
      bridgeTests,
      summary: {
        apiTestsSuccess: apiTests.filter((t) => t.success).length,
        apiTestsTotal: apiTests.length,
        bridgeTestsSuccess: bridgeTests.filter((t) => t.success).length,
        bridgeTestsTotal: bridgeTests.length
      }
    }
  }

  /**
   * 测试API调用
   */
  async _testAPICalls(accountType, _account) {
    const tests = []

    try {
      if (accountType === 'claude') {
        // Claude API测试
        tests.push(await this._testClaudeAPI())
      } else if (accountType === 'claudeConsole') {
        // Claude Console API测试
        tests.push(await this._testClaudeAPI())
      } else if (accountType === 'openai' || accountType === 'openaiResponses') {
        // OpenAI API测试
        tests.push(await this._testOpenAIAPI())
      } else if (accountType === 'gemini') {
        // Gemini API测试
        tests.push(await this._testGeminiAPI())
      } else if (accountType === 'azureOpenai') {
        // Azure OpenAI API测试
        tests.push(await this._testOpenAIAPI())
      }
    } catch (error) {
      tests.push({
        success: false,
        error: error.message,
        type: 'api'
      })
    }

    return tests
  }

  /**
   * 测试桥接调用
   */
  async _testBridgeCalls(accountType, _account) {
    const tests = []

    try {
      // 测试Claude→OpenAI桥接
      if (accountType === 'claude' || accountType === 'claudeConsole') {
        tests.push(await this._testClaudeToOpenAIBridge())
      }

      // 测试OpenAI→Claude桥接
      if (
        accountType === 'openai' ||
        accountType === 'openaiResponses' ||
        accountType === 'azureOpenai'
      ) {
        tests.push(await this._testOpenAIToClaudeBridge())
      }
    } catch (error) {
      tests.push({
        success: false,
        error: error.message,
        type: 'bridge'
      })
    }

    return tests
  }

  /**
   * 测试Claude API
   */
  async _testClaudeAPI() {
    const requestBody = {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: 'Hello, this is a test message.'
        }
      ]
    }

    try {
      const response = await this.httpClient.post('/api/v1/messages', requestBody, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        }
      })

      return {
        success: true,
        type: 'claude-api',
        status: response.status,
        model: response.data.model,
        usage: response.data.usage
      }
    } catch (error) {
      return {
        success: false,
        type: 'claude-api',
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    }
  }

  /**
   * 测试OpenAI API
   */
  async _testOpenAIAPI() {
    const requestBody = {
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'user',
          content: 'Hello, this is a test message.'
        }
      ],
      truncation: 'auto',
      tools: [
        {
          type: 'web_search'
        }
      ]
    }

    try {
      const response = await this.httpClient.post('/openai/responses', requestBody, {
        headers: {
          'x-api-key': this.apiKey
        }
      })

      return {
        success: true,
        type: 'openai-api',
        status: response.status,
        model: response.data.model,
        usage: response.data.usage
      }
    } catch (error) {
      return {
        success: false,
        type: 'openai-api',
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    }
  }

  /**
   * 测试Gemini API
   */
  async _testGeminiAPI() {
    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: 'Hello, this is a test message.'
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.7
      }
    }

    try {
      const response = await this.httpClient.post(
        '/gemini/v1beta/models/gemini-pro:generateContent',
        requestBody,
        {
          headers: {
            'x-api-key': this.apiKey
          }
        }
      )

      return {
        success: true,
        type: 'gemini-api',
        status: response.status,
        model: 'gemini-pro',
        usage: response.data.usageMetadata
      }
    } catch (error) {
      return {
        success: false,
        type: 'gemini-api',
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    }
  }

  /**
   * 测试Claude→OpenAI桥接
   */
  async _testClaudeToOpenAIBridge() {
    const requestBody = {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: 'Hello, this is a bridge test message.'
        }
      ]
    }

    try {
      const response = await this.httpClient.post('/api/v1/messages', requestBody, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        }
      })

      // 检查是否使用了桥接（通过响应中的模型或特殊标记）
      const isBridged = response.data.model && response.data.model.startsWith('gpt-')

      return {
        success: true,
        type: 'claude-to-openai-bridge',
        status: response.status,
        model: response.data.model,
        isBridged,
        usage: response.data.usage
      }
    } catch (error) {
      return {
        success: false,
        type: 'claude-to-openai-bridge',
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    }
  }

  /**
   * 测试OpenAI→Claude桥接
   */
  async _testOpenAIToClaudeBridge() {
    const requestBody = {
      model: 'gpt-5',
      input: [
        {
          role: 'user',
          content: 'Hello, this is a bridge test message.'
        }
      ],
      truncation: 'auto'
    }

    try {
      const response = await this.httpClient.post('/openai/responses', requestBody, {
        headers: {
          'x-api-key': this.apiKey
        }
      })

      // 检查是否使用了桥接（通过响应中的模型或特殊标记）
      const isBridged = response.data.model && response.data.model.startsWith('claude-')

      return {
        success: true,
        type: 'openai-to-claude-bridge',
        status: response.status,
        model: response.data.model,
        isBridged,
        usage: response.data.usage
      }
    } catch (error) {
      return {
        success: false,
        type: 'openai-to-claude-bridge',
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    }
  }

  /**
   * 生成测试报告
   */
  generateReport(testResults) {
    const report = {
      timestamp: new Date().toISOString(),
      config: {
        baseURL: this.baseURL,
        apiKey: this.apiKey ? `***${this.apiKey.slice(-8)}` : 'NOT_SET'
      },
      summary: {
        totalAccounts: testResults.length,
        successfulAccounts: testResults.filter((r) => r.enableResult.success).length,
        totalAPITests: testResults.reduce((sum, r) => sum + r.apiTests.length, 0),
        successfulAPITests: testResults.reduce(
          (sum, r) => sum + r.apiTests.filter((t) => t.success).length,
          0
        ),
        totalBridgeTests: testResults.reduce((sum, r) => sum + r.bridgeTests.length, 0),
        successfulBridgeTests: testResults.reduce(
          (sum, r) => sum + r.bridgeTests.filter((t) => t.success).length,
          0
        )
      },
      accountResults: testResults,
      errors: []
    }

    // 收集所有错误
    testResults.forEach((result) => {
      if (!result.enableResult.success) {
        report.errors.push({
          type: 'enable_account',
          account: `${result.accountType}:${result.account.id}`,
          error: result.enableResult.error
        })
      }

      result.apiTests.forEach((test) => {
        if (!test.success) {
          report.errors.push({
            type: 'api_test',
            account: `${result.accountType}:${result.account.id}`,
            testType: test.type,
            error: test.error,
            status: test.status
          })
        }
      })

      result.bridgeTests.forEach((test) => {
        if (!test.success) {
          report.errors.push({
            type: 'bridge_test',
            account: `${result.accountType}:${result.account.id}`,
            testType: test.type,
            error: test.error,
            status: test.status
          })
        }
      })
    })

    return report
  }

  /**
   * 保存报告到文件
   */
  async saveReport(report, filename = null) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const reportFilename = filename || `account-test-report-${timestamp}.json`
    const reportPath = path.join(__dirname, '..', 'test-reports', reportFilename)

    try {
      await fs.mkdir(path.dirname(reportPath), { recursive: true })
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
      console.log(`📊 Test report saved to: ${reportPath}`)
      return reportPath
    } catch (error) {
      console.error('❌ Failed to save report:', error.message)
      throw error
    }
  }

  /**
   * 延迟函数
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

module.exports = AccountTestUtils
