#!/usr/bin/env node

/**
 * 账户管理测试脚��
 *
 * 功能：
 * 1. 停用全部账户
 * 2. 逐一启用单个账户
 * 3. 使用非桥接和桥接两种方式测试每个账户
 * 4. 生成详细的测试报告
 *
 * 使用方法：
 * node scripts/test-account-management.js
 *
 * 环境变量：
 * - TEST_BASE_URL: 服务地址 (默认: http://localhost:3000)
 * - ADMIN_USERNAME: 管理员用户名
 * - ADMIN_PASSWORD: 管理员密码
 * - TEST_API_KEY: 测试用的 API Key
 * - TEST_VERBOSE: 是否输出详细日志
 */

const fs = require('fs').promises
const path = require('path')
const { config, validateConfig } = require('./test-account-management.config')
const AccountTestUtils = require('./account-test-utils')

class AccountManagementTester {
  constructor() {
    this.testUtils = new AccountTestUtils(config)
    this.testResults = []
    this.startTime = Date.now()
    this.reportData = {
      summary: {
        totalAccounts: 0,
        testedAccounts: 0,
        successfulAccounts: 0,
        failedAccounts: 0,
        skippedAccounts: 0,
        totalAPITests: 0,
        successfulAPITests: 0,
        totalBridgeTests: 0,
        successfulBridgeTests: 0,
        startTime: new Date().toISOString(),
        endTime: null,
        duration: 0
      },
      accountResults: [],
      errors: [],
      config: {
        baseURL: config.service.baseURL,
        testCases: {
          testAPICalls: config.testCases.testAPICalls,
          testBridgeCalls: config.testCases.testBridgeCalls,
          testConcurrent: config.testCases.testConcurrent
        }
      }
    }
  }

  /**
   * 主测试流程
   */
  async run() {
    try {
      console.log('🚀 Starting Account Management Test')
      console.log('='.repeat(60))

      // 1. 验证配置
      this.validateConfiguration()

      // 2. 初始化测试工具
      await this.initializeTestUtils()

      // 3. 获取所有账户
      const accounts = await this.getAllAccounts()

      // 4. 停用所有账户
      if (config.testCases.testAccountDisabling) {
        await this.disableAllAccounts(accounts)
      }

      // 5. 逐一测试每个账户
      await this.testAccountsIndividually(accounts)

      // 6. 生成最终报告
      await this.generateFinalReport()

      console.log('✅ Account Management Test Completed Successfully')
      console.log(
        `📊 Summary: ${this.reportData.summary.successfulAccounts}/${this.reportData.summary.testedAccounts} accounts passed`
      )
    } catch (error) {
      console.error('❌ Test execution failed:', error.message)
      await this.logError('test_execution_failed', error)
      process.exit(1)
    }
  }

  /**
   * 验证配置
   */
  validateConfiguration() {
    console.log('🔍 Validating configuration...')
    validateConfig()
    console.log('✅ Configuration validated')
  }

  /**
   * 初始化测试工具
   */
  async initializeTestUtils() {
    console.log('🔧 Initializing test utilities...')

    try {
      // 获取管理员 token
      await this.testUtils.getAdminToken()
      console.log('✅ Admin authentication successful')

      // 验证服务连接
      await this.testUtils._testAPICall('/health', 'GET')
      console.log('✅ Service connection verified')
    } catch (error) {
      throw new Error(`Failed to initialize test utilities: ${error.message}`)
    }
  }

  /**
   * 获取所有账户
   */
  async getAllAccounts() {
    console.log('📋 Fetching all accounts...')

    try {
      const accounts = await this.testUtils.getAllAccounts()

      // 统计账户总数
      let totalAccounts = 0
      const accountTypes = Object.keys(accounts)

      for (const accountType of accountTypes) {
        totalAccounts += accounts[accountType].length
        console.log(`  📝 ${accountType}: ${accounts[accountType].length} accounts`)
      }

      this.reportData.summary.totalAccounts = totalAccounts
      console.log(`✅ Found ${totalAccounts} total accounts`)

      return accounts
    } catch (error) {
      throw new Error(`Failed to fetch accounts: ${error.message}`)
    }
  }

