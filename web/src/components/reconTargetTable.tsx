// Paged browser over the live target table, with per-row lineage (pre-existing vs loaded by which run).
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type MigrationInfo } from '../api.ts';
import { useNav } from '../nav.tsx';
import { AsyncPanel, Badge, Button, Card, EmptyState, Pager, cx, fmt, table } from './ui.tsx';

const PAGE = 50;
const INTERNAL = new Set(['id', '_load_run_id', 'loaded_from', 'loaded_by_workspace']);

type Field = MigrationInfo['target']['fields'][number];
type Row = Record<string, unknown>;

export function ReconTargetTable() {
  const nav = useNav();
  const [offset, setOffset] = useState(0);
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  const accounts = useQuery({
    queryKey: ['targetAccounts', offset],
    queryFn: () => api.targetAccounts({ offset, limit: PAGE }),
    placeholderData: keepPreviousData,
  });
  const total = accounts.data?.total ?? 0;

  // A rollback can shrink the table under the current page: fall back to the first page.
  useEffect(() => {
    if (offset > 0 && accounts.data && offset >= accounts.data.total) setOffset(0);
  }, [offset, accounts.data]);

  const pager = accounts.data && <Pager offset={offset} limit={PAGE} total={total} onChange={setOffset} />;
  return (
    <Card
      title={`Target table · ${info.data?.target.name ?? 'accounts'}`}
      subtitle="Live rows. Lineage shows whether a row pre-dates the migration or which run loaded it (and from which source record)."
      actions={pager}
    >
      <AsyncPanel
        query={accounts}
        lines={6}
        isEmpty={(d) => d.total === 0}
        empty={
          <EmptyState
            title="The target table is empty"
            description="Rows appear here once an approved plan version is executed."
            action={<Button onClick={() => nav.go('execute')}>Go to Execute</Button>}
          />
        }
      >
        {(d) => (
          <div className={cx('space-y-2', accounts.isPlaceholderData && 'opacity-60')} aria-busy={accounts.isFetching || undefined}>
            <TargetRows items={d.items} fields={info.data?.target.fields ?? null} currentWorkspace={info.data?.workspace.id ?? null} />
            <div className="flex justify-end">{pager}</div>
          </div>
        )}
      </AsyncPanel>
    </Card>
  );
}

function TargetRows({ items, fields, currentWorkspace }: { items: Row[]; fields: Field[] | null; currentWorkspace: number | null }) {
  // Prefer the schema's column order; fall back to the row's own keys while /api/migration is still loading.
  const columns: { name: string; type: Field['type'] | null }[] = fields
    ? fields.map((f) => ({ name: f.name, type: f.type }))
    : Object.keys(items[0] ?? {})
        .filter((k) => !INTERNAL.has(k))
        .map((name) => ({ name, type: null }));
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} scope="col" className={cx(table.th, 'whitespace-nowrap')}>
                {c.name}
              </th>
            ))}
            <th scope="col" className={table.th}>
              Lineage
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((row) => (
            <tr key={String(row.id)} className={table.tr}>
              {columns.map((c) => (
                <td key={c.name} className={cx(table.td, 'whitespace-nowrap text-xs')}>
                  <Cell value={row[c.name]} name={c.name} type={c.type} />
                </td>
              ))}
              <td className={cx(table.td, 'whitespace-nowrap text-xs')}>
                <Lineage row={row} currentWorkspace={currentWorkspace} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ value, name, type }: { value: unknown; name: string; type: Field['type'] | null }) {
  if (value === null || value === undefined) return <span className="text-slate-400">∅</span>;
  if (type === 'boolean') return <>{value === 1 || value === true ? 'true' : 'false'}</>;
  if (type === 'integer' && name.endsWith('_cents') && typeof value === 'number') {
    return (
      <span className="tabular-nums" title={`${value} cents`}>
        {fmt.cents(value)}
      </span>
    );
  }
  return <span className={type === 'integer' ? 'tabular-nums' : undefined}>{fmt.value(value)}</span>;
}

function Lineage({ row, currentWorkspace }: { row: Row; currentWorkspace: number | null }) {
  const runId = row._load_run_id;
  if (runId === null || runId === undefined) return <Badge>pre-existing</Badge>;
  const from = typeof row.loaded_from === 'string' ? row.loaded_from : null;
  const ws = typeof row.loaded_by_workspace === 'number' ? row.loaded_by_workspace : null;
  if (!from) {
    return (
      <Badge tone="amber" title="This row carries a load run id but has no active ledger entry">
        run #{String(runId)} · no active ledger entry
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="blue">loaded by run #{String(runId)}</Badge>
      <span className="font-mono text-slate-500" title="Source record key">
        from {from}
      </span>
      {ws !== null && ws !== currentWorkspace && <Badge tone="violet">workspace #{ws}</Badge>}
    </span>
  );
}
