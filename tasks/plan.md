# Plan — Agentic Data Migration Planner & Reconciliation Workbench (Aggroso Problem 2, Expert)

## Context

Aggroso candidate assessment, **Problem 2 (Expert, 7–10h focused effort)**; ~30h left on the 48h clock (2026-10-03).
Graded on: usable frontend + working backend + persistence; functional AI agent with human approval; clear loading/empty/
validation/success/failure states; structured app + AI-workflow logs; focused tests; **working hosted deployment with the AI
operational until review ends**; `README.md`, `AGENT_USAGE.md`, `.env.example` (never commit secrets).

`/Users/manishsoni/MK_PRJ` is greenfield (only skill folders). Toolchain: Node 26.3, npm 11, Docker 29, sqlite3, gh (soni0021),
firecrawl, railway CLI (not logged in). No `ANTHROPIC_API_KEY` and no `ant` CLI profile.

**User decisions:** TypeScript full-stack · Claude, default **`claude-sonnet-5-5`** · dataset **Legacy CRM `legacy_customers` → `accounts`** ·
hosted demo behind **Basic auth + per-IP limit + daily agent cap** · **API key arrives later today** · **hosting set up later by the user**
(Railway Hobby recommended) · lightweight, performant, aggressively tested (TDD).

**Outcome:** one bounded dataset (documented max **500** records; ships **200**) is profiled, gap-analysed and mapped by a tool-restricted
Claude agent (or a labelled deterministic heuristic draft), reviewed/edited/approved by a human, dry-run deterministically, executed
idempotently into a mock target, reconciled and rolled back — with append-only history of every approval, run, retry and rollback.

**Research basis** (6-angle sweep + 4-lens adversarial plan review; notes in workflow journals → `docs/research.md`): SchemaPilot (closest
analogue: "AI reasons, policy decides, humans approve ambiguity"; `source = migrated + rejected`), DataBridge-D365 (Claude + fixed
transform enum + audit log), Flatfile mapping DSL (finite rules, explicit `ignore`), AWS DMS failure tables + error escalation,
dbt-audit-helper reconcile statuses, dlt `_load_id` lineage, pandera long-format failures, Magneto/Matchmaker/Parciak (candidates →
LLM, target-centric N-to-1, abstain option, 3-level confidence), Anthropic jailbreak guidance (untrusted data only in JSON tool results).
No mature OSS "LLM migration planner" exists → differentiator is **execution discipline**; the LLM is strictly advisory.

---

## Architecture decisions

