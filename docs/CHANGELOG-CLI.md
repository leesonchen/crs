# CLI Integration Changelog

## 2025-10-05 - v1.1.156+

### ✨ 新增功能

1. **支持 Claude Code CLI v2.0.1**
   - 支持 `thinking` 内容类型（extended thinking）
   - 支持 `document` 内容类型
   - 兼容 `?beta=true` 参数

2. **桥接模式增强**
   - 优化模型映射逻辑
   - 支持账户级和全局级模型映射
   - 自动内容类型转换

3. **完整文档体系**
   - CLI Integration Guide（15KB）
   - CLI Quick Reference（6.6KB）
   - 文档索引中心（4.6KB）

### 🐛 Bug 修复

1. **修复默认模型配置**
   - 从 `gpt-5-codex-medium` 改为 `gpt-5`
   - 提升上游 API 兼容性

2. **修复 URL 拼接问题**
   - 智能处理 baseApi 和 upstreamPath
   - 避免路径重复（如 `/v1/v1/responses`）

3. **修复 accountType 识别**
   - 动态检测账户类型
   - 正确传递给调度器和限流逻辑

4. **修复非文本内容支持**
   - 转换器支持 5 种内容类型
   - 优雅处理 thinking 和 document

### 🔧 改进优化

1. **代码位置**
   - `config/config.js:89` - 默认模型配置
   - `src/services/claudeToOpenAIResponses.js:92-93` - 允许类型列表
   - `src/services/claudeToOpenAIResponses.js:179-193` - thinking/document 处理
   - `src/services/claudeToOpenAIResponses.js:273-285` - document 辅助方法
   - `src/services/openaiResponsesRelayService.js:55-67` - 账户类型检测
   - `src/services/openaiResponsesRelayService.js:84-96` - 智能 URL 拼接

2. **日志增强**
   - 添加桥接模式标识 🌉
   - 模型映射来源标记
   - 账户选择详细信息

### 📖 文档更新

- **新增**: CLI Integration Guide - 完整的集成指南
- **新增**: CLI Quick Reference - 快速参考卡片
- **新增**: docs/README.md - 文档索引中心
- **更新**: CLAUDE.md - 补充桥接模式说明

### 🔗 相关提交

- `a3833236` - 增加明细和费用说明
- `3e0167c1` - fix(bridge): 修复 OpenAI OAuth 账户桥接时的 accountType 识别错误
- `57d73fef` - fix(bridge): 修复 Claude→OpenAI 桥接的 URL 拼接和端点问题
- `8aeaf659` - fix(bridge): 修复 OpenAI-Responses 流式桥接缺少返回值导致客户端无响应
- `9198539b` - feat(web): OpenAI-Responses 账户支持 Claude 桥接 UI 配置

---

## 历史版本

### v1.1.155 及之前
- 基础 Claude Code CLI v1.0.110 支持
- 基础桥接模式实现
- 只支持 text/tool_use/tool_result 内容类型

---

**维护者**: Claude Relay Service Team
**文档**: [CLI Integration Guide](./cli-integration-guide.md)
