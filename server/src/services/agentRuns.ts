// Agent runs: caps, async execution behind a 202, persisted step trace, plan version on success.
import type { AppDeps } from '../app.ts';
import type { LlmClient } from '../agent/llm.ts';
import { runAgentLoop, type StepRecord } from '../agent/loop.ts';
import { conflict, notFound, tooManyRequests } from '../http/errors.ts';
import { engineContext } from './context.ts';
import { appendEvent } from './events.ts';
import { createVersion, getVersion } from './plans.ts';

export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export type AgentRun = {
  id: number;
  migrationId: number;
  status: AgentRunStatus;
  mode: 'live' | 'scripted';
  model: string;
  responseModel: string | null;
  basedOnVersion: number | null;
  iterations: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  latencyMs: number | null;
  errorCode: string | null;
  error: string | null;
  resultVersion: number | null;
  createdAt: string;
  finishedAt: string | null;
};

export type AgentStep = {
  seq: number;
  kind: 'llm' | 'tool' | 'system';
  toolName: string | null;
  input: unknown;
  summary: string | null;
  thinking: string | null;
  isError: boolean;
  stopReason: string | null;
  requestId: string | null;
  model: string | null;
  durationMs: number | null;
  tokens: { input: number | null; output: number | null; cacheRead: number | null };
  createdAt: string;
};

type RawRun = {
  id: number;
  migration_id: number;
  status: AgentRunStatus;
  mode: 'live' | 'scripted';
  model: string;
  response_model: string | null;
  based_on_version: number | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number | null;
  error_code: string | null;
  error: string | null;
  result_version: number | null;
  created_at: string;
  finished_at: string | null;
};

