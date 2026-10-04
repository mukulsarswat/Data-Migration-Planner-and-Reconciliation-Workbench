// Execute-step panels: gate pre-checks, the runs table (with retry) and the selected run's detail.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Run, type VersionSummary } from '../api.ts';
import { useNav, type StepId } from '../nav.tsx';
import { Badge, Banner, Button, CountTile, EmptyState, cx, fmt } from './ui.tsx';
import { IdentityList, RunStatusBadge, Section, dryRunCountsOf, executeCountsOf, hasCounts, pctOf } from './runCommon.tsx';
import { RunRecordsPanel } from './runRecords.tsx';

// ---------------------------------------------------------------- gate pre-checks

type GateState = 'pass' | 'fail' | 'unknown';
type Gate = { label: string; state: GateState; detail: ReactNode; action?: ReactNode };

/** Versions whose rows are still loaded: executions since the last rollback that inserted something. */
function loadedVersions(runs: Run[]): number[] {
  const lastRollback = runs.find((r) => r.kind === 'rollback' && r.status === 'succeeded');
  const since = lastRollback?.id ?? 0;
  const versions = runs
    .filter((r) => r.kind === 'execute' && r.id > since && r.version !== null && executeCountsOf(r).inserted > 0)
    .map((r) => r.version!);
  return [...new Set(versions)].sort((a, b) => a - b);
}

