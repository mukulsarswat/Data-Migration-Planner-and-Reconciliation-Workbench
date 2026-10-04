// One audit event on the History timeline: a type badge coloured by family, references, actor, time,
// a compact human-readable payload summary and the raw event as JSON.
import type { EventRow } from '../api.ts';
import { Badge, cx, fmt } from './ui.tsx';
import { JsonDetails } from './logsJson.tsx';

type Family = 'violet' | 'sky' | 'green' | 'red' | 'slate' | 'amber' | 'blue' | 'neutral';

const BADGE: Record<Family, string> = {
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  slate: 'bg-slate-100 text-slate-700 ring-slate-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  neutral: 'bg-white text-slate-600 ring-slate-200',
};
const DOT: Record<Family, string> = {
  violet: 'bg-violet-500',
  sky: 'bg-sky-500',
  green: 'bg-emerald-500',
  red: 'bg-rose-500',
  slate: 'bg-slate-500',
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  neutral: 'bg-slate-300',
};

function family(type: string): Family {
  if (type === 'plan_approved' || type === 'execution_completed') return 'green';
  if (type === 'plan_rejected' || type === 'execution_failed') return 'red';
  if (type.startsWith('execution_') || type === 'run_interrupted') return 'amber';
  if (type.startsWith('plan_') || type.startsWith('agent_')) return 'violet';
  if (type.startsWith('clarification_')) return 'sky';
  if (type.startsWith('dry_run_')) return 'slate';
  if (type.startsWith('rollback_')) return 'blue';
  return 'neutral';
}

export function EventTypeBadge({ type }: { type: string }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', BADGE[family(type)])}>
      {type.replaceAll('_', ' ')}
    </span>
  );
}

type Payload = Record<string, unknown>;
const num = (p: Payload, k: string): number | null => (typeof p[k] === 'number' ? (p[k] as number) : null);
const str = (p: Payload, k: string): string | null => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** `ai` marks events whose subject (an agent-authored plan version) was produced by the LLM. */
type Summary = { parts: (string | null | false)[]; note?: string | null; ai?: boolean };

