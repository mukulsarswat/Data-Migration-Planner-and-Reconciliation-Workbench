// Sample-records browser: raw legacy rows exactly as exported, searchable and paged server-side.
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type MigrationInfo } from '../api.ts';
import { AsyncPanel, Badge, Button, Card, EmptyState, Pager, cx, table } from './ui.tsx';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_CELL_CHARS = 40;

export function SampleRecordsCard({ source }: { source: MigrationInfo['source'] }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const next = draft.trim();
    if (next === q) return;
    const t = setTimeout(() => {
      setQ(next);
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, q]);

  const records = useQuery({
    queryKey: ['sourceRecords', offset, q],
    queryFn: () => api.sourceRecords({ offset, limit: PAGE_SIZE, q }),
    placeholderData: keepPreviousData,
  });

  const clear = () => {
    setDraft('');
    setQ('');
    setOffset(0);
  };

  return (
    <Card
      title="Sample records"
      subtitle="Raw values exactly as exported (untrimmed). Leading/trailing whitespace is shown as ␣; empty strings as “empty”."
      actions={
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Search
          <input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={80}
            placeholder="row id or any value"
            className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
      }
    >
      <AsyncPanel
        query={records}
        lines={6}
        isEmpty={(d) => d.items.length === 0}
        empty={
          q ? (
            <EmptyState title={`No records match “${q}”`} description="Search matches the row id or any raw value (case-insensitive)." action={<Button onClick={clear}>Clear search</Button>} />
          ) : (
            <EmptyState title="The source extract is empty" description="Reset the local database (npm run db:reset) to reload the bundled dataset." />
          )
        }
      >
        {(d) => (
          <div className={cx('space-y-2', records.isPlaceholderData && 'opacity-60')} aria-busy={records.isFetching || undefined}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">
                {q ? (
                  <>
                    {d.total} matching “{q}”
                  </>
                ) : (
                  <>{d.total} records</>
                )}
              </p>
              <Pager offset={offset} limit={PAGE_SIZE} total={d.total} onChange={setOffset} />
            </div>
            <div className={cx(table.wrap, 'max-h-[36rem] overflow-y-auto')}>
              <table className={table.table}>
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th scope="col" className={table.th}>Row</th>
                    {source.fields.map((f) => (
                      <th key={f.name} scope="col" className={cx(table.th, 'whitespace-nowrap normal-case')}>
                        <span className="font-mono">{f.name}</span>
                        {f.pii && (
                          <span className="ml-1">
                            <Badge tone="amber">PII</Badge>
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.items.map((r) => (
                    <tr key={r.sourceKey} className={table.tr}>
                      <td className={cx(table.td, 'font-mono text-xs text-slate-500')}>{r.sourceKey}</td>
                      {source.fields.map((f) => (
                        <td key={f.name} className={cx(table.td, 'whitespace-nowrap py-1.5')}>
                          <RawValue value={r.values[f.name]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AsyncPanel>
    </Card>
  );
}

/** Renders a raw cell so that whitespace problems and empties are visible instead of silently collapsed. */
function RawValue({ value }: { value: string | undefined }) {
  if (value === undefined) return <span className="text-xs text-slate-300">—</span>;
  if (value === '') return <span className="text-xs italic text-slate-400">empty</span>;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
  const [lead, core, trail] = m ? [m[1] ?? '', m[2] ?? '', m[3] ?? ''] : ['', value, ''];
  const shown = core.length > MAX_CELL_CHARS ? `${core.slice(0, MAX_CELL_CHARS)}…` : core;
  return (
    <span title={JSON.stringify(value)} className="font-mono text-xs text-slate-800">
      {lead && <Ws n={lead.length} />}
      {shown}
      {trail && <Ws n={trail.length} />}
    </span>
  );
}

function Ws({ n }: { n: number }) {
  return (
    <span className="rounded bg-amber-100 text-amber-700" aria-label={`${n} whitespace character${n === 1 ? '' : 's'}`}>
      {'␣'.repeat(n)}
    </span>
  );
}
