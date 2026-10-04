// Every documented gate, plus the agent HTTP flow, proved through the API (each would fail if its guard broke).
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { workbenchRoutes } from '../../src/routes/workbench.ts';
import { agentRoutes } from '../../src/routes/agent.ts';
import { assistant, scriptedClient, toolUse } from '../../src/agent/scriptedClient.ts';
import type { LlmClient } from '../../src/agent/llm.ts';
import { SUBMIT_TOOL } from '../../src/agent/tools.ts';
import { createVersion, decide } from '../../src/services/plans.ts';
import { runDryRun } from '../../src/services/runs.ts';
import { makeDeps } from '../helpers.ts';
import { toSubmission } from '../agent/fixtures.ts';

type Json = Record<string, any>;

function harness(env: Record<string, string> = {}, client: () => LlmClient | null = () => null) {
  const deps = makeDeps(env);
  const app = createApp(deps, [workbenchRoutes, agentRoutes(() => client())]);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Json };
  };
  return { deps, app, call };
}

/** v1 = gold plan (+ overrides), approved and dry-run. */
function goldVersion(h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}, approve = true) {
  const v = createVersion(h.deps, { migrationId: 1, plan: { ...h.deps.dataset.goldPlan, ...overrides }, author: 'user', actor: 't', parentVersion: null, changeNote: 'gold' });
  if (approve) decide(h.deps, 1, v.version, 'approved', 't', '');
  runDryRun(h.deps, 1, v.version, 't');
  return v.version;
}

async function settle(h: ReturnType<typeof harness>, id: number) {
  for (let i = 0; i < 200; i++) {
    const r = await h.call('GET', `/api/agent-runs/${id}`);
    if (!['queued', 'running'].includes(r.body.run.status)) return r.body;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('agent run did not settle');
}

const submitGold = (h: ReturnType<typeof harness>) =>
  assistant([toolUse('s1', SUBMIT_TOOL, toSubmission(h.deps.dataset.goldPlan))], { inputTokens: 5000, outputTokens: 900 });

describe('agent HTTP flow', () => {
  it('POST 202 → run completes → agent-authored plan version + persisted trace + events + health status', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({}, () => scriptedClient([assistant([toolUse('t1', 'get_source_schema', {}), toolUse('t2', 'get_field_gaps', {})]), submitGold(h)]));
    const started = await h.call('POST', '/api/agent-runs', { actor: 'alice' });
    expect(started.status).toBe(202);
    const done = await settle(h, started.body.id);
    expect(done.run).toMatchObject({ status: 'succeeded', resultVersion: 1, iterations: 2 });
    expect(done.run.tokens.output).toBe(1200);
    expect(done.steps.map((s: Json) => s.kind)).toEqual(['llm', 'tool', 'tool', 'llm', 'tool']);
    expect(done.steps.filter((s: Json) => s.kind === 'tool').map((s: Json) => s.toolName)).toEqual(['get_source_schema', 'get_field_gaps', SUBMIT_TOOL]);
    const v1 = await h.call('GET', '/api/plans/1');
    expect(v1.body.author).toBe('agent');
    expect(v1.body.agentRunId).toBe(started.body.id);
    const events = (await h.call('GET', '/api/events')).body.items.map((e: Json) => e.type);
    expect(events).toEqual(expect.arrayContaining(['agent_run_started', 'agent_run_succeeded', 'plan_version_created']));
    const logs = h.deps.logBuffer.query({ limit: 1000 });
    expect(logs.some((l) => l.msg === 'agent tool call' && l['gen_ai.tool.name'] === 'get_field_gaps')).toBe(true);
    expect((await h.call('GET', '/api/health')).body.llm.lastRunStatus).toBe('succeeded');
  });

  it('LLM_NOT_CONFIGURED (409) when no API key is configured', async () => {
    const h = harness();
    const r = await h.call('POST', '/api/agent-runs', {});
    expect([r.status, r.body.error.code]).toEqual([409, 'LLM_NOT_CONFIGURED']);
  });

  it('AGENT_RUN_IN_PROGRESS (409) for a second run, and the workspace cannot be switched under it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let h!: ReturnType<typeof harness>;
    const client: LlmClient = { mode: 'scripted', create: async () => (await gate, { message: submitGold(h), requestId: 'r' }) };
    h = harness({}, () => client);
    const first = await h.call('POST', '/api/agent-runs', {});
    const second = await h.call('POST', '/api/agent-runs', {});
    const sw = await h.call('POST', '/api/workspaces', {});
    release();
    await settle(h, first.body.id);
    expect([second.status, second.body.error.code]).toEqual([409, 'AGENT_RUN_IN_PROGRESS']);
    expect([sw.status, sw.body.error.code]).toEqual([409, 'AGENT_RUN_IN_PROGRESS']);
  });

  it('AGENT_CAP_REACHED (429) once the per-IP daily cap of live runs is used', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({ AGENT_RUNS_PER_IP_PER_DAY: '1' }, () => ({ mode: 'live', create: async () => ({ message: submitGold(h), requestId: 'r' }) }));
    const first = await h.call('POST', '/api/agent-runs', {});
    await settle(h, first.body.id);
    const second = await h.call('POST', '/api/agent-runs', {}, { 'x-forwarded-for': '203.0.113.9' }); // spoofed hop ignored
    expect([second.status, second.body.error.code]).toEqual([429, 'AGENT_CAP_REACHED']);
  });
});

