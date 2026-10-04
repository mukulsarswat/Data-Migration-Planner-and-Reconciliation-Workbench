// Shared pieces of the Proposal step: agent-run polling rules, the heuristic fallback button, the
// "review this version" jump, and the failure panel that explains every agent error code.
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type AgentRun } from '../api.ts';
import { useActor, useNav, useRefreshAll } from '../nav.tsx';
import { Badge, Banner, Button, ErrorBanner, type Tone } from './ui.tsx';

export const POLL_MS = 1500;
/** Client-side safety net: stop polling a run that is still queued/running this long after createdAt (server budget is ~180 s). */
export const CLIENT_CAP_MS = 200_000;

export const isActive = (r: Pick<AgentRun, 'status'>) => r.status === 'queued' || r.status === 'running';
export const elapsedMs = (r: Pick<AgentRun, 'createdAt'>, now: number) => Math.max(0, now - Date.parse(r.createdAt));
export const isStalled = (r: AgentRun, now: number) => isActive(r) && elapsedMs(r, now) >= CLIENT_CAP_MS;
/** Poll while a run is in flight, but never past the client cap. */
export const shouldPoll = (r: AgentRun) => isActive(r) && !isStalled(r, Date.now());

/** Wall clock that ticks every second while `active` (drives elapsed timers and the client timeout). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const STATUS_TONE: Record<AgentRun['status'], Tone> = { queued: 'neutral', running: 'blue', succeeded: 'green', failed: 'red', interrupted: 'amber' };

export function RunStatusBadge({ run, now }: { run: AgentRun; now: number }) {
  if (isStalled(run, now)) {
    return (
      <Badge tone="amber" title={`Still ${run.status} ${Math.round(CLIENT_CAP_MS / 1000)} s after it started; polling stopped`}>
        no response
      </Badge>
    );
  }
  return <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>;
}

/** Opens a plan version in the Review step (refreshing first so the new version is listed there). */
export function ReviewVersionButton({ version }: { version: number }) {
  const nav = useNav();
  const refreshAll = useRefreshAll();
  return (
    <Button
      size="sm"
      variant="primary"
      onClick={() => {
        void refreshAll();
        nav.selectVersion(version);
        nav.go('review');
      }}
    >
      Review v{version} →
    </Button>
  );
}

/** POST /api/plans/heuristic with its own pending / error / success states. */
export function HeuristicDraftButton({ label, variant = 'secondary', children }: { label: string; variant?: 'primary' | 'secondary'; children?: ReactNode }) {
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const draft = useMutation({ mutationFn: () => api.heuristicDraft(actor), onSuccess: () => void refreshAll() });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={variant} loading={draft.isPending} onClick={() => draft.mutate()}>
          {draft.isPending ? 'Generating…' : label}
        </Button>
        {children}
      </div>
      {draft.isError && <ErrorBanner error={draft.error} title="Could not create the heuristic draft" onRetry={() => draft.mutate()} />}
      {draft.isSuccess && (
        <Banner tone="success" title={`Plan v${draft.data.version} created (heuristic draft)`} actions={<ReviewVersionButton version={draft.data.version} />}>
          {draft.data.blockers} blocker{draft.data.blockers === 1 ? '' : 's'} and {draft.data.unresolvedClarifications} open clarification
          {draft.data.unresolvedClarifications === 1 ? '' : 's'} to resolve before approval.
        </Banner>
      )}
    </div>
  );
}

type Explanation = { what: string; next: string };

const HEURISTIC_NEXT = 'Generate the deterministic heuristic draft instead; it needs no AI.';