| # | Decision | Why |
|---|---|---|
| A1 | New git repo `MK_PRJ/migration-workbench/`, **single package.json** (no workspaces): `shared/`, `server/`, `web/`; `shared` imported by relative path (server) / Vite alias (web) | One install, one container; avoids type-stripping refusal for `.ts` under `node_modules` |
| A2 | Server runs **TS directly via Node native type stripping** (`node server/src/index.ts`); tsconfig: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`, `module/moduleResolution: nodenext`, `resolveJsonModule`; JSON fixtures read via `fs.readFileSync`. `tsc --noEmit` (TS 7) for typecheck. A Vitest **boot test** spawns the real `node server/src/index.ts` and polls `/api/health` so strip-only failures can't hide behind Vite's transform | No server build; fallbacks: `tsx`, TS 5.9 |
| A3 | Runtime **Node 26** everywhere (`.nvmrc`, `engines`, Docker `node:26-slim`), `TZ=UTC` in scripts + Dockerfile | Tested runtime == shipped runtime (Node 26 LTS 2026-10-28) |
| A4 | **Hono 4.13** + `@hono/node-server` 2; serves Vite `dist/` via `serveStatic`; `compress()` for JSON | Tiny; `app.request()` port-less integration tests |
| A5 | **better-sqlite3 13** (N-API; glibc+musl prebuilds bundled), single file `DB_PATH`, WAL, `synchronous=NORMAL`, FK on, `busy_timeout`; hand-written SQL; `schema.sql` on boot; no ORM | Transaction helper + savepoints; single file because ATTACH'd transactions aren't atomic under WAL. Never `await` inside a transaction |
| A6 | Mock target `tgt_accounts`: DDL CHECK/NOT NULL/UNIQUE **generated from `target-schema.json`** (same source as the JS validator, parity-tested); lineage `_load_run_id`; **5 pre-existing rows** (3 collide with source keys) | Validator/DDL can't drift; rollback must spare foreign rows |
| A7 | Closed declarative **transform DSL** (14 ops) with an **op signature table** (in/out type, null behaviour, arity) driving static validation; strict-compatible wire format (no dictionaries: `map_values.pairs:[{from,to}]`; `default.value` string coerced by target type) | Flatfile/Auto-Tables precedent; VRL-style fail-before-run; strict tool compatible |
| A8 | Agent = **manual tool loop** on `@anthropic-ai/sdk` 0.131 behind an `LlmClient` port typed with **Beta** types (`BetaMessageParam`, `BetaMessage`, `BetaToolUnion`) | Explicit terminal-tool semantics, step persistence, scripted fakes; fallbacks need the beta namespace |
| A9 | Request shape: `client.beta.messages.create({model: ANTHROPIC_MODEL ?? 'claude-sonnet-5-5', max_tokens: 16000, output_config:{effort:'medium'}, thinking:{type:'adaptive', display:'summarized'}, tool_choice:{type:'auto'}, cache_control:{type:'ephemeral'}, betas:['server-side-fallback-2026-07-01'], fallbacks:'default', …}, {timeout: min(remaining,120s), maxRetries:1, signal: runAbort})` with `runAbort = AbortSignal.timeout(180s)`; never `thinking.disabled`/`budget_tokens`; no prefill | Claude API reference (forced tool_choice 400s on Sonnet/Opus 5.5; non-streaming 16k is SDK-safe; summarized thinking makes the trace readable) |
| A10 | **Only `submit_migration_plan` is `strict:true`** (enum/const/anyOf/$ref ok; no min/max/length, all objects `additionalProperties:false`); other tools small non-strict + zod; a `lintStrictSchema()` unit test guards the tools array | Strict-mode limits; avoids 400s discovered late |
| A11 | **Deterministic pre-processing**: field profiles (type class, null rate, distinct ratio/key flag, format signatures, length range; PII-masked top values) + candidates (normalized-name exact = 1.0, synonym table, 3-gram Dice, type-compat filter) + **fieldGaps** + **clarification triggers with deterministic patch options** + **heuristic draft** | Magneto/Parciak; powers agent tools, the no-LLM path, and e2e |
| A12 | Immutable **plan versions** (canonical JSON → SHA-256), immutable **approvals** (`UNIQUE(plan_version_id)`, one terminal decision), triggers block UPDATE/DELETE on `plan_versions`, `approvals`, `events`; `assertExecutable()` recomputes the hash from `plan_json` | Approve→reject can't leave a stale "approved"; tamper-evident |
| A13 | Idempotency at the **data layer**: target `UNIQUE(external_ref)`, ledger lookup → `INSERT … ON CONFLICT(external_ref) DO NOTHING RETURNING id`, ledger partial UNIQUE active `(migration_id, source_key)`; **run lock**: every mutating run (execute/retry/rollback) opens one IMMEDIATE tx that runs gates + inserts its `runs` row `running` (partial UNIQUE ⇒ 409 `RUN_IN_PROGRESS`); execute fully synchronous (batches of 50, per-row savepoints); retry-once per run (`UNIQUE(parent_run_id)`); UI disables buttons while pending. **No Idempotency-Key header machinery** | Requirement met where it matters; less code |
| A14 | Rollback = ledger-scoped compensating delete, one IMMEDIATE tx; `NOTHING_TO_ROLL_BACK` 409; ledger rows keep `rolled_back_at` | Pre-existing rows protected; re-execute allowed |
| A15 | **Workspaces instead of destructive reset**: "Start new workspace" = recorded rollback of active rows + new `migrations` row made current; nothing deleted; history filterable; status banner shows workspace state. Dev-only `npm run db:reset` deletes the file | Shared hosted demo stays clean for each grader without violating append-only history |
| A16 | React 19.3 + Vite 8 + TanStack Query 5 + Tailwind 4; native `<table>`/`<dialog>`; one generic `<AsyncPanel>` for loading/empty/error/success; no router (stepper) | Bundle < 200KB gz; fast UI build |
| A17 | pino JSON logs (redaction) → stdout **and** in-memory ring buffer (last 1000) exposed at `GET /api/logs?requestId&level` + Logs tab; request id in every error envelope links there; agent steps persisted (model, response model, tool, args, result summary, summarized thinking, stop_reason, request_id, latency, tokens incl. cache) | Graders can *see* structured app + AI logs on the hosted site |
| A18 | Basic auth (`BASIC_AUTH_USER/PASS`) on everything except `/api/health`; per-IP (10/day) + global (60/day) agent caps, configurable; `/api/health` reports `{db, llm:{configured, model, lastRunStatus, lastRunAt}}`; Docker `HEALTHCHECK` via `node -e fetch(...)` | Keeps the AI operational and cheap during review |
| A19 | Hosting: Railway Hobby (volume `/data`, `DB_PATH=/data/workbench.db`, Serverless off, `RAILWAY_RUN_UID=0` if non-root). Local `docker build && docker run -v` smoke at every checkpoint | Render/Koyeb free lose SQLite; Fly trial auto-stops |

---

## Engine contract (lives in `shared/`, locked by tests in S1/S2)

**DSL ops & signatures** — step `{op, params}`; mapping `{target, sources[], steps[], origin: agent|heuristic|human, confidence: high|medium|low, rationale}`.
Input = the value for 1 source, `string[]` for ≥2 (only `concat` accepts arrays). Arity: 0 sources ⇒ first step must be `default`; ≥2 ⇒ first step must be `concat`.
`''` ≠ `null` until `null_if_empty`. All ops pass `null` through except `null_if_empty`, `default`, `map_values` (fallback), `to_boolean`.
Ops: `copy`, `trim`, `lowercase`, `uppercase`, `null_if_empty`, `default{value}`, `split_full_name{part:first|last}` ('Doe, Jane' | 'Jane Doe'),
`concat{separator}`, `parse_date{formats[]}` (hand-written token parser `yyyy/MM/dd/MMM`, ISO string from integers, `Date.UTC` round-trip calendar
check, **never `new Date(string)`**; `AMBIGUOUS_DATE` when ≥2 formats yield different dates), `parse_currency_to_cents` (regex: sign/parens/$/comma
thousands/0–2 decimals → integer assembly, no float), `to_integer`, `to_boolean{true_values,false_values}`, `map_values{pairs:[{from,to}], fallback}`
(lookup via `Map`), `normalize_phone{default_country:'US'}` → E.164 (NANP; documented limit).

**Plan** = `{mappings[], ignored:[{source, reason}], clarifications[], risks[], summary}`; **server-owned** `errorBudgetPct` (default 30, human-editable 0–50,
in plan hash; agent-supplied value rejected). **fieldGaps** (computed server-side, annotated by agent): `sourceWithoutTarget` (fax, notes),
`requiredTargetWithoutSource` (country), `typeIncompatible` (bal→cents, signup_dt→date, vip_flag→bool, status code→enum) + suggested ops.

**Static validation (approve gate):** refs exist; op params valid; arity rules; source type → op chain → target type compatible; every required target
covered (a `default`-only mapping counts); every source field mapped or `ignored`; no unresolved clarification; reviewer named.

**Clarification** = `{id, question, impact, trigger, options:[{label, patch}]}`; triggers: required target w/o source, unmapped enum values,
ambiguous date formats, lossy cast, small top-2 candidate margin, agent `NO_MATCH`. Choosing an option applies its `patch` server-side → new
`human` version with diff (**no LLM call**). E.g. country → `{target:'country', sources:[], steps:[{op:'default', params:{value:'US'}}]}`.

**Record partition (dry run):** `source = transform_failed + transformed`; `transformed = accepted + validation_rejected`; `rejected = transform_failed + validation_rejected`.
Then whole-dataset duplicate check on the **transformed `external_ref`**: all members of a duplicate group → rejected `DUPLICATE_TARGET_KEY` (evidence lists siblings; order-independent).
Records sorted by `(source_key)` where `source_key` is a generator-assigned surrogate (`r0001`…; `cust_id` stays in payload).
`result_hash = sha256(canonical({planHash, sourceHash, per-record outcomes}))` — transform/validation only. **Conflict preflight** (read-only count of
accepted keys already present in target and not owned by this workspace) shown beside the dry run, *outside* the hash. Counts also `byField{total,valid,error,empty}`.

**Evidence** (long format): `{sourceKey, stage: transform|validation|dedupe|load, targetField, sourceFields, rawValues, stepIndex, op, code, message}`;
codes `MISSING_REQUIRED, TRANSFORM_FAILED, AMBIGUOUS_DATE, TYPE_MISMATCH, ENUM_VIOLATION, PATTERN_VIOLATION, MAX_LENGTH, DUPLICATE_TARGET_KEY, TARGET_CONFLICT, LOAD_CONSTRAINT`.
All errors per record collected; raw record kept. `toTargetRow()` (bool→0/1, date→'YYYY-MM-DD', cents→int, undefined→null) is used for insert binding **and** row hashes.

**Execute gates (409 with actionable message):** `assertExecutable` (approved, hash recomputed == version == approval); succeeded dry run for this hash;
reject rate `rejected/source ≤ errorBudgetPct` ("34% > 30%: edit mappings or raise the budget in a new version"); no running run; no active ledger rows from a
*different* version ("rollback first"). Per record: active ledger row ⇒ `skipped_existing` (assert target row exists); else insert `RETURNING id` ⇒ ledger ⇒
`inserted`; no row ⇒ `conflict` (TARGET_CONFLICT); savepoint-caught constraint error ⇒ `LOAD_CONSTRAINT`. Recompute transform hash == approved dry-run hash.
`failAfter` demo control fails after N records (committed batches persist). **Retry** = child run (attempt+1), same gates.
**Load partition:** `accepted = loaded_active + conflict + load_rejected + pending`.

**Reconcile (from current state, not run counters):** dry-run accepted keys for the active version vs active ledger vs target anti-joins; `SUM(balance_cents)`;
per-key statuses (perfect match / missing from target / values do not match / extra in target) via business-column row hash.
Verdicts: **MATCHED** (pending=0, extra=0, mismatched=0, sums equal) · **INCOMPLETE** (pending>0 after failed/interrupted run) · **ROLLED_BACK_CLEAN**
(active ledger 0, no `_load_run_id` rows, pre-existing snapshot hash unchanged) · **MISMATCHED**. Totals panel: source 200 · accepted · rejected · conflicts · target = 5 pre-existing + loaded.

**Rollback:** IMMEDIATE tx with run lock; delete target rows of active ledger rows; set `rolled_back_at`; record run + event; post-check = ROLLED_BACK_CLEAN.

---

## Bounded dataset — `server/src/dataset/` (committed fixtures from seeded `scripts/gen-dataset.ts`)

- `source-schema.json` `legacy_customers` (with descriptions): `cust_id` 'C-00042', `full_name` ('Doe, Jane' | 'Jane Doe'), `email_addr`, `phone`
  ('(555) 123-4567' | '555.123.4567' | '+1 555…'), `status` ('A'|'I'|'P'|''|'X'), `signup_dt` ('03/14/2019' | '2019-03-14' | '14-Mar-2019' | '03/04/2019'),
  `bal` ('$1,234.50' | '-$12.00' | '(45.00)' | ''), `vip_flag` ('Y'|'N'|'yes'|''), `fax`, `notes`.
- `target-schema.json` `accounts`: `external_ref` UNIQUE NOT NULL, `first_name` NOT NULL ≤50, `last_name` NOT NULL, `email` nullable lowercase pattern,
  `phone_e164` nullable `^\+[1-9]\d{7,14}$`, `status` enum active|inactive|pending NOT NULL, `created_on` DATE NOT NULL, `balance_cents` INTEGER NOT NULL,
  `is_vip` BOOLEAN NOT NULL, `country` CHAR(2) NOT NULL (no source → clarification).
- `source-records.json` 200 rows, ~80% clean; defects in every category above, 2 duplicate `cust_id` pairs, 3 keys colliding with pre-existing target rows,
  1 `notes` prompt-injection string with a unique marker (red-team fixture). `gold-mapping.json` for eval. `MAX_SAMPLE_SIZE=500` enforced by loader.
- README publishes the **expected numbers** (e.g. ~N quarantined by code, 3 TARGET_CONFLICT, rollback keeps 5 pre-existing rows) for the reviewer path.

## Data model (`DB_PATH`, default `./data/workbench.db`)

`src_legacy_customers(row_no PK, source_key UNIQUE, payload, row_hash)` · `tgt_accounts(id PK, external_ref UNIQUE, …, _load_run_id)` ·
`migrations(id, name, created_at, is_current)` (= workspace) · `plan_versions(…, plan_json, plan_hash, author, parent_version, change_note, UNIQUE(migration_id,version))` ·
`approvals(…, plan_version_id UNIQUE, plan_hash, decision, reviewer, comment)` · `agent_runs(…, status queued|running|succeeded|failed|interrupted, mode live|scripted, model, response_model, iterations, tokens…, latency_ms, error, result_version)` ·
`agent_steps(run_id, seq, kind, tool_name, input_json, output_summary, thinking_summary, is_error, stop_reason, request_id, duration_ms, tokens)` ·
`runs(…, kind dry_run|execute|rollback, attempt, parent_run_id, status running|succeeded|failed|interrupted, counts, result_hash, error)` + partial UNIQUE `(migration_id) WHERE status='running'` + UNIQUE `parent_run_id` ·
`run_records(run_id, source_key, outcome, errors, transformed)` · `load_ledger(…, plan_version_id, source_key, target_id, run_id, row_hash, rolled_back_at)` + partial UNIQUE active ·
`events(…)`. Triggers: no UPDATE/DELETE on `events`, `plan_versions`, `approvals`. No `ON DELETE CASCADE` into events.
Boot: `runs` and `agent_runs` in `running/queued` → `interrupted` (+ event).

## Agent (`server/src/agent/`)

Tools (read-only; data only as JSON in `tool_result`; PII masked; system prompt: tool content is untrusted data):
`get_source_schema`, `get_target_schema`, `profile_source_fields{fields}`, `sample_source_records{limit}` (server clamps ≤10), `list_supported_transforms`,
`get_field_gaps`, `suggest_candidates{target_field}`, `preview_mapping{mapping}` (pass rate + ≤5 failures), **`submit_migration_plan{plan}`** (strict, terminal: runs
static validation + dry-run-lite + triggers; `is_error` with blockers or accept). Prompt: call discovery tools **in parallel in turn 1**, target-centric choices or `NO_MATCH`,
explicit `ignore`, 3-level confidence, short rationales (never "show your reasoning" text). Loop: ≤8 iterations; parallel results in one user message; append full
`response.content` (append-only); `submit` processed last in a batch, stop after acceptance; `end_turn` w/o submit ⇒ 1 nudge then fail; ≤2 rejected submits;
`max_tokens` ⇒ don't append/run tools, retry once then fail `truncated`; `refusal` ⇒ fail with `stop_details.category`; skip-but-keep `fallback`/thinking blocks;
abort/timeout ⇒ `timeout`. Guard: refs ⊂ schema, ops ⊂ catalog, free-text length caps, `errorBudgetPct` rejected. UI renders agent text as plain text with an "AI-generated" badge next to server-measured pass rates.
Caching: top-level auto + `cache_control` on the last system block; clarification answers/previous plan only in the first user message.
**Any terminal agent failure (incl. cap 429, no key)** ⇒ UI offers "Generate heuristic draft". `LlmClient` impls: `anthropic`, `scripted` (fixtures incl. a hand-written realistic transcript).

## API (zod; envelope `{error:{code,message,details,requestId}}`)

`GET /api/health` (no auth) · `GET /api/migration` (schemas, catalog, profile, gaps, workspace status) · `POST /api/workspaces` · `GET /api/source/records` ·
`POST /api/agent-runs` (202) · `GET /api/agent-runs/:id` · `POST /api/plans/heuristic` · `GET /api/plans` · `GET /api/plans/:v` (+diff vs parent) · `POST /api/plans` ·
`POST /api/plans/:v/clarifications/:id` (apply option patch) · `POST /api/plans/:v/approve|reject` · `POST /api/runs/dry-run` · `POST /api/runs/execute` ·
`POST /api/runs/:id/retry` · `POST /api/rollback` · `GET /api/runs[/:id[/records]]` · `GET /api/reconciliation` · `GET /api/target/accounts` · `GET /api/events` · `GET /api/logs`.

## Frontend (`web/`)

Status banner (workspace · current version · approval · rows loaded · LLM status) + stepper: **1 Inputs** (schemas, profile, sample, catalog, **Gaps & incompatibilities**) →
**2 Proposal** (run agent / heuristic draft, live trace with thinking summaries + tool calls + tokens, risks, clarifications with option buttons) →
**3 Review** (mapping table: origin badge, confidence, rationale, pass rate, before/after sample; edit via source `<select>` + ignore toggle + steps JSON
textarea validated by shared zod; version list + server diff; **"Dry run this version"**; approve dialog shows its dry-run summary; reject) → **4 Dry run** (count tiles,
partition, byField, quarantine table with evidence, determinism badge, conflict preflight) → **5 Execute** (execute / simulate failure / retry; per-run tiles) →
**6 Reconcile & rollback** (verdict, equations, per-key statuses) → **History** (events, filter by workspace) · **Logs** (ring buffer, filter by request id).
Every panel via `<AsyncPanel>`: loading skeleton, empty state with next action, inline validation errors, success banner, failure banner (message + request id link + retry).

## Repo layout

```
migration-workbench/  CLAUDE.md README.md AGENT_USAGE.md .env.example .nvmrc Dockerfile .dockerignore .gitignore package.json tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts
  tasks/{plan,todo}.md  docs/{research,agent-log}.md  scripts/{gen-dataset,smoke-agent,bench}.ts
  shared/{dsl,ops,plan,partition,canonical,targetRow,api}.ts
  server/src/{index,app,config,logger,logBuffer}.ts  db/{connection,schema.sql,ddl-from-schema,seed,boot}.ts  repos/*.ts  dataset/*.json
  server/src/engine/{transforms,validate,profile,candidates,gaps,triggers,heuristic,dryRun,execute,reconcile,rollback,workspace,gates}.ts
  server/src/agent/{llm,anthropicClient,scriptedClient,tools,strictLint,guard,loop,prompts,caps}.ts  server/src/routes/*.ts
  server/test/{unit,property,integration,agent,boot}/**  server/test/fixtures/*.json   web/src/{main,App,api}.tsx steps/* components/*   e2e/*.spec.ts
```

---

## Delivery plan — true vertical slices, TDD (red→green→refactor), **no commits by the agent (user handles git)**, time-boxed

**H0 — human prerequisites (async, ask at start):** (a) `ANTHROPIC_API_KEY` in `migration-workbench/.env` when available (later today) + set an Anthropic workspace
spend limit; (b) `railway login` + Hobby plan when convenient → first hosted deploy happens at the **first checkpoint after login**, then every checkpoint;
(c) empty GitHub repo + visibility decision before first push (outward-facing; confirm before pushing).

**S0 — Skeleton (≤1h, by T+1h)**
- T0.1 Scaffold repo, deps (verified versions), tsconfig per A2, `.nvmrc` 26, Vitest, CLAUDE.md (commands, erasable-only rule, boundaries), `.gitignore`, **skeleton README/AGENT_USAGE/.env.example**, `tasks/plan.md` + `tasks/todo.md`, `docs/research.md` (from research journals), `docs/agent-log.md`.
- T0.2 DB: pragmas, DDL generated from target schema, triggers, partial indexes, boot recovery, seed; Hono app + `/api/health` + Basic auth (health exempt) + error envelope + request id + pino + log ring buffer; web shell served statically; Dockerfile (`node:26-slim`, TZ=UTC, HEALTHCHECK).
- ✔ `npm run typecheck && npm test` green: triggers abort UPDATE/DELETE; partial uniques enforce; boot test spawns real server; health 200 w/o creds, other routes 401. `docker build && docker run -v` → health OK, data persists across restart.

**S1 — Plan → review → dry run (≤2.5h, by T+3.5h)**
- T1.1 Dataset generator + fixtures + loader (MAX_SAMPLE_SIZE). ✔ 200 rows, all defect categories, deterministic generator.
- T1.2 DSL ops + signature table + `toTargetRow`. ✔ table-driven tests per op incl. `null`/`''`/array input; dates under TZ=UTC/Asia/Kolkata/America/Los_Angeles; currency edge cases; `map_values` prototype keys ('constructor').
- T1.3 Validation + evidence + dedupe + static plan validator + DDL/validator parity test. ✔ test per code/rule; arity rules; default-only country valid.
- T1.4 Profile + candidates + gaps + triggers (+ patch options) + heuristic draft. ✔ gaps list exact; triggers fire for country/status/date; heuristic+country patch ⇒ approvable with zero LLM calls.
- T1.5 Dry run (partition, hash, byField, conflict preflight). ✔ fast-check: same hash twice, shuffle-invariant (fixture incl. twins), partition identities hold.
- T1.6 Versions, approvals (immutable, one decision), clarification-patch endpoint, diff; minimal UI for Inputs/Proposal(heuristic)/Review/Dry run with `<AsyncPanel>`.
- ✔ Checkpoint: API flow test heuristic → patch → approve → dry run; browser check; docker smoke; README updated.

**S2 — Execute → retry → reconcile → rollback → history (≤2h, by T+5.5h)**
- T2.1 Gates + run lock + execute (ledger, RETURNING, savepoints, failAfter, hash re-check) + retry-once. ✔ fast-check: execute×N ⇒ identical business projection; random failAfter + retry ⇒ same projection as clean run; conflicts quarantined; pre-existing untouched; 409s for every gate incl. approve→reject and rollback-while-running.
- T2.2 Reconcile (verdicts) + rollback + workspaces. ✔ reconcile after failAfter = INCOMPLETE, after retry = MATCHED, after rollback = ROLLED_BACK_CLEAN, rollback→re-execute = MATCHED; new workspace leaves history intact.
- T2.3 UI: Execute, Reconcile & rollback, History, Logs, status banner.
- ✔ Checkpoint: full no-LLM flow in browser; docker smoke; hosted deploy if login available.

**S3 — Agent (≤1.5h offline + ≤0.5h when key lands, by T+7.5h)**
- T3.1 `LlmClient` (Beta types), tools, `lintStrictSchema`, guard, loop, step persistence, caps, async runs, boot interruption. ✔ scripted tests: parallel discovery batch; unknown tool ⇒ is_error; rejected submit → corrected → accepted; no-submit nudge; iteration cap; max_tokens retry; refusal; fallback block present; abort at 180s (fake timers); injection fixture ⇒ `notes` ignored and marker absent from free text.
- T3.2 Anthropic adapter + **contract tests with stub `fetch`** (request body: model, effort, adaptive+summarized, tool_choice auto, fallbacks+beta header, strict lint; canned 400/529/timeout/refusal/fallback responses). Proposal UI: live trace, risks, clarifications, heuristic CTA on any failure.
- T3.3 (when key lands) `npm run smoke:agent`: live plan validates; record p50 latency/iterations/cache_read; save transcript as extra fixture; tune effort/iterations if p50 > 90s.
- ✔ Checkpoint: live agent → patch → approve → dry run → execute via UI; hosted redeploy + hosted live agent run.

**S4 — Harden, test, document, ship (≤2h, by T+9.5h; buffer to deadline)**
- T4.1 Playwright 2 specs on the heuristic path: (1) happy path incl. clarification patch, approve, dry run, execute, reconcile MATCHED; (2) failAfter → INCOMPLETE → retry (no duplicates) → rollback (5 pre-existing kept) → history; plus empty/validation/failure-state assertions.
- T4.2 Security/perf pass (security-and-hardening): secrets never logged, caps, auth, PII masking, bundle size, `npm run bench` (report-only: dry run 500 < 50ms, execute 500 < 200ms).
- T4.3 Time-boxed (≤45 min) adversarial code review workflow (requirements verifier + engine/agent/security hunters) → fix confirmed findings.
- T4.4 README (setup, architecture diagram, done/excluded scope, limitations, tests + traceability, deployment, reviewer path with expected numbers, sample log lines), AGENT_USAGE.md (from agent-log), final `.env.example`.
- T4.5 Final deploy (user-confirmed), verify volume persistence across redeploy, hosted smoke incl. live agent, **start a fresh workspace** so graders land on step 1; draft submission remarks (URL, Basic-auth creds, reviewer path, sample inputs).

**Cut triggers:** S1 not done by T+4h ⇒ drop stretch items 1–6; S2 not done by T+6.5h ⇒ also drop 7–9 and the Playwright spec 2 (API test covers it). Never cut: hash-bound approval gate, dry-run counts + evidence, ledger idempotency, rollback, append-only history, live hosted agent, README/AGENT_USAGE/.env.example.

**Stretch (only after hosted MVP + docs), in cut order:** 1 Brotli precompress · 2 cost_usd / OTel attribute naming · 3 eval P/R/F1 script vs gold · 4 `fc.commands` model-based test · 5 agent re-run with free-text answers · 6 structured param editors (default/map_values) · 7 enum value-coverage view · 8 boot-time agent warm-up ping · 9 per-IP limiter (keep global cap).

Skills applied: `test-driven-development` (every task), `incremental-implementation`, `debugging-and-error-recovery` (any red), `context-engineering`
(CLAUDE.md + `tasks/todo.md` as restartable state), `security-and-hardening` (T4.2), `code-review-and-quality` (T4.3), `shipping-and-launch` (T4.5).
`docs/agent-log.md` records prompts, delegations, agent mistakes and rejected suggestions as they happen (incl. this plan review's findings) → AGENT_USAGE.md.

---

## Requirement traceability (requirement → mechanism → named proof)

| Requirement | Mechanism | Proof |
|---|---|---|
| Propose field mappings | submit plan mappings (agent/heuristic) | scripted run: every required target mapped; gold F1 (stretch) |
| Identify incompatible / missing fields | `fieldGaps` + agent annotations, Gaps card | gaps test: country, fax, notes, bal/signup_dt/vip_flag/status listed |
| Suggest supported transformations | ops ⊂ catalog via strict enum + guard | `signup_dt` uses `parse_date` ≥3 formats; unknown op ⇒ is_error |
| Explain mapping risks | `risks[]`, per-mapping rationale/confidence + measured pass rate | risks mention ambiguous dates; UI shows pass rate |
| Generate clarification questions | deterministic triggers + agent phrasing + patch options | clarifications include country; patch ⇒ approvable |
| Prepare a proposed migration plan | strict `submit_migration_plan`, versioned | accepted plan passes static validation |
| Only provided inspection/validation tools | allowlist, no write tools | unknown tool test; adapter contract tools list |
| Approve before execution | `assertExecutable` (hash recomputed) | 409 tests: unapproved, rejected, edited |
| Version plans | immutable versions + diff + triggers | UPDATE abort test; edit ⇒ v+1 |
| Deterministic dry run | pure engine, TZ-safe ops, canonical hash | fast-check determinism/shuffle; multi-TZ date tests |
| Quarantine + field-level evidence | `run_records` long-format, raw kept | per-code tests; e2e quarantine table |
| Source/transformed/accepted/rejected counts | partition identities | fast-check identities; UI tiles |
| Execute approved migration | gated synchronous execute | integration + e2e |
| No duplicates on retry | UNIQUE + ledger + run lock | properties (execute×N, failAfter+retry), e2e spec 2 |
| Compare source and target totals | reconcile verdicts + equations + sums | verdict tests across lifecycle |
| Rollback | ledger-scoped delete | ROLLED_BACK_CLEAN test; pre-existing kept |
| History of execution/approval/retry/rollback | append-only events + immutable tables | trigger tests; History panel |
| One source/target, max sample size | single dataset; MAX_SAMPLE_SIZE=500 | loader test; README |
| UI states | `<AsyncPanel>` everywhere | e2e state assertions |
| Structured app + AI logs | pino + ring buffer + agent_steps | log-shape test; Logs/trace panels |
| Hosted, AI operational | Docker + Railway volume + health LLM status + caps | hosted smoke; health shows llm configured |
| README / AGENT_USAGE / .env.example | skeletons day 0, finalized T4.4 | checklist in T4.3 review |

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| API key / hosting login arrive late | everything offline-testable (scripted LLM, stub-fetch contract tests, heuristic path); first deploy at first checkpoint after login; deploy steps scripted and rehearsed in local Docker |
| Strict schema 400s / latency over budget | single strict tool + linter test; live spike first thing when key lands; effort/iteration tuning; heuristic CTA |
| AI unavailable during review (caps, credit, restarts) | sized caps, spend limit, health LLM status, interrupted-run recovery, heuristic fallback |
| Native type-stripping vs Vitest divergence | `verbatimModuleSyntax` + boot test spawning real server |
| Timezone / float nondeterminism | hand-written date parser, integer cents, multi-TZ tests, TZ=UTC |
| Prompt injection via data | read-only tools, JSON tool results, PII masking, guard, plain-text rendering, human approval, red-team fixture |
| Time overrun | slice time boxes + cut triggers + ordered stretch list; docs updated every checkpoint |

## Verification (end-to-end)
1. `npm run typecheck && npm test` (unit + property + integration + agent + boot; offline) and `npm run test:e2e` (Playwright, heuristic path).
2. `npm run smoke:agent` with real key: plan validates, trace + tokens + cache hits recorded, p50 latency within budget.
3. Browser walk-through (claude-in-chrome): agent → apply country patch → edit a mapping → dry run this version → approve → dry run again (hash identical) → execute with simulated failure (INCOMPLETE) → retry (no duplicates, MATCHED) → rollback (ROLLED_BACK_CLEAN, 5 pre-existing rows) → History + Logs show every step; zero console errors.
4. `docker build && docker run -v` → same smoke; restart container ⇒ data persists.
5. Hosted URL: health shows LLM configured; same smoke incl. live agent; fresh workspace for graders; submission remarks drafted.
