# Migration Workbench

An agentic **data-migration planner and reconciliation workbench** for one bounded dataset. It migrates a legacy CRM extract
(`legacy_customers`, 200 untyped rows) into a strongly typed `accounts` table.

- A **tool-restricted Claude agent** profiles the data and proposes field mappings, transformations, risks and clarification
  questions. It can only call read-only inspection and validation tools.
- A **human reviews, edits and approves** an immutable, hash-bound plan version.
- The app then **dry-runs it deterministically**, **quarantines** invalid records with field-level evidence, **executes**
  idempotently into a mock target (a retry never duplicates rows), **reconciles** source against target, and can **roll back**.
- Every approval, execution, retry and rollback goes into an **append-only history**.

> **Hosted demo:** _URL and Basic-auth credentials are in the submission remarks._ · Stack: Node 26 · Hono · SQLite ·
> React 19 · Claude Sonnet 5.5

---

## Reviewer walkthrough (about 3 minutes)

This works with or without an LLM key. Put your name in **Reviewer** (top right) first. The numbers below are for the
**heuristic draft**, which is deterministic. An agent-drafted plan is reviewed the same way, but may raise different
questions and versions.

| Step | Do | You should see |
|---|---|---|
| 1. Inputs | Skim | Source and target schemas, 7 gaps (e.g. `country` has no source), field profiles, the 14 supported transforms |
| 2. Proposal | **Run AI agent** (or **Generate heuristic draft**) | A live trace of tool calls and model turns; then a new plan version |
| 3. Review & approve | Answer the 4 clarifications: *Treat empty as 0*, *Default to 'US'*, *Quarantine the 5 rows*, *Keep US month/day* | Each answer saves a **new immutable version** (v2…v5) with a diff; the blockers go to 0 |
| 4. Dry run | **Run dry run** twice | Source **200** · Transformed **180** · Accepted **164** · Rejected **36**. The result hash is **identical** on the second run. The quarantine shows field-level evidence. 3 keys will conflict at load |
| 3. Review & approve | **Approve…** | The decision is bound to the plan hash |
| 5. Execute | Tick **Simulate a failure after 75**, execute, then **Retry** | The first run fails (50 rows committed, the second batch rolled back); the retry skips them and inserts the rest |
| 6. Reconcile & rollback | Read the verdict, then **Roll back…** | **MATCHED**: 161 loaded + 3 conflicts + 36 rejected = 200, money check equal to the cent. After rollback: **ROLLED_BACK_CLEAN**, and the 5 pre-existing target rows are intact |
| History / Logs | Browse | Every approval, run, retry, rollback and agent step; structured logs filterable by request id |

To start over cleanly, use **Start a new workspace…** (step 6). It records a rollback and creates a fresh workspace;
history is never deleted.

---

## Run it locally

```bash
nvm use                 # Node 26 (native TypeScript type stripping: no server build step)
npm install
cp .env.example .env    # add ANTHROPIC_API_KEY to enable the live agent (optional)
npm run dev             # API :8787 + Vite UI :5173  (or: npm run build && npm start → http://localhost:8787)
```

| Command | What it does |
|---|---|
| `npm test` | 1345 offline tests: unit, property (fast-check), integration, agent, boot and adversarial verifiers (about 6 s) |
| `npm run test:e2e` | Playwright journey through the real UI and server; fresh DB, no LLM (uses the system Chrome channel) |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7) |
| `npm run bench` | Report-only latency at the 500-record maximum |
| `npm run smoke:agent` | **Live** agent run + mini eval against the gold mapping (needs a key; spends tokens) |
| `npm run gen:dataset` | Regenerates the committed fixtures deterministically (seeded PRNG) |
| `npm run db:reset` | Deletes the local SQLite file |

Docker: `docker build -t migration-workbench . && docker run -p 8787:8787 -v mw-data:/data --env-file .env migration-workbench`
(the image stores SQLite at `/data/workbench.db`; keep `DB_PATH` unset in `.env`, as in `.env.example`).

---

## Architecture

```
 Browser (React 19 + TanStack Query, 8 lazy-loaded steps)
    │  JSON over HTTP; every error is {error:{code,message,details,requestId}}
    ▼
 Hono app (Node 26, runs .ts directly)
    ├─ middleware: request id → access log → Basic auth (not /api/health) → 1 MB body limit → error envelope
    ├─ routes/workbench.ts   inputs · plans/versions/clarifications/approvals · runs · reconcile · history
    ├─ routes/agent.ts       POST 202 + polling; per-IP and global daily caps
    ├─ services/             plans (hash-bound versions, approval gate) · runs (dry run / execute / retry / rollback)
    │                        reconcile · workspaces · agentRuns · events (append-only)
    ├─ engine/ (pure)        transforms (14-op DSL) · validate · staticValidate · dryRun · profile · candidates
    │                        gaps · triggers (clarifications + deterministic patches) · heuristic · mask (PII)
    └─ agent/                manual tool loop over @anthropic-ai/sdk (beta) · 8 read-only tools + strict submit tool
                             · guard · strict-schema linter · scripted client for tests
    ▼
 SQLite (better-sqlite3, one file, WAL): src_legacy_customers · tgt_accounts (mock target, CHECKs generated from
 target-schema.json) · migrations (workspaces) · plan_versions · approvals · runs · run_records (evidence) ·
 load_ledger · agent_runs · agent_steps · events
```

