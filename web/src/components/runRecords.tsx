// Per-record outcomes of a run with their field-level evidence (long format: one row per error).
// Used for the dry-run quarantine and for an execution's load records.
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type Evidence, type RunRecord } from '../api.ts';
import { AsyncPanel, Badge, EmptyState, Pager, cx, fmt, type Tone } from './ui.tsx';
import { OUTCOME_TONE, OutcomeBadge } from './runCommon.tsx';

const PAGE = 25;

const CODE_TONE: Record<string, Tone> = {
  TRANSFORM_FAILED: 'red',
  MISSING_REQUIRED: 'red',
  TYPE_MISMATCH: 'red',
  LOAD_CONSTRAINT: 'red',
  AMBIGUOUS_DATE: 'amber',
  ENUM_VIOLATION: 'amber',
  PATTERN_VIOLATION: 'amber',
  MAX_LENGTH: 'amber',
  DUPLICATE_TARGET_KEY: 'violet',
  TARGET_CONFLICT: 'violet',
};
export function CodeBadge({ code }: { code: string }) {
  return <Badge tone={CODE_TONE[code] ?? 'neutral'}>{code}</Badge>;
}

/** A raw source value with empty / null / whitespace made visible (they are often the reason a record failed). */
export function RawValue({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-slate-400" title="null">∅</span>;
  if (value === '') return <span className="text-slate-400" title="empty string">""</span>;
  return <span className="whitespace-pre-wrap break-all">"{value}"</span>;
}

export type OutcomeOption = { value: string; label: string; count?: number };

export function RunRecordsPanel({
  runId,
  options,
  initial,
  emptyHint,
}: {
  runId: number;
  options: OutcomeOption[];
  initial: string;
  emptyHint?: (outcome: string) => string;
}) {
  const [outcome, setOutcome] = useState(initial);
  const [offset, setOffset] = useState(0);
  const records = useQuery({
    queryKey: ['runRecords', runId, outcome, offset],
    queryFn: () => api.runRecords(runId, { outcome, offset, limit: PAGE }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Filter by outcome" className="inline-flex flex-wrap gap-1 rounded-md bg-slate-100 p-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={outcome === o.value}
              onClick={() => {
                setOutcome(o.value);
                setOffset(0);
              }}
              className={cx(
                'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium',
                outcome === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
              )}
            >
              <span className={cx('h-2 w-2 rounded-full', DOT[OUTCOME_TONE[o.value] ?? 'neutral'])} aria-hidden />
              {o.label}
              {o.count !== undefined && <span className="tabular-nums text-slate-500">{o.count}</span>}
            </button>
          ))}
        </div>
        {records.data && <Pager offset={offset} limit={PAGE} total={records.data.total} onChange={setOffset} />}
      </div>
      <AsyncPanel
        query={records}
        lines={6}
        isEmpty={(d) => d.total === 0}
        empty={<EmptyState title={`No ${outcome} records in run #${runId}`} description={emptyHint?.(outcome)} />}
      >
        {(d) => (
          <div className={cx(records.isPlaceholderData && 'opacity-60')} aria-busy={records.isFetching || undefined}>
            <RecordsTable items={d.items} />
          </div>
        )}
      </AsyncPanel>
    </div>
  );
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-slate-400',
  green: 'bg-emerald-500',
  red: 'bg-rose-500',
  amber: 'bg-amber-500',
  blue: 'bg-sky-500',
  violet: 'bg-violet-500',
};

const th = 'bg-slate-50 px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500';
const td = 'px-2.5 py-1.5 align-top text-xs text-slate-700';