  /**
   * 停用所有账户
   */
  async disableAllAccounts(_accounts) {
    console.log('🔄 Disabling all accounts...')

    try {
      const results = await this.testUtils.disableAllAccounts()

      const successful = results.filter((r) => r.success).length
      const failed = results.filter((r) => !r.success).length

      console.log(`✅ Disabled ${successful} accounts, ${failed} failed`)

      if (failed > 0) {
        console.warn('⚠️  Some accounts failed to disable, but continuing with tests...')
      }
    } catch (error) {
      throw new Error(`Failed to disable accounts: ${error.message}`)
    }
  }

  /**
   * 逐一测试每个账户
   */
  async testAccountsIndividually(accounts) {
    console.log('🧪 Testing accounts individually...')
    console.log('='.repeat(60))

    const accountTypes = Object.keys(accounts)

    for (const accountType of accountTypes) {
      // 检查是否跳过此账户类型
      if (this.shouldSkipAccountType(accountType)) {
        console.log(`⏭️  Skipping ${accountType} accounts (configuration)`)
        continue
      }

      console.log(`\n🎯 Testing ${accountType} accounts...`)

      for (const account of accounts[accountType]) {
        // 检查是否跳过此账户
        if (this.shouldSkipAccount(account)) {
          console.log(`  ⏭️  Skipping account: ${account.name || account.id}`)
          this.reportData.summary.skippedAccounts++
          continue
        }

        await this.testSingleAccount(accountType, account)
      }
    }
  }

  /**
   * 检查是否应该跳过此账户类型
   */
  shouldSkipAccountType(accountType) {
    const { skipAccountTypes, onlyAccountTypes } = config.accountTesting

    // 如果指定了 onlyAccountTypes，只测试这些类型
    if (onlyAccountTypes.length > 0) {
      return !onlyAccountTypes.includes(accountType)
    }

    // 否则检查 skipAccountTypes
    return skipAccountTypes.includes(accountType)
  }

  /**
   * 检查是否应该跳过此账户
   */
  shouldSkipAccount(account) {
    const { skipAccountIds, testInactiveAccounts } = config.accountTesting

    // 检查账户 ID 是否在跳过列表中
    if (skipAccountIds.includes(account.id)) {
      return true
    }

    // 检查账户是否活跃
    if (!testInactiveAccounts && !account.schedulable) {
      return true
    }

    return false
  }

  /**
   * 测试单个账户
   */
  async testSingleAccount(accountType, account) {
    const accountName = account.name || account.id
    console.log(`  🧪 Testing account: ${accountName}`)

    try {
      // 1. 启用账户
      console.log(`    🔄 Enabling account...`)
      const result = await this.testUtils.enableAndTestAccount(accountType, account)

      // 2. 记录结果
      this.reportData.accountResults.push(result)
      this.reportData.summary.testedAccounts++

      // 3. 更新统计
      if (result.enableResult.success) {
        this.reportData.summary.successfulAccounts++
        console.log(`    ✅ Account test successful`)
      } else {
        this.reportData.summary.failedAccounts++
        console.log(`    ❌ Account test failed: ${result.enableResult.error}`)
      }

      // 4. 更新 API 测试统计
      this.reportData.summary.totalAPITests += result.apiTests.length
      this.reportData.summary.successfulAPITests += result.apiTests.filter((t) => t.success).length

      // 5. 更新桥接测试统计
      this.reportData.summary.totalBridgeTests += result.bridgeTests.length
      this.reportData.summary.successfulBridgeTests += result.bridgeTests.filter(
        (t) => t.success
      ).length

      // 6. 添加延迟
      await this.testUtils._sleep(config.accountTesting.testDelay)
    } catch (error) {
      console.error(`    ❌ Failed to test account ${accountName}:`, error.message)

      // 记录失败结果
      const failedResult = {
        accountType,
        account,
        enableResult: { success: false, error: error.message },
        apiTests: [],
        bridgeTests: [],
        error: error.message
      }

      this.reportData.accountResults.push(failedResult)
      this.reportData.summary.testedAccounts++
      this.reportData.summary.failedAccounts++

      await this.logError(`account_test_failed_${account.id}`, error, {
        accountType,
        accountId: account.id
      })
    }
  }

