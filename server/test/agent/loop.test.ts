// Agent loop behaviour with a scripted LLM (offline, deterministic).
import { describe, expect, it } from 'vitest';
import { runAgentLoop, type AgentSettings, type StepRecord } from '../../src/agent/loop.ts';
import { assistant, scriptedClient, toolUse } from '../../src/agent/scriptedClient.ts';
import { runReadOnlyTool, toolDefinitions, SUBMIT_TOOL } from '../../src/agent/tools.ts';
import { lintStrictSchema } from '../../src/agent/strictLint.ts';
import { engineContext } from '../../src/services/context.ts';
import type { LlmClient } from '../../src/agent/llm.ts';
import { dataset } from '../helpers.ts';
import { DISCOVERY_CALLS, toSubmission } from './fixtures.ts';

const ctx = engineContext(dataset());
const settings: AgentSettings = { model: 'claude-sonnet-5-5', effort: 'medium', maxIterations: 8, timeoutMs: 10_000 };
const discovery = () => assistant(DISCOVERY_CALLS.map(([id, name, input]) => toolUse(id, name, input)), { inputTokens: 3000, outputTokens: 200 });
const submit = (input: unknown, id = 's1') => assistant([{ type: 'text', text: 'Submitting.' }, toolUse(id, SUBMIT_TOOL, input)], { inputTokens: 9000, outputTokens: 2500, cacheRead: 2900 });
const gold = () => toSubmission(dataset().goldPlan);

async function run(client: LlmClient, s: AgentSettings = settings) {
  const steps: StepRecord[] = [];
  const outcome = await runAgentLoop(client, ctx, s, (st) => steps.push(st));
  return { outcome, steps };
}