**Key design decisions** (full rationale in [`tasks/plan.md`](tasks/plan.md); research in [`docs/research.md`](docs/research.md)):

- **The LLM is advisory; deterministic code decides.** The agent's tools are read-only. Its submission goes through a strict
  JSON-schema tool (field names and ops are enums). The server re-validates it, and only a human approval unlocks
  execution. The error budget is server-owned, so the agent cannot loosen its own gate.
- **A closed transformation DSL.** 14 ops with an explicit signature table (input/output type, null behaviour, arity).
  Static validation checks types end to end (source text → op chain → target type). There are no expressions or code.
- **Deterministic dry run.** It is a pure function of the plan and the source. Dates are parsed by a hand-written token
  parser (never `Date` on strings), money is integer cents, records are sorted by code unit, and hashes use canonical
  JSON. The tests run it under four timezones.
- **Idempotency at the data layer.** `UNIQUE(external_ref)` + `INSERT … ON CONFLICT DO NOTHING RETURNING id`, a load
  ledger (partial unique index on active rows), batch-per-transaction with per-row savepoints, and a run lock
  (partial unique index on `status='running'`).
- **Rollback** deletes, in one transaction, only the target rows the ledger says this workspace inserted. Pre-existing rows
  are checked against their seed hash.
- **Reconcile from current state, not from run counters.** It gives one of four verdicts: MATCHED / INCOMPLETE /
  ROLLED_BACK_CLEAN / MISMATCHED.
- **Immutable history.** SQLite triggers block UPDATE and DELETE on `events`, `plan_versions` and `approvals`. Each version
  has exactly one terminal decision, and the approval hash is recomputed from the stored plan at execute time.

### Bounded dataset (the provided inputs)

The inputs live in `server/src/dataset/` and are generated deterministically by `scripts/gen-dataset.ts`.

- `source-schema.json`: 10 untyped legacy fields, 5 of them flagged as PII.
- `target-schema.json`: 10 typed fields with constraints.
- `source-records.json`: 200 rows.
- `target-seed.json`: 5 pre-existing target rows. 3 of them collide with source keys.
- `gold-plan.json`: a hand-written reference plan.
- `defect-manifest.json`: which row carries which seeded defect.

The seeded defects are bad dates, day-first dates, invalid emails, empty or one-word names, unknown status codes, malformed
money, bad phones, duplicate keys, an over-long name and a prompt-injection note.

**Limits:** one source, one target, at most `MAX_SAMPLE_SIZE = 500` records (enforced by the loader).

### Supported transformation rules

`copy` · `trim` · `lowercase` · `uppercase` · `null_if_empty` · `default` · `split_full_name` · `concat` · `parse_date`
(yyyy-MM-dd, MM/dd/yyyy, dd/MM/yyyy, dd-MMM-yyyy, yyyyMMdd; AMBIGUOUS_DATE when two formats disagree) ·
`parse_currency_to_cents` · `to_integer` · `to_boolean` · `map_values` · `normalize_phone` (North American → E.164)

### The agent

- **Model and request settings:** `claude-sonnet-5-5` by default (`ANTHROPIC_MODEL`; `claude-opus-5-5` also works), effort
  `medium`, adaptive thinking with summarized display, `tool_choice: auto`, prompt caching on the frozen system prompt and
  tools, and server-side refusal fallback (`fallbacks: "default"`).
- **Limits:** at most 8 turns, a 180-second wall clock enforced with an `AbortSignal`, and per-request timeouts.
- **Tools:**
  - `get_source_schema`, `get_target_schema`, `profile_source_fields`, `sample_source_records` (at most 10 rows, PII
    masked), `list_supported_transforms`, `get_field_gaps`, `suggest_candidates`, `preview_mapping`.
  - The terminal `submit_migration_plan`, the only `strict: true` tool.
