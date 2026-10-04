// Read-only panels of a dry-run report: determinism, error budget, conflict preflight, rejects by code / by field.
import type { DryRunCounts } from '../api.ts';
import { Badge, cx, fmt, table } from './ui.tsx';
import { CodeBadge } from './runRecords.tsx';
import { Section } from './runCommon.tsx';

export function DeterminismPanel({
  resultHash,
  planHash,
  previousResultHash,
  match,
}: {
  resultHash: string | null;
  planHash: string | null;
  previousResultHash: string | null;
  match: boolean | null;
}) {
  return (
    <Section title="Determinism" hint="Same plan + same source ⇒ the same result hash, regardless of clock, timezone or row order.">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">result</span>
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-800" title={resultHash ?? undefined}>
          {fmt.hash(resultHash)}
        </code>
        <span className="text-slate-500">plan</span>
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-800" title={planHash ?? undefined}>
          {fmt.hash(planHash)}
        </code>
      </div>
      {match === null && <Badge tone="blue">first dry run of this plan hash</Badge>}
      {match === true && <Badge tone="green">✓ identical to previous dry run</Badge>}
      {match === false && (
        <div className="space-y-1">
          <Badge tone="red">DIFFERENT from previous dry run</Badge>
          <p className="text-xs text-rose-700">
            The previous dry run of this plan produced <code className="font-mono">{fmt.hash(previousResultHash)}</code>. The source data or engine
            changed between runs; investigate before executing.
          </p>
        </div>
      )}
    </Section>
  );
}

export function ErrorBudgetPanel({ rejectRatePct, budgetPct, rejected, source }: { rejectRatePct: number; budgetPct: number; rejected: number; source: number }) {
  const within = rejectRatePct <= budgetPct;
  return (
    <Section title="Error budget" hint="Share of source records that would be rejected, compared with the plan's error budget.">
      <div className="flex items-baseline gap-2">
        <span className={cx('text-2xl font-semibold tabular-nums', within ? 'text-emerald-700' : 'text-rose-700')}>{fmt.pct(rejectRatePct)}</span>
        <span className="text-sm text-slate-600">
          {within ? '≤' : '>'} budget {budgetPct}%
        </span>
        <span className="text-xs text-slate-500">
          ({rejected} of {source} rejected)
        </span>
      </div>
      <div
        className="relative h-2.5 rounded-full bg-slate-100"
        role="meter"
        aria-label="Reject rate"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rejectRatePct}
      >
        <div className={cx('h-full rounded-full', within ? 'bg-emerald-500' : 'bg-rose-500')} style={{ width: `${Math.min(100, rejectRatePct)}%` }} />
        <div className="absolute -top-1 h-4.5 w-0.5 bg-slate-800" style={{ left: `${budgetPct}%` }} title={`Budget ${budgetPct}%`} aria-hidden />
      </div>
      <p className={cx('text-xs', within ? 'text-emerald-800' : 'text-rose-800')}>
        {within
          ? 'Within budget: execution is allowed once this version is approved.'
          : 'Over budget: execution is blocked (ERROR_BUDGET_EXCEEDED). Fix the failing mappings or raise the budget in a new plan version.'}
      </p>
    </Section>
  );
}

export function ConflictPreflightPanel({ keys, count }: { keys: string[] | null; count: number }) {
  const shown = keys?.slice(0, 60) ?? [];
  return (
    <Section
      title="Conflict preflight"
      hint="Accepted keys that already exist in the target and were not loaded by this workspace. They will be TARGET_CONFLICT at load and skipped. Not part of the result hash."
    >
      {count === 0 ? (
        <p className="text-sm text-emerald-700">✓ No accepted key exists in the target yet.</p>
      ) : (
        <>
          <p className="text-sm">
            <strong className="tabular-nums text-violet-700">{count}</strong> key{count === 1 ? '' : 's'} will conflict at load.
          </p>
          {keys ? (
            <ul className="flex flex-wrap gap-1" aria-label="Conflicting keys">
              {shown.map((k) => (
                <li key={k} className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[11px] text-violet-800 ring-1 ring-violet-200">
                  {k}
                </li>
              ))}
              {keys.length > shown.length && <li className="text-xs text-slate-500">+{keys.length - shown.length} more</li>}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">This stored run keeps only the count; run the dry run again to list the keys.</p>
          )}
        </>
      )}
    </Section>
  );
}

export function ByCodeTable({ byCode }: { byCode: DryRunCounts['byCode'] }) {
  const rows = Object.entries(byCode)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, [, n]) => s + n, 0);
  return (
    <Section title="Rejects by error code" hint="Records per code. A record can carry several codes, so the counts can add up to more than the rejected total.">
      {rows.length === 0 ? (
        <p className="text-sm text-emerald-700">✓ No errors.</p>
      ) : (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col" className={table.th}>Code</th>
                <th scope="col" className={cx(table.th, 'text-right')}>Count</th>
                <th scope="col" className={cx(table.th, 'w-1/3')}>Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([code, n]) => (
                <tr key={code} className={table.tr}>
                  <td className={table.td}>
                    <CodeBadge code={code} />
                  </td>
                  <td className={cx(table.td, 'text-right tabular-nums')}>{n}</td>
                  <td className={table.td}>
                    <Bar parts={[{ n, cls: 'bg-rose-400' }]} total={total} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function ByFieldTable({ byField }: { byField: DryRunCounts['byField'] }) {
  const rows = Object.entries(byField);
  return (
    <Section title="Per target field" hint="valid = no error on this field (includes empty) · empty = null after transform · error = the field failed for that record.">
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col" className={table.th}>Field</th>
              <th scope="col" className={cx(table.th, 'text-right')}>Total</th>
              <th scope="col" className={cx(table.th, 'text-right')}>Valid</th>
              <th scope="col" className={cx(table.th, 'text-right')}>Error</th>
              <th scope="col" className={cx(table.th, 'text-right')}>Empty</th>
              <th scope="col" className={cx(table.th, 'w-1/4')}>Mix</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([field, c]) => (
              <tr key={field} className={table.tr}>
                <td className={cx(table.td, 'font-mono text-xs font-medium text-slate-900')}>{field}</td>
                <td className={cx(table.td, 'text-right tabular-nums')}>{c.total}</td>
                <td className={cx(table.td, 'text-right tabular-nums text-emerald-700')}>{c.valid}</td>
                <td className={cx(table.td, 'text-right tabular-nums', c.error > 0 ? 'font-semibold text-rose-700' : 'text-slate-400')}>{c.error}</td>
                <td className={cx(table.td, 'text-right tabular-nums', c.empty > 0 ? 'text-slate-700' : 'text-slate-400')}>{c.empty}</td>
                <td className={table.td}>
                  <Bar
                    total={c.total}
                    parts={[
                      { n: Math.max(0, c.valid - c.empty), cls: 'bg-emerald-400' },
                      { n: c.empty, cls: 'bg-slate-300' },
                      { n: c.error, cls: 'bg-rose-400' },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Bar({ parts, total }: { parts: { n: number; cls: string }[]; total: number }) {
  return (
    <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
      {parts.map((p, i) => (
        <div key={i} className={p.cls} style={{ width: `${total ? (p.n / total) * 100 : 0}%` }} />
      ))}
    </div>
  );
}
