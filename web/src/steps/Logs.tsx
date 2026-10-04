// Logs: structured application + AI-workflow log lines from the server's in-memory ring buffer, filterable by
// request id (shared with the "request …" links in error banners via nav.logsFilter) and minimum level.
import { useEffect, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useNav } from '../nav.tsx';
import { AsyncPanel, Banner, Button, Card, EmptyState, cx } from '../components/ui.tsx';
import { LogLine } from '../components/logsEntry.tsx';

const LIMIT = 200;
const LEVELS = [
  { id: 'info', label: 'info and above' },
  { id: 'warn', label: 'warn and above' },
  { id: 'error', label: 'errors only' },
] as const;
type Level = (typeof LEVELS)[number]['id'];

/** Lags `value` by `delayMs` so typing in the filter does not fire a request per keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function LogsStep() {
  const nav = useNav();
  const ridId = useId();
  const levelId = useId();
  const [minLevel, setMinLevel] = useState<Level>('info');
  const [auto, setAuto] = useState(false);
  const requestId = useDebounced(nav.logsFilter.trim(), 300);
  const logs = useQuery({
    queryKey: ['logs', requestId, minLevel],
    queryFn: () => api.logs({ requestId: requestId || undefined, minLevel, limit: LIMIT }),
    refetchInterval: auto ? 3000 : false,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Logs</h2>
          <p className="text-sm text-slate-500">Structured application and AI-workflow logs: HTTP requests, agent LLM turns and tool calls, run failures.</p>
        </div>
      </div>

      <Banner tone="info" title="Last 1000 entries kept in memory; secrets are redacted">
        The newest {LIMIT} matching entries are shown, newest first. Click a request id to see every line for that request.
      </Banner>

      <Card
        title="Entries"
        subtitle={logs.dataUpdatedAt ? `Updated ${new Date(logs.dataUpdatedAt).toLocaleTimeString()}${auto ? ' · auto-refreshing every 3 s' : ''}` : undefined}
        actions={
          <Button size="sm" onClick={() => void logs.refetch()} loading={logs.isFetching && !logs.isPending}>
            Refresh
          </Button>
        }
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor={ridId} className="block text-xs font-medium text-slate-700">
              Request id
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id={ridId}
                value={nav.logsFilter}
                onChange={(e) => nav.setLogsFilter(e.target.value)}
                placeholder="any request"
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                className="w-full min-w-0 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm"
              />
              {nav.logsFilter && (
                <Button size="sm" variant="ghost" onClick={() => nav.setLogsFilter('')}>
                  Clear
                </Button>
              )}
            </div>
          </div>
          <div>
            <label htmlFor={levelId} className="block text-xs font-medium text-slate-700">
              Minimum level
            </label>
            <select
              id={levelId}
              value={minLevel}
              onChange={(e) => setMinLevel(e.target.value as Level)}
              className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {LEVELS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Auto-refresh (3 s)
          </label>
        </div>

        <AsyncPanel
          query={logs}
          lines={8}
          isEmpty={(d) => d.entries.length === 0}
          empty={
            requestId ? (
              <EmptyState
                title="No entries for this request id"
                description="The buffer keeps only the last 1000 entries, so older lines may have been evicted, or the id may be mistyped."
                action={<Button onClick={() => nav.setLogsFilter('')}>Show all requests</Button>}
              />
            ) : minLevel !== 'info' ? (
              <EmptyState
                title={`No ${minLevel === 'error' ? 'errors' : 'warnings or errors'} in the buffer`}
                description="That is good news. Lower the level to see routine activity."
                action={<Button onClick={() => setMinLevel('info')}>Show info and above</Button>}
              />
            ) : (
              <EmptyState title="No log entries yet" description="Entries appear as you use the workbench." action={<Button onClick={() => nav.go('inputs')}>Go to Inputs</Button>} />
            )
          }
        >
          {(d) => (
            <ol className={cx('divide-y divide-slate-100 rounded-md border border-slate-200', logs.isPlaceholderData && 'opacity-60')} aria-busy={logs.isFetching || undefined}>
              {[...d.entries].reverse().map((entry, i) => (
                <LogLine key={`${entry.time}:${i}`} entry={entry} activeRequestId={requestId} onFilter={nav.setLogsFilter} />
              ))}
            </ol>
          )}
        </AsyncPanel>
      </Card>
    </div>
  );
}
