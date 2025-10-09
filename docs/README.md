# 📚 Claude Relay Service 文档中心

欢迎来到 Claude Relay Service 的文档中心。这里包含了项目的完整技术文档和使用指南。

---

## 🗂️ 文档目录

### 🚀 快速开始

- **[CLI Integration Guide](./cli-integration-guide.md)** - Claude Code CLI 和 Codex CLI 集成指南
  - 详细的 CLI 调用格式和参数说明
  - 桥接模式（Bridge Mode）完整配置指南
  - 常见问题故障排查
  - 代码示例和日志分析

- **[CLI Quick Reference](./cli-quick-reference.md)** - CLI 快速参考卡片
  - 常用命令速查
  - 配置检查清单
  - 错误代码速查表
  - curl 命令示例

### 🏗️ 架构设计

- **[Architecture](./architecture.md)** - 系统架构文档
  - 核心组件和数据流
  - 服务架构图
  - 技术选型说明

- **[Design](./design.md)** - 设计文档
  - 详细设计规范
  - API 设计原则
  - 数据模型设计

### 📋 需求和规划

- **[Requirements](./requirements.md)** - 项目需求文档
  - 功能需求
  - 非功能需求
  - 技术约束

- **[Tasks](./tasks.md)** - 任务和待办事项
  - 当前任务列表
  - 开发进度跟踪
  - 未来规划

### 🔧 专题指南

- **[API Forwarding Analysis](./api-forwarding-analysis.md)** - API 转发分析
  - 请求转发机制
  - 流式响应处理
  - 性能优化建议

- **[Claude-OpenAI Bridge Plan](./claude-openai-bridge-plan.md)** - Claude→OpenAI 桥接计划
  - 桥接功能设计文档
  - 实现路线图

- **[Codex CLI Playwright MCP](./codex-cli-playwright-mcp.md)** - Codex CLI 与 Playwright MCP 集成
  - MCP 协议支持
  - Playwright 集成方案

---

## 🎯 按场景查找

### 我想配置 CLI 工具

1. 阅读 **[CLI Integration Guide](./cli-integration-guide.md)** 了解基础概念
2. 查看 **[CLI Quick Reference](./cli-quick-reference.md)** 获取配置模板
3. 参考 **调用示例对比** 章节选择合适的集成方式

### 我遇到了错误

1. 查看 **[CLI Quick Reference](./cli-quick-reference.md)** 的故障排查速查表
2. 阅读 **[CLI Integration Guide](./cli-integration-guide.md)** 的故障排查章节
3. 检查日志标识含义表

### 我想了解桥接模式

1. 阅读 **[CLI Integration Guide](./cli-integration-guide.md)** 的桥接模式章节
2. 查看 **[Claude-OpenAI Bridge Plan](./claude-openai-bridge-plan.md)** 了解设计原理
3. 参考配置示例进行设置

### 我想贡献代码

1. 了解 **[Architecture](./architecture.md)** 系统架构
2. 查看 **[Design](./design.md)** 设计规范
3. 阅读 **[Tasks](./tasks.md)** 了解当前开发任务

---

## 📖 推荐阅读路径

### 新用户
```
1. CLI Quick Reference（快速上手）
   ↓
2. CLI Integration Guide（深入了解）
   ↓
3. Architecture（理解原理）
```

### 开发者
```
1. Architecture（了解架构）
   ↓
2. Design（设计规范）
   ↓
3. API Forwarding Analysis（技术细节）
   ↓
4. Tasks（参与开发）
```

### 运维人员
```
1. CLI Quick Reference（快速参考）
   ↓
2. CLI Integration Guide - 故障排查（问题解决）
   ↓
3. 日志监控和健康检查
```

---

## 🔄 最近更新

### 2025-10-05
- ✨ **新增**: [CLI Integration Guide](./cli-integration-guide.md) - 完整的 CLI 集成指南
- ✨ **新增**: [CLI Quick Reference](./cli-quick-reference.md) - CLI 快速参考卡片
- 🔧 **更新**: 桥接模式支持 `thinking` 和 `document` 内容类型
- 🐛 **修复**: 默认模型从 `gpt-5-codex-medium` 改为 `gpt-5`

---

## 📝 文档维护

### 如何贡献文档

1. **发现错误**: 提交 Issue 说明错误内容
2. **补充内容**: 提交 Pull Request 添加新的文档章节
3. **更新信息**: 提交 Pull Request 更新过时的内容

### 文档编写规范

- 使用 Markdown 格式
- 保持结构清晰，使用标题层级
- 提供代码示例和实际用例
- 包含日志示例和错误信息
- 标注版本和更新日期

---

## 🔗 相关链接

- **GitHub**: [leesonchen/crs](https://git.leeson.top/leesonchen/crs)
- **Docker Hub**: [leesonchen/crs](https://hub.docker.com/r/leesonchen/crs)
- **官方网站**: [pincc.ai](https://pincc.ai/)
- **演示站点**: [demo.pincc.ai](https://demo.pincc.ai/admin-next/login)
- **Telegram 频道**: [claude_relay_service](https://t.me/claude_relay_service)

---

## 💡 需要帮助？

- 💬 提交 [GitHub Issue](https://git.leeson.top/leesonchen/crs/issues)
- 📧 加入 [Telegram 群组](https://t.me/claude_relay_service)
- 📖 查阅本文档中心
- 🌐 访问 [官方网站](https://pincc.ai/)

---

**文档版本**: v1.1.156+
**最后更新**: 2025-10-05
**维护团队**: Claude Relay Service Team