/** Per-type summary of the payload. Unknown types fall back to their primitive fields. */
function summarize(e: EventRow): Summary {
  const p = e.payload;
  switch (e.type) {
    case 'plan_version_created': {
      const parent = num(p, 'parentVersion');
      return {
        parts: [parent !== null ? `from v${parent}` : 'first version', `author ${str(p, 'author') ?? '?'}`, `hash ${fmt.hash(str(p, 'planHash'))}`],
        note: str(p, 'changeNote'),
        ai: p.author === 'agent',
      };
    }
    case 'clarification_answered': {
      const choice = p.choice;
      return {
        parts: [
          `clarification ${str(p, 'clarificationId') ?? '?'}`,
          choice === 'dismissed' ? 'dismissed' : typeof choice === 'number' ? `chose option ${choice + 1}` : null,
          `v${num(p, 'fromVersion') ?? '?'} → v${num(p, 'toVersion') ?? '?'}`,
        ],
      };
    }
    case 'plan_approved':
    case 'plan_rejected':
      return { parts: [`plan hash ${fmt.hash(str(p, 'planHash'))}`], note: str(p, 'comment') };
    case 'dry_run_completed': {
      const det = p.deterministicMatch;
      return {
        parts: [
          `${num(p, 'accepted') ?? '?'} accepted / ${num(p, 'rejected') ?? '?'} rejected of ${num(p, 'source') ?? '?'}`,
          `result ${fmt.hash(str(p, 'resultHash'))}`,
          det === true ? 'identical to previous dry run' : det === false ? 'differs from previous dry run' : 'first dry run of this version',
        ],
      };
    }
    case 'execution_started':
    case 'execution_retried': {
      const parent = num(p, 'parentRunId');
      const failAfter = num(p, 'failAfter');
      return {
        parts: [`attempt ${num(p, 'attempt') ?? 1}`, parent !== null && `retry of run #${parent}`, failAfter !== null && `simulated failure after ${plural(failAfter, 'record')}`],
      };
    }
    case 'execution_completed':
    case 'execution_failed': {
      const count = (k: string, word: string) => {
        const n = num(p, k);
        return n ? `${n.toLocaleString()} ${word}` : null;
      };
      const code = str(p, 'errorCode');
      return {
        parts: [
          `${(num(p, 'inserted') ?? 0).toLocaleString()} inserted`,
          count('skippedExisting', 'already loaded'),
          count('conflict', 'conflicts'),
          count('loadRejected', 'load-rejected'),
          count('pending', 'pending'),
        ],
        note: code ? `${code}: ${str(p, 'error') ?? ''}` : null,
      };
    }
    case 'rollback_completed': {
      const deleted = num(p, 'deleted') ?? 0;
      const ledger = num(p, 'ledgerRows') ?? 0;
      return { parts: [`${plural(deleted, 'row')} deleted`, `${ledger.toLocaleString()} ledger ${ledger === 1 ? 'entry' : 'entries'} closed`], note: str(p, 'reason') };
    }
    case 'run_interrupted':
      return { parts: [`${str(p, 'kind') ?? 'run'} interrupted`], note: str(p, 'reason') };
    case 'agent_run_started': {
      const based = num(p, 'basedOnVersion');
      return { parts: [str(p, 'model'), str(p, 'mode') && `${str(p, 'mode')} mode`, based !== null ? `revising v${based}` : 'from scratch'] };
    }
    case 'agent_run_succeeded':
    case 'agent_run_failed':
    case 'agent_run_interrupted': {
      const result = num(p, 'resultVersion');
      const code = str(p, 'errorCode');
      return {
        parts: [result !== null ? `proposed v${result}` : e.type === 'agent_run_succeeded' ? 'no version created' : null],
        note: code ? `${code}: ${str(p, 'error') ?? ''}` : str(p, 'reason'),
      };
    }
    case 'workspace_created': {
      const prev = num(p, 'previousWorkspaceId');
      const rolledBack = num(p, 'rolledBack');
      return {
        parts: [str(p, 'name'), prev !== null && `replaces workspace #${prev}`, rolledBack !== null && `${plural(rolledBack, 'row')} rolled back first`],
      };
    }
    default:
      return {
        parts: Object.entries(p)
          .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
          .slice(0, 6)
          .map(([k, v]) => `${k}: ${fmt.value(v)}`),
      };
  }
}

/** The plan version an event refers to, from whichever payload field carries it. */
function versionRef(e: EventRow): number | null {
  for (const k of ['version', 'toVersion', 'resultVersion']) {
    const v = e.payload[k];
    if (typeof v === 'number') return v;
  }
  return null;
}

export function EventItem({ e, workspaceLabel }: { e: EventRow; workspaceLabel: string | null }) {
  const s = summarize(e);
  const parts = s.parts.filter((x): x is string => typeof x === 'string' && x !== '');
  const version = versionRef(e);
  return (
    <li className="relative pb-5 pl-6 last:pb-0">
      <span className={cx('absolute top-1.5 -left-[5px] h-2.5 w-2.5 rounded-full ring-2 ring-white', DOT[family(e.type)])} aria-hidden />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <EventTypeBadge type={e.type} />
        {s.ai && <Badge tone="violet">AI-generated</Badge>}
        {version !== null && <Badge tone="violet">v{version}</Badge>}
        {e.runId !== null && <Badge>run #{e.runId}</Badge>}
        {e.agentRunId !== null && <Badge tone="violet">agent run #{e.agentRunId}</Badge>}
        {workspaceLabel && <Badge tone="blue">{workspaceLabel}</Badge>}
        <span className="text-xs text-slate-500">
          by <span className="font-medium text-slate-700">{e.actor}</span>
        </span>
        <time className="ml-auto text-xs tabular-nums text-slate-500" dateTime={e.createdAt}>
          {fmt.time(e.createdAt)}
        </time>
      </div>
      {parts.length > 0 && <p className="mt-1 text-sm text-slate-700">{parts.join(' · ')}</p>}
      {s.note && (
        <p className="mt-1 text-xs break-words text-slate-600 italic">“{s.note}”</p>
      )}
      <JsonDetails value={e} label="Raw event" />
    </li>
  );
}
