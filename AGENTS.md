# Repository Guidelines

## Project Structure & Module Organization
The backend entrypoint is `src/app.js`, with domain folders (`routes/`, `services/`, `models/`, `utils/`, `validators/`) that should remain single-responsibility. CLI automation lives in `cli/` and `src/cli/`, while operational scripts (deploy, data transfer, migrations) stay in `scripts/`. Copy templates from `config/` and `.env.example` during `make setup`. The admin SPA sits under `web/admin-spa` with its own npm lifecycle, architecture notes live in `docs/`, and pricing tables in `resources/model-pricing/` feed `pricingService`.

## Build, Test, and Development Commands
Run `make setup` once for dependencies and baseline config. Use `npm run dev` for hot-reload development, `npm start` for a linted production run, and `npm run service:start` for managed staging processes. Frontend work requires `npm run install:web` then `npm run build:web`. Health and telemetry tooling is available through `make docker-up` / `make docker-down` and `npm run service:logs:follow`.

## Coding Style & Naming Conventions
JavaScript follows Node 18 CommonJS with 2-space indentation, single quotes, and no semicolons, enforced by ESLint and Prettier (`npm run lint:check`, `npm run format:check`). Keep filenames in lowerCamelCase (`pricingService.js`) except shell scripts, which use kebab-case. Inject configuration only through helpers in `config/` and favour async/await over raw promises.

## Testing Guidelines
Jest drives the automated suite (`npm test`). Place new specs as `*.test.js` near the code they cover or inside `__tests__/` folders so Jest picks them up. For integration drills, extend the harnesses in `scripts/test-*.js` and document required env vars in the script header. Validate coverage with `npm test -- --coverage` and mock external APIs or Redis via utilities in `src/utils/`.

## Commit & Pull Request Guidelines
Commit messages are short imperatives (Chinese or English) such as `修复转发路径` or `Add cache monitor hooks`; keep subjects under 72 characters and use the body for context or migration notes. PRs should state what changed, why, and how you validated it (e.g., `npm run lint:check`, `npm test`). Link issues with `Closes #123` and attach screenshots for UI changes touching `web/admin-spa`. Document any config or credential updates before requesting review.