describe('execution gates', () => {
  it('ERROR_BUDGET_EXCEEDED (409) when the dry-run reject rate is above the plan budget', async () => {
    const h = harness();
    const v = goldVersion(h, { errorBudgetPct: 10 }); // gold rejects 18%
    const r = await h.call('POST', '/api/runs/execute', { version: v });
    expect([r.status, r.body.error.code]).toEqual([409, 'ERROR_BUDGET_EXCEEDED']);
    expect(r.body.error.details).toEqual({ rejectRatePct: 18, errorBudgetPct: 10 });
  });

  it('PLAN_REJECTED (409) for a rejected version', async () => {
    const h = harness();
    const v = goldVersion(h, {}, false);
    await h.call('POST', `/api/plans/${v}/reject`, { reviewer: 'bob', comment: 'no' });
    const r = await h.call('POST', '/api/runs/execute', { version: v });
    expect([r.status, r.body.error.code]).toEqual([409, 'PLAN_REJECTED']);
  });

  it('HASH_MISMATCH (409) when a stored plan is tampered with after approval', async () => {
    const h = harness();
    const v = goldVersion(h);
    h.deps.db.exec('DROP TRIGGER trg_plan_versions_no_update');
    h.deps.db.prepare(`UPDATE plan_versions SET plan_json = replace(plan_json, '"value":"US"', '"value":"CA"') WHERE version = ?`).run(v);
    const r = await h.call('POST', '/api/runs/execute', { version: v });
    expect([r.status, r.body.error.code]).toEqual([409, 'HASH_MISMATCH']);
  });

  it('RUN_IN_PROGRESS (409) while another execution holds the run lock', async () => {
    const h = harness();
    const v = goldVersion(h);
    h.deps.db.prepare(`INSERT INTO runs (migration_id, kind, status, started_at) VALUES (1, 'execute', 'running', 'x')`).run();
    const r = await h.call('POST', '/api/runs/execute', { version: v });
    expect([r.status, r.body.error.code]).toEqual([409, 'RUN_IN_PROGRESS']);
  });

  it('FAULT_INJECTION_DISABLED (422) and BAD_FAIL_AFTER (422)', async () => {
    const off = harness({ ALLOW_FAULT_INJECTION: 'false' });
    const v1 = goldVersion(off);
    const r1 = await off.call('POST', '/api/runs/execute', { version: v1, failAfter: 10 });
    expect([r1.status, r1.body.error.code]).toEqual([422, 'FAULT_INJECTION_DISABLED']);
    const on = harness();
    const v2 = goldVersion(on);
    const r2 = await on.call('POST', '/api/runs/execute', { version: v2, failAfter: 9999 });
    expect([r2.status, r2.body.error.code]).toEqual([422, 'BAD_FAIL_AFTER']);
  });

  it('NOT_RETRYABLE / ALREADY_RETRIED / PARENT_ROLLED_BACK (409)', async () => {
    const h = harness();
    const v = goldVersion(h);
    const ok = await h.call('POST', '/api/runs/execute', { version: v });
    expect((await h.call('POST', `/api/runs/${ok.body.id}/retry`, {})).body.error.code).toBe('NOT_RETRYABLE');
    await h.call('POST', '/api/rollback', {});
    const failed = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 75 });
    const retried = await h.call('POST', `/api/runs/${failed.body.id}/retry`, {});
    expect(retried.body.status).toBe('succeeded');
    expect((await h.call('POST', `/api/runs/${failed.body.id}/retry`, {})).body.error.code).toBe('ALREADY_RETRIED');
    await h.call('POST', '/api/rollback', {});
    const failed2 = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 75 });
    await h.call('POST', '/api/rollback', {});
    expect((await h.call('POST', `/api/runs/${failed2.body.id}/retry`, {})).body.error.code).toBe('PARENT_ROLLED_BACK');
  });

  it('STALE_VERSION (409): answers and edits must build on the latest version', async () => {
    const h = harness();
    await h.call('POST', '/api/plans/heuristic', {});
    const v1 = (await h.call('GET', '/api/plans/1')).body;
    const country = v1.plan.clarifications.find((c: Json) => c.field === 'country');
    const answered = await h.call('POST', `/api/plans/1/clarifications/${country.id}`, { choice: 0 });
    expect(answered.body.version).toBe(2);
    const stale = await h.call('POST', `/api/plans/1/clarifications/${v1.plan.clarifications[0].id}`, { choice: 0 });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'STALE_VERSION']);
  });

  it('edits cannot forge clarification answers', async () => {
    const h = harness();
    await h.call('POST', '/api/plans/heuristic', {});
    const v1 = (await h.call('GET', '/api/plans/1')).body;
    const forged = {
      ...v1.plan,
      clarifications: v1.plan.clarifications.map((c: Json) => ({ ...c, resolution: { choice: 'dismissed', by: 'Chief Risk Officer' } })),
    };
    const saved = await h.call('POST', '/api/plans', { parentVersion: 1, plan: forged, changeNote: 'forge' });
    expect([saved.status, saved.body.error.code]).toEqual([422, 'NO_CHANGES']); // resolutions are ignored, so nothing changed
  });
});

describe('HTTP hardening', () => {
  it('CSRF_REJECTED (403) for cross-site state changes; same-origin requests pass', async () => {
    const h = harness();
    const evil = await h.call('POST', '/api/workspaces', {}, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    expect([evil.status, evil.body.error.code]).toEqual([403, 'CSRF_REJECTED']);
    const foreign = await h.call('POST', '/api/plans/heuristic', {}, { origin: 'https://evil.example', host: 'localhost' });
    expect(foreign.status).toBe(403);
    const same = await h.call('POST', '/api/plans/heuristic', {}, { origin: 'http://localhost', host: 'localhost', 'sec-fetch-site': 'same-origin' });
    expect(same.status).toBe(201);
  });

  it('sends anti-framing, nosniff and CSP headers', async () => {
    const h = harness();
    const r = await h.call('GET', '/api/health');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
