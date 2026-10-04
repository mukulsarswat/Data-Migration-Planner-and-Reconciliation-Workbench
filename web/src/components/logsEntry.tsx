// One structured (pino) log line: time, level, message, request id (click to filter), the fields that matter for
// HTTP and AI-workflow debugging, and the full entry as JSON.
import type { LogEntry } from '../api.ts';
import { Badge, cx, type Tone } from './ui.tsx';
import { JsonDetails } from './logsJson.tsx';

const LEVELS: Record<number, { label: string; tone: Tone }> = {
  10: { label: 'trace', tone: 'neutral' },
  20: { label: 'debug', tone: 'neutral' },
  30: { label: 'info', tone: 'blue' },
  40: { label: 'warn', tone: 'amber' },
  50: { label: 'error', tone: 'red' },
  60: { label: 'fatal', tone: 'red' },
};

type Formatter = (v: unknown) => string | null;
const plain: Formatter = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const ms: Formatter = (v) => (typeof v === 'number' ? `${v} ms` : null);
const usage: Formatter = (v) => {
  if (!v || typeof v !== 'object') return null;
  const u = v as Record<string, unknown>;
  const part = (k: string, label: string) => (typeof u[k] === 'number' ? `${label} ${(u[k] as number).toLocaleString()}` : null);
  return [part('input', 'in'), part('output', 'out'), part('cacheRead', 'cache read'), part('cacheWrite', 'cache write')].filter(Boolean).join(' · ') || null;
};
const list: Formatter = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : null) : plain(v));
const error: Formatter = (v) => {
  if (!v || typeof v !== 'object') return plain(v);
  const e = v as { type?: unknown; message?: unknown };
  return [e.type, e.message].filter((x) => typeof x === 'string' && x).join(': ') || null;
};
const clip: Formatter = (v) => {
  const s = plain(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

/** Fields surfaced inline, in display order; everything else stays in the JSON view. */
const KEY_FIELDS: { key: string; label: string; format?: Formatter }[] = [
  { key: 'method', label: 'method' },
  { key: 'path', label: 'path' },
  { key: 'status', label: 'status' },
  { key: 'durationMs', label: 'took', format: ms },
  { key: 'runId', label: 'run' },
  { key: 'agentRunId', label: 'agent run' },
  { key: 'step', label: 'step' },
  { key: 'gen_ai.tool.name', label: 'tool' },
  { key: 'gen_ai.request.model', label: 'model' },
  { key: 'gen_ai.response.model', label: 'response model' },
  { key: 'stopReason', label: 'stop' },
  { key: 'toolCalls', label: 'tool calls', format: list },
  { key: 'usage', label: 'tokens', format: usage },
  { key: 'isError', label: 'tool error' },
  { key: 'summary', label: 'summary', format: clip },
  { key: 'err', label: 'error', format: error },
  { key: 'port', label: 'port' },
  { key: 'signal', label: 'signal' },
];

function statusClass(status: unknown): string {
  if (typeof status !== 'number') return '';
  if (status >= 500) return 'bg-rose-100 text-rose-800';
  if (status >= 400) return 'bg-amber-100 text-amber-900';
  return 'bg-emerald-50 text-emerald-800';
}

function clock(t: number): { short: string; full: string } {
  const d = new Date(t);
  return {
    short: `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`,
    full: d.toLocaleString(),
  };
}

export function LogLine({ entry, onFilter, activeRequestId }: { entry: LogEntry; onFilter: (requestId: string) => void; activeRequestId: string }) {
  const level = LEVELS[entry.level] ?? { label: String(entry.level), tone: 'neutral' as Tone };
  const time = clock(entry.time);
  const rid = typeof entry.requestId === 'string' ? entry.requestId : null;
  // Agent LLM turns log the provider's request id under `requestId`; HTTP access lines log ours.
  const ridTitle = entry.agentRunId !== undefined ? 'Anthropic request id' : 'Request id';
  const fields = KEY_FIELDS.flatMap(({ key, label, format }) => {
    const value = (format ?? plain)(entry[key]);
    return value === null || value === '' ? [] : [{ key, label, value }];
  });
  return (
    <li className={cx('px-3 py-2', entry.level >= 50 && 'bg-rose-50/40', entry.level === 40 && 'bg-amber-50/40')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <time className="font-mono text-xs tabular-nums text-slate-500" dateTime={new Date(entry.time).toISOString()} title={time.full}>
          {time.short}
        </time>
        <Badge tone={level.tone}>{level.label}</Badge>
        <span className="text-sm font-medium break-words text-slate-900">{entry.msg ?? '(no message)'}</span>
        {rid &&
          (rid === activeRequestId ? (
            <span className="font-mono text-xs text-slate-500" title={`${ridTitle} ${rid}`}>
              req {rid.slice(0, 8)}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onFilter(rid)}
              title={`${ridTitle} ${rid}: show only entries for it`}
              aria-label={`Filter logs by request ${rid}`}
              className="font-mono text-xs text-indigo-700 underline decoration-dotted hover:text-indigo-900"
            >
              req {rid.slice(0, 8)}
            </button>
          ))}
      </div>
      {fields.length > 0 && (
        <dl className="mt-1 flex flex-wrap gap-1.5">
          {fields.map((f) => (
            <div key={f.key} className={cx('inline-flex max-w-full gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700', f.key === 'status' && statusClass(entry.status))}>
              <dt className="text-slate-500">{f.label}</dt>
              <dd className="break-all">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <JsonDetails value={entry} label="Full entry" />
    </li>
  );
}