export function GateChecklist({ version, runs, activeLoadedRows }: { version: VersionSummary; runs: Run[]; activeLoadedRows: number | null }) {
  const nav = useNav();
  const plan = useQuery({ queryKey: ['plan', version.version], queryFn: () => api.plan(version.version) });
  const dryRun = runs.find((r) => r.kind === 'dry_run' && r.status === 'succeeded' && r.planHash === version.planHash) ?? null;
  const budget = plan.data?.plan.errorBudgetPct ?? null;
  const rate = dryRun ? pctOf(dryRunCountsOf(dryRun).rejected, dryRunCountsOf(dryRun).source) : null;
  const loaded = activeLoadedRows === 0 ? [] : loadedVersions(runs);
  const others = loaded.filter((x) => x !== version.version);
  const running = runs.find((r) => r.status === 'running' && r.kind !== 'dry_run');
  const link = (label: string, step: StepId) => (
    <Button size="sm" variant="ghost" onClick={() => nav.go(step)}>
      {label} →
    </Button>
  );

  const gates: Gate[] = [
    {
      label: 'Plan version approved',
      state: version.approval?.decision === 'approved' ? 'pass' : 'fail',
      detail: version.approval ? `${version.approval.decision} by ${version.approval.reviewer} · hash ${fmt.hash(version.planHash)}` : 'Not reviewed yet',
    },
    {
      label: 'Dry run for this plan hash',
      state: dryRun ? 'pass' : 'fail',
      detail: dryRun ? `Dry run #${dryRun.id} · result ${fmt.hash(dryRun.resultHash)}` : `No dry run of v${version.version}'s exact plan yet`,
      action: dryRun ? undefined : link('Run a dry run', 'dryrun'),
    },
    {
      label: 'Reject rate within the error budget',
      state: rate === null || budget === null ? 'unknown' : rate <= budget ? 'pass' : 'fail',
      detail:
        rate === null
          ? 'Needs a dry run'
          : budget === null
            ? plan.isError
              ? 'Cannot load the plan budget'
              : 'Loading budget…'
            : `${fmt.pct(rate)} ${rate <= budget ? '≤' : '>'} ${budget}% budget`,
      action: rate !== null && budget !== null && rate > budget ? link('Fix mappings', 'review') : undefined,
    },
    {
      label: 'No other version loaded',
      state: activeLoadedRows === null ? 'unknown' : others.length ? 'fail' : 'pass',
      detail: others.length
        ? `Rows from ${others.map((x) => `v${x}`).join(', ')} are active: roll back first`
        : loaded.includes(version.version)
          ? `v${version.version} is already loaded: re-executing skips its rows (idempotent)`
          : 'Target has no rows from this workspace',
      action: others.length ? link('Roll back', 'reconcile') : undefined,
    },
    {
      label: 'No run in progress',
      state: running ? 'fail' : 'pass',
      detail: running ? `Run #${running.id} (${running.kind}) is still running` : 'Run lock is free',
    },
  ];

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
        {gates.map((g) => (
          <li key={g.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <GateIcon state={g.state} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900">{g.label}</p>
              <p className={cx('text-xs', g.state === 'fail' ? 'text-rose-700' : 'text-slate-500')}>{g.detail}</p>
            </div>
            {g.action}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">Pre-checks from the current state. The server re-checks every gate atomically when you execute.</p>
    </div>
  );
}

function GateIcon({ state }: { state: GateState }) {
  const s = {
    pass: { cls: 'bg-emerald-100 text-emerald-700', ch: '✓', label: 'passes' },
    fail: { cls: 'bg-rose-100 text-rose-700', ch: '✗', label: 'blocks execution' },
    unknown: { cls: 'bg-slate-100 text-slate-500', ch: '?', label: 'not known yet' },
  }[state];
  return (
    <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold', s.cls)} role="img" aria-label={s.label}>
      {s.ch}
    </span>
  );
}

// ---------------------------------------------------------------- run outcome banner

/** Execute/retry return 201 even when the run itself failed (e.g. simulated fault), so the banner follows run.status. */
export function RunOutcomeBanner({ run, what }: { run: Run; what: string }) {
  const c = executeCountsOf(run);
  if (run.status === 'succeeded') {
    return (
      <Banner tone="success" title={`${what}: run #${run.id} of v${run.version} succeeded`}>
        {c.inserted} inserted · {c.skippedExisting} skipped_existing · {c.conflict} conflict · {c.loadRejected} load_rejected of {c.accepted} accepted records.
      </Banner>
    );
  }
  return (
    <Banner tone="warning" title={`${what}: run #${run.id} stopped (${run.errorCode ?? run.status})`}>
      {run.error && <p>{run.error}</p>}
      <p>
        {c.processed} of {c.accepted} accepted records were committed; {c.pending} are pending. Use Retry in the runs table to resume: rows that are
        already loaded are skipped, never duplicated.
      </p>
    </Banner>
  );
}

// ---------------------------------------------------------------- runs table

const th = 'bg-slate-50 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap';
const td = 'px-2 py-1.5 align-top text-xs text-slate-700';
const COUNT_COLS = [
  ['accepted', 'Accepted'],
  ['processed', 'Processed'],
  ['inserted', 'Inserted'],
  ['skippedExisting', 'Skipped existing'],
  ['conflict', 'Conflict'],
  ['loadRejected', 'Load rejected'],
  ['pending', 'Pending'],
] as const;

/** Mirrors the server's retry gate: failed/interrupted execution, not yet retried, and not rolled back since. */
export const canRetry = (r: Run, runs: readonly Run[] = []) =>
  r.kind === 'execute' &&
  (r.status === 'failed' || r.status === 'interrupted') &&
  r.retriedBy === null &&
  !runs.some((x) => x.kind === 'rollback' && x.status === 'succeeded' && x.id > r.id);

export function RunsTable({
  runs,
  selectedId,
  onSelect,
  onRetry,
  retryingId,
  retryBusy,
}: {
  runs: Run[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRetry: (id: number) => void;
  retryingId: number | null;
  retryBusy: boolean;
}) {
  if (runs.length === 0) {
    return <EmptyState title="No executions yet" description="Execute the approved version above; each attempt, retry and rollback appears here." />;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200">
        <thead>
          <tr>
            <th scope="col" className={th}>Run</th>
            <th scope="col" className={th}>Kind</th>
            <th scope="col" className={th}>Ver.</th>
            <th scope="col" className={th}>Attempt</th>
            <th scope="col" className={th}>Status</th>
            {COUNT_COLS.map(([k, label]) => (
              <th key={k} scope="col" className={cx(th, 'text-right')}>
                {label}
              </th>
            ))}
            <th scope="col" className={th}>Error</th>
            <th scope="col" className={th}>Started</th>
            <th scope="col" className={th}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((r) => {
            const selected = r.id === selectedId;
            const c = executeCountsOf(r);
            const failAfter = typeof r.options.failAfter === 'number' ? r.options.failAfter : null;
            return (
              <tr key={r.id} className={cx(selected ? 'bg-indigo-50/70' : 'hover:bg-slate-50')}>
                <td className={cx(td, 'font-mono font-semibold text-slate-900')}>#{r.id}</td>
                <td className={td}>
                  <span className="whitespace-nowrap">{r.kind}</span>
                  {failAfter !== null && (
                    <div className="mt-0.5">
                      <Badge tone="amber" title="Fault injection demo">fail after {failAfter}</Badge>
                    </div>
                  )}
                </td>
                <td className={td}>{r.version !== null ? `v${r.version}` : '—'}</td>
                <td className={cx(td, 'whitespace-nowrap')}>
                  {r.kind === 'execute' ? r.attempt : '—'}
                  {r.parentRunId !== null && <div className="text-slate-500">retry of #{r.parentRunId}</div>}
                </td>
                <td className={td}>
                  <RunStatusBadge status={r.status} />
                  {r.retriedBy !== null && <div className="mt-0.5 whitespace-nowrap text-slate-500">retried by #{r.retriedBy}</div>}
                </td>
                {r.kind === 'rollback' ? (
                  <td colSpan={COUNT_COLS.length} className={cx(td, 'text-slate-600')}>
                    {hasCounts(r) ? `Deleted ${Number(r.counts.deleted ?? 0)} target rows (${Number(r.counts.ledgerRows ?? 0)} ledger rows)` : '—'}
                  </td>
                ) : (
                  COUNT_COLS.map(([k]) => (
                    <td key={k} className={cx(td, 'text-right tabular-nums', c[k] === 0 && 'text-slate-400', k === 'pending' && c[k] > 0 && 'font-semibold text-amber-700')}>
                      {hasCounts(r) ? c[k] : '—'}
                    </td>
                  ))
                )}
                <td className={cx(td, 'font-mono')} title={r.error ?? undefined}>
                  {r.errorCode ?? <span className="text-slate-400">—</span>}
                </td>
                <td className={cx(td, 'whitespace-nowrap text-slate-500')}>{fmt.time(r.startedAt)}</td>
                <td className={cx(td, 'whitespace-nowrap text-right')}>
                  <div className="flex justify-end gap-1">
                    {canRetry(r, runs) && (
                      <Button size="sm" variant="primary" loading={retryingId === r.id} disabled={retryBusy} onClick={() => onRetry(r.id)}>
                        Retry
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" aria-pressed={selected} onClick={() => onSelect(r.id)}>
                      {selected ? 'Viewing' : 'Details'}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- run detail

export function RunDetail({ run, runs = [] }: { run: Run; runs?: readonly Run[] }) {
  if (run.kind === 'rollback') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CountTile label="Target rows deleted" value={Number(run.counts.deleted ?? 0)} tone="amber" />
          <CountTile label="Ledger rows closed" value={Number(run.counts.ledgerRows ?? 0)} />
        </div>
        <p className="text-xs text-slate-500">A rollback deletes exactly the rows in this workspace's active load ledger; it has no per-record outcomes.</p>
      </div>
    );
  }
  if (run.status === 'running' || !hasCounts(run)) {
    return <EmptyState title={`Run #${run.id} is still running`} description="Counts and load records appear when it finishes." />;
  }
  const c = executeCountsOf(run);
  const initial = c.conflict > 0 ? 'conflict' : c.loadRejected > 0 ? 'load_rejected' : c.inserted > 0 ? 'inserted' : 'skipped_existing';
  return (
    <div className="space-y-5">
      {run.error && (
        <Banner tone={run.errorCode === 'FAULT_INJECTED' ? 'warning' : 'error'} title={`${run.errorCode ?? 'Error'}: ${run.error}`}>
          {canRetry(run, runs)
            ? 'Committed batches stay loaded. Retry resumes from the ledger.'
            : run.retriedBy !== null
              ? `Retried by run #${run.retriedBy}.`
              : runs.some((x) => x.kind === 'rollback' && x.id > run.id)
                ? 'Its rows were rolled back afterwards; start a new execution instead of retrying.'
                : null}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <CountTile label="Accepted" value={c.accepted} hint="from the dry run" />
        <CountTile label="Processed" value={c.processed} tone="blue" />
        <CountTile label="Inserted" value={c.inserted} tone="green" />
        <CountTile label="Skipped existing" value={c.skippedExisting} hint="already in ledger" />
        <CountTile label="Conflict" value={c.conflict} tone={c.conflict ? 'violet' : 'neutral'} hint="TARGET_CONFLICT" />
        <CountTile label="Load rejected" value={c.loadRejected} tone={c.loadRejected ? 'red' : 'neutral'} hint="LOAD_CONSTRAINT" />
        <CountTile label="Pending" value={c.pending} tone={c.pending ? 'amber' : 'neutral'} hint="not reached" />
      </div>
      <Section title="Load partition">
        <IdentityList
          items={[
            { lhs: ['accepted', c.accepted], rhs: [['processed', c.processed], ['pending', c.pending]] },
            {
              lhs: ['processed', c.processed],
              rhs: [['inserted', c.inserted], ['skipped_existing', c.skippedExisting], ['conflict', c.conflict], ['load_rejected', c.loadRejected]],
            },
          ]}
        />
      </Section>
      <Section title="Load records" hint="Per-record load outcome with evidence. Pending records were never reached, so they have no row here.">
        <RunRecordsPanel
          key={run.id}
          runId={run.id}
          initial={initial}
          options={[
            { value: 'inserted', label: 'inserted', count: c.inserted },
            { value: 'skipped_existing', label: 'skipped_existing', count: c.skippedExisting },
            { value: 'conflict', label: 'conflict', count: c.conflict },
            { value: 'load_rejected', label: 'load_rejected', count: c.loadRejected },
          ]}
        />
      </Section>
    </div>
  );
}
