# 📚 Claude Relay Service 文档中心

欢迎来到 Claude Relay Service 的文档中心���这里包含了项目的完整技术文档、使用指南和开发资料。

---

## 🗂️ 文档目录

### 🚀 快速开始

- **[CLI Guide](./CLI-GUIDE.md)** - CLI 综合集成指南 ⭐
  - Claude Code CLI 和 Codex CLI 完整集成方法
  - 桥接模式配置和使用
  - 快速参考和故障排查
  - 版本兼容性说明

### 🏗️ 架构设计

- **[Architecture](./architecture.md)** - 系统架构文档 ⭐
  - 整体架构图和数据流
  - 核心组件和技术选型
  - 部署架构和监控方案

- **[Design](./design.md)** - 技术架构设计文档 ⭐
  - 详细的设计规范和原则
  - 服务层和接口定义
  - 性能优化和安全设计

- **[Bridge Service Design](./bridge-service-design.md)** - 桥接服务专项设计
  - 桥接模式架构和实现
  - 账户标准化规范
  - 转换器集成方案

### 🔧 开发指南

- **[Development Guide](./DEVELOPMENT.md)** - 开发指南 ⭐
  - 开发任务和进度跟踪
  - API转发逻辑分析
  - 技术架构和开发环境
  - 版本预览和界面截图

### 📋 项目规划

- **[Requirements](./requirements.md)** - 项目需求文档
  - 功能需求和非功能需求
  - 技术约束和验收标准

---

## 🎯 按场景查找

### 我想配置 CLI 工具

1. 阅读 **[CLI Guide](./CLI-GUIDE.md)** 了解基础概念
2. 查看快速参考章节获取配置模板
3. 参考调用示例选择合适的集成方式

### 我遇到了错误

1. 查看 **[CLI Guide](./CLI-GUIDE.md)** 的故障排查章节
2. 检查日志标识速查表
3. 参考常见错误解决方案

### 我想了解桥接模式

1. 阅读 **[CLI Guide](./CLI-GUIDE.md)** 的桥接模式章节
2. 查看 **[Bridge Service Design](./bridge-service-design.md)** 了解设计原理
3. 参考 Web 界面配置指南

### 我想贡献代码

1. 了解 **[Architecture](./architecture.md)** 系统架构
2. 查看 **[Design](./design.md)** 设计规范
3. 阅读 **[Development Guide](./DEVELOPMENT.md)** 了解当前任务

### 我是运维人员

1. 查看 **[Architecture](./architecture.md)** 的部署架构
2. 阅读 **[CLI Guide](./CLI-GUIDE.md)** 的健康检查和监控
3. 参考 **[Development Guide](./DEVELOPMENT.md)** 的故障排查

---

## 📖 推荐阅读路径

### 新用户
```
1. CLI Guide（快速上手）
   ↓
2. Architecture（理解原理）
   ↓
3. Design（深入了解）
```

### 开发者
```
1. Architecture（了解架构）
   ↓
2. Design（设计规范）
   ↓
3. Development Guide（参与开发）
   ↓
4. Bridge Service Design（技术细节）
```

### 运维人员
```
1. CLI Guide（快速参考）
   ↓
2. Architecture（部署架构）
   ↓
3. Development Guide（问题解决）
   ↓
4. CLI Guide 故障排查（运维支持）
```

---

## 🔄 最近更新

### 2025-10-05 - 文档重构
- ✨ **重构**: 合并 CLI 相关文档为综合指南
- ✨ **新增**: [Development Guide](./DEVELOPMENT.md) 开发指南
- 🔧 **更新**: 统一文档结构和索引
- 🗑️ **精简**: 删除过时和重复文档，提高维护性

### 2025-10-05 - 功能更新
- ✨ **新增**: 支持 Claude Code CLI v2.0.1（thinking 和 document 内容类型）
- ✨ **新增**: 完整的双向桥接模式支持
- 🔧 **修复**: 默认模型配置和 URL 拼接问题
- 🔧 **优化**: 账户类型识别和调度逻辑

---

## 📝 文档维护

### 文档编写规范

- 使用 Markdown 格式
- 保持结构清晰，使用标题层级
- 提供代码示例和实际用例
- 包含日志示例和错误信息
- 标注版本和更新日期

### 贡献指南

1. **发现错误**: 提交 Issue 说明错误内容
2. **补充内容**: 提交 Pull Request 添加新的文档章节
3. **更新信息**: 提交 Pull Request 更新过时的内容

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

## 📊 文档统计

- **总文档数**: 6 个（从 13 个精简）
- **核心文档**: 4 个（架构、设计、桥接、CLI）
- **精简比例**: 54%（显著提高维护性）
- **覆盖范围**: 用户指南、开发文档、架构设计

### 核心文档速览

| 文档 | 用途 | 读者 |
|------|------|------|
| [CLI Guide](./CLI-GUIDE.md) | CLI 使用和集成 | 终端用户 |
| [Architecture](./architecture.md) | 系统架构理解 | 开发者、运维 |
| [Design](./design.md) | 技术设计规范 | 开发者 |
| [Bridge Service Design](./bridge-service-design.md) | 桥接功能设计 | 开发者 |
| [Development Guide](./DEVELOPMENT.md) | 开发任务和分析 | 开发者 |
| [Requirements](./requirements.md) | 项目需求 | 产品经理 |