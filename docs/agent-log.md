# Agent log

A running log of how AI coding agents were used, kept while the work happened. AGENT_USAGE.md is compiled from it.
Entries record what was delegated, what the agents got wrong, which suggestions were rejected and why, and how each was verified.

## 2026-10-03 — Research and planning (Claude Code, Opus 5.5, plan mode, "ultracode" multi-agent workflows)

**Prompt (user, paraphrased):** "Pick Problem 2. Deep-research similar implementations with firecrawl, then plan everything explicitly
so the system is lightweight and performant. Set it up locally, test aggressively against the requirements, use TDD."

**Delegated work:**
- A research workflow ran 6 parallel subagents, each on one angle: products, academic schema matching, GitHub repos, engineering
  patterns, Claude HITL agent design, stack/hosting verification. They used firecrawl search/scrape, WebSearch/WebFetch, and
  `npm view`. Their notes are in `docs/research.md`.
- The report-writer subagent failed on an auth error ("organization has disabled Claude subscription access"). The main agent
  read the six raw notes and wrote the synthesis itself.
- A plan-review workflow ran 4 adversarial subagents, each with a different lens (requirements traceability, engine correctness,
  Claude API/runtime feasibility, scope/delivery risk). It returned about 45 findings. All blocker and major findings were applied.

**Mistakes in the agent's first plan, caught by the adversarial review before any code was written:**
1. The data model declared `source_key` the PRIMARY KEY of the source table while the fixture deliberately contained duplicate
   `cust_id`s. Seeding would have failed, and the "shuffle-invariant hash" property would have flaked.
   Fix: a surrogate `source_key` (`r0001`...), and duplicates detected on the transformed `external_ref` across the whole dataset.
2. better-sqlite3 cannot bind JS booleans, so `is_vip: true` would have failed every execute batch, and row hashes of JS objects
   would never have matched SELECTed rows. Fix: one `toTargetRow()` used for both binding and hashing.
3. Reconciliation equations were built on per-run counters, so the verdict would have been MISMATCHED right after a clean rollback.
   Fix: reconcile from current state, with explicit MATCHED / INCOMPLETE / ROLLED_BACK_CLEAN / MISMATCHED verdicts.
4. The date and currency parsing plan had timezone and float risks: an IST dev machine and a UTC host would produce different
   hashes, and a float could lose a cent. Fix: a hand-written token date parser, integer-cent currency parsing, TZ matrix tests.
5. Strict tool schemas were planned with a dictionary (`map_values.mapping`) and the full plan schema repeated in 3 strict tools.
   Both exceed strict-mode rules. Fix: one strict tool, `pairs:[{from,to}]`, and a strict-schema linter test.
6. Approvals were not unique per version, so an approve followed by a reject would still have passed an EXISTS gate.
   Fix: `UNIQUE(plan_version_id)`, immutability triggers, and recomputing the hash at execute.
7. Node's native type stripping and Vitest's transform differ on type-only imports, so tests could pass while the server crashed
   on boot. Fix: `verbatimModuleSyntax`, plus a boot test that spawns the real server.
8. The admin "reset" contradicted the append-only history triggers. Fix: "Start new workspace" (a recorded rollback plus a new
   workspace row). Nothing is ever deleted.
9. Clarification answers had no defined effect on the plan. Fix: options carry deterministic patches, applied without an LLM call.

**Suggestions rejected or modified (with reasons):**
- "Use the SDK beta tool runner." Rejected in favour of a small manual loop. It gives explicit terminal-tool semantics, per-step
  persistence, and a port for scripted fakes.
- "Default to Claude Opus 5.5." The skill guidance says Opus. The user explicitly chose `claude-sonnet-5-5` (cheaper and faster).
  It is configurable through `ANTHROPIC_MODEL`.
- "Cut Playwright entirely." Modified: one Playwright journey that covers the whole reviewer path on the heuristic draft, which needs no LLM.
- "Keep Idempotency-Key request machinery." Rejected: data-layer idempotency (UNIQUE + ledger + run lock) already satisfies the
  requirement with far less code.
- "Deploy a walking skeleton to Railway in hour 1." Deferred by the user, who will log in to Railway later. Local Docker
  smoke tests run at each checkpoint instead.

**Verification approach decided:** a requirement-to-test traceability table (README); fast-check properties for determinism,
idempotency and rollback; stub-fetch contract tests for the Claude adapter; a boot test against the real Node runtime; local
Docker smoke tests; a browser walkthrough; a hosted smoke run including a live agent call.

## 2026-10-03 — Implementation via parallel agent workflows

**Delegated work:** after the main agent froze the contracts (`shared/*.ts`, `schema.sql`, the dataset generator), a workflow
ran 4 implementation subagents in parallel, each owning disjoint files and working TDD-style: transforms, validation, analysis
(profiling/candidates/gaps/triggers/heuristic) and platform (DB/app/boot/Docker). An **adversarial verifier subagent** then
attacked each module by writing new edge-case tests in `server/test/verify/` without touching the source. The main agent
meanwhile wrote the integration layer (dry run, services, routes, agent loop) against the declared interfaces.

**Defects the verifiers caught in agent-written code (fixed by the main agent, with the failing tests kept as regressions):**
- `validatePlanStatic` checked enum and pattern constants only when `map_values` was the *last* step, so `map_values('actve') → copy`
  passed static validation. It now follows constants forward through value-preserving ops.
- `validateRow` read `row[field]` and `rawValues[src]` without `Object.hasOwn`, so fields named like `Object.prototype` members
  (`toString`) resolved to functions.

**First full run:** 756/760 tests passed before those fixes, including the integration flow and property tests the main agent
had written in advance against the interfaces. That confirmed the frozen-contract approach.
- The analysis verifier confirmed 15 defects. Two were high severity:
  - `maskValue` left the letters unmasked in any PII value containing 7 or more digits, so an injection note with a phone
    number appended would have reached the LLM in clear text. Letters are now always masked, digits are counted with
    `\p{Nd}`, and slicing is by code point.
  - The heuristic split *separate* first/last-name columns with `split_full_name`. It now copies them as-is.

  Medium severity:
  - The choice between day-first and month-first date formats depended on record order, because only one sample per
    signature was checked. Slash-date evidence is now counted over all values.
  - Values padded with whitespace were not recognised as dates or money.

  Low severity: a substring match picked up `hotel_code` as the phone field, a negated character class in a pattern
  triggered an `uppercase` step, and a clipped clarification could split a surrogate pair.
- Docker: `npm ci` in `node:26-slim` failed. npm runs `node-gyp rebuild` implicitly whenever a package has a
  `binding.gyp` file, and the slim image has no Python. better-sqlite3 13 ships prebuilt binaries, so `--ignore-scripts`
  is safe. The research claim ("prebuilds bundled") was true but incomplete; the local build had silently compiled
  from source.
- Performance: profiling showed the dry run re-hashing the unchanged source set on every call (about 80% of its runtime)
  and reconcile running a correlated query per key (O(n²)). After the fixes, p95 at 500 rows is: dry run 8.9 ms,
  execute + rollback 27 ms, reconcile 8.9 ms.