/** One <tbody> per record: a header row (key, outcome, raw source values), then one row per evidence item. */
function RecordsTable({ items }: { items: RunRecord[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className={th}>Stage</th>
            <th scope="col" className={th}>Target field</th>
            <th scope="col" className={th}>Source field = raw value</th>
            <th scope="col" className={th}>Step · op</th>
            <th scope="col" className={th}>Code</th>
            <th scope="col" className={cx(th, 'min-w-[16rem]')}>Message</th>
          </tr>
        </thead>
        {items.map((r) => (
          <RecordGroup key={r.sourceKey} record={r} />
        ))}
      </table>
    </div>
  );
}

function RecordGroup({ record }: { record: RunRecord }) {
  const involved = new Set(record.errors.flatMap((e) => e.sourceFields));
  return (
    <tbody className="border-t-2 border-slate-200">
      <tr className="bg-slate-50/70">
        <th scope="rowgroup" colSpan={6} className="px-2.5 py-2 text-left font-normal">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-slate-900">{record.sourceKey}</span>
            <OutcomeBadge outcome={record.outcome} />
            {record.errors.length > 0 && (
              <span className="text-xs text-slate-500">
                {record.errors.length} issue{record.errors.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <dl className="mt-1.5 flex flex-wrap gap-1 font-mono text-[11px]" aria-label="Raw source values">
            {Object.entries(record.raw).map(([field, value]) => (
              <div
                key={field}
                className={cx('flex gap-1 rounded px-1.5 py-0.5', involved.has(field) ? 'bg-amber-100 ring-1 ring-amber-300' : 'bg-white ring-1 ring-slate-200')}
              >
                <dt className="text-slate-500">{field}</dt>
                <dd className="text-slate-800">
                  <RawValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
          {record.transformed && record.errors.length > 0 && (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-800">Transformed row</summary>
              <TransformedRow row={record.transformed} />
            </details>
          )}
        </th>
      </tr>
      {record.errors.length === 0 ? (
        <tr>
          <td colSpan={6} className={td}>
            <span className="text-emerald-700">No issues.</span>{' '}
            {record.transformed && <span className="text-slate-500">Target row:</span>}
            {record.transformed && <TransformedRow row={record.transformed} />}
          </td>
        </tr>
      ) : (
        record.errors.map((e, i) => <EvidenceRow key={i} e={e} />)
      )}
    </tbody>
  );
}

function EvidenceRow({ e }: { e: Evidence }) {
  return (
    <tr className="border-t border-slate-100">
      <td className={td}>
        <span className="text-slate-500">{e.stage}</span>
      </td>
      <td className={cx(td, 'font-mono font-medium text-slate-900')}>{e.targetField ?? '—'}</td>
      <td className={cx(td, 'font-mono')}>
        {e.sourceFields.length === 0 ? (
          <span className="text-slate-400">—</span>
        ) : (
          <ul className="space-y-0.5">
            {e.sourceFields.map((f) => (
              <li key={f}>
                <span className="text-slate-500">{f}</span> = <RawValue value={e.rawValues[f]} />
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={cx(td, 'whitespace-nowrap font-mono')}>
        {e.op ? (
          <span title={e.stepIndex === null ? undefined : `Step index ${e.stepIndex} (0-based) in the mapping's chain`}>
            {e.stepIndex !== null && <span className="text-slate-500">step {e.stepIndex + 1} · </span>}
            {e.op}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className={td}>
        <CodeBadge code={e.code} />
      </td>
      <td className={td}>
        <p>{e.message}</p>
        {e.siblings && e.siblings.length > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-slate-500">Shares the key with</span>
            {e.siblings.map((s) => (
              <span key={s} className="rounded bg-violet-50 px-1 font-mono text-violet-700 ring-1 ring-violet-200">
                {s}
              </span>
            ))}
          </p>
        )}
      </td>
    </tr>
  );
}

function TransformedRow({ row }: { row: Record<string, unknown> }) {
  return (
    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {Object.entries(row).map(([k, v]) => (
        <span key={k}>
          <span className="text-slate-500">{k}</span>=<span className="text-slate-800">{fmt.value(v)}</span>
        </span>
      ))}
    </span>
  );
}