- **Prompt-injection defence:** data reaches the model only as JSON tool results and is masked; the system prompt declares
  all tool content untrusted; the server guard rejects any reference that is not in the schema or the op catalog; the
  error budget is not settable by the agent; a human approves every plan.
  - The fixture contains an injection note (`r0167`). Tests prove that no tool output (samples, profiles or preview
    messages) exposes it: `test/agent/loop.test.ts` and `test/verify/review-{agent,docs}.test.ts`.
- **Failure handling:** every failure (timeout, rate limit, refusal, invalid plan, cap reached, no key) shows an
  explained state with a **Generate heuristic draft** fallback.

### HTTP hardening (public demo)

- **Basic auth** on every route except `GET /api/health`. It fails closed: setting only one of
  `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` is a startup error, and the server logs a warning when auth is off.
- **CSRF guard:** state-changing requests are refused (403 `CSRF_REJECTED`) when the browser marks them cross-site
  (`Sec-Fetch-Site`) or their `Origin` does not match the host. Browsers re-send cached Basic credentials, so this matters.
- **Security headers:** strict CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`,
  and `Referrer-Policy: no-referrer`.
- **Agent cost caps:** per client IP and global, per UTC day. The client IP is the socket address, or the proxy-appended
  `X-Forwarded-For` hop only when `TRUST_PROXY=true`, so a spoofed header cannot bypass the cap.
- **Redaction:** secrets are removed from logs, and error responses never include stack traces.

---

## Requirement traceability

| Requirement | Where | Proved by |
|---|---|---|
| Propose mappings, incompatible/missing fields, supported transforms, risks, clarifications, a plan | `agent/`, `engine/gaps.ts`, `engine/triggers.ts` | `test/agent/loop.test.ts`, `test/integration/gates.test.ts` (HTTP 202 → agent-authored version with persisted trace), `test/unit/{gaps,triggers,heuristic}.test.ts`, `npm run smoke:agent` |
| Agent uses only the provided inspection/validation tools | `agent/tools.ts` (allowlist, no write tools) | loop test "answers unknown tools with an error result"; adapter contract test (9 tools) |
| Human approval before execution | `services/plans.ts` `assertExecutable` (hash recomputed) | `test/integration/flow.test.ts` (NOT_APPROVED, ALREADY_DECIDED, PLAN_NOT_APPROVABLE), `test/integration/gates.test.ts` (PLAN_REJECTED, HASH_MISMATCH on tampering, STALE_VERSION, forged answers ignored); e2e |
| Version migration plans | immutable `plan_versions` + diff + triggers | db trigger tests; flow test (edit ⇒ v+1) |
| Deterministic dry run | `engine/dryRun.ts` | `test/property/lifecycle.property.test.ts` (any record order, 4 timezones); e2e (identical hash) |
| Quarantine invalid records + field-level evidence | `run_records.errors` (stage, field, raw values, step, op, code, message) | `test/unit/{transforms,validate}.test.ts`; e2e quarantine table |
| Source / transformed / accepted / rejected counts | `countResults` partition identities | property test (identities on arbitrary subsets); e2e tiles |
| Execute an approved migration into the mock target | `services/runs.ts` `execute` | flow test; gates test (ERROR_BUDGET_EXCEEDED, RUN_IN_PROGRESS, BAD_FAIL_AFTER, FAULT_INJECTION_DISABLED); e2e |
| No duplicate insertion on retry | UNIQUE key + ledger + run lock | property tests "failure at any point + retry ⇒ clean state", "execute N times"; e2e (166 unique refs) |
| Compare source and target totals | `services/reconcile.ts` (4 balance equations, money sum, per-key status) | flow + property tests (MATCHED / INCOMPLETE / ROLLED_BACK_CLEAN) |
| Rollback of the mock migration | ledger-scoped compensating delete | property test (exact pre-state restored); e2e (5 rows remain) |
| Execution, approval, retry, rollback history | append-only `events` | trigger tests; flow test (event types); e2e History |
| One source, one target, documented max sample size | `MAX_SAMPLE_SIZE = 500` | `test/unit/datasetLoad.test.ts` |
| Loading / empty / validation / success / failure states | `web/src/components/ui.tsx` `AsyncPanel`, banners, dialogs | e2e (empty states, blocked approval, 409 gate, success banners) |
| Structured app + AI-workflow logs | pino JSON + in-memory buffer (`/api/logs`), `agent_steps` trace | `test/integration/app.test.ts` (access logs, redaction), `gates.test.ts` (agent steps + `gen_ai.tool.name` log lines); Logs and Proposal trace views |

## Tests

| Suite | Files | Tests | What it covers |
|---|---|---|---|
| unit | 10 | 537 | every DSL op (null / `''` / arrays / timezones), validation codes, static plan rules, profiling, candidates, gaps, triggers, heuristic, masking, dataset loader |
| property (fast-check) | 2 | 15 | transform totality and round-trips; dry-run determinism under shuffles; partition identities; execute N times; crash at any point then retry; rollback inverse |
| integration | 4 | 79 | DB constraints and triggers, HTTP envelope/auth/logging/CSRF/headers, full lifecycle through the API, every documented 409/422/429 gate, the agent HTTP flow, and the gold-plan numbers |
| agent | 2 | 23 | scripted-LLM loop (parallel tools, rejected→corrected submit, nudge, caps, max_tokens, refusal, fallback blocks, timeout, injection); real SDK adapter against a stubbed `fetch` (wire body, beta header, error classes) |
| boot | 1 | 1 | spawns the real `node server/src/index.ts` (native type stripping), health, auth, graceful SIGTERM |
| verify | 8 | 690 | adversarial suites written by independent verifier and reviewer agents; each failing test was a confirmed defect, now fixed (see AGENT_USAGE.md) |
| e2e (Playwright) | 1 | 1 journey | the reviewer walkthrough above, in a real browser under the production CSP, with zero console errors |

**Performance** (`npm run bench`, 500 records, p95 over 15 warm runs on an Apple-silicon laptop; numbers depend on the
machine): dry run 4.6 ms · dry run + persisting evidence 6.2 ms · execute + rollback 13.7 ms · reconcile 4.1 ms ·
RSS after the bench about 150 MB · initial JS 84 KB gzipped.

## Scope

**Completed:** every assignment requirement is implemented and tested locally, plus the items below. The hosted
deployment and a live-model smoke run are listed in the submission remarks once done.

Extras:
- workspaces (a clean restart without deleting history);
- a deterministic heuristic planner, used as the no-key fallback and as a baseline;
- clarification answers applied as deterministic plan patches, with no LLM call;
- an error-budget gate on execution;
- a conflict preflight in the dry run;
- PII masking toward the LLM;
- a log viewer.

**Intentionally excluded:**
- **Not required by the assignment:** production DB access, arbitrary transformation code, distributed or streaming
  migration, live cloud connectors.
- **Multi-user features:** user accounts and roles. "Reviewer" is a self-declared name; the hosted demo is protected by
  one shared Basic-auth login.
- **Agent extras:** an agent re-run that takes free-text answers into account (the endpoint accepts `reviewerNotes`, but
  the UI's main path uses deterministic patches); per-request cost in USD; an LLM-judge eval suite (`smoke:agent`
  reports precision, recall and F1 against the gold plan).

## Limitations

- **Single process.** SQLite with synchronous better-sqlite3 runs one node. The run lock is a database constraint, but
  horizontal scaling would need Postgres and advisory locks.
- **Shared demo state.** All reviewers share the current workspace. "Start a new workspace" gives a clean slate.
- **Phones:** `normalize_phone` only supports North American numbers.
- **Date formats:** `parse_date` supports the 5 listed formats.
- **Duplicate source keys** are quarantined as a group (both rows); there is no merge or survivorship logic.
- **Agent latency** depends on the provider. The budget is at most 180 s and 8 turns; a live measurement is pending the
  live smoke run. The UI polls and stays responsive, and the heuristic draft is always one click away.

## Deployment

- **Image:** a single Docker image (`node:26-slim`, multi-stage, prebuilt better-sqlite3 binary, `HEALTHCHECK` on
  `/api/health`). It serves the API and the built UI.
- **Recommended host:** **Railway Hobby** with a volume mounted at `/data`.

**Environment** (names only; see `.env.example`):
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`, `TRUST_PROXY=true` (behind Railway's proxy)
- `AGENT_RUNS_PER_IP_PER_DAY`, `AGENT_RUNS_GLOBAL_PER_DAY`
- `DB_PATH=/data/workbench.db`, `PORT`

**Railway setup** (`railway.json` holds the build and health-check config; `railway up` uploads the local directory,
honouring `.gitignore`, so `.env` is never uploaded):

```bash
railway login && railway init                 # or: railway link (an existing project)
railway up --detach                           # first deploy creates the service (Docker build runs on Railway)
railway volume add --mount-path /data         # persistent SQLite
railway variable set DB_PATH=/data/workbench.db TRUST_PROXY=true BASIC_AUTH_USER=reviewer AGENT_RUNS_GLOBAL_PER_DAY=60
printf %s "$KEY"  | railway variable set ANTHROPIC_API_KEY --stdin   # secrets via stdin, not argv
printf %s "$PASS" | railway variable set BASIC_AUTH_PASS --stdin
railway domain                                # public URL
```

Keep "serverless/sleep" off.

**Behaviour once running:**
- `/api/health` needs no auth and reports DB status, LLM configuration and the last agent run status.
- Restarts mark any in-flight runs `interrupted`, so they can be retried.
