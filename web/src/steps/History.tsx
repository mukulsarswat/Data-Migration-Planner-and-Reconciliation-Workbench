// History: the append-only audit trail (plan versions, clarifications, approvals, dry runs, executions, retries,
// rollbacks, agent runs, workspaces), newest first, for this workspace or all of them.
import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type EventRow } from '../api.ts';
import { useNav } from '../nav.tsx';
import { AsyncPanel, Banner, Button, Card, EmptyState, cx } from '../components/ui.tsx';
import { EventItem } from '../components/historyEvent.tsx';

type Scope = 'current' | 'all';
const LIMIT = 200;

export function HistoryStep() {
  const nav = useNav();
  const [scope, setScope] = useState<Scope>('current');
  const [type, setType] = useState('');
  const events = useQuery({ queryKey: ['events', scope], queryFn: () => api.events({ scope, limit: LIMIT }) });
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  const workspaceNames = useMemo(() => new Map(info.data?.workspaces.map((w) => [w.id, w.name]) ?? []), [info.data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">History</h2>
          <p className="text-sm text-slate-500">Who did what, when, and to which plan version or run.</p>
        </div>
        <Button size="sm" onClick={() => void events.refetch()} loading={events.isFetching && !events.isPending}>
          Refresh
        </Button>
      </div>

      <Banner tone="info" title="Append-only audit trail">
        Database triggers block every UPDATE and DELETE on events, so entries can never be edited or removed. It covers plan versions and
        clarification answers, approvals and rejections, dry runs, executions and retries, rollbacks, agent runs and workspace changes.
      </Banner>

      <Card
        title="Timeline"
        subtitle={scope === 'current' ? `Events in ${info.data?.workspace.name ?? 'this workspace'}` : 'Events across every workspace'}
        actions={
          <>
            <ScopeToggle scope={scope} onChange={setScope} />
            {events.data && <TypeFilter items={events.data.items} value={type} onChange={setType} />}
          </>
        }
      >
        <AsyncPanel
          query={events}
          lines={6}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState
              title={scope === 'current' ? 'No history in this workspace yet' : 'No history yet'}
              description="Events appear as soon as you draft a plan, answer a clarification, approve, run or roll back."
              action={<Button onClick={() => nav.go('proposal')}>Go to Proposal</Button>}
            />
          }
        >
          {(d) => (
            <Timeline
              items={d.items}
              type={type}
              onClearType={() => setType('')}
              workspaceLabel={(id) => (scope === 'all' && id !== null ? (workspaceNames.get(id) ?? `workspace #${id}`) : null)}
            />
          )}
        </AsyncPanel>
      </Card>
    </div>
  );
}

function Timeline({
  items,
  type,
  onClearType,
  workspaceLabel,
}: {
  items: EventRow[];
  type: string;
  onClearType: () => void;
  workspaceLabel: (migrationId: number | null) => string | null;
}) {
  const shown = type ? items.filter((e) => e.type === type) : items;
  if (shown.length === 0) {
    return (
      <EmptyState
        title={`No “${type.replaceAll('_', ' ')}” events in this scope`}
        description="Pick another type or show all events."
        action={<Button onClick={onClearType}>Show all types</Button>}
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {shown.length.toLocaleString()} event{shown.length === 1 ? '' : 's'}, newest first
        {items.length >= LIMIT && ` (the latest ${LIMIT} are loaded)`}.
      </p>
      <ol className="ml-1.5 border-l border-slate-200">
        {shown.map((e) => (
          <EventItem key={e.id} e={e} workspaceLabel={workspaceLabel(e.migrationId)} />
        ))}
      </ol>
    </div>
  );
}

function ScopeToggle({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  const options: { id: Scope; label: string }[] = [
    { id: 'current', label: 'This workspace' },
    { id: 'all', label: 'All workspaces' },
  ];
  return (
    <div role="group" aria-label="Event scope" className="inline-flex rounded-md shadow-sm ring-1 ring-slate-300">
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={scope === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'px-3 py-1 text-xs font-medium',
            i === 0 ? 'rounded-l-md' : 'rounded-r-md border-l border-slate-300',
            scope === o.id ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TypeFilter({ items, value, onChange }: { items: EventRow[]; value: string; onChange: (t: string) => void }) {
  const id = useId();
  const counts = new Map<string, number>();
  for (const e of items) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  // Keep the current selection listed even if the new scope has none of it, so the <select> stays truthful.
  if (value && !counts.has(value)) counts.set(value, 0);
  const types = [...counts.keys()].sort();
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs text-slate-600">
      Type
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
        <option value="">All types ({items.length})</option>
        {types.map((t) => (
          <option key={t} value={t}>
            {t.replaceAll('_', ' ')} ({counts.get(t)})
          </option>
        ))}
      </select>
    </label>
  );
}
