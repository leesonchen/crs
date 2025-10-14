# CODEBUDDY.md This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目概述

Claude Relay Service 是一个功能完整的 AI API 中转服务，支持 Claude 和 Gemini 双平台。提供多账户管理、API Key 认证、代理配置和现代化 Web 管理界面。该服务作为客户端（如 SillyTavern、Claude Code、Gemini CLI）与 AI API 之间的中间件，提供认证、限流、监控等功能。

## 常用命令

### 安装和初始化
```bash
# 安装依赖
npm install
npm run install:web

# 初始化配置
cp config/config.example.js config/config.js
cp .env.example .env
npm run setup
```

### 开发和运行
```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm start

# 后台服务管理
npm run service:start:daemon    # 后台启动
npm run service:status         # 查看状态
npm run service:logs            # 查看日志
npm run service:stop            # 停止服务
npm run service:restart:daemon  # 重启服务
```

### 前端构建
```bash
npm run build:web
npm run install:web
```

### 代码质量
```bash
npm run lint                    # ESLint 检查和修复
npm run lint:check             # 仅检查不修复
npm run format                  # Prettier 格式化
npm run format:check           # 检查格式
npm test                       # 运行测试
```

### 数据管理
```bash
npm run data:export            # 导出数据
npm run data:import            # 导入数据
npm run migrate:fix-usage-stats # 修复使用统计
```

## 核心架构

### 项目结构
- `src/` - 后端 Node.js 代码
  - `services/` - 核心业务逻辑服务
  - `routes/` - HTTP 路由处理
  - `middleware/` - 认证和中间件
  - `utils/` - 工具函数
- `web/admin-spa/` - 前端管理界面（Vue.js + Tailwind CSS）
- `cli/` - 命令行工具
- `scripts/` - 运维脚本和定时任务
- `config/` - 配置文件

### 关键服务组件

**核心中继服务：**
- `claudeRelayService.js` - Claude API 请求转发和流式响应
- `openaiRelayService.js` - OpenAI 格式中继服务
- `geminiRelayService.js` - Gemini API 转发服务

**账户管理服务：**
- `claudeAccountService.js` - Claude 账户管理，OAuth token 刷新
- `geminiAccountService.js` - Gemini 账户管理，Google OAuth
- `apiKeyService.js` - API Key 验证、限流和统计

**桥接服务（2025-10 新增）：**
- `bridgeService.js` - 双向 API 格式转换（OpenAI ↔ Claude）
- 支持 Codex CLI 访问 Claude 和 Claude Code 访问 OpenAI

### 认证流程
1. 客户端使用自建 API Key（cr_ 前缀格式）发送请求
2. `authenticateApiKey` 中间件验证 API Key 和限流
3. 账户服务选择可用 Claude/Gemini 账户
4. 检查 OAuth token 有效性，自动刷新（支持代理）
5. 使用 OAuth Bearer token 转发请求到 API 提供商
6. 记录使用统计和成本计算

### 数据流架构
- **Redis 存储**: 所有敏感数据（OAuth token、refreshToken）使用 AES 加密存储
- **API Key 哈希**: 使用哈希映射优化查找性能（O(n) → O(1))
- **流式响应**: 支持 SSE 流式传输，实时解析 usage 数据
- **异步处理**: 非阻塞统计记录和日志写入

## 重要配置

### 环境变量（必须）
- `JWT_SECRET` - JWT 密钥（32字符以上随机字符串）
- `ENCRYPTION_KEY` - 数据加密密钥（32字符固定长度）
- `REDIS_HOST` - Redis 主机地址
- `REDIS_PORT` - Redis 端口

### 桥接配置（系统设置）
- 支持 OpenAI ↔ Claude 双向格式转换
- 虚拟模型映射（如 gpt-5 → claude-sonnet-4）
- 在 Web 管理界面的"桥接设置"标签中配置

## 开发注意事项

### 代码风格
- 使用 ESLint + Prettier 格式化
- 后端代码：2 空格缩进，单引号字符串
- 前端代码：Vue 3 + Composition API，Tailwind CSS

### 前端开发要求
- **响应式设计**: 必须兼容手机、平板、桌面
- **暗黑模式**: 所有组件必须同时支持明亮和暗黑模式
- 使用 Tailwind CSS 的 `dark:` 前缀
- 主题管理：`web/admin-spa/src/stores/theme.js`

### 敏感数据处理
- OAuth token 和 refreshToken 必须使用 AES 加密存储
- API Key 使用哈希存储，支持 cr_ 前缀格式
- 参考 `claudeAccountService.js` 中的加密实现

### 错误处理
- 使用 Winston 结构化日志
- 遵循项目现有的错误处理模式
- 客户端断开时自动清理资源

## 部署和运维

### Docker 部署（推荐）
```bash
docker-compose up -d
```

### 生产环境建议
- 使用 Caddy 反向代理（自动 HTTPS）
- 配置防火墙只开放必要端口
- 定期备份重要配置和数据
- 监控日志文件 `logs/` 目录

### 健康检查
- `GET /health` - 系统健康状态
- `GET /metrics` - 系统指标
- 查看 `logs/claude-relay-*.log` 监控服务状态

## 故障排除

### 常见问题
- **Redis 连接失败**: 检查 Redis 服务运行状态
- **OAuth 授权失败**: 验证代理配置和网络连接
- **API 请求失败**: 检查 API Key 格式和账户状态

### 调试工具
- Web 管理界面实时日志查看
- CLI 状态工具：`npm run cli status`
- 健康检查端点：`/health`

## 重要文件位置

- 核心服务逻辑：`src/services/`
- 路由处理：`src/routes/`
- 配置管理：`config/config.js`
- Redis 模型：`src/models/redis.js`
- 前端主题：`web/admin-spa/src/stores/theme.js`
- 桥接配置：`src/services/bridgeService.js`

## 相关文档

- `README.md` - 详细部署和使用指南
- `CLAUDE.md` - 更详细的技术架构说明
- `AGENTS.md` - 项目开发规范
- `docs/` 目录 - 设计和架构文档