/** Plain-language meaning of every agent failure code (start errors and terminal run errors). */
const EXPLAIN: Record<string, Explanation> = {
  LLM_NOT_CONFIGURED: { what: 'No ANTHROPIC_API_KEY is configured on this server, so the AI agent cannot run.', next: HEURISTIC_NEXT },
  AGENT_RUN_IN_PROGRESS: {
    what: 'Another agent run is still queued or running in this workspace; only one may run at a time.',
    next: 'Wait for it to finish (its trace is listed below), or generate the heuristic draft now.',
  },
  AGENT_CAP_REACHED: {
    what: 'The daily limit of AI agent runs for this deployment is reached (per client or global). It resets at 00:00 UTC.',
    next: HEURISTIC_NEXT,
  },
  TIMEOUT: { what: 'The agent exceeded its time budget and the server stopped it. No plan was saved.', next: `Try again, ideally with notes that narrow the task. Or: ${HEURISTIC_NEXT}` },
  CLIENT_TIMEOUT: {
    what: `The run has not reached a final status ${CLIENT_CAP_MS / 1000} s after it started, so this page stopped polling. The server may be stuck or was restarted.`,
    next: `Check again, or: ${HEURISTIC_NEXT}`,
  },
  RATE_LIMITED: { what: 'The Anthropic API rate-limited the request.', next: `Wait a minute and try again. Or: ${HEURISTIC_NEXT}` },
  AUTH: { what: 'Anthropic rejected the server’s API key (invalid, revoked or without access to the model).', next: `An operator must fix ANTHROPIC_API_KEY. Meanwhile: ${HEURISTIC_NEXT}` },
  BAD_REQUEST: { what: 'The Anthropic API rejected the request as invalid. This is a server-side bug; the Logs step has details.', next: HEURISTIC_NEXT },
  UPSTREAM_UNAVAILABLE: { what: 'The Anthropic API is overloaded or temporarily unavailable.', next: `Try again in a few minutes. Or: ${HEURISTIC_NEXT}` },
  NETWORK: { what: 'The server could not reach the Anthropic API.', next: `Try again shortly. Or: ${HEURISTIC_NEXT}` },
  REFUSAL: { what: 'The model declined to complete the request.', next: `Review your notes, then try again. Or: ${HEURISTIC_NEXT}` },
  TRUNCATED: { what: 'The model’s response hit the output-token limit twice, so no complete plan was produced.', next: `Try again. Or: ${HEURISTIC_NEXT}` },
  NO_PLAN: { what: 'The model stopped without submitting a plan, even after a reminder.', next: `Try again. Or: ${HEURISTIC_NEXT}` },
  INVALID_PLAN: {
    what: 'The model’s submitted plans failed server-side validation too many times. Nothing invalid was saved.',
    next: `Try again with notes about the failing fields. Or: ${HEURISTIC_NEXT}`,
  },
  ITERATION_LIMIT: { what: 'The model did not produce an accepted plan within the maximum number of turns.', next: `Try again. Or: ${HEURISTIC_NEXT}` },
  INTERRUPTED: { what: 'The server restarted while this run was in progress, so it was abandoned.', next: `Start a new run. Or: ${HEURISTIC_NEXT}` },
  INTERNAL: { what: 'Unexpected server error while running the agent. The Logs step has details.', next: HEURISTIC_NEXT },
};

const FALLBACK: Explanation = { what: 'The agent did not produce a plan.', next: HEURISTIC_NEXT };

export function explainAgentError(code: string): Explanation {
  return EXPLAIN[code] ?? FALLBACK;
}

/** Failure state for the agent: what happened, why, and a prominent heuristic fallback. */
export function AgentFailurePanel({
  title,
  code,
  message,
  requestId,
  actions,
}: {
  title: string;
  code: string;
  message: string | null;
  requestId?: string | null;
  actions?: ReactNode;
}) {
  const nav = useNav();
  const e = explainAgentError(code);
  return (
    <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-900">
      <p className="font-medium">{title}</p>
      <p className="mt-1">
        <span className="mr-1.5">
          <Badge tone="red">{code}</Badge>
        </span>
        {e.what}
      </p>
      {message && <p className="mt-1 break-words text-xs opacity-90">Server message: {message}</p>}
      {requestId && (
        <p className="mt-1 font-mono text-xs">
          request{' '}
          <button className="underline" onClick={() => nav.showLogs(requestId)}>
            {requestId.slice(0, 8)}
          </button>
        </p>
      )}
      <p className="mt-2 text-xs">{e.next}</p>
      <div className="mt-3">
        <HeuristicDraftButton variant="primary" label="Generate heuristic draft instead">
          {actions}
        </HeuristicDraftButton>
      </div>
    </div>
  );
}
