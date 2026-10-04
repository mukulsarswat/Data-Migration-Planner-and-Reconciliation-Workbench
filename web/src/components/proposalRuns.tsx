// Agent runs: the polled list and the detail panel (status, model, tokens, outcome and live trace).
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AgentRun, type AgentStep } from '../api.ts';
import { AsyncPanel, Banner, Button, cx, fmt } from './ui.tsx';
import {
  AgentFailurePanel,
  CLIENT_CAP_MS,
  POLL_MS,
  ReviewVersionButton,
  RunStatusBadge,
  elapsedMs,
  isActive,
  isStalled,
  seconds,
  shouldPoll,
  useNow,
} from './proposalShared.tsx';
import { TraceTimeline } from './proposalTrace.tsx';

/** ['agentRuns'], polled every 1.5 s while any run is queued/running (up to the client cap). */
export function useAgentRuns() {
  return useQuery({
    queryKey: ['agentRuns'],
    queryFn: api.agentRuns,
    refetchInterval: (q) => (q.state.data?.items.some(shouldPoll) ? POLL_MS : false),
  });
}

export function RunsList({ runs, selectedId, onSelect }: { runs: AgentRun[]; selectedId: number | null; onSelect: (id: number) => void }) {
  const now = useNow(runs.some(isActive));
  return (
    <ul className="space-y-1.5" aria-label="Agent runs">
      {runs.map((r) => {
        const selected = r.id === selectedId;
        return (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              aria-current={selected ? 'true' : undefined}
              className={cx(
                'w-full rounded-md border px-3 py-2 text-left transition',
                selected ? 'border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200' : 'border-slate-200 bg-white hover:bg-slate-50',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">Run #{r.id}</span>
                <RunStatusBadge run={r} now={now} />
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {fmt.time(r.createdAt)} · {r.mode}
              </span>
              <span className="mt-0.5 block truncate text-xs text-slate-600">{runOneLiner(r)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function runOneLiner(r: AgentRun): string {
  if (r.resultVersion !== null) return `→ plan v${r.resultVersion}`;
  if (r.errorCode) return r.errorCode;
  return r.basedOnVersion !== null ? `revising v${r.basedOnVersion}` : 'fresh proposal';
}

/** ['agentRun', id], polled while queued/running; polling stops on a terminal status or at the client cap. */
export function RunDetail({ id }: { id: number }) {
  const detail = useQuery({
    queryKey: ['agentRun', id],
    queryFn: () => api.agentRun(id),
    refetchInterval: (q) => {
      const run = q.state.data?.run;
      return run && shouldPoll(run) ? POLL_MS : false;
    },
  });
  return (
    <AsyncPanel query={detail} lines={6}>
      {(d) => <RunDetailBody run={d.run} steps={d.steps} checking={detail.isFetching} onCheckAgain={() => void detail.refetch()} />}
    </AsyncPanel>
  );
}

function RunDetailBody({ run, steps, checking, onCheckAgain }: { run: AgentRun; steps: AgentStep[]; checking: boolean; onCheckAgain: () => void }) {
  const active = isActive(run);
  const now = useNow(active);
  const stalled = isStalled(run, now);
  const live = active && !stalled;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-slate-900">Agent run #{run.id}</h3>
        <RunStatusBadge run={run} now={now} />
        {live && (
          <span className="text-xs tabular-nums text-slate-500" aria-live="polite">
            {run.status} for {Math.floor(elapsedMs(run, now) / 1000)} s · refreshing every {POLL_MS / 1000} s
          </span>
        )}
      </div>

      <RunMeta run={run} />
      <RunOutcome run={run} stalled={stalled} checking={checking} onCheckAgain={onCheckAgain} />
      <TraceTimeline run={run} steps={steps} live={live} />
    </div>
  );
}

function RunMeta({ run }: { run: AgentRun }) {
  // A dated snapshot of the requested alias (e.g. "<model>-20260101") is the same model, not a fallback.
  const fallback = run.responseModel && !run.responseModel.startsWith(run.model) ? run.responseModel : null;
  const items: [string, ReactNode][] = [
    [
      'Model',
      <>
        <span className="font-mono">{run.model}</span>
        {fallback && (
          <span className="block text-amber-700">
            served by fallback model <span className="font-mono">{fallback}</span>
          </span>
        )}
      </>,
    ],
    ['Mode', run.mode === 'live' ? 'live (Anthropic API)' : 'scripted (offline fixture)'],
    ['Based on', run.basedOnVersion !== null ? `v${run.basedOnVersion}` : 'fresh proposal'],
    ['Iterations', run.iterations],
    ['Latency', run.latencyMs !== null ? seconds(run.latencyMs) : '—'],
    [
      'Tokens',
      <span className="tabular-nums" title={`cache write: ${run.tokens.cacheWrite.toLocaleString()}`}>
        {run.tokens.input.toLocaleString()} in · {run.tokens.output.toLocaleString()} out · {run.tokens.cacheRead.toLocaleString()} cache read
      </span>,
    ],
    ['Started', fmt.time(run.createdAt)],
    ['Finished', fmt.time(run.finishedAt)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="font-medium uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="mt-0.5 break-words text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunOutcome({ run, stalled, checking, onCheckAgain }: { run: AgentRun; stalled: boolean; checking: boolean; onCheckAgain: () => void }) {
  if (run.status === 'succeeded') {
    if (run.resultVersion === null) return <Banner tone="success" title="The agent run succeeded" />;
    return (
      <Banner tone="success" title={`Plan v${run.resultVersion} created`} actions={<ReviewVersionButton version={run.resultVersion} />}>
        Proposed by the AI agent in {run.iterations} turn{run.iterations === 1 ? '' : 's'} and re-validated by the server. It is a draft: review the
        mappings, answer the clarifications and approve it before any dry run.
      </Banner>
    );
  }
  if (run.status === 'failed' || run.status === 'interrupted') {
    return (
      <AgentFailurePanel
        title={`Agent run #${run.id} ${run.status === 'interrupted' ? 'was interrupted' : 'failed'}: no plan was created`}
        code={run.errorCode ?? (run.status === 'interrupted' ? 'INTERRUPTED' : 'UNKNOWN')}
        message={run.error}
      />
    );
  }
  if (stalled) {
    return (
      <AgentFailurePanel
        title={`No result after ${CLIENT_CAP_MS / 1000} s`}
        code="CLIENT_TIMEOUT"
        message={null}
        actions={
          <Button loading={checking} onClick={onCheckAgain}>
            Check again
          </Button>
        }
      />
    );
  }
  return (
    <Banner tone="info" title={run.status === 'queued' ? 'Queued: the agent is about to start' : 'The agent is working…'}>
      Each model turn and tool call appears in the trace below as it happens. The server stops the run if it exceeds its time budget.
    </Banner>
  );
}
