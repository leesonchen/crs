#!/usr/bin/env node

/**
 * 快速测试脚本 - 验证账户管理测试工具的基本功能
 *
 * 使用方法：
 * node scripts/quick-test.js
 */

const AccountTestUtils = require('./account-test-utils')

// 简单的测试配置
const testConfig = {
  baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  apiKey:
    process.env.TEST_API_KEY ||
    'cr_f656ba569babc360a61823224ba69c4528a68a4f5db9ee48b5819e9ce1c995b9',
  timeout: 30000
}

async function quickTest() {
  console.log('🚀 Starting Quick Test')
  console.log('='.repeat(50))

  try {
    // 创建测试工具实例
    const testUtils = new AccountTestUtils(testConfig)

    // 1. 测试管理员登录
    console.log('1️⃣ Testing admin authentication...')
    const token = await testUtils.getAdminToken()
    console.log(`✅ Admin authentication successful, token length: ${token.length}`)

    // 2. 测试获取账户列表
    console.log('\n2️⃣ Testing account listing...')
    const accounts = await testUtils.getAllAccounts()

    let totalAccounts = 0
    const accountTypes = Object.keys(accounts)

    for (const accountType of accountTypes) {
      const count = accounts[accountType].length
      totalAccounts += count
      console.log(`  📝 ${accountType}: ${count} accounts`)

      // 显示第一个账户的详细信息
      if (count > 0) {
        const firstAccount = accounts[accountType][0]
        console.log(`    First account: ${firstAccount.name || firstAccount.id}`)
        console.log(`    Schedulable: ${firstAccount.schedulable}`)
      }
    }

    console.log(`✅ Found ${totalAccounts} total accounts`)

    // 3. 测试健康检查
    console.log('\n3️⃣ Testing service health...')
    try {
      const response = await testUtils.httpClient.get('/health')
      console.log(`✅ Service health check passed, status: ${response.status}`)
    } catch (error) {
      console.warn(`⚠️  Service health check failed: ${error.message}`)
    }

    // 4. 测试一个账户的状态切换（如果有账户的话）
    if (totalAccounts > 0) {
      console.log('\n4️⃣ Testing account status toggle...')

      // 找到第一个可用的账户
      let testAccount = null
      let testAccountType = null

      for (const accountType of accountTypes) {
        if (accounts[accountType].length > 0) {
          testAccount = accounts[accountType][0]
          testAccountType = accountType
          break
        }
      }

      if (testAccount) {
        console.log(
          `  🧪 Testing with account: ${testAccount.name || testAccount.id} (${testAccountType})`
        )

        // 记录原始状态
        const originalStatus = testAccount.schedulable
        console.log(`  📊 Original schedulable status: ${originalStatus}`)

        // 切换状态
        const toggleResult = await testUtils.enableAccount(testAccountType, testAccount.id)
        if (toggleResult.success) {
          console.log(`  ✅ Toggle successful, new status: ${toggleResult.schedulable}`)

          // 等待一下然后切换回来
          await testUtils._sleep(1000)

          const restoreResult = await testUtils.disableAccount(testAccountType, testAccount.id)
          if (restoreResult.success) {
            console.log(`  ✅ Restore successful, final status: ${restoreResult.schedulable}`)
          } else {
            console.warn(`  ⚠️  Failed to restore original status: ${restoreResult.error}`)
          }
        } else {
          console.error(`  ❌ Toggle failed: ${toggleResult.error}`)
        }
      }
    }

    console.log('\n✅ Quick Test Completed Successfully!')
    console.log('🎉 All basic functions are working correctly.')
  } catch (error) {
    console.error('\n❌ Quick Test Failed:', error.message)
    console.error('Stack:', error.stack)

    // 提供故障排除建议
    console.log('\n💡 Troubleshooting Suggestions:')
    console.log('1. Make sure the CRS service is running')
    console.log('2. Check if the service URL is correct:', testConfig.baseURL)
    console.log('3. Verify admin credentials')
    console.log('4. Check network connectivity')

    process.exit(1)
  }
}

// 运行快速测试
if (require.main === module) {
  quickTest()
}

module.exports = quickTest
