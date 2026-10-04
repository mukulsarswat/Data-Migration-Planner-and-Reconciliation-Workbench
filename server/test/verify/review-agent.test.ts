// Adversarial review of the AI agent layer (agent/*, services/agentRuns.ts, routes/agent.ts).
// Every test here asserts the CORRECT behaviour; a failing test is a confirmed defect.
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { runAgentLoop, type AgentSettings, type StepRecord } from '../../src/agent/loop.ts';
import { assistant, scriptedClient, toolUse } from '../../src/agent/scriptedClient.ts';
import { runReadOnlyTool, SUBMIT_TOOL } from '../../src/agent/tools.ts';
import type { LlmClient, LlmMessage, LlmRequest } from '../../src/agent/llm.ts';
import { engineContext } from '../../src/services/context.ts';
import { startAgentRun } from '../../src/services/agentRuns.ts';
import { createApp, type AppEnv } from '../../src/app.ts';
import { workbenchRoutes } from '../../src/routes/workbench.ts';
import { agentRoutes } from '../../src/routes/agent.ts';
import { validateRow } from '../../src/engine/validate.ts';
import { dataset, makeDeps } from '../helpers.ts';
import { toSubmission } from '../agent/fixtures.ts';

const ctx = engineContext(dataset());
const settings: AgentSettings = { model: 'claude-sonnet-5-5', effort: 'medium', maxIterations: 8, timeoutMs: 10_000 };
const goldSubmit = (id = 's1') => assistant([toolUse(id, SUBMIT_TOOL, toSubmission(dataset().goldPlan))]);

/** A client that reports mode 'live' (so caps apply) but answers offline. */
function liveLike(respond: (req: LlmRequest) => Promise<LlmMessage> | LlmMessage): LlmClient {
  return { mode: 'live', async create(req) { return { message: await respond(req), requestId: 'req_test' }; } };
}

type Json = Record<string, any>;
function harness(env: Record<string, string>, client: LlmClient) {
  const deps = makeDeps(env);
  const app: Hono<AppEnv> = createApp(deps, [workbenchRoutes, agentRoutes(() => client)]);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const settle = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const row = deps.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(id) as { status: string };
      if (row.status !== 'queued' && row.status !== 'running') return row.status;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`agent run ${id} never settled`);
  };
  return { deps, app, call, settle };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ------------------------------------------------------------------------------------------------ PII / injection

