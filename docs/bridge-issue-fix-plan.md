# Problem Fix Plan: Claude Console Bridge Responses

## 背景
- 请求 `r88u8imbvw` 直连 OpenAI Responses，Codex CLI 成功展示完整 `Repository Guidelines` 内容。
- 请求 `nr9w4e24fx9` 通过 Claude Console 桥接，仅返回开场问候（"Hello! I'm ready..."），未生成正文。
- 当前桥接逻辑会把长说明压入 system prompt，Claude Haiku 在高压提示下只反馈准备语，缺少任务执行。

## 目标
- 让 Claude Console 桥接模式产出与直连模式一致的完整文本响应。
- 保持现有事件转换器（`ClaudeToOpenAIResponsesConverter`）生成标准 SSE 序列。

## 修复步骤
1. **梳理 prompt 转换链**
   - 复查 `src/services/openaiResponsesToClaude.js`（或等效入口）中 instructions、input、messages 的映射。
   - 记录实际发送给 Claude 的 `system` 与 `messages` 内容，确认是否存在过长或重复的 system prompt。

2. **调整指令拆分策略**
   - 若用户指令过长，考虑将主体放入 `messages[0].content`，仅保留简短 guardrails 在 `system`。
   - 为 Haiku 添加明确的任务执行提示（如“直接输出最终文档，不必等待确认”）。

3. **本地验证生成质量**
   - 使用相同输入执行一次桥接调用，捕获 `/app/logs/claude-relay-*.log` 中的新事件。
   - 确认 `response.output_text.delta` 包含正文片段而非问候语。

4. **扩展自动化测试**
   - 在 `tests/claude-openai.test.js` 或新增用例中模拟相同 prompts，断言 delta 事件含关键段落（例如 "Project Structure"）。
   - 更新 `test_codex_cli.sh` 以回归此场景。

5. **部署与监测**
   - 部署前执行 `npm run monitor` 与 `node scripts/manage.js status` 确认桥接服务健康。
   - 部署后复查最新日志，比较 token usage 与事件序列，确保与直连模式一致。

## 风险与缓解
- **Claude 输出仍可能被截断**：必要时调整 `max_tokens` 或改用 Sonnet 模型。
- **新增提示影响直连模式**：将 prompt 策略封装在 Claude 专用分支，避免影响 OpenAI Responses 直连。
- **自动化不捕捉语义偏差**：除正则断言外，保留人工 spot check（抓取最新日志片段）。

## 时间线建议
1. 分析与 prompt 调整：0.5 天
2. 本地验证与日志核对：0.5 天
3. 测试补充、完善脚本：0.5 天
4. 部署与观察：0.5 天

> 负责人：桥接模块维护人（建议与运维值班确认窗口）。
