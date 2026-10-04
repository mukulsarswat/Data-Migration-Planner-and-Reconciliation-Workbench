// Adversarial review of the integration layer (services/{plans,runs,reconcile,workspace}, engine/dryRun, routes/workbench).
// Every test here asserts the CORRECT behaviour and currently FAILS: each one reproduces a confirmed defect.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { workbenchRoutes } from '../../src/routes/workbench.ts';
import { agentRoutes } from '../../src/routes/agent.ts';
import { assistant, toolUse } from '../../src/agent/scriptedClient.ts';
import { SUBMIT_TOOL } from '../../src/agent/tools.ts';
import type { LlmClient } from '../../src/agent/llm.ts';
import { dryRun } from '../../src/engine/dryRun.ts';
import { createVersion, decide } from '../../src/services/plans.ts';
import { toSubmission } from '../agent/fixtures.ts';
import { dataset, makeDeps } from '../helpers.ts';

type Json = Record<string, any>;

function harness(client?: LlmClient) {
  const deps = makeDeps();
  const app = createApp(deps, client ? [workbenchRoutes, agentRoutes(() => client)] : [workbenchRoutes]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  return { deps, db: deps.db, call };
}
type H = ReturnType<typeof harness>;

/** Gold plan as v1, approved and dry-run (the README walkthrough numbers: 164 accepted, 161 insertable, 3 conflicts). */
async function goldReady(h: H) {
  const v = createVersion(h.deps, { migrationId: 1, plan: h.deps.dataset.goldPlan, author: 'user', actor: 't', parentVersion: null, changeNote: 'gold' });
  decide(h.deps, 1, v.version, 'approved', 't', '');
  expect((await h.call('POST', '/api/runs/dry-run', { version: v.version })).status).toBe(201);
  return v.version;
}

const mapping = (plan: Json, target: string) => plan.mappings.find((m: Json) => m.target === target);

describe('clarifications and edits', () => {
  it('F1: answering a clarification after a human edit must not silently revert that edit (stale option patches)', async () => {
    const h = harness();
    await h.call('POST', '/api/plans/heuristic', { actor: 'alice' });
    const v1 = (await h.call('GET', '/api/plans/1')).body;
    // The reviewer knows legacy code 'X' means a closed account → inactive. This is exactly what the UI editor sends:
    // the edited mappings plus the base version's clarifications (reviewEditor.buildPlan spreads `base`).
    const plan = structuredClone(v1.plan);
    mapping(plan, 'status').steps[2].params.pairs.push({ from: 'X', to: 'inactive' });
    const edit = await h.call('POST', '/api/plans', { parentVersion: 1, plan, actor: 'bob', changeNote: 'X = closed' });
    expect(edit.status).toBe(201);
    // 'Z', '' and ' ' are still unknown, so the status clarification is still open on v2. Answer it: "map the rest to pending".
    const v2 = (await h.call('GET', `/api/plans/${edit.body.version}`)).body;
    const q = v2.plan.clarifications.find((c: Json) => c.id === 'clr-unmapped_enum_values-status');
    const pendingChoice = q.options.findIndex((o: Json) => o.label.includes("'pending'"));
    const answered = await h.call('POST', `/api/plans/${v2.version}/clarifications/${q.id}`, { choice: pendingChoice, actor: 'carol' });
    expect(answered.status).toBe(201);
    const v3 = (await h.call('GET', `/api/plans/${answered.body.version}`)).body;
    // Bob's X → inactive pair must survive; today the v1 snapshot inside the option patch overwrites the whole mapping.
    expect(mapping(v3.plan, 'status').steps[2].params.pairs).toContainEqual({ from: 'X', to: 'inactive' });
  });

  it('F2: POST /api/plans must not accept client-forged clarification resolutions (gate + audit bypass)', async () => {
    const h = harness();
    await h.call('POST', '/api/plans/heuristic', { actor: 'alice' });
    let version = 1;
    // Answer every clarification except the blocking "empty balance" one, honestly.
    for (let g = 0; g < 10; g++) {
      const v = (await h.call('GET', `/api/plans/${version}`)).body;
      const open = v.plan.clarifications.find((c: Json) => c.resolution === null && c.id !== 'clr-empty_required_values-balance_cents');
      if (!open) break;
      version = (await h.call('POST', `/api/plans/${version}/clarifications/${open.id}`, { choice: 0, actor: 'alice' })).body.version;
    }
    const base = (await h.call('GET', `/api/plans/${version}`)).body.plan;
    // Mallory marks the blocking question as answered "Treat empty as 0" BY ALICE, without applying that option's patch.
    const forged = structuredClone(base);
    const q = forged.clarifications.find((c: Json) => c.id === 'clr-empty_required_values-balance_cents');
    const zeroChoice = q.options.findIndex((o: Json) => o.label === 'Treat empty as 0');
    q.resolution = { choice: zeroChoice, by: 'alice' };
    const edit = await h.call('POST', '/api/plans', { parentVersion: version, plan: forged, actor: 'mallory' });
    const approve = edit.status === 201 ? await h.call('POST', `/api/plans/${edit.body.version}/approve`, { reviewer: 'mallory' }) : null;
    // Today: 201, then 200 approved — the plan claims alice chose "Treat empty as 0" while the 6 empty balances stay quarantined,
    // and no clarification_answered event exists. Either the edit is refused or the forged resolution is not honoured.
    expect(approve?.status ?? 422).not.toBe(200);
  });

  it('F3: answering on a non-latest version must not silently drop answers recorded in newer versions (lost update)', async () => {
    const h = harness();
    await h.call('POST', '/api/plans/heuristic', { actor: 'x' });
    // Alice answers country on v1 → v2. Bob's tab still shows v1 and answers status on v1 → v3 (parent v1).
    const a = await h.call('POST', '/api/plans/1/clarifications/clr-required_target_unmapped-country', { choice: 0, actor: 'alice' });
    expect(a.body.version).toBe(2);
    const b = await h.call('POST', '/api/plans/1/clarifications/clr-unmapped_enum_values-status', { choice: 0, actor: 'bob' });
    const latest = (await h.call('GET', `/api/plans/${b.body.version ?? 2}`)).body;
    // Expected: 409 (stale parent) — or the new latest keeps alice's answer. Today the latest version (v3) has no country mapping.
    const ok = b.status === 409 || mapping(latest.plan, 'country') !== undefined;
    expect(ok).toBe(true);
  });
});

describe('dry run', () => {
  it('F4: a duplicate business key is quarantined as a group even when the sibling fails a transform', () => {
    const ds = dataset();
    // A plausible edit: drop null_if_empty from the phone mapping. r0178 (empty phone) now fails its transform.
    const plan = structuredClone(ds.goldPlan);
    const phone = plan.mappings.find((m) => m.target === 'phone_e164')!;
    phone.steps = phone.steps.filter((s) => s.op !== 'null_if_empty');
    const res = dryRun(ds.records, plan, ds.target, 'h');
    const r0010 = res.results.find((r) => r.sourceKey === 'r0010')!; // Zara Walker, cust_id C-10410
    const r0178 = res.results.find((r) => r.sourceKey === 'r0178')!; // Olivia Patel, cust_id C-10410
    expect(r0178.outcome).toBe('transform_failed');
    // README/dryRun.ts: "Every member of a duplicate group is rejected: identity is ambiguous, so neither row may be loaded".
    expect(r0010.outcome).not.toBe('accepted');
  });
});

describe('execute, retry, reconcile', () => {
  it('F5: reconcile labels accepted-but-unloaded keys of an INCOMPLETE run as pending, not "missing from target"', async () => {
    const h = harness();
    const v = await goldReady(h);
    const failed = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 75 });
    expect(failed.body.counts).toMatchObject({ processed: 50, pending: 114 });
    const rec = (await h.call('GET', '/api/reconciliation')).body;
    expect(rec.verdict).toBe('INCOMPLETE');
    expect(rec.totals.pending).toBe(111);
    // Today statusCounts = { perfect match: 50, 'missing from target': 111, conflict: 3 } (red "missing" in the UI) while the
    // Pending tile says 111; the 'pending' status is only used AFTER a rollback (the condition is inverted).
    expect(rec.statusCounts['missing from target'] ?? 0).toBe(0);
    expect(rec.statusCounts.pending).toBe(111);
  });

  it('F6: a failed run cannot be "retried" after its committed batches were rolled back', async () => {
    const h = harness();
    const v = await goldReady(h);
    const failed = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 75 });
    expect((await h.call('POST', '/api/rollback', { reason: 'undo the partial load' })).status).toBe(201);
    const retried = await h.call('POST', `/api/runs/${failed.body.id}/retry`, {});
    // Today: 201 succeeded, 161 rows re-inserted — a full re-load labelled "attempt 2 / resumes from the ledger".
    expect(retried.status).toBe(409);
  });

  it('F7: failAfter >= accepted must not silently produce a successful run (fault never injected)', async () => {
    const h = harness();
    const v = await goldReady(h);
    const run = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 164 }); // = accepted
    // Either refuse the value (422) or inject the failure; today: 201 + status 'succeeded', badge "fail after 164".
    expect(run.status === 422 || run.body.status === 'failed').toBe(true);
  });

  it('F8: GET /api/runs keeps the failed execution (and its Retry) reachable after many dry runs', async () => {
    const h = harness();
    const v = await goldReady(h);
    const failed = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 75 });
    for (let i = 0; i < 50; i++) await h.call('POST', '/api/runs/dry-run', { version: v });
    const runs = await h.call('GET', '/api/runs');
    // Hard LIMIT 50 with no paging/kind filter: the Execute step's runs table (the only Retry entry point) loses the run.
    expect(runs.body.items.some((r: Json) => r.id === failed.body.id)).toBe(true);
  });
});

