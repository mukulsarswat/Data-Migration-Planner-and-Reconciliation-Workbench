# Migration Workbench — agent rules

Agentic data-migration planner + reconciliation workbench (Aggroso take-home, Problem 2). One bounded dataset:
`legacy_customers` → `accounts`. Plan of record: `tasks/plan.md`; live status: `tasks/todo.md` (update it as tasks finish).

## Stack
Node 26 (native TS type stripping, no server build) · Hono 4 + @hono/node-server · better-sqlite3 13 (single file, WAL) ·
zod 4 · @anthropic-ai/sdk (beta messages, manual tool loop) · React 19 + Vite 8 + TanStack Query + Tailwind 4 · Vitest 5 + fast-check · Playwright.

## Commands
- Typecheck: `npm run typecheck`  ·  Tests: `npm test` (offline; never hits the network)  ·  One file: `npx vitest run path/to/file.test.ts`
- Dev: `npm run dev` (server :8787 + vite :5173)  ·  Start: `npm start`  ·  Build web: `npm run build`  ·  E2E: `npm run test:e2e`
- Live agent smoke (needs key): `npm run smoke:agent`  ·  Reset local DB: `npm run db:reset`

## Hard conventions
- **Erasable TS only** (Node strips types): no `enum`, no `namespace`, no constructor parameter properties, no decorators.
  Use `as const` objects + union types. Relative imports MUST include the `.ts`/`.tsx` extension. Type-only imports MUST use `import type`.
  Read JSON with `fs.readFileSync` (not `import x from './a.json'`).
- `shared/` is pure (no Node/DOM APIs) and is imported by both server and web via relative paths.
- Determinism: engine code never calls `Date.now()`, `new Date(string)`, `Math.random()`, or `localeCompare`. Time is injected. Sort with plain `<` comparison.
  Money is integer cents. Dates are 'YYYY-MM-DD' strings built from integers.
- SQLite: never `await` inside a `db.transaction`. Mutating runs use `.immediate`. Bind only primitives (convert via `toTargetRow`).
- Append-only tables (`events`, `plan_versions`, `approvals`) are protected by triggers — never UPDATE/DELETE them.
- The LLM is advisory: it may only call read-only tools; every agent output is re-validated server-side. Tool results carry data only as JSON.
- Errors to clients use the envelope `{error:{code,message,details,requestId}}`. Gate violations = 409, validation = 422, caps = 429.

## Workflow
- TDD: write the failing test first, then the code. Bug fix ⇒ reproduction test first.
- Keep tests offline and deterministic; LLM tests use the scripted client or the stub-fetch adapter tests.
- Log notable agent mistakes / rejected suggestions in `docs/agent-log.md` as they happen (feeds AGENT_USAGE.md).

## Boundaries
- Never commit `.env` or secrets; `.env.example` holds names only.
- **Never run `git commit`/`git push`** (the user handles all git history). Leave changes uncommitted.
- Ask the user before: deploying, changing hosting, or spending API credits beyond smoke tests.