describe('agent loop', () => {
  it('discovers in parallel, then submits a plan that is accepted (origin agent, server-owned error budget)', async () => {
    const client = scriptedClient([discovery(), submit(gold())]);
    const { outcome, steps } = await run(client);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.iterations).toBe(2);
    expect(outcome.plan.mappings.every((m) => m.origin === 'agent')).toBe(true);
    expect(outcome.plan.errorBudgetPct).toBe(30);
    expect(outcome.plan.clarifications.some((c) => c.trigger === 'agent_question')).toBe(true);
    expect(outcome.usage).toEqual({ input: 12000, output: 2700, cacheRead: 2900, cacheWrite: 0 });
    expect(steps.filter((s) => s.kind === 'tool').map((s) => (s as { toolName: string }).toolName)).toEqual([
      'get_source_schema',
      'get_target_schema',
      'profile_source_fields',
      'get_field_gaps',
      'list_supported_transforms',
      SUBMIT_TOOL,
    ]);
    // All five parallel results go back in ONE user message, in call order, after the assistant turn (append-only).
    const second = client.requests[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = second.messages[2]!.content as { type: string; tool_use_id: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(second.messages[1]!.content).toEqual(discovery().content);
  });

  it('sends the documented request shape (auto tool choice, adaptive summarized thinking, effort, caching, fallbacks)', async () => {
    const client = scriptedClient([submit(gold())]);
    await run(client);
    const req = client.requests[0] as unknown as Record<string, any>;
    expect(req.model).toBe('claude-sonnet-5-5');
    expect(req.max_tokens).toBe(16000);
    expect(req.tool_choice).toEqual({ type: 'auto' });
    expect(req.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(req.output_config).toEqual({ effort: 'medium' });
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.fallbacks).toBe('default');
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.tools.map((t: { name: string }) => t.name)).toContain(SUBMIT_TOOL);
    expect(req.tools.filter((t: { strict?: boolean }) => t.strict).map((t: { name: string }) => t.name)).toEqual([SUBMIT_TOOL]);
  });

  it('the strict submit schema passes the strict-mode linter; the linter flags violations', () => {
    const tools = toolDefinitions(ctx.source, ctx.target);
    expect(lintStrictSchema(tools.find((t) => t.name === SUBMIT_TOOL)!.input_schema)).toEqual([]);
    const issues = lintStrictSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3, minimum: 1 } } });
    expect(issues).toContain("$.properties.a: unsupported keyword 'maxLength'");
    expect(issues).toContain("$.properties.a: unsupported keyword 'minimum'");
    expect(issues).toContain('$: objects must set additionalProperties: false');
  });

  it('answers unknown tools with an error result and keeps going', async () => {
    const client = scriptedClient([assistant([toolUse('x1', 'drop_table', { name: 'tgt_accounts' })]), submit(gold())]);
    const { outcome, steps } = await run(client);
    expect(outcome.ok).toBe(true);
    const unknown = steps.find((s) => s.kind === 'tool' && s.toolName === 'drop_table') as { isError: boolean };
    expect(unknown.isError).toBe(true);
    const sent = client.requests[1]!.messages[2]!.content as { is_error: boolean; content: string }[];
    expect(sent[0]!.is_error).toBe(true);
    expect(sent[0]!.content).toContain('Only the provided inspection and validation tools');
  });

  it('rejects an invalid submission with actionable errors, then accepts the corrected one', async () => {
    const bad = gold();
    bad.mappings = bad.mappings.map((m) => (m.target === 'created_on' ? { ...m, steps: [{ op: 'trim', params: {} }] } : m));
    const client = scriptedClient([submit(bad, 'b1'), submit(gold(), 'g1')]);
    const { outcome } = await run(client);
    expect(outcome.ok).toBe(true);
    const feedback = client.requests[1]!.messages[2]!.content as { is_error: boolean; content: string }[];
    expect(feedback[0]!.is_error).toBe(true);
    expect(feedback[0]!.content).toContain('TARGET_TYPE_MISMATCH');
  });

  it('gives up with INVALID_PLAN after repeated bad submissions', async () => {
    const bad = { ...gold(), ignored: [] }; // fax and notes unaccounted
    const { outcome } = await run(scriptedClient([submit(bad, 'a'), submit(bad, 'b'), submit(bad, 'c')]));
    expect(outcome).toMatchObject({ ok: false, code: 'INVALID_PLAN' });
  });

  it('nudges once when the model stops without submitting, then fails with NO_PLAN', async () => {
    const talk = assistant([{ type: 'text', text: 'Here is my plan in prose.' }]);
    const recovered = await run(scriptedClient([talk, submit(gold())]));
    expect(recovered.outcome.ok).toBe(true);
    const failed = await run(scriptedClient([talk, talk]));
    expect(failed.outcome).toMatchObject({ ok: false, code: 'NO_PLAN' });
  });

  it('stops at the iteration cap', async () => {
    const loop = (_: unknown, i: number) => assistant([toolUse(`i${i}`, 'get_source_schema', {})]);
    const { outcome } = await run(scriptedClient(Array.from({ length: 10 }, loop)), { ...settings, maxIterations: 3 });
    expect(outcome).toMatchObject({ ok: false, code: 'ITERATION_LIMIT', iterations: 3 });
  });

  it('never runs tools from a truncated turn: retries once, then fails TRUNCATED', async () => {
    const truncated = assistant([toolUse('m1', SUBMIT_TOOL, { mappings: [] })], { stop: 'max_tokens' });
    const retried = await run(scriptedClient([truncated, submit(gold())]));
    expect(retried.outcome.ok).toBe(true);
    expect(retried.steps.filter((s) => s.kind === 'tool')).toHaveLength(1); // only the good submit ran
    const failed = await run(scriptedClient([truncated, truncated]));
    expect(failed.outcome).toMatchObject({ ok: false, code: 'TRUNCATED' });
  });

  it('reports refusals with their category', async () => {
    const refusal = assistant([], { stop: 'refusal' as never });
    (refusal as unknown as { stop_details: unknown }).stop_details = { type: 'refusal', category: 'cyber', explanation: null };
    const { outcome } = await run(scriptedClient([refusal]));
    expect(outcome).toMatchObject({ ok: false, code: 'REFUSAL' });
    if (!outcome.ok) expect(outcome.message).toContain('cyber');
  });

  it('keeps fallback and thinking blocks in history and records the serving model', async () => {
    const withFallback = assistant(
      [
        { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
        { type: 'thinking', thinking: 'Checking date formats first.', signature: 'sig' },
        ...DISCOVERY_CALLS.slice(0, 1).map(([id, name, input]) => toolUse(id, name, input)),
      ],
      { model: 'claude-sonnet-5' },
    );
    const client = scriptedClient([withFallback, submit(gold())]);
    const { outcome, steps } = await run(client);
    expect(outcome.ok).toBe(true);
    expect(client.requests[1]!.messages[1]!.content).toEqual(withFallback.content);
    const llm = steps.find((s) => s.kind === 'llm') as { responseModel: string; thinking: string };
    expect(llm.responseModel).toBe('claude-sonnet-5');
    expect(llm.thinking).toBe('Checking date formats first.');
  });

  it('enforces the wall-clock budget even if a request hangs', async () => {
    const hanging: LlmClient = {
      mode: 'scripted',
      create: (_req, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    };
    const t0 = Date.now();
    const { outcome } = await run(hanging, { ...settings, timeoutMs: 150 });
    expect(outcome).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('ignores agent attempts to set the error budget and never exposes the injection payload in tool output', async () => {
    const { outcome } = await run(scriptedClient([submit(toSubmission(dataset().goldPlan, { errorBudgetPct: 100 }))]));
    expect(outcome.ok && outcome.plan.errorBudgetPct).toBe(30);
    for (let offset = 0; offset < 200; offset += 10) {
      const out = runReadOnlyTool('sample_source_records', { limit: 10, offset }, ctx);
      expect(out.content).not.toContain('INJECT-7f3a');
      expect(out.content).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    }
    expect(runReadOnlyTool('profile_source_fields', { fields: [] }, ctx).content).not.toContain('INJECT-7f3a');
  });

  it('clamps sample size to 10 rows and validates preview mappings', () => {
    const sample = JSON.parse(runReadOnlyTool('sample_source_records', { limit: 500, offset: 0 }, ctx).content);
    expect(sample.data.rows).toHaveLength(10);
    const preview = JSON.parse(
      runReadOnlyTool('preview_mapping', { target: 'created_on', sources: ['signup_dt'], steps: [{ op: 'trim', params: {} }, { op: 'parse_date', params: { formats: ['MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MMM-yyyy'] } }] }, ctx).content,
    );
    expect(preview.data.typeCheck).toBe('ok');
    expect(preview.data.passRatePct).toBeGreaterThan(90);
    expect(preview.data.failures.length).toBeGreaterThan(0);
    const bad = runReadOnlyTool('preview_mapping', { target: 'created_on', sources: ['nope'], steps: [] }, ctx);
    expect(bad.isError).toBe(true);
  });
});