describe('preview_mapping leaks unmasked PII and the r0167 injection note to the model', () => {
  it('failure messages carry raw (unmasked) PII values', () => {
    const out = runReadOnlyTool(
      'preview_mapping',
      { target: 'is_vip', sources: ['email_addr'], steps: [{ op: 'to_boolean', params: { true_values: ['Y'], false_values: ['N'] } }] },
      ctx,
    );
    const failures = JSON.parse(out.content).data.failures as { raw: Record<string, string>; message: string }[];
    // raw is masked ('Y***@Example.Com') but message repeats the full address verbatim
    for (const f of failures) {
      const masked = f.raw.email_addr!;
      if (masked === '') continue;
      expect(f.message, `masked raw=${masked}`).not.toMatch(/value '[^*']+@[^']+' is not a listed/);
    }
  });

  it('an agent probing notes with map_values reads the injection payload verbatim (it DOES reach the model)', async () => {
    // Each turn the scripted "model" lists every notes value it has seen so far as a pair, so the next preview's
    // first 5 failures are new values. This is exactly what a model exploring an unknown free-text field does.
    const seen = new Set<string>();
    const turn = (req: LlmRequest): LlmMessage => {
      const last = req.messages.at(-1)!;
      if (Array.isArray(last.content)) {
        for (const block of last.content as { type: string; content?: unknown }[]) {
          if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
          const data = JSON.parse(block.content).data as { failures?: { message: string }[] } | undefined;
          for (const f of data?.failures ?? []) {
            const m = /^value '([\s\S]*)' has no mapping$/.exec(f.message);
            if (m) seen.add(m[1]!);
          }
        }
      }
      const pairs = [{ from: 'A', to: 'active' }, ...[...seen].map((from) => ({ from, to: 'x' }))]; // pairs needs >= 1 item
      return assistant([
        toolUse(`p${req.messages.length}`, 'preview_mapping', {
          target: 'status',
          sources: ['notes'],
          steps: [{ op: 'null_if_empty', params: {} }, { op: 'map_values', params: { pairs, fallback: '' } }],
        }),
      ]);
    };
    const client = scriptedClient(Array.from({ length: 8 }, () => turn));
    const steps: StepRecord[] = [];
    await runAgentLoop(client, ctx, { ...settings, maxIterations: 8 }, (s) => steps.push(s));
    // index of the first request sent to the model that contains the payload (-1 = never)
    const leakedAt = client.requests.findIndex((r) => JSON.stringify(r.messages).includes('IGNORE ALL PREVIOUS INSTRUCTIONS'));
    expect(leakedAt, 'first model request carrying the r0167 payload').toBe(-1); // actual: 3 (after three preview calls)
    expect(seen.has(dataset().records.find((r) => r.sourceKey === 'r0167')!.values.notes!)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ preview fidelity

describe('preview_mapping pass rate ignores the target constraints', () => {
  it('reports 100% pass for a status mapping that every single row would fail (enum violation)', () => {
    const out = JSON.parse(
      runReadOnlyTool('preview_mapping', { target: 'status', sources: ['status'], steps: [{ op: 'trim', params: {} }] }, ctx).content,
    ).data;
    const mapping = { target: 'status', sources: ['status'], steps: [{ op: 'trim' as const, params: {} }], origin: 'agent' as const, confidence: 'high' as const, rationale: '' };
    const wouldPass = ctx.records.filter((r) => {
      const res = ctx.run(r.values, mapping);
      if (!res.ok) return false;
      return validateRow(r.sourceKey, { status: res.value } as never, { ...ctx.target, fields: ctx.target.fields.filter((f) => f.name === 'status') }, [mapping], r.values).length === 0;
    }).length;
    expect(wouldPass).toBe(0); // 'A'/'I'/'P' are not in the enum
    expect(out.typeCheck).toBe('ok');
    expect(out.pass).toBe(wouldPass); // actual: 200 (passRatePct 100)
  });
});

// ------------------------------------------------------------------------------------------------ caps

describe('per-IP daily cap', () => {
  it('cannot be bypassed by a client-supplied X-Forwarded-For prefix', async () => {
    const h = harness({ AGENT_RUNS_PER_IP_PER_DAY: '1', AGENT_RUNS_GLOBAL_PER_DAY: '100' }, liveLike(() => goldSubmit()));
    // The trusted proxy appends the real peer address (198.51.100.9); everything before it is client-controlled.
    const post = (spoof: string) => h.call('POST', '/api/agent-runs', {}, { 'x-forwarded-for': `${spoof}, 198.51.100.9` });
    const first = await post('1.1.1.1');
    expect(first.status).toBe(202);
    await h.settle(first.body.id);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await post(`10.0.0.${i}`);
      statuses.push(r.status);
      if (r.status === 202) await h.settle(r.body.id);
    }
    expect(statuses).toEqual([429, 429, 429, 429]); // actual: [202, 202, 202, 202]
  });
});

// ------------------------------------------------------------------------------------------------ lifecycle

describe('agent run vs. "Start a new workspace"', () => {
  it('an in-flight run is not orphaned: still pollable, and no second concurrent live run', async () => {
    const gates = [deferred(), deferred()];
    let calls = 0;
    const h = harness({}, liveLike(async () => { await gates[Math.min(calls++, 1)]!.promise; return goldSubmit(); }));
    const started = await h.call('POST', '/api/agent-runs', { actor: 'alice' });
    expect(started.status).toBe(202);
    const runId = started.body.id as number;

    // Chosen fix: switching workspaces is refused while an agent run is in flight (the run stays pollable and its plan
    // lands in the workspace the reviewer is looking at).
    const sw = await h.call('POST', '/api/workspaces', { actor: 'bob' });
    expect(sw.status).toBe(409);
    expect(sw.body.error.code).toBe('AGENT_RUN_IN_PROGRESS');

    const poll = await h.call('GET', `/api/agent-runs/${runId}`);
    const second = await h.call('POST', '/api/agent-runs', { actor: 'bob' });
    gates.forEach((g) => g.resolve());
    await h.settle(runId);
    if (second.status === 202) await h.settle(second.body.id);

    const orphanVersions = h.deps.db
      .prepare('SELECT pv.version, m.is_current FROM plan_versions pv JOIN migrations m ON m.id = pv.migration_id WHERE pv.agent_run_id = ?')
      .all(runId) as { version: number; is_current: number }[];
    expect.soft(poll.status, 'UI poll of the in-flight run after the switch').toBe(200); // actual: 404 AGENT_RUN_NOT_FOUND
    expect.soft(second.status, 'second live run while the first is still running').toBe(409); // actual: 202
    expect.soft(orphanVersions.every((v) => v.is_current === 1), 'agent plan version written into an archived workspace').toBe(true);
  });
});

describe('agent run completion bookkeeping', () => {
  it('a DB error while finishing never surfaces as a rejected (unhandled) promise and never leaves the run "running"', async () => {
    const deps = makeDeps();
    const gate = deferred();
    const client: LlmClient = { mode: 'scripted', async create() { await gate.promise; return { message: goldSubmit(), requestId: 'r' }; } };
    const { run, done } = startAgentRun(deps, 1, client, { actor: 'alice', clientIp: '127.0.0.1' });
    // Stand-in for a transient SQLITE_BUSY / SQLITE_FULL / IOERR on the agent_runs row while the run completes.
    deps.db.exec(`CREATE TRIGGER fault BEFORE UPDATE ON agent_runs BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;`);
    gate.resolve();
    const settled = await done.then(() => 'resolved', (e: unknown) => `rejected: ${(e as Error).message}`);
    deps.db.exec('DROP TRIGGER fault');
    // routes/agent.ts drops `done`, so a rejection here is an unhandledRejection => Node exits the server.
    expect.soft(settled).toBe('resolved');
    await new Promise((r) => setTimeout(r, 1200)); // the failure is recorded once the transient fault clears
    const status = (deps.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(run.id) as { status: string }).status;
    expect.soft(status).not.toBe('running'); // actual: stuck 'running' => every later POST is 409 AGENT_RUN_IN_PROGRESS until restart
  });
});

// ------------------------------------------------------------------------------------------------ loop / API contract

describe('loop contract against the Messages API', () => {
  it('never echoes an assistant turn with empty content (API 400: messages must have non-empty content)', async () => {
    const empty = assistant([], { stop: 'end_turn' });
    const client = scriptedClient([empty, goldSubmit()]);
    await runAgentLoop(client, ctx, settings, () => {});
    const second = client.requests[1];
    expect(second, 'loop should nudge and call the model again').toBeDefined();
    const emptyAssistant = second!.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0);
    expect(emptyAssistant).toHaveLength(0); // actual: 1 => the nudge request is rejected, run fails BAD_REQUEST
  });

  it('counts the tokens of every attempt when a server-side fallback served the turn (usage.iterations)', async () => {
    const served = goldSubmit();
    (served as unknown as { model: string }).model = 'claude-sonnet-5';
    (served.content as unknown[]).unshift({ type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } });
    served.usage = {
      ...served.usage,
      input_tokens: 5000,
      output_tokens: 900,
      iterations: [
        { type: 'message', input_tokens: 5000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: 'fallback_message', input_tokens: 5000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
    } as never;
    const outcome = await runAgentLoop(scriptedClient([served]), ctx, settings, () => {});
    expect(outcome.ok).toBe(true);
    expect(outcome.usage.input + outcome.usage.output).toBe(5000 + 400 + 5000 + 900); // actual: 5900 (declined attempt dropped)
  });
});
