// Presentation helpers for the Review step: provenance badges, op-chip rendering of step chains, pass-rate colours.
import type { Approval, VersionSummary } from '../api.ts';
import type { Step } from '../../../shared/dsl.ts';
import type { FieldMapping } from '../../../shared/plan.ts';
import { Badge, fmt, type Tone } from './ui.tsx';

export function AuthorBadge({ author }: { author: VersionSummary['author'] }) {
  const meta = {
    agent: { tone: 'violet', title: 'Drafted by the AI agent' },
    heuristic: { tone: 'blue', title: 'Deterministic heuristic draft (no LLM)' },
    user: { tone: 'green', title: 'Created by a reviewer (edit or clarification answer)' },
  } as const;
  return (
    <Badge tone={meta[author].tone} title={meta[author].title}>
      {author}
    </Badge>
  );
}

export function ApprovalBadge({ approval }: { approval: Approval | null }) {
  if (!approval) return <Badge tone="amber">awaiting review</Badge>;
  return approval.decision === 'approved' ? <Badge tone="green">approved</Badge> : <Badge tone="red">rejected</Badge>;
}

export function OriginBadge({ origin }: { origin: FieldMapping['origin'] }) {
  if (origin === 'agent') return <Badge tone="violet" title="Proposed by the AI agent">AI</Badge>;
  if (origin === 'heuristic') return <Badge tone="blue" title="Deterministic heuristic (no LLM)">heuristic</Badge>;
  return <Badge tone="green" title="Set or edited by a reviewer">human</Badge>;
}

export function ConfidenceBadge({ confidence }: { confidence: FieldMapping['confidence'] }) {
  const tone: Tone = confidence === 'high' ? 'green' : confidence === 'medium' ? 'amber' : 'red';
  return (
    <Badge tone={tone} title="Confidence of the proposer">
      {confidence} conf.
    </Badge>
  );
}

export function AiBadge() {
  return (
    <Badge tone="violet" title="Written by a language model: verify before relying on it">
      AI-generated
    </Badge>
  );
}

export const severityTone = (s: 'high' | 'medium' | 'low'): Tone => (s === 'high' ? 'red' : s === 'medium' ? 'amber' : 'neutral');

export const passRateTone = (pct: number): Tone => (pct >= 99 ? 'green' : pct >= 90 ? 'amber' : 'red');

/** Compact, human-readable params for an op chip (the full JSON goes in the chip's tooltip). */
export function stepParamsText(step: Step): string {
  switch (step.op) {
    case 'default':
      return JSON.stringify(step.params.value);
    case 'concat':
      return `sep ${JSON.stringify(step.params.separator)}`;
    case 'split_full_name':
      return step.params.part;
    case 'parse_date':
      return step.params.formats.join(' | ');
    case 'to_boolean':
      return `true: ${step.params.true_values.join(', ')} · false: ${step.params.false_values.join(', ')}`;
    case 'map_values': {
      const pairs = step.params.pairs.map((p) => `${p.from}→${p.to}`);
      const shown = pairs.length > 4 ? [...pairs.slice(0, 4), `+${pairs.length - 4} more`] : pairs;
      const fallback = step.params.fallback === null ? 'fail' : JSON.stringify(step.params.fallback);
      return `${shown.join(', ')} · else ${fallback}`;
    }
    case 'normalize_phone':
      return step.params.default_country;
    default:
      return '';
  }
}

export function StepChain({ steps }: { steps: readonly Step[] }) {
  if (!steps.length) return <span className="text-xs text-slate-400">no steps</span>;
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Transformation steps">
      {steps.map((s, i) => {
        const p = stepParamsText(s);
        return (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="text-slate-400">
                →
              </span>
            )}
            <span
              title={`${s.op} ${JSON.stringify(s.params)}`}
              className="inline-flex max-w-[14rem] items-baseline gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-800 ring-1 ring-inset ring-slate-200"
            >
              <span className="font-semibold">{s.op}</span>
              {p && <span className="truncate text-slate-500">{p}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function SourceList({ sources }: { sources: readonly string[] }) {
  if (!sources.length) return <span className="text-xs italic text-slate-500">constant</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {sources.map((s, i) => (
        <code key={`${s}-${i}`} className="rounded bg-sky-50 px-1 py-0.5 text-[11px] text-sky-800">
          {s}
        </code>
      ))}
    </span>
  );
}

/** Raw source values as `field=value` pairs (null shown as ∅, empty string as ""). */
export function RawValues({ raw }: { raw: Record<string, string | null> }) {
  const entries = Object.entries(raw);
  if (!entries.length) return <span className="italic text-slate-500">(no source)</span>;
  return (
    <span className="font-mono text-[11px] text-slate-700">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && ', '}
          <span className="text-slate-500">{k}=</span>
          {fmt.value(v)}
        </span>
      ))}
    </span>
  );
}

/**
 * Who wrote a version's free text (summary, risks, ignore reasons). Reviewer versions copy that text from their parent,
 * so walk up through `user` versions to the draft that produced it.
 */
export function contentAuthor(versions: readonly VersionSummary[], version: number): VersionSummary['author'] | null {
  const byVersion = new Map(versions.map((v) => [v.version, v]));
  const seen = new Set<number>();
  let cur = byVersion.get(version);
  while (cur && cur.author === 'user' && cur.parentVersion !== null && !seen.has(cur.version)) {
    seen.add(cur.version);
    cur = byVersion.get(cur.parentVersion);
  }
  return cur?.author ?? null;
}
