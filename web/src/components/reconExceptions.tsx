// Per-key statuses plus the drill-down table of keys that are not a perfect match (the server caps it at 100).
import { useId, useState } from 'react';
import type { Reconciliation } from '../api.ts';
import { Badge, Card, cx, table } from './ui.tsx';
import { ReconStatusCounts, STATUS_ORDER, statusTone } from './reconSummary.tsx';

const SERVER_CAP = 100;

export function ReconExceptions({ r }: { r: Reconciliation }) {
  const [status, setStatus] = useState('');
  const filterId = useId();
  const present = [...new Set(r.exceptions.map((e) => e.status))].sort(
    (a, b) => (STATUS_ORDER as readonly string[]).indexOf(a) - (STATUS_ORDER as readonly string[]).indexOf(b),
  );
  const rows = status ? r.exceptions.filter((e) => e.status === status) : r.exceptions;
  const nonMatching = Object.entries(r.statusCounts).reduce((sum, [s, n]) => (s === 'perfect match' ? sum : sum + n), 0);

  return (
    <Card
      title="Per-key status & exceptions"
      subtitle="Every accepted key compared with the target by business-column row hash."
      actions={
        present.length > 1 && (
          <label htmlFor={filterId} className="flex items-center gap-2 text-xs text-slate-600">
            Status
            <select id={filterId} value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
              <option value="">All ({r.exceptions.length})</option>
              {present.map((s) => (
                <option key={s} value={s}>
                  {s} ({r.exceptions.filter((e) => e.status === s).length})
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      <div id="recon-exceptions" className="scroll-mt-4 space-y-3">
        <ReconStatusCounts counts={r.statusCounts} />
        {r.exceptions.length === 0 ? (
          <p className="text-sm text-emerald-700">✓ No exceptions: every accepted key is a perfect match.</p>
        ) : (
          <>
            {nonMatching > r.exceptions.length && (
              <p className="text-xs text-slate-500">
                Showing the first {Math.min(SERVER_CAP, r.exceptions.length)} of {nonMatching.toLocaleString()} non-matching keys.
              </p>
            )}
            <div className={cx(table.wrap, 'max-h-96 overflow-y-auto')}>
              <table className={table.table}>
                <caption className="sr-only">Keys that are not a perfect match</caption>
                <thead>
                  <tr>
                    <th scope="col" className={cx(table.th, 'sticky top-0')}>Source key</th>
                    <th scope="col" className={cx(table.th, 'sticky top-0')}>External ref</th>
                    <th scope="col" className={cx(table.th, 'sticky top-0')}>Status</th>
                    <th scope="col" className={cx(table.th, 'sticky top-0')}>Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((e) => (
                    <tr key={`${e.sourceKey}:${e.status}`} className={table.tr}>
                      <td className={cx(table.td, 'font-mono text-xs')}>{e.sourceKey}</td>
                      <td className={cx(table.td, 'font-mono text-xs')}>{e.externalRef ?? '—'}</td>
                      <td className={table.td}>
                        <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                      </td>
                      <td className={cx(table.td, 'text-xs')}>{e.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
