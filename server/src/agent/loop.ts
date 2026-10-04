// Manual tool-use loop: append-only history, parallel tool calls answered in one user turn, explicit terminal tool,
// hard time budget (AbortSignal) and every step recorded for the AI-workflow trace.
import type { MigrationPlan } from '../../../shared/plan.ts';
import type { EngineContext } from '../services/context.ts';
import type { AgentFailureCode, LlmClient, LlmContentBlock, LlmMessage, LlmMessageParam, LlmRequest, LlmToolResult } from './llm.ts';
import { classifyLlmError } from './anthropicClient.ts';
import { SYSTEM_PROMPT, userPrompt } from './prompts.ts';
import { SUBMIT_TOOL, handleSubmit, runReadOnlyTool, toolDefinitions } from './tools.ts';

export type AgentSettings = { model: string; effort: 'low' | 'medium' | 'high'; maxIterations: number; timeoutMs: number };

export type StepRecord =
  | {
      kind: 'llm';
      model: string;
      responseModel: string;
      stopReason: string | null;
      requestId: string | null;
      durationMs: number;
      usage: Usage;
      thinking: string;
      text: string;
      toolCalls: string[];
    }
  | { kind: 'tool'; toolName: string; input: unknown; summary: string; isError: boolean; durationMs: number }
  | { kind: 'system'; summary: string; isError: boolean };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type AgentOutcome =
  | { ok: true; plan: MigrationPlan; iterations: number; usage: Usage; responseModel: string | null }
  | { ok: false; code: AgentFailureCode; message: string; iterations: number; usage: Usage; responseModel: string | null };

const MAX_REJECTED_SUBMITS = 2;
const PER_REQUEST_TIMEOUT_MS = 120_000;
const NUDGE = 'Please finish now: call submit_migration_plan with your complete plan.';

