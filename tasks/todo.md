# Todo — live status (source of truth for restarts)

Plan: `tasks/plan.md`. Mark `[x]` only when the task's tests are green. Times are wall-clock targets from start (T0 ≈ 2026-10-03 16:40 local).

## H0 — human prerequisites (async)
- [ ] ANTHROPIC_API_KEY in `.env` (+ Anthropic workspace spend limit) — user, later today
- [ ] `railway login` + Hobby plan — user, later
- [ ] GitHub repo + visibility decision — confirm before first push

## S0 — Skeleton (≤1h)
- [x] T0.1 Scaffold, configs, CLAUDE.md, docs skeletons, research.md, agent-log.md
- [x] T0.2 DB (pragmas, DDL from target schema, triggers, partial indexes, boot recovery, seed) + Hono app (health, Basic auth, envelope, request id, pino, log buffer) + static shell + Dockerfile
- [~] Checkpoint S0: typecheck + tests green; boot test ✓ — docker build/run/persist PENDING (host disk full; Dockerfile fixed)

## S1 — Plan → review → dry run (≤2.5h)
- [x] T1.1 Dataset generator + fixtures + loader
- [x] T1.2 DSL ops + signature table + toTargetRow
- [x] T1.3 Validation + evidence + dedupe + static plan validator + DDL parity
- [x] T1.4 Profile + candidates + gaps + triggers/patches + heuristic draft
- [x] T1.5 Dry run (partition, hash, byField, conflict preflight)
- [x] T1.6 Versions/approvals/clarification patches/diff API + minimal UI (Inputs, Proposal-heuristic, Review, Dry run)
- [x] Checkpoint S1

## S2 — Execute → retry → reconcile → rollback → history (≤2h)
- [x] T2.1 Gates + run lock + execute + retry
- [x] T2.2 Reconcile verdicts + rollback + workspaces
- [x] T2.3 UI: Execute, Reconcile & rollback, History, Logs, status banner
- [x] Checkpoint S2

## S3 — Agent (≤1.5h + 0.5h when key lands)
- [x] T3.1 LlmClient (Beta types), tools, strict lint, guard, loop, persistence, caps, async runs
- [x] T3.2 Anthropic adapter + stub-fetch contract tests + Proposal UI (trace, risks, clarifications, heuristic CTA)
- [ ] T3.3 Live smoke (needs key): latency/iterations/cache; transcript fixture
- [ ] Checkpoint S3

## S4 — Harden, test, document, ship (≤2h)
- [x] T4.1 Playwright 2 specs (heuristic path)
- [x] T4.2 Security/perf pass + bench
- [x] T4.3 Adversarial code review workflow (4 lenses, 32 failing tests ≈ 26 issues) + fixes
- [x] T4.4 README, AGENT_USAGE.md, .env.example final
- [ ] T4.5 Deploy (user-confirmed), hosted smoke, fresh workspace, submission remarks

## Stretch (cut order)
1 Brotli · 2 cost_usd/OTel names · 3 eval P/R/F1 · 4 fc.commands model test · 5 agent re-run w/ answers · 6 param editors · 7 enum coverage · 8 warm-up ping · 9 per-IP limiter

## Status 2026-10-03 (end of build session)
- Green: typecheck · 1345/1345 vitest (unit, property, integration incl. gates, agent, boot, verify) · Playwright journey under the
  production CSP · bench well within budget at 500 rows · web build 84 KB gz initial.
- Done since last status: final adversarial review fixes (PII/injection leak via preview, stale and forged clarifications, CSRF and
  headers, fail-closed auth, TRUST_PROXY caps, crash-safe agent finish, workspace/agent guard, dedupe with failed twin, pending and
  money reconcile, retry-after-rollback, failAfter bounds, run filters), docs truth pass, `railway.json`.
- Waiting on the user:
  1. ANTHROPIC_API_KEY in `.env` → T3.3 `npm run smoke:agent` (fill results into AGENT_USAGE.md).
  2. `railway login` → T4.5 deploy (commands in README; confirm with the user first).
  3. Local docker build/run smoke: deferred (host disk is low; Railway builds remotely).