describe('workspaces', () => {
  it('F9: an agent run in flight during "Start a new workspace" must not land its plan in the archived workspace', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client: LlmClient = {
      mode: 'scripted',
      async create() {
        await gate;
        return { message: assistant([toolUse('s1', SUBMIT_TOOL, toSubmission(dataset().goldPlan))]), requestId: 'req_1' };
      },
    };
    const h = harness(client);
    const started = await h.call('POST', '/api/agent-runs', { actor: 'alice' });
    expect(started.status).toBe(202);
    const ws = await h.call('POST', '/api/workspaces', { actor: 'bob' });
    // The per-workspace "one active agent run" guard no longer sees run #1, so a second paid run starts in parallel.
    const second = await h.call('POST', '/api/agent-runs', { actor: 'bob' });
    release();
    for (let i = 0; i < 200; i++) {
      const row = h.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE status IN (\'queued\',\'running\')').get() as { n: number };
      if (row.n === 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const poll = await h.call('GET', `/api/agent-runs/${started.body.id}`);
    const archived = (h.db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE migration_id = 1').get() as { n: number }).n;
    // Expected: the switch is refused while an agent run is active (409), or the result stays reachable / is discarded.
    // Today: switch 201, second run 202, poll of run #1 → 404 AGENT_RUN_NOT_FOUND, and v1 is written into workspace 1.
    expect({ ws: ws.status, second: second.status, poll: poll.status, archivedVersions: archived }).toEqual(
      ws.status === 409 ? expect.anything() : { ws: 201, second: 409, poll: 200, archivedVersions: 0 },
    );
  });
});

describe('provenance', () => {
  it('F10: an edit cannot relabel the origin of a mapping it did not change', async () => {
    const h = harness();
    await h.call('POST', '/api/plans/heuristic', { actor: 'alice' });
    const plan = structuredClone((await h.call('GET', '/api/plans/1')).body.plan);
    mapping(plan, 'email').origin = 'agent';
    mapping(plan, 'email').rationale = 'Proposed by the AI agent after profiling.';
    const edit = await h.call('POST', '/api/plans', { parentVersion: 1, plan, actor: 'mallory' });
    const v2 = (await h.call('GET', `/api/plans/${edit.body.version ?? 1}`)).body;
    // Same target/sources/steps as the parent ⇒ provenance must come from the parent (heuristic), not from the client.
    expect(mapping(v2.plan, 'email').origin).toBe('heuristic');
  });
});
