// Typed API client. Every failure becomes an ApiError carrying the server envelope (code, message, details, requestId),
// so each panel can render a precise failure state with a link to the matching log lines.
import type { MigrationPlan, FieldGaps, Clarification, PlanIssue, FieldMapping } from '../../shared/plan.ts';
import type { DryRunCounts, Evidence, ExecuteCounts } from '../../shared/evidence.ts';
import type { SourceSchema, TargetSchema, SourceRecord } from '../../shared/schemas.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  requestId: string | null;
  constructor(status: number, code: string, message: string, details: unknown, requestId: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.', null, null);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body (e.g. proxy error page) */
  }
  if (!res.ok) {
    const env = (data as { error?: { code: string; message: string; details: unknown; requestId: string | null } } | null)?.error;
    throw new ApiError(
      res.status,
      env?.code ?? `HTTP_${res.status}`,
      env?.message ?? (res.status === 401 ? 'Authentication required' : `Request failed (${res.status})`),
      env?.details ?? null,
      env?.requestId ?? res.headers.get('x-request-id'),
    );
  }
  return data as T;
}

// ---------------------------------------------------------------- DTOs (mirror server responses)

export type Approval = { decision: 'approved' | 'rejected'; reviewer: string; comment: string; planHash: string; createdAt: string };
export type VersionSummary = {
  version: number;
  parentVersion: number | null;
  author: 'agent' | 'heuristic' | 'user';
  actor: string;
  planHash: string;
  changeNote: string;
  createdAt: string;
  agentRunId: number | null;
  approval: Approval | null;
  blockers: number;
  unresolvedClarifications: number;
};
export type PassRate = {
  passRatePct: number;
  ok: number;
  total: number;
  samples: { sourceKey: string; raw: Record<string, string | null>; value: unknown }[];
  failures: { sourceKey: string; raw: Record<string, string | null>; message: string }[];
};
export type PlanDiff = {
  from: number | null;
  to: number;
  changedTargets: { target: string; change: 'added' | 'removed' | 'modified'; before: FieldMapping | null; after: FieldMapping | null }[];
  ignoredAdded: string[];
  ignoredRemoved: string[];
  clarificationsResolved: string[];
  errorBudgetChanged: { before: number; after: number } | null;
};
export type VersionDetail = VersionSummary & {
  plan: MigrationPlan;
  issues: PlanIssue[];
  approvalIssues: PlanIssue[];
  diff: PlanDiff;
  passRates: Record<string, PassRate>;
};
export type FieldProfile = {
  field: string;
  pii: boolean;
  total: number;
  empty: number;
  distinct: number;
  distinctRatio: number;
  keyLike: boolean;
  minLength: number;
  maxLength: number;
  formats: { signature: string; count: number; example: string }[];
  topValues: { value: string; count: number }[];
};
export type OpInfo = { name: string; in: string; out: string; nulls: string; description: string; example: string; params: string[] };
export type Run = {
  id: number;
  migrationId: number;
  planVersionId: number | null;
  version: number | null;
  planHash: string | null;
  kind: 'dry_run' | 'execute' | 'rollback';
  attempt: number;
  parentRunId: number | null;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  counts: Record<string, number>;
  resultHash: string | null;
  options: Record<string, unknown>;
  actor: string;
  errorCode: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  retriedBy: number | null;
};
export type Workspace = { id: number; name: string; createdAt: string; isCurrent: boolean };
export type MigrationInfo = {
  workspace: Workspace;
  workspaces: Workspace[];
  source: SourceSchema;
  target: TargetSchema;
  catalog: { ops: OpInfo[]; dateFormats: string[] };
  profiles: FieldProfile[];
  gaps: FieldGaps;
  limits: { records: number; maxSampleSize: number };
  status: {
    latestVersion: VersionSummary | null;
    activeLoadedRows: number;
    lastRun: Run | null;
    llm: { configured: boolean; model: string };
    faultInjection: boolean;
  };
};
export type DryRunResponse = {
  run: Run;
  counts: DryRunCounts;
  resultHash: string;
  previousResultHash: string | null;
  deterministicMatch: boolean | null;
  conflictPreflight: string[];
  rejectRatePct: number;
  errorBudgetPct: number;
  withinErrorBudget: boolean;
};
export type RunRecord = { sourceKey: string; outcome: string; errors: Evidence[]; transformed: Record<string, unknown> | null; raw: Record<string, string> };
export type Verdict = 'NOT_EXECUTED' | 'MATCHED' | 'INCOMPLETE' | 'ROLLED_BACK_CLEAN' | 'MISMATCHED';
export type Reconciliation = {
  verdict: Verdict;
  version: number | null;
  totals: {
    source: number;
    accepted: number;
    rejected: number;
    conflicts: number;
    loadRejected: number;
    loadedActive: number;
    pending: number;
    targetTotal: number;
    preExisting: number;
    expectedBalanceCents: number;
    actualBalanceCents: number;
  };
  equations: { name: string; expression: string; holds: boolean }[];
  statusCounts: Record<string, number>;
  exceptions: { sourceKey: string; externalRef: string | null; status: string; detail: string }[];
  preExistingIntact: boolean;
  lastLoadRun: { id: number; kind: string; status: string } | null;
};
export type EventRow = {
  id: number;
  migrationId: number | null;
  type: string;
  actor: string;
  planVersionId: number | null;
  runId: number | null;
  agentRunId: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
};
export type AgentRun = {
  id: number;
  migrationId: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
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
export type LogEntry = { level: number; time: number; msg?: string; requestId?: string; [k: string]: unknown };
export type Health = {
  status: string;
  version: string;
  llm: { configured: boolean; model: string; lastRunStatus: string | null; lastRunAt: string | null };
};

export type { MigrationPlan, FieldMapping, Clarification, PlanIssue, Evidence, DryRunCounts, ExecuteCounts, SourceRecord };

// ---------------------------------------------------------------- endpoints

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  health: () => request<Health>('GET', '/api/health'),
  migration: () => request<MigrationInfo>('GET', '/api/migration'),
  newWorkspace: (actor: string) => request<{ workspace: Workspace; rolledBack: number }>('POST', '/api/workspaces', { actor }),
  sourceRecords: (p: { offset?: number; limit?: number; q?: string }) =>
    request<{ total: number; items: SourceRecord[] }>('GET', `/api/source/records${q(p)}`),
  targetAccounts: (p: { offset?: number; limit?: number }) =>
    request<{ total: number; items: Record<string, unknown>[] }>('GET', `/api/target/accounts${q(p)}`),

  plans: () => request<{ items: VersionSummary[] }>('GET', '/api/plans'),
  plan: (v: number) => request<VersionDetail>('GET', `/api/plans/${v}`),
  heuristicDraft: (actor: string) => request<VersionSummary>('POST', '/api/plans/heuristic', { actor }),
  saveEdit: (parentVersion: number, plan: MigrationPlan, changeNote: string, actor: string) =>
    request<VersionSummary>('POST', '/api/plans', { parentVersion, plan, changeNote, actor }),
  answerClarification: (v: number, id: string, choice: number | 'dismissed', actor: string) =>
    request<VersionSummary>('POST', `/api/plans/${v}/clarifications/${encodeURIComponent(id)}`, { choice, actor }),
  approve: (v: number, reviewer: string, comment: string) => request<VersionSummary>('POST', `/api/plans/${v}/approve`, { reviewer, comment }),
  reject: (v: number, reviewer: string, comment: string) => request<VersionSummary>('POST', `/api/plans/${v}/reject`, { reviewer, comment }),

  dryRun: (version: number, actor: string) => request<DryRunResponse>('POST', '/api/runs/dry-run', { version, actor }),
  execute: (version: number, actor: string, failAfter: number | null) => request<Run>('POST', '/api/runs/execute', { version, actor, failAfter }),
  retry: (runId: number, actor: string) => request<Run>('POST', `/api/runs/${runId}/retry`, { actor }),
  rollback: (actor: string, reason: string) => request<{ run: Run; counts: { deleted: number } }>('POST', '/api/rollback', { actor, reason }),
  runs: (kind?: string) => request<{ items: Run[] }>('GET', `/api/runs${q({ kind, limit: 200 })}`),
  run: (id: number) => request<Run>('GET', `/api/runs/${id}`),
  runRecords: (id: number, p: { outcome?: string; offset?: number; limit?: number }) =>
    request<{ total: number; items: RunRecord[] }>('GET', `/api/runs/${id}/records${q(p)}`),
  reconciliation: () => request<Reconciliation>('GET', '/api/reconciliation'),

  events: (p: { scope?: 'current' | 'all'; limit?: number }) => request<{ items: EventRow[] }>('GET', `/api/events${q(p)}`),
  logs: (p: { requestId?: string; minLevel?: string; limit?: number }) => request<{ entries: LogEntry[] }>('GET', `/api/logs${q(p)}`),

  startAgent: (actor: string, basedOnVersion: number | null, reviewerNotes: string | null) =>
    request<AgentRun>('POST', '/api/agent-runs', { actor, basedOnVersion, reviewerNotes }),
  agentRuns: () => request<{ items: AgentRun[] }>('GET', '/api/agent-runs'),
  agentRun: (id: number) => request<{ run: AgentRun; steps: AgentStep[] }>('GET', `/api/agent-runs/${id}`),
};
