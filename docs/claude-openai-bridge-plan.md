Claude CLI → OpenAI Responses 调度改造方案
===========================================

背景
----
- 目前 `/claude/openai/v1/messages` 仅调度 `openai-responses` 平台账户，Claude CLI 的请求无法复用已有 OpenAI 直连账户。
- Claude CLI 在调用时需要把 Claude 模型映射成 OpenAI 模型，现有桥接层仅支持内置的 `defaultModel`，无法按账户配置映射关系。
- 管理后台尚未暴露「允许 Claude API 调用」的开关，导致配置灵活度不足。

目标
----
1. **扩展账户配置**：为 `openai` 平台账户新增布尔型 `allowClaudeBridge` 与可选的 `claudeModelMapping`（键为 Claude 模型，值为 OpenAI 模型）。
2. **调度逻辑调整**：当请求来源为 Claude API，允许选择已开启 `allowClaudeBridge` 的 `openai` 账户，并沿用现有粘性会话、优先级与限流判定。
3. **模型映射支持**：桥接层根据命中账户的映射表和全局默认值决定最终投递到 OpenAI 的模型。
4. **配置管理**：管理后台支持新增字段的展示、编辑与校验，API 与配置模板同步更新。
5. **可观测性**：补充日志以确认调度来源、映射命中情况，方便排障。

设计方案
------

### 数据结构与配置
- **后端服务层** (`openaiAccountService`):
  - `createAccount`/`updateAccount` 增加 `allowClaudeBridge`（默认 `false`）与 `claudeModelMapping`（序列化存储）。
  - `getAccount`/`getAllAccounts` 时解析布尔值与 JSON，保证旧数据兼容（字段缺省视为 `false`）。
- **配置模板**：`config/config.example.js` 增加 `claudeBridgeDefaults`（全局默认模型、fallback 映射等），并在账号示例中注明新字段。
- **校验层**：`src/validators/clientDefinitions.js` 和 `claudeCodeValidator.js` 增加字段校验、限制映射表值仅允许 OpenAI 模型名字符串。

### 调度流程
- **入口识别**：在 `claudeOpenaiBridge.js` 中附带请求元信息（如 `req._bridgeSource = 'claude-cli'`）。
- **筛选策略** (`unifiedOpenAIScheduler.selectAccountForApiKey`):
  - 维持原有粘性、限流、优先级逻辑。
  - 在候选列表阶段增加过滤：当请求标记为 Claude Bridge 时，允许 `openai-responses` 账户（现有流程）以及 `allowClaudeBridge === true` 的 `openai` 账户共同参与。
  - 若 API Key 绑定专属 `openai` 账户但未开启开关，则保留当前拒绝逻辑并返回 403，提示管理员。

### 模型映射
- **解析顺序**：
  1. 账户级 `claudeModelMapping` 命中。
  2. 全局 `claudeBridgeDefaults.modelMapping`。
  3. 默认回退 `claudeBridgeDefaults.defaultModel`。
- **实现位置**：
  - 扩展 `ClaudeToOpenAIResponsesConverter` 构造函数接受映射表与默认模型。
  - 在选定账户后，将账户映射表合并传入转换器；若账户允许但未配置映射，使用全局默认。
  - 若最终仍无法确定模型，返回 400 并输出详细日志。

### 管理后台
- **界面**：
  - `AccountsView.vue` 中为 `openai` 类型账户新增开关与映射输入（可用 JSON 文本域或键值对编辑器）。
  - `AccountUsageDetailModal.vue`、列表页增加字段展示，便于排查。
- **接口**：更新 `src/routes/admin.js` 相应 API，确保新增字段在创建/更新时透传并校验。

### 日志与调试
- `claudeOpenaiBridge.js`：记录请求来源、目标模型、映射来源（账户 / 全局 / 默认）。
- `unifiedOpenAIScheduler`：当 Claude 请求命中 `openai` 账户时提示 `allowClaudeBridge=true`。
- `openaiResponsesRelayService`：标记 `bridgeAccountType`，方便关联上游日志。

### 兼容与迁移
- 现有 `openai` 账户默认不开启 Claude 调度，避免意外使用。
- 后端在读取旧账号数据时若缺少新字段，按默认值补齐，不影响现行流程。
- 若已有手动维护映射，可编写一次性脚本迁移到 Redis 中的账户字段（可选）。

验证计划
------
- **单元测试**：扩展转换器与调度器测试，覆盖映射命中、开关过滤、回退路径。
- **集成验证**：模拟 Claude CLI 请求命中 `openai` 与 `openai-responses` 两类账户，确认日志、调度结果与上游模型一致。
- **回归检查**：确保原有 Codex/OpenAI API 与管理后台操作不受影响；执行 `npm test` 与关键 lint。

风险与待定事项
-----------
- 映射表配置界面的用户体验与校验需与产品确认（JSON 输入 vs. 可视化编辑）。
- 若账户级映射项数较多，需评估 Redis 存储与读取性能（建议限制在几十条以内）。
- 未来若支持 Claude 工具调用，需要新增 tools 转换逻辑，当前方案未覆盖。
