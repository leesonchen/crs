# 账户管理测试工具

## 概述

这是一个全面的账户管理测试工具，用于验证每个账户在桥接和非桥接模式下的正��工作。

## 功能特性

- ✅ 自动停用所有账户
- ✅ 逐一启用并测试每个账户
- ✅ 非桥接模式 API 测试
- ✅ 桥接模式 API 测试（Claude ↔ OpenAI）
- ✅ 详细的测试报告生成
- ✅ 支持多种账户类型（Claude、OpenAI、Gemini、Azure OpenAI）
- ✅ 可配置的测试选项和跳过规则

## 快速开始

### 1. 配置环境

复制环境变量模板：
```bash
cp scripts/.env.example scripts/.env
```

编辑 `scripts/.env` 文件，填入实际配置：
```env
# 服务配置
TEST_BASE_URL=http://localhost:3000

# 管理员配置
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_admin_password

# API Key 配置
TEST_API_KEY=cr_your_test_api_key
```

### 2. 运行测试

```bash
# 运行完整测试
node scripts/test-account-management.js

# 或者使用 npm script
npm run test:accounts
```

### 3. 查看报告

测试完成后，报告会保存在 `test-reports/` 目录中：
- `account-test-report-*.json` - 标准测试报告
- `account-test-report-*-detailed.json` - 详细 JSON 报告
- `logs/error-*.json` - 错误日志（如果有）

## 测试流程

1. **配置验证** - 检查必需的配置项
2. **初始化** - 验证管理员凭据和服务连接
3. **获取账户** - 获取所有类型的账户列表
4. **停用账户** - 停用所有账户以确保干净的测试环境
5. **逐一测试** - ��用每个账户并执行测试
6. **生成报告** - 生成详细的测试报告

## 测试内容

### API 测试

- **Claude API**: 使用 `claude-3-5-haiku-20241022` 模型
- **OpenAI API**: 使用 `gpt-4o-mini` 模型
- **Gemini API**: 使用 `gemini-pro` 模型

### 桥接测试

- **Claude → OpenAI**: Claude 格式请求 → OpenAI 账户处理
- **OpenAI → Claude**: OpenAI 格式请求 → Claude 账户处理

## 配置选项

### 环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `TEST_BASE_URL` | 服务地址 | `http://localhost:3000` |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | - |
| `TEST_API_KEY` | 测试用 API Key | - |
| `TEST_VERBOSE` | 详细日志输出 | `false` |
| `TEST_JSON_OUTPUT` | JSON 格式报告 | `true` |

### 高级配置

编辑 `scripts/test-account-management.config.js` 进行高级配置：

```javascript
// 跳过特定账户类型
accountTesting: {
  skipAccountTypes: ['gemini'], // 跳过 Gemini 账户
  onlyAccountTypes: ['claude'], // 只测试 Claude 账户
  skipAccountIds: ['account-123'], // 跳过特定账户
}

// 测试选项
testCases: {
  testAccountDisabling: true, // 是否测试账户禁用
  testAPICalls: true,         // 是否测试 API 调用
  testBridgeCalls: true,      // 是否测试桥接调用
}
```

## 报告格式

### 控制台输出

```
📊 TEST SUMMARY
==============================
🎯 Accounts Tested: 5/6
✅ Successful: 4
❌ Failed: 1
⏭️  Skipped: 0

🔧 API Tests: 8/10 passed
🌉 Bridge Tests: 6/8 passed
```

### JSON 报告结构

```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "summary": {
    "totalAccounts": 6,
    "testedAccounts": 5,
    "successfulAccounts": 4,
    "failedAccounts": 1
  },
  "accountResults": [
    {
      "accountType": "claude",
      "account": { "id": "claude-001", "name": "Main Claude" },
      "enableResult": { "success": true },
      "apiTests": [...],
      "bridgeTests": [...]
    }
  ],
  "errors": []
}
```

## 故障排除

### 常见问题

**1. 管理员认证失败**
```
❌ Failed to get admin token: Invalid credentials
```
**解决方案**: 检查 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 配置

**2. 服务连接失败**
```
❌ Failed to connect to service: ECONNREFUSED
```
**解决方案**: 确保 CRS 服务正在运行，检查 `TEST_BASE_URL` 配置

**3. API Key 无效**
```
❌ API call failed: Invalid API key
```
**解决方案**: 检查 `TEST_API_KEY` 配置，或设置 `createIfMissing: true` 自动创建

**4. 账户启用失败**
```
❌ Failed to enable claude account claude-001: Account not found
```
**解决方案**: 检查账户 ID 是否正确，账户是否存在

### 调试模式

启用详细日志输出：
```bash
TEST_VERBOSE=true node scripts/test-account-management.js
```

## 集成到 CI/CD

### GitHub Actions 示例

```yaml
- name: Test Account Management
  env:
    TEST_BASE_URL: http://localhost:3000
    ADMIN_USERNAME: ${{ secrets.ADMIN_USERNAME }}
    ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
    TEST_API_KEY: ${{ secrets.TEST_API_KEY }}
  run: |
    node scripts/test-account-management.js
```

### Docker 测试

```bash
docker run --network host \
  -e TEST_BASE_URL=http://localhost:3000 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=$ADMIN_PASSWORD \
  -v $(pwd)/test-reports:/app/test-reports \
  node-app node scripts/test-account-management.js
```

## 注意事项

1. **测试环境影响**: 测试会停用所有账户，请勿在生产环境运行
2. **API 限制**: 测试会产生 API 调用，注意配额限制
3. **并发限制**: 建议串行测试以避免账户状态冲突
4. **网络延迟**: 测试包含 API 调用延迟，预计运行时间较长

## 扩展开发

### 添加新的测试用例

1. 在 `testCases` 配置中添加新测试
2. 在 `AccountTestUtils` 中实现测试方法
3. 在主测试脚本中调用测试方法

### 添加新的账户类型

1. 在 `getAllAccounts()` 中添加新的账户类型获取
2. 在 `_getAccounts()` 中添加对应的端点
3. 在 `_getToggleEndpoint()` 中添加切换端点
4. 在测试方法中添加对应平台的测试逻辑

## 技术架构

```
┌─────────────────────────────────┐
│        Main Test Script         │
│  test-account-management.js     │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│      Test Utilities             │
│    account-test-utils.js        │
│  • Admin authentication         │
│  • Account management           │
│  • API testing                  │
│  • Report generation            │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│        CRS Service              │
│  • Admin APIs                   │
│  • Account toggle endpoints     │
│  • Bridge APIs                  │
│  • Relay APIs                   │
└─────────────────────────────────┘
```

## 许可证

本工具遵循项目主体许可证。