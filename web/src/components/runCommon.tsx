// Shared bits for the Dry run and Execute steps: version picker, run/outcome badges, typed views of Run.counts,
// and a pass/fail identity list used to show that the record partitions add up.
import type { ReactNode } from 'react';
import type { DryRunCounts, ExecuteCounts, Run, VersionSummary } from '../api.ts';
import { Badge, cx, type Tone } from './ui.tsx';

/** Same rounding as the server (one decimal), so the UI never disagrees with a gate message. */
export const pctOf = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Run.counts is untyped JSON; a stored dry run holds DryRunCounts plus the preflight conflict count. */
export function dryRunCountsOf(run: Run): DryRunCounts & { conflictPreflight: number } {
  const c = run.counts as unknown as Partial<DryRunCounts> & { conflictPreflight?: number };
  return {
    source: num(c.source),
    transformed: num(c.transformed),
    accepted: num(c.accepted),
    rejected: num(c.rejected),
    transformFailed: num(c.transformFailed),
    validationRejected: num(c.validationRejected),
    byCode: c.byCode ?? {},
    byField: c.byField ?? {},
    conflictPreflight: num(c.conflictPreflight),
  };
}

export function executeCountsOf(run: Run): ExecuteCounts {
  const c = run.counts as Partial<ExecuteCounts>;
  return {
    accepted: num(c.accepted),
    processed: num(c.processed),
    inserted: num(c.inserted),
    skippedExisting: num(c.skippedExisting),
    conflict: num(c.conflict),
    loadRejected: num(c.loadRejected),
    pending: num(c.pending),
  };
}

export const hasCounts = (run: Run) => Object.keys(run.counts).length > 0;

const STATUS_TONE: Record<Run['status'], Tone> = { running: 'blue', succeeded: 'green', failed: 'red', interrupted: 'amber' };
export function RunStatusBadge({ status }: { status: Run['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

export const OUTCOME_TONE: Record<string, Tone> = {
  accepted: 'green',
  transform_failed: 'red',
  validation_rejected: 'amber',
  inserted: 'green',
  skipped_existing: 'blue',
  conflict: 'violet',
  load_rejected: 'red',
};
export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={OUTCOME_TONE[outcome] ?? 'neutral'}>{outcome}</Badge>;
}

export function versionLabel(v: VersionSummary): string {
  const decision = v.approval ? v.approval.decision : 'awaiting review';
  return `v${v.version} · ${v.author} · ${decision}`;
}

export function VersionSelect({
  id,
  versions,
  value,
  onChange,
  label = 'Plan version',
}: {
  id: string;
  versions: VersionSummary[];
  value: number;
  onChange: (v: number) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-slate-600">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
      >
        {versions.map((v) => (
          <option key={v.version} value={v.version}>
            {versionLabel(v)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One line per identity, e.g. "source 200 = transform_failed 12 + transformed 188 ✓". */
export function IdentityList({ items }: { items: { lhs: [string, number]; rhs: [string, number][] }[] }) {
  return (
    <ul className="space-y-1 font-mono text-xs">
      {items.map(({ lhs, rhs }) => {
        const holds = lhs[1] === rhs.reduce((sum, [, n]) => sum + n, 0);
        return (
          <li key={lhs[0]} className={cx('flex flex-wrap items-baseline gap-x-1.5', holds ? 'text-slate-700' : 'text-rose-700')}>
            <Term name={lhs[0]} n={lhs[1]} />
            <span>=</span>
            {rhs.map(([name, n], i) => (
              <span key={name} className="flex items-baseline gap-x-1.5">
                {i > 0 && <span>+</span>}
                <Term name={name} n={n} />
              </span>
            ))}
            <span
              className={cx('ml-1 font-sans font-semibold', holds ? 'text-emerald-600' : 'text-rose-600')}
              aria-label={holds ? 'holds' : 'does not hold'}
            >
              {holds ? '✓' : '✗'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Term({ name, n }: { name: string; n: number }) {
  return (
    <span>
      <span className="text-slate-500">{name}</span> <strong className="tabular-nums text-slate-900">{n}</strong>
    </span>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