const toRun = (r: RawRun): AgentRun => ({
  id: r.id,
  migrationId: r.migration_id,
  status: r.status,
  mode: r.mode,
  model: r.model,
  responseModel: r.response_model,
  basedOnVersion: r.based_on_version,
  iterations: r.iterations,
  tokens: { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens },
  latencyMs: r.latency_ms,
  errorCode: r.error_code,
  error: r.error,
  resultVersion: r.result_version,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export function getAgentRun(deps: AppDeps, migrationId: number, id: number): { run: AgentRun; steps: AgentStep[] } {
  const row = deps.db.prepare('SELECT * FROM agent_runs WHERE id = ? AND migration_id = ?').get(id, migrationId) as RawRun | undefined;
  if (!row) throw notFound('AGENT_RUN_NOT_FOUND', `Agent run #${id} does not exist in this workspace`);
  const steps = (
    deps.db.prepare('SELECT * FROM agent_steps WHERE agent_run_id = ? ORDER BY seq').all(id) as {
      seq: number;
      kind: AgentStep['kind'];
      tool_name: string | null;
      input_json: string | null;
      output_summary: string | null;
      thinking_summary: string | null;
      is_error: number;
      stop_reason: string | null;
      request_id: string | null;
      model: string | null;
      duration_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      created_at: string;
    }[]
  ).map((s) => ({
    seq: s.seq,
    kind: s.kind,
    toolName: s.tool_name,
    input: s.input_json ? (JSON.parse(s.input_json) as unknown) : null,
    summary: s.output_summary,
    thinking: s.thinking_summary,
    isError: s.is_error === 1,
    stopReason: s.stop_reason,
    requestId: s.request_id,
    model: s.model,
    durationMs: s.duration_ms,
    tokens: { input: s.input_tokens, output: s.output_tokens, cacheRead: s.cache_read_tokens },
    createdAt: s.created_at,
  }));
  return { run: toRun(row), steps };
}

export function listAgentRuns(deps: AppDeps, migrationId: number): AgentRun[] {
  return (deps.db.prepare('SELECT * FROM agent_runs WHERE migration_id = ? ORDER BY id DESC LIMIT 20').all(migrationId) as RawRun[]).map(toRun);
}

/** UTC-day caps (per client IP and global) — keeps a public demo from becoming an LLM-cost faucet. */
function enforceCaps(deps: AppDeps, clientIp: string) {
  const dayStart = deps.now().slice(0, 10) + 'T00:00:00.000Z';
  const count = (sql: string, ...args: unknown[]) => (deps.db.prepare(sql).get(...args) as { n: number }).n;
  const global = count("SELECT COUNT(*) AS n FROM agent_runs WHERE created_at >= ? AND mode = 'live'", dayStart);
  if (global >= deps.config.caps.globalPerDay) {
    throw tooManyRequests('AGENT_CAP_REACHED', `The daily limit of ${deps.config.caps.globalPerDay} agent runs is reached; use the heuristic draft or try again tomorrow (UTC)`);
  }
  const mine = count("SELECT COUNT(*) AS n FROM agent_runs WHERE created_at >= ? AND client_ip = ? AND mode = 'live'", dayStart, clientIp);
  if (mine >= deps.config.caps.perIpPerDay) {
    throw tooManyRequests('AGENT_CAP_REACHED', `You reached ${deps.config.caps.perIpPerDay} agent runs today; use the heuristic draft or try again tomorrow (UTC)`);
  }
}

export type StartOptions = { actor: string; clientIp: string; basedOnVersion?: number | null; reviewerNotes?: string | null };

/** Validate, record and launch an agent run; returns immediately (the caller responds 202). */
export function startAgentRun(deps: AppDeps, migrationId: number, client: LlmClient | null, opts: StartOptions): { run: AgentRun; done: Promise<void> } {
  const { db, config } = deps;
  if (!client) {
    throw conflict('LLM_NOT_CONFIGURED', 'No ANTHROPIC_API_KEY is configured on this deployment; generate the deterministic heuristic draft instead');
  }
  const previous = opts.basedOnVersion ? getVersion(db, migrationId, opts.basedOnVersion) : null;
  const now = deps.now();
  const id = db.transaction(() => {
    const active = db.prepare("SELECT id FROM agent_runs WHERE migration_id = ? AND status IN ('queued','running')").get(migrationId) as { id: number } | undefined;
    if (active) throw conflict('AGENT_RUN_IN_PROGRESS', `Agent run #${active.id} is still running`);
    if (client.mode === 'live') enforceCaps(deps, opts.clientIp);
    const info = db
      .prepare(
        `INSERT INTO agent_runs (migration_id, status, mode, model, based_on_version, client_ip, created_at)
         VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(migrationId, client.mode, config.anthropic.model, previous?.version ?? null, opts.clientIp, now);
    const runId = Number(info.lastInsertRowid);
    appendEvent(db, { migrationId, type: 'agent_run_started', actor: opts.actor, agentRunId: runId, payload: { model: config.anthropic.model, mode: client.mode, basedOnVersion: previous?.version ?? null } }, now);
    return runId;
  }).immediate();

  // Never let a background failure become an unhandled rejection (that would crash the whole server).
  const done = executeAgentRun(deps, migrationId, id, client, opts, previous?.plan ?? null).catch((err: unknown) => {
    deps.logger.error({ err, agentRunId: id }, 'agent run crashed');
    recordFailureWithRetry(deps, migrationId, id, opts.actor, 0);
  });
  return { run: getAgentRun(deps, migrationId, id).run, done };
}

async function executeAgentRun(
  deps: AppDeps,
  migrationId: number,
  id: number,
  client: LlmClient,
  opts: StartOptions,
  previousPlan: import('../../../shared/plan.ts').MigrationPlan | null,
): Promise<void> {
  const { db, config, logger } = deps;
  db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").run(id);
  let seq = 0;
  const insertStep = db.prepare(
    `INSERT INTO agent_steps (agent_run_id, seq, kind, tool_name, input_json, output_summary, thinking_summary, is_error, stop_reason,
                              request_id, model, duration_ms, input_tokens, output_tokens, cache_read_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const record = (s: StepRecord) => {
    seq++;
    const now = deps.now();
    if (s.kind === 'llm') {
      insertStep.run(id, seq, 'llm', null, null, s.text || `model turn → ${s.toolCalls.join(', ') || s.stopReason}`, s.thinking || null, 0, s.stopReason, s.requestId, s.responseModel, s.durationMs, s.usage.input, s.usage.output, s.usage.cacheRead, now);
      logger.info(
        { agentRunId: id, step: seq, 'gen_ai.request.model': s.model, 'gen_ai.response.model': s.responseModel, stopReason: s.stopReason, requestId: s.requestId, durationMs: s.durationMs, usage: s.usage, toolCalls: s.toolCalls },
        'agent llm turn',
      );
    } else if (s.kind === 'tool') {
      insertStep.run(id, seq, 'tool', s.toolName, truncateJson(s.input), s.summary, null, s.isError ? 1 : 0, null, null, null, s.durationMs, null, null, null, now);
      logger.info({ agentRunId: id, step: seq, 'gen_ai.tool.name': s.toolName, isError: s.isError, durationMs: s.durationMs, summary: s.summary }, 'agent tool call');
    } else {
      insertStep.run(id, seq, 'system', null, null, s.summary, null, s.isError ? 1 : 0, null, null, null, null, null, null, null, now);
      logger.warn({ agentRunId: id, step: seq, summary: s.summary }, 'agent run event');
    }
  };
  const started = performance.now();
  const outcome = await runAgentLoop(
    client,
    engineContext(deps.dataset),
    { model: config.anthropic.model, effort: config.anthropic.effort, maxIterations: config.anthropic.maxIterations, timeoutMs: config.anthropic.timeoutMs },
    record,
    { previousPlan, reviewerNotes: opts.reviewerNotes ?? null },
  );
  const latencyMs = Math.round(performance.now() - started);
  db.prepare(
    `UPDATE agent_runs SET iterations = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, latency_ms = ?, response_model = ? WHERE id = ?`,
  ).run(outcome.iterations, outcome.usage.input, outcome.usage.output, outcome.usage.cacheRead, outcome.usage.cacheWrite, latencyMs, outcome.responseModel, id);
  if (outcome.ok) {
    const latest = (db.prepare('SELECT MAX(version) AS v FROM plan_versions WHERE migration_id = ?').get(migrationId) as { v: number | null }).v;
    const version = createVersion(deps, {
      migrationId,
      plan: outcome.plan,
      author: 'agent',
      actor: `agent:${config.anthropic.model}`,
      parentVersion: latest,
      agentRunId: id,
      changeNote: `Proposed by the AI agent (${outcome.iterations} turns)`,
    });
    finish(deps, migrationId, id, { status: 'succeeded', resultVersion: version.version }, opts.actor);
  } else {
    finish(deps, migrationId, id, { status: 'failed', errorCode: outcome.code, error: outcome.message }, opts.actor);
  }
}

/** Transient DB errors (SQLITE_BUSY/FULL/IOERR) must not leave a run 'running' forever: retry with a short backoff. */
function recordFailureWithRetry(deps: AppDeps, migrationId: number, id: number, actor: string, attempt: number): void {
  try {
    finish(deps, migrationId, id, { status: 'failed', errorCode: 'INTERNAL', error: 'Unexpected error while running the agent' }, actor);
  } catch (err) {
    if (attempt === 0) deps.logger.error({ err, agentRunId: id }, 'could not record agent run failure; retrying');
    if (attempt < 40) setTimeout(() => recordFailureWithRetry(deps, migrationId, id, actor, attempt + 1), Math.min(500, 10 * 2 ** attempt)).unref();
  }
}

function finish(
  deps: AppDeps,
  migrationId: number,
  id: number,
  r: { status: 'succeeded' | 'failed'; resultVersion?: number; errorCode?: string; error?: string },
  actor: string,
) {
  const now = deps.now();
  deps.db.transaction(() => {
    deps.db
      .prepare('UPDATE agent_runs SET status = ?, result_version = ?, error_code = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(r.status, r.resultVersion ?? null, r.errorCode ?? null, r.error ?? null, now, id);
    appendEvent(
      deps.db,
      { migrationId, type: r.status === 'succeeded' ? 'agent_run_succeeded' : 'agent_run_failed', actor, agentRunId: id, payload: { resultVersion: r.resultVersion ?? null, errorCode: r.errorCode ?? null, error: r.error ?? null } },
      now,
    );
  })();
}

function truncateJson(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  return s.length > 8000 ? JSON.stringify({ truncated: true, preview: s.slice(0, 8000) }) : s;
}
