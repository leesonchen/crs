# Repository Guidelines

## 项目结构与模块组织
- `src/` 存放 Node.js 后端，`routes/claudeOpenaiBridge.js` 与 `services/openaiResponses*` 是转发核心；`middleware/` 管理鉴权与速率限制。
- `cli/` 提供本地运维指令（如账号迁移、状态检查），`scripts/` 里是守护、监控与定时任务脚本；修改脚本前先用 `node scripts/manage.js status` 确认当前服务状态。
- `config/` 保存环境配置模板与价格缓存；`web/admin-spa/` 是管理后台前端源码，构建产物会输出到 `web/admin-spa/dist` 并由 Express 托管。
- 日志默认写入部署节点的 `app/logs`，本仓库仅保存代码，切勿在部署目录 `/home/leeson/claude-relay-service/app` 直接改动。

## 构建、测试与开发命令
- 首次安装：`npm install && npm run install:web`，随后执行 `npm run setup` 初始化基础数据。
- 本地开发：`npm run dev` 会启用 nodemon 重启后端；需要管理服务可使用 `npm run service:start` / `npm run service:restart`。
- 前端构建：`npm run build:web`；部署时还需同步 `src/` 目录并重启后端。
- 常用调试脚本：`npm run status:detail` 查看账号与速率，`npm run monitor` 持续输出健康状况。

## 编码风格与命名约定
- 使用 ESLint + Prettier；后台代码统一 2 空格缩进，字符串首选单引号。
- 新增函数名使用 camelCase，导出的类名用 PascalCase；日志 key 使用 snake_case 方便搜索。
- 需要跨服务调用时优先放入 `services/`，路由层保持瘦身；调试日志请加上请求 `requestId` 便于追踪。

## 测试指南
- 单元测试使用 Jest，运行 `npm test`；可用 `npm test -- path/to/file` 聚焦单个模块。
- 对转发层改动至少补一条模拟请求测试（参考 `tests/` 示例，若无则先创建 `tests/claude-openai.test.js`）。
- 调试日志建议临时加入 `logger.debug` 并在合并前移除或降级。

## 提交与合并请求规范
- 提交信息沿用现有风格：动词开头的简短英文或中文句子，如 `Support tool bridging...`、`增加调试信息`。
- PR 需说明影响的接口和复现步骤，涉及部署操作请注明是否已同步 `/app/logs` 的验证截图或关键行。
- 若引入配置变更，请附 `.env.example` 更新及回滚步骤；多功能改动请拆分为若干小 patch，方便审阅。

## 调试与运维提示
- Claude ↔ OpenAI 桥接问题优先查看 `/app/logs/claude-relay-*.log` 与 `http-debug-*.log`，必要时启用 `logger.info` 的工具摘要。
- 出现 `Stream must be set to true` 或工具映射异常时，回滚至 git 最新提交后重新部署，避免直接在运行目录修改。