  /**
   * 生成最终报告
   */
  async generateFinalReport() {
    console.log('\n📊 Generating final report...')

    try {
      // 更新摘要信息
      this.reportData.summary.endTime = new Date().toISOString()
      this.reportData.summary.duration = Date.now() - this.startTime

      // 生成报告
      const report = this.testUtils.generateReport(this.reportData.accountResults)

      // 保存报告
      const reportPath = await this.testUtils.saveReport(report)
      console.log(`📄 Report saved to: ${reportPath}`)

      // 输出控制台摘要
      this.printConsoleSummary()

      // 如果配置了 JSON 输出，也保存 JSON 格式
      if (config.output.jsonOutput) {
        const jsonReportPath = reportPath.replace('.json', '-detailed.json')
        await fs.writeFile(jsonReportPath, JSON.stringify(this.reportData, null, 2))
        console.log(`📄 Detailed JSON report saved to: ${jsonReportPath}`)
      }
    } catch (error) {
      console.error('❌ Failed to generate report:', error.message)
      await this.logError('report_generation_failed', error)
    }
  }

  /**
   * 输出控制台摘要
   */
  printConsoleSummary() {
    const { summary } = this.reportData

    console.log(`\n${'='.repeat(60)}`)
    console.log('📊 TEST SUMMARY')
    console.log('='.repeat(60))
    console.log(`🎯 Accounts Tested: ${summary.testedAccounts}/${summary.totalAccounts}`)
    console.log(`✅ Successful: ${summary.successfulAccounts}`)
    console.log(`❌ Failed: ${summary.failedAccounts}`)
    console.log(`⏭️  Skipped: ${summary.skippedAccounts}`)
    console.log()
    console.log(`🔧 API Tests: ${summary.successfulAPITests}/${summary.totalAPITests} passed`)
    console.log(
      `🌉 Bridge Tests: ${summary.successfulBridgeTests}/${summary.totalBridgeTests} passed`
    )
    console.log()
    console.log(`⏱️  Duration: ${Math.round(summary.duration / 1000)}s`)
    console.log(`🕒 End Time: ${summary.endTime}`)
    console.log('='.repeat(60))

    // 如果有失败的账户，显示详情
    if (summary.failedAccounts > 0) {
      console.log('\n❌ FAILED ACCOUNTS:')
      this.reportData.accountResults
        .filter((result) => !result.enableResult.success)
        .forEach((result) => {
          console.log(`  - ${result.accountType}: ${result.account.name || result.account.id}`)
          if (result.enableResult.error) {
            console.log(`    Error: ${result.enableResult.error}`)
          }
        })
    }
  }

  /**
   * 记录错误
   */
  async logError(type, error, context = {}) {
    const errorLog = {
      type,
      message: error.message,
      stack: error.stack,
      context,
      timestamp: new Date().toISOString()
    }

    this.reportData.errors.push(errorLog)

    if (config.output.saveDetailedLogs) {
      try {
        const logDir = path.join(config.output.reportDir, 'logs')
        await fs.mkdir(logDir, { recursive: true })
        const logFile = path.join(logDir, `error-${Date.now()}-${type}.json`)
        await fs.writeFile(logFile, JSON.stringify(errorLog, null, 2))
      } catch (logError) {
        console.error('Failed to save error log:', logError.message)
      }
    }
  }

  /**
   * 测试 API 调用 (内部方法)
   */
  async _testAPICall(endpoint, method = 'GET', data = null) {
    try {
      const response = await this.testUtils.httpClient.request({
        method,
        url: endpoint,
        data,
        timeout: config.service.timeout
      })

      return response.data
    } catch (error) {
      throw new Error(`API call failed: ${error.message}`)
    }
  }
}

/**
 * 主函数
 */
async function main() {
  const tester = new AccountManagementTester()

  try {
    await tester.run()
    process.exit(0)
  } catch (error) {
    console.error('💥 Test execution failed:', error.message)
    process.exit(1)
  }
}

// 运行测试
if (require.main === module) {
  main()
}

module.exports = AccountManagementTester
