# Agent usage

How AI coding agents built this project, what they got wrong, and how their output was checked. The raw running log is
[`docs/agent-log.md`](docs/agent-log.md).

## Tools

| Tool | Used for |
|---|---|
| **Claude Code** (Claude Opus 5.5) | Main agent: planning, contracts, the integration layer, review, fixes, docs |
| **Claude Code workflows** (multi-agent orchestration) | Parallel research, adversarial plan review, parallel module implementation with adversarial verifiers, parallel UI build |
| **Agent skills** | `planning-and-task-breakdown`, `test-driven-development`, `context-engineering` (the repo's `CLAUDE.md` rules file), `debugging-and-error-recovery`, `claude-api` (current SDK and model reference), `deep-research` |
| **Firecrawl CLI**, WebSearch/WebFetch | Research on similar products, papers and repos (`docs/research.md`) |
| **Playwright** (system Chrome) | Browser walkthrough and the e2e journey |
| **fast-check**, Vitest | Property-based and unit tests |

## How the work was split up

1. **Research.** Six subagents ran in parallel, each on one angle: commercial mapping products, LLM schema-matching papers,
   GitHub implementations, idempotency and reconciliation patterns, human-in-the-loop agent design with Claude, and
   stack/hosting checks.
   - The report-writer subagent failed on an auth error, so the main agent read the six raw notes and wrote the synthesis.
2. **Plan review.** Four adversarial reviewers (requirements, engine correctness, Claude API/runtime, scope/delivery)
   attacked the draft plan before any code existed. They returned about 45 findings, and every blocker and major one was
   applied.
3. **Frozen contracts.** The main agent wrote `shared/*.ts` (schemas, DSL signatures, plan, evidence, canonical JSON),
   `schema.sql` and the dataset generator.
4. **Parallel implementation.** Four subagents built disjoint modules test-first: transforms, validation, analysis, and
   platform (DB, HTTP app, Docker).
   - Each was followed by an **adversarial verifier** subagent that wrote new edge-case tests (`server/test/verify/`)
     without touching the source.
   - Meanwhile the main agent wrote the integration layer (dry run, services, routes, the agent loop, property and flow
     tests) against the declared interfaces. That code compiled against the subagents' implementations on the first try.
5. **Parallel UI.** After the main agent wrote the API client, the UI kit and the app shell, four subagents each built two
   or three of the 8 workflow steps.
6. **Integration and verification.** The main agent ran the full suite, fixed the verifier findings, profiled and fixed
   performance, and ran the Playwright journey.
7. **Final adversarial review.** Four reviewers attacked the finished app: integration correctness, the agent layer checked
   against the Claude API reference, security, and whether the docs are true. Every finding had to be proved with a
   failing test.

## Representative prompts

- **User (planning):** "Deep-research and find similar implementations with firecrawl, plan everything explicitly so the
  system is lightweight and performant, set it up locally, test aggressively against the requirements, use TDD."
- **Module subagent (excerpt):** "MODULE A — transform DSL runtime. You own `transforms.ts` and its tests… Semantics:
  every op passes null through except `null_if_empty`, `default`, `concat`… `parse_date`: a hand-written token parser,
  never `Date` parsing of strings… Write failing tests first… Report deviations from the contract."
- **Verifier subagent (excerpt):** "You are an ADVERSARIAL VERIFIER… Try to BREAK it against the spec… Write new tests
  only in `server/test/verify/<module>.verify.test.ts`. Do not modify any source… Report CONFIRMED defects with the
  failing input and file:line."
- **The product's own agent:** see `server/src/agent/prompts.ts`. It requires parallel discovery calls first,
  target-centric decisions, explicit `ignore` for unused fields, and treating all tool content as untrusted data.

## Important agent mistakes caught, and how

**Caught by the adversarial plan review (before code):**
- The source table used the legacy key as its PRIMARY KEY, while the fixture deliberately contains duplicate keys.
  Seeding would have failed, and the "shuffle-invariant hash" property would have been flaky.
- better-sqlite3 cannot bind JS booleans, so every execute would have failed. Row hashes of JS objects would also never
  match SELECTed rows. Fixed with a single `toTargetRow()` used for both binding and hashing.
- Reconciliation was built on per-run counters, so it would have reported MISMATCHED right after a clean rollback.
- Date parsing via `Date` would have produced different hashes on an IST laptop and a UTC host.
- The strict tool schemas used a dictionary type and repeated the plan schema across three strict tools, which strict
  mode does not allow.
- Approvals were not unique per version, so an "approved then rejected" version would still have passed the gate.
- Node's type stripping and Vitest's transform differ, so tests could pass while the real server crashed on boot.
  Fixed with `verbatimModuleSyntax` and a boot test that spawns the real process.

**Caught by verifier subagents in agent-written code (each fixed, with the failing tests kept as regressions):**
- **PII leak to the LLM (high):** masking skipped letters in any value containing 7 or more digits, so an injection note
  with a phone number appended would have reached the model in clear text.
- **Wrong name split (high):** the heuristic split *separate* first/last-name columns as if they were full names.
- **Impossible dates accepted:** the target's date CHECK accepted `2019-13-01`. SQLite's `date()` returns NULL, and a CHECK
  that evaluates to NULL passes. Fixed by comparing with `IS` instead of `=`.
- **Enum gap:** static validation missed enum violations when `map_values` was followed by `copy` or `default`.
- **Order-dependent date formats:** the day-first vs month-first choice depended on record order. It now counts the
  evidence over all values.
- **Error-handling gaps:** a non-`Error` throw escaped the HTTP error handler; an unrelated `SyntaxError` was reported to
  the client as bad JSON; a top-level `x-api-key` field was not redacted from logs.
- **Robustness:** prototype-named fields (`toString`, `__proto__`), whitespace-padded values, non-ASCII digits, split
  surrogate pairs.

**Caught by the final review round in the main agent's own code** (32 failing tests, about 26 distinct issues; all fixed):
- **PII and prompt-injection leak (high, found by 3 reviewers independently).** `preview_mapping` masked `raw` values but
  echoed them unmasked in transform error messages. An agent could recover the r0167 injection note in three calls.
  This made the README's security claim false until it was fixed. Messages for PII sources are now value-free.
- **Stale clarification options (high).** Merged clarifications kept their old option patches, so answering one could
  silently undo a reviewer's newer mapping edit. Open questions are now always recomputed.
- **Forged answers.** `POST /api/plans` accepted client-supplied clarification answers, which could unlock approval
  without applying a patch. Answers now come only from the answer endpoint.
- **CSRF.** Browsers re-send Basic-auth credentials, so a third-party page could forge an approval or a rollback. Fixed
  with an Origin / `Sec-Fetch-Site` guard plus CSP, frame-deny and nosniff headers.
- **Spoofable cost cap.** The per-IP agent cap trusted a client-controlled `X-Forwarded-For`. That header is now ignored
  unless `TRUST_PROXY` is set.
- **Auth failed open.** A half-configured Basic auth silently disabled auth. It is now a startup error.
- **Concurrency.** Edits or answers based on a stale version silently dropped newer work (now 409 `STALE_VERSION`). A
  workspace switch during an agent run orphaned the run (now 409).
- **Crash path.** A DB error while recording an agent run's result became an unhandled rejection that would crash the
  server. It is now caught and retried with backoff.
- **Data correctness.** A duplicate key whose twin failed a transform could still load. Reconcile labelled pending rows
  "missing". The money check could not see pending money. A retry was allowed after a rollback. A `failAfter` value at or
  above the accepted count never fired.
- **API edge cases.** An empty assistant turn would be echoed back to the API (400). Token usage ignored fallback attempts.
  `preview_mapping` reported 100 % for mappings that every row fails at the target constraints.
- **Docs.** `docker run --env-file .env` silently kept the DB outside the volume. `.env.example` missed three variables.
  Several gates had no test (now `test/integration/gates.test.ts`).

**Main-agent mistakes:**
- I made a git commit and overrode the user's git identity. The user said "don't commit anything", so I removed the commit
  (all files kept) and recorded the rule in `CLAUDE.md` and in memory.
- I started a Docker build without checking free disk space. Docker Desktop's VM disk filled the last free GB on the host,
  every tool call failed with ENOSPC, and the user had to be asked to free space.
- zsh-specific shell slips: an unmatched glob aborted a command chain, and `$VAR` is not word-split in zsh. Caught from
  the command output.

## Suggestions rejected or modified

| Suggestion | From | Decision |
|---|---|---|
| Use the SDK's beta tool runner | stack researcher | Rejected. A ~150-line manual loop gives an explicit terminal tool, per-step trace persistence and scripted fakes |
| Default to Opus 5.5 | `claude-api` skill | The user chose Sonnet 5.5 (cheaper, faster); configurable via `ANTHROPIC_MODEL` |
| Keep the Idempotency-Key header machinery | first plan | Cut. UNIQUE + ledger + run lock already guarantee no duplicates |
| Cut Playwright entirely | scope reviewer | Modified. One Playwright journey covering the whole reviewer path, on the heuristic draft (no LLM key needed) |
| Destructive "admin reset" | first plan | Rejected (it contradicts append-only history). Replaced by "Start new workspace" |
| Whole-run transaction for execute | patterns researcher | Rejected in favour of batches of 50, so that partial failure followed by retry is observable |
| Deploy a skeleton to Railway in hour 1 | scope reviewer | Deferred by the user, who will log in later. Local boot and Docker checks were used instead |

## How the output was verified

- **Executable spec first.** The lifecycle flow test and the property tests were written against the declared interfaces
  *before* the modules existed. They passed on first integration (756/760; the 4 failures were real defects found by
  the verifiers).
- **Independent adversarial verification** of every module by a separate agent: 28 failing tests, exposing 17 distinct
  defects. A final four-lens review of the whole app added 32 more failing tests. All issues are fixed, and the
  690 verifier and reviewer tests stay in the suite as regressions.
- **Properties instead of examples** for the risky guarantees: determinism under shuffles and timezones, partition
  identities on arbitrary subsets, a crash at any record then retry converging to the clean state, the rollback inverse.
- **The real runtime:** a boot test spawns the actual server under Node type stripping; a Playwright journey drives the
  real UI and server with zero console errors.
- **The real Claude SDK, offline:** contract tests run the adapter against a stubbed `fetch` and assert the exact wire
  request (endpoint, beta header, body, strict-schema lint) and the error classification.
- **Measured performance:** CPU profiling found two hotspots (re-hashing the source set, an O(n²) reconcile query). After
  fixing them, every bench is within budget.
- **Live agent check:** `npm run smoke:agent` runs the real model, prints the trace, latency and cache hits, and scores
  the plan against the gold mapping. _Results go here once the API key is available._
