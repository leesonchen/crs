# Redis 账户清空工具

## 功能说明

安全清空 Redis 中的所有账户数据，支持预览模式和强制模式。

> **✅ 2024-11-24 更新**: 增强安全性和错误处理
> - 强制模式需要输入 "DELETE ALL ACCOUNTS" 确认
> - 自动创建备份文件（强制模式）
> - 显示详细的删除结果（成功/失败统计）
> - 改进 SCAN 性能（可配置 COUNT 参数）
> - 完善的错误处理和日志

## 受支持的账户类型

- Claude 官方账户 (claude:account:*)
- Claude Console 账户 (claude_console_account:*)
- OpenAI 常规账户 (openai:account:*)
- OpenAI Responses 账户 (openai_responses_account:*)
- OpenAI Chat 账户 (openai_chat_account:*)
- Gemini 账户 (gemini_account:*)
- AWS Bedrock 账户 (bedrock_account:*)
- Azure OpenAI 账户 (azure_open_ai_account:*)
- Droid 账户 (droid_account:*)
- CCR 账户 (ccr_account:*)
- 共享账户集合 (shared_*_accounts)

## 使用方法

### 1. 预览模式（推荐）

```bash
npm run accounts:clear:dry
```

功能：
- 显示将要清空的账户列表和数量
- 不执行实际的删除操作
- 建议在清空之前先运行此命令确认

### 2. 正常清空（带确认提示）

```bash
npm run accounts:clear
```

功能：
- 显示将要清空的账户列表
- 需要手动输入 `YES` 确认
- 防止误操作的安全保护

### 3. 强制清空（跳过确认）

```bash
npm run accounts:clear:force
```

功能：
- 跳过确认提示直接清空
- 用于自动化脚本或确定要清空时使用
- ⚠️ 危险操作，使用前务必确认已备份

### 4. 查看帮助信息

```bash
npm run accounts:clear -- --help
```

## 完整操作流程

### 清空并导入新数据的操作步骤

```bash
# 1. 备份当前数据（重要！）
npm run data:export:enhanced -- --output=backup-before-clear.json

# 2. 预览将要清空的账户
npm run accounts:clear:dry

# 3. 确认后执行清空（需要输入 YES 确认）
npm run accounts:clear

# 4. 验证已清空
npm run accounts:clear:dry

# 5. 导入新数据
npm run data:import:enhanced -- --input=your-import-file.json
```

## 重要提醒

⚠️ **危险操作警告** ⚠️

- 此操作会**永久删除**所有账户数据
- 删除后**无法恢复**，请务必备份重要数据
- 建议总是先使用 `--dry-run` 预览
- API Keys 不会被清空（需要单独处理）
- 共享集合（shared_*_accounts）也会被清空

### 🛡️ 安全保护机制

**强制模式（--force）** 有双重保护：
1. 自动创建备份文件（`backup-before-clear-*.json`）
2. 需要输入完整短语 `DELETE ALL ACCOUNTS` 确认

**正常模式** 需要输入 `YES` 确认

### ⚠️ 强制模式风险

使用 `npm run accounts:clear:force` 或 `--force` 参数时：
- 脚本会自动备份数据（安全保护）
- **仍需要**输入 `DELETE ALL ACCOUNTS` 确认
- 如果备份失败会提示是否继续

## 常见问题

### Q: 为什么清空后导入新数据？

A: 当你有以下情况时需要清空后再导入：
1. 数据结构发生重大变化
2. 需要彻底清除旧账户
3. 从其他环境导入数据
4. 修复账户类型混淆问题

### Q: 可以只清空特定类型的账户吗？

A: 当前版本不支持，会清空所有账户类型。如需清空特定类型，需要修改脚本。

### Q: 强制模式还需要确认吗？

A: 是的！强制模式需要输入完整的 `DELETE ALL ACCOUNTS` 短语确认，防止误操作。这是为了保护数据安全。

### Q: 备份文件包含什么数据？

A: 备份文件包含所有被删除账户的完整数据，包括：
- 账户类型和名称
- Redis 键名
- 账户的所有字段（包含加密数据）
- 备份时间戳和操作原因

可以手动导入或使用脚本恢复这些备份数据。

### Q: 删除失败怎么办？

A: 脚本会显示详细的删除结果：
- 成功删除的数量
- 失败的数量和失败原因
- 失败的具体键名（前3个）

如果删除失败，可以：
1. 检查 Redis 是否正常运行
2. 手动使用 `redis-cli del <key>` 删除特定键
3. 查看 Redis 日志获取更多信息

### Q: 大数据量清空需要多长时间？

A: 取决于：
- Redis 实例的性能
- 账户数量（SCAN 每 1000 个键显示进度）
- Pipeline 批量删除效率（每组约 1-10ms）

示例：
- 1000 个账户：几秒
- 10,000 个账户：30-60 秒
- 100,000 个账户：5-10 分钟

脚本使用 Redis Pipeline 批量删除，比单个删除快 10-100 倍。

### Q: 清空操作会删除 API Keys 吗？

A: 不会，API Keys 不会被清空。如需清空 API Keys，请使用：
```bash
redis-cli keys "apikey:*" | xargs redis-cli del
```

## 脚本位置

`scripts/clear-accounts.js`