export function buildRequest(settings: AgentSettings, ctx: EngineContext, messages: LlmMessageParam[]): LlmRequest {
  return {
    model: settings.model,
    max_tokens: 16_000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: toolDefinitions(ctx.source, ctx.target),
    tool_choice: { type: 'auto' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: settings.effort },
    cache_control: { type: 'ephemeral' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages,
  } as LlmRequest;
}

export async function runAgentLoop(
  client: LlmClient,
  ctx: EngineContext,
  settings: AgentSettings,
  record: (step: StepRecord) => void,
  opts: { previousPlan?: MigrationPlan | null; reviewerNotes?: string | null; clock?: () => number } = {},
): Promise<AgentOutcome> {
  const clock = opts.clock ?? (() => performance.now());
  const started = clock();
  const abort = AbortSignal.timeout(settings.timeoutMs);
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let responseModel: string | null = null;
  let iterations = 0;
  let nudged = false;
  let maxTokensRetried = false;
  let rejectedSubmits = 0;
  const messages: LlmMessageParam[] = [
    {
      role: 'user',
      content: userPrompt({
        sourceName: ctx.source.name,
        targetName: ctx.target.name,
        records: ctx.records.length,
        previousPlanJson: opts.previousPlan ? JSON.stringify(opts.previousPlan) : null,
        reviewerNotes: opts.reviewerNotes ?? null,
      }),
    },
  ];
  const fail = (code: AgentFailureCode, message: string): AgentOutcome => {
    record({ kind: 'system', summary: `${code}: ${message}`, isError: true });
    return { ok: false, code, message, iterations, usage, responseModel };
  };

  while (iterations < settings.maxIterations) {
    const remaining = settings.timeoutMs - (clock() - started);
    if (remaining <= 0 || abort.aborted) return fail('TIMEOUT', 'The agent run exceeded its time budget');
    iterations++;
    let message: LlmMessage;
    let requestId: string | null;
    const t0 = clock();
    try {
      ({ message, requestId } = await client.create(buildRequest(settings, ctx, messages), {
        signal: abort,
        timeoutMs: Math.max(1, Math.min(remaining, PER_REQUEST_TIMEOUT_MS)),
      }));
    } catch (err) {
      const { code, message: msg } = abort.aborted ? { code: 'TIMEOUT' as const, message: 'The agent run exceeded its time budget' } : classifyLlmError(err);
      return fail(code, msg);
    }
    responseModel = message.model;
    const u = message.usage;
    const turn = turnUsage(u);
    usage.input += turn.input;
    usage.output += turn.output;
    usage.cacheRead += turn.cacheRead;
    usage.cacheWrite += turn.cacheWrite;
    const blocks = message.content as LlmContentBlock[];
    const toolUses = blocks.filter((b): b is Extract<LlmContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    record({
      kind: 'llm',
      model: settings.model,
      responseModel: message.model,
      stopReason: message.stop_reason,
      requestId,
      durationMs: Math.round(clock() - t0),
      usage: turn,
      thinking: blocks
        .filter((b) => b.type === 'thinking')
        .map((b) => (b as { thinking?: string }).thinking ?? '')
        .join('\n')
        .trim(),
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
        .trim(),
      toolCalls: toolUses.map((t) => t.name),
    });

    if (message.stop_reason === 'refusal') {
      const category = (message.stop_details as { category?: string | null } | null)?.category ?? 'unspecified';
      return fail('REFUSAL', `The model declined the request (category: ${category})`);
    }
    if (message.stop_reason === 'max_tokens') {
      // Never run tools from a truncated turn; retry the same request once.
      if (maxTokensRetried) return fail('TRUNCATED', 'The model response was truncated twice');
      maxTokensRetried = true;
      continue;
    }
    if (blocks.length === 0) {
      // An empty assistant turn may not be echoed back (only the final message may be empty): nudge instead.
      if (nudged) return fail('NO_PLAN', 'The model finished without submitting a plan');
      nudged = true;
      appendUserText(messages, NUDGE);
      continue;
    }
    messages.push({ role: 'assistant', content: message.content as LlmMessageParam['content'] });
    if (message.stop_reason === 'pause_turn') continue;

    if (toolUses.length === 0) {
      if (nudged) return fail('NO_PLAN', 'The model finished without submitting a plan');
      nudged = true;
      messages.push({ role: 'user', content: NUDGE });
      continue;
    }

    // Run read-only tools first, the (single) submission last.
    const results: LlmToolResult[] = [];
    const submit = toolUses.find((t) => t.name === SUBMIT_TOOL);
    for (const t of toolUses) {
      if (t.name === SUBMIT_TOOL) continue;
      const t1 = clock();
      const out = runReadOnlyTool(t.name, t.input, ctx);
      record({ kind: 'tool', toolName: t.name, input: t.input, summary: out.summary, isError: out.isError, durationMs: Math.round(clock() - t1) });
      results.push({ type: 'tool_result', tool_use_id: t.id, content: out.content, is_error: out.isError });
    }
    if (submit) {
      for (const extra of toolUses.filter((t) => t.name === SUBMIT_TOOL && t !== submit)) {
        results.push({ type: 'tool_result', tool_use_id: extra.id, content: JSON.stringify({ error: 'Only one submission per turn is processed.' }), is_error: true });
      }
      const t1 = clock();
      const out = handleSubmit(submit.input, ctx);
      record({ kind: 'tool', toolName: SUBMIT_TOOL, input: submit.input, summary: out.summary, isError: !out.accepted, durationMs: Math.round(clock() - t1) });
      if (out.accepted) return { ok: true, plan: out.plan, iterations, usage, responseModel };
      rejectedSubmits++;
      if (rejectedSubmits > MAX_REJECTED_SUBMITS) return fail('INVALID_PLAN', `The submitted plan was rejected ${rejectedSubmits} times: ${out.issues.slice(0, 3).join('; ')}`);
      results.push({ type: 'tool_result', tool_use_id: submit.id, content: out.content, is_error: true });
    }
    messages.push({ role: 'user', content: results });
  }
  return fail('ITERATION_LIMIT', `No accepted plan after ${settings.maxIterations} model turns`);
}

/** Tokens for one turn: when a server-side fallback served it, `usage.iterations` lists every attempt (top-level usage
 *  covers only the serving one), so sum the attempts. */
function turnUsage(u: LlmMessage['usage']): Usage {
  const iterations = (u as { iterations?: { type?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }[] | null }).iterations;
  const attempts = Array.isArray(iterations) && iterations.length ? iterations : [u as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }];
  return attempts.reduce<Usage>(
    (acc, a) => ({
      input: acc.input + (a.input_tokens ?? 0),
      output: acc.output + (a.output_tokens ?? 0),
      cacheRead: acc.cacheRead + (a.cache_read_input_tokens ?? 0),
      cacheWrite: acc.cacheWrite + (a.cache_creation_input_tokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

/** Add a text block to the trailing user turn (or a new user turn) without breaking user/assistant alternation. */
function appendUserText(messages: LlmMessageParam[], text: string): void {
  const last = messages.at(-1);
  if (last && last.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : [...last.content];
    messages[messages.length - 1] = { role: 'user', content: [...content, { type: 'text', text }] };
  } else messages.push({ role: 'user', content: text });
}
