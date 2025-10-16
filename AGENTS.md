# Repository Guidelines

Repository maintainers expect contributors to move quickly while keeping bridge stability front-of-mind. Treat the sections below as a checklist when planning work or triaging incidents.

## Project Structure & Module Organization
- `src/` holds the Node.js relay; `routes/claudeOpenaiBridge.js` and `services/openaiResponses*` drive event conversion, while `middleware/` guards auth and rate policies.
- `cli/` bundles operational utilities (migration, account toggles); `scripts/` schedules daemons—run `node scripts/manage.js status` before modifying automation.
- `config/` stores environment templates and cached pricing; `web/admin-spa/` builds the admin SPA into `web/admin-spa/dist` for Express hosting.
- Runtime logs live on the deployment host under `app/logs`; never edit `/home/leeson/claude-relay-service/app` directly—work through version control.

## Build, Test, and Development Commands
- `npm install && npm run install:web` seeds dependencies; follow with `npm run setup` to create baseline data.
- `npm run dev` starts nodemon for the backend; use `npm run service:start` or `npm run service:restart` when managing the systemd-style wrapper.
- `npm run build:web` compiles the admin SPA; redeploy by syncing `src/` and restarting services. Diagnostics: `npm run status:detail` inspects throttle pools, `npm run monitor` streams health metrics, and `node scripts/manage.js status` reveals daemon activity.

## Coding Style & Naming Conventions
- Enforce ESLint and Prettier with two-space indentation and single quotes in backend code.
- Use camelCase for functions, PascalCase for exported classes, and snake_case log keys to keep `requestId` searching consistent.
- Route handlers stay thin; extract cross-service logic into `services/` and share helpers via `utils/`.
- Remove temporary `logger.debug` statements before merging or downgrade them to `info`.

## Testing Guidelines
- Jest powers unit tests; run `npm test` or scope with `npm test -- path/to/file`.
- Bridge changes must include a simulated request under `tests/` (e.g., extend `tests/claude-openai.test.js`) to confirm event ordering.
- Verify streaming flows with `test_codex_cli.sh` when modifying SSE handling; capture anomalies from `/app/logs/claude-relay-*.log`.

## Commit & Pull Request Guidelines
- Start commit messages with an action verb (`Support bridge fallback`, `增加调试信息`); stay concise.
- PRs should detail affected endpoints, reproduction steps, and any deployment touches—attach log excerpts instead of raw files.
- Document config changes in `.env.example`, including rollback instructions.
- Split multifaceted updates into reviewable patches; note follow-up tasks in `TEST_REPORT.md` if validation is pending.

## Security & Operations Tips
- Toggle account availability via the admin SPA or CLI scripts—avoid manual database edits.
- Investigate relay issues with `/app/logs/claude-relay-*.log` and `http-debug-*.log`, and confirm new model mappings in `routes/claudeOpenaiBridge.js` before deploying.
