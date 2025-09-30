# 当前任务说明（Claude CLI → OpenAI Responses 桥接增强）

## 背景
- 需要让 Claude CLI 通过 `/claude/openai/v1/messages` 转发到 OpenAI Responses，并可复用“OpenAI 直连账户”。
- 早期问题：模型映射缺失、工具/内容类型限制、非流式请求被上游要求 `stream=true`、客户端断连导致的 `CanceledError` 被记录为异常等。
- 目标：在不影响现有接口的前提下，引入按账户可控的桥接开关与模型映射，并逐步完善调度、日志与前端管理能力。

## 已完成
- 服务层：`openaiAccountService`
  - 新增 `allowClaudeBridge`（是否允许被 Claude 桥接调度）与 `claudeModelMapping`（Claude→OpenAI 模型映射）。
  - `create/get/update/getAllAccounts` 全链路支持序列化/反序列化与兼容默认值；列表返回补充规范化数据。
  - 测试环境跳过解密缓存清理定时器，避免 Jest 退出时异步日志告警。
- 管理接口：`/openai-accounts`（Admin 路由）
  - 创建/更新支持新字段，布尔与 JSON 入参校验，错误信息清晰。
- 配置：`config/config.example.js`
  - 新增 `claudeBridgeDefaults`，支持默认模型与全局映射（可由环境变量提供 JSON）。
- 测试基线：新增/完善 5 套用例（转换器、桥接路由、账户与 Admin API），均通过。
- 文档：`docs/claude-openai-bridge-plan.md` 方案已落库。

## 待进行（按小迭代推进）
1) 调度增强（后端）
- 在 `unifiedOpenAIScheduler` 中，当来源为 Claude→OpenAI 桥接时，纳入 `allowClaudeBridge=true` 的 `openai` 账户与 `openai-responses` 账户共同参与筛选；保持粘性/限流/优先级规则。

2) 模型映射接入（桥接层）
- `claudeOpenaiBridge.js` 根据 “账户映射 → 全局映射 → 默认模型” 的优先级确定上游模型；补充映射来源调试日志与缺省回退。

3) 前端管理（Admin SPA）
- 在 `AccountsView.vue` 增加开关与映射配置（JSON 文本域或键值编辑器），表单校验与回显。

4) 日志与稳健性
- 将客户端断连 `CanceledError` 在 `openaiResponsesRelayService.js` 中降级为 info，并保留上下文。

5) 文档与配置
- 更新 README/.env 示例，补充映射示例、回滚说明与部署注意事项。

## 备注
- 测试超时策略：>10 分钟的自动测试改为人工验证；当前所有新增用例已在本地通过。
- 部署注意：勿直接修改运行目录 `/home/leeson/claude-relay-service/app`，该目录仅用于查看日志。
