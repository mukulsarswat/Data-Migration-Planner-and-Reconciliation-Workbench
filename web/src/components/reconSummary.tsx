// Reconciliation numbers: source-vs-target totals, the balance equations, the money check and per-key status counts.
import type { Reconciliation } from '../api.ts';
import { Badge, Card, CountTile, cx, fmt, type Tone } from './ui.tsx';

export const STATUS_ORDER = ['perfect match', 'missing from target', 'values do not match', 'extra in target', 'conflict', 'load rejected', 'pending'] as const;

export function statusTone(status: string): Tone {
  if (status === 'perfect match') return 'green';
  if (status === 'conflict' || status === 'load rejected') return 'amber';
  if (status === 'pending') return 'blue';
  return 'red';
}

const num = (n: number) => n.toLocaleString();

export function ReconTotals({ r }: { r: Reconciliation }) {
  const t = r.totals;
  // Before the first execution only the source/target counts are meaningful; the rest would read as a misleading 0.
  const executed = r.verdict !== 'NOT_EXECUTED';
  const val = (n: number) => (executed ? num(n) : '—');
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      <CountTile label="Source" value={num(t.source)} hint="legacy records" />
      <CountTile label="Accepted" value={val(t.accepted)} tone={executed ? 'green' : 'neutral'} hint="passed dry run" />
      <CountTile label="Rejected" value={val(t.rejected)} tone={executed && t.rejected > 0 ? 'amber' : 'neutral'} hint="quarantined" />
      <CountTile
        label="Conflicts"
        value={val(t.conflicts)}
        tone={executed && t.conflicts > 0 ? 'amber' : 'neutral'}
        hint={executed && t.loadRejected > 0 ? `+ ${num(t.loadRejected)} load-rejected` : 'key already in target'}
      />
      <CountTile label="Loaded (active)" value={num(t.loadedActive)} tone="blue" hint="this workspace" />
      <CountTile label="Pending" value={val(t.pending)} tone={executed && t.pending > 0 ? 'amber' : 'neutral'} hint="accepted, not loaded" />
      <CountTile label="Target total" value={num(t.targetTotal)} hint="rows in target" />
      <CountTile label="Pre-existing" value={num(t.preExisting)} tone={r.preExistingIntact ? 'neutral' : 'red'} hint="not loaded by any run" />
    </div>
  );
}

export function ReconEquations({ r }: { r: Reconciliation }) {
  return (
    <Card title="Balance equations" subtitle="Recomputed from the current target and load ledger, not from run counters.">
      {r.equations.length === 0 ? (
        <p className="text-sm text-slate-500">Equations are computed once this workspace has executed a plan version.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {r.equations.map((eq) => (
            <li key={eq.name} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <span
                className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white', eq.holds ? 'bg-emerald-600' : 'bg-rose-600')}
                aria-hidden
              >
                {eq.holds ? '✓' : '✗'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">{eq.name}</p>
                <p className="font-mono text-xs break-words text-slate-600">{eq.expression}</p>
              </div>
              <Badge tone={eq.holds ? 'green' : 'red'}>{eq.holds ? 'holds' : 'does not hold'}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ReconMoneyCheck({ r }: { r: Reconciliation }) {
  const t = r.totals;
  const diff = t.actualBalanceCents - t.expectedBalanceCents;
  const executed = r.verdict !== 'NOT_EXECUTED';
  return (
    <Card title="Money check & integrity" subtitle="Sum of balance_cents the plan produces for the loaded keys vs the sum stored in those target rows.">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Expected</dt>
          <dd className="text-lg font-semibold tabular-nums text-slate-900" title={`${t.expectedBalanceCents} cents`}>
            {fmt.cents(t.expectedBalanceCents)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Loaded</dt>
          <dd className="text-lg font-semibold tabular-nums text-slate-900" title={`${t.actualBalanceCents} cents`}>
            {fmt.cents(t.actualBalanceCents)}
          </dd>
        </div>
      </dl>
      <p className={cx('mt-2 text-sm font-medium', !executed ? 'text-slate-500' : diff === 0 ? 'text-emerald-700' : 'text-rose-700')}>
        {!executed ? 'Nothing loaded yet.' : diff === 0 ? '✓ Balances agree to the cent' : `✗ Loaded balance is off by ${fmt.cents(diff)}`}
      </p>
      <div className={cx('mt-4 rounded-md border px-3 py-2 text-sm', r.preExistingIntact ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900')}>
        <p className="font-medium">{r.preExistingIntact ? '✓ Pre-existing rows intact' : '✗ Pre-existing rows changed'}</p>
        <p className="mt-0.5 text-xs opacity-90">
          {r.preExistingIntact
            ? `The ${num(t.preExisting)} rows that were in the target before any load still hash to the original snapshot.`
            : 'Rows that existed before the migration no longer match the original snapshot. Investigate before loading again.'}
        </p>
      </div>
    </Card>
  );
}

export function ReconStatusCounts({ counts }: { counts: Reconciliation['statusCounts'] }) {
  const entries = Object.entries(counts).sort(([a], [b]) => rank(a) - rank(b));
  if (entries.length === 0) return <p className="text-sm text-slate-500">No per-key statuses yet.</p>;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Per-key status counts">
      {entries.map(([status, n]) => (
        <li key={status}>
          <Badge tone={statusTone(status)}>
            {status}: <span className="ml-1 tabular-nums font-semibold">{num(n)}</span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function rank(status: string): number {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}
