// "Gaps & incompatibilities": the server's deterministic field-gap analysis, plus op chips for suggested step chains.
import type { MigrationInfo } from '../api.ts';
import type { Step } from '../../../shared/dsl.ts';
import { Badge, Card, table } from './ui.tsx';

type Gaps = MigrationInfo['gaps'];

export function GapsCard({ gaps }: { gaps: Gaps }) {
  const total = gaps.sourceWithoutTarget.length + gaps.requiredTargetWithoutSource.length + gaps.typeIncompatible.length;
  return (
    <Card
      title="Gaps & incompatibilities"
      subtitle="Computed deterministically on the server from field names, descriptions and profiles. Every plan must resolve each item before it can be approved."
      actions={<Badge tone={total ? 'amber' : 'green'}>{total} item{total === 1 ? '' : 's'}</Badge>}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="gaps-required">
          <h3 id="gaps-required" className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-700">
            Required targets without a source ({gaps.requiredTargetWithoutSource.length})
          </h3>
          {gaps.requiredTargetWithoutSource.length === 0 ? (
            <p className="text-xs text-slate-500">None: every required target has a candidate source field.</p>
          ) : (
            <ul className="space-y-2">
              {gaps.requiredTargetWithoutSource.map((g) => (
                <li key={g.target} className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-semibold text-rose-900">{g.target}</code>
                    <Badge tone="red">required · no source</Badge>
                  </div>
                  <p className="mt-1 text-xs text-rose-900">{g.reason}</p>
                  <p className="mt-1 text-xs text-rose-800/80">Needs a constant default (a clarification will ask which) or a new source column.</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="gaps-unmatched">
          <h3 id="gaps-unmatched" className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
            Source fields without a target ({gaps.sourceWithoutTarget.length})
          </h3>
          {gaps.sourceWithoutTarget.length === 0 ? (
            <p className="text-xs text-slate-500">None: every source field has a candidate target.</p>
          ) : (
            <ul className="space-y-2">
              {gaps.sourceWithoutTarget.map((g) => (
                <li key={g.source} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                  <code className="font-mono text-sm font-semibold text-slate-900">{g.source}</code>
                  <p className="mt-1 text-xs text-slate-600">{g.reason}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">A plan must map these or explicitly ignore them with a reason.</p>
        </section>
      </div>

      <section aria-labelledby="gaps-types" className="mt-5">
        <h3 id="gaps-types" className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
          Type-incompatible pairs ({gaps.typeIncompatible.length})
        </h3>
        {gaps.typeIncompatible.length === 0 ? (
          <p className="text-xs text-slate-500">None: every matched pair can be copied as text.</p>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th scope="col" className={table.th}>Source → target</th>
                  <th scope="col" className={table.th}>Types</th>
                  <th scope="col" className={table.th}>Why</th>
                  <th scope="col" className={table.th}>Suggested steps</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {gaps.typeIncompatible.map((g) => (
                  <tr key={`${g.source}->${g.target}`} className={table.tr}>
                    <td className={`${table.td} whitespace-nowrap font-mono text-xs`}>
                      {g.source} <span className="text-slate-400">→</span> {g.target}
                    </td>
                    <td className={`${table.td} whitespace-nowrap text-xs`}>
                      {g.sourceType} <span className="text-slate-400">→</span> {g.targetType}
                    </td>
                    <td className={`${table.td} min-w-48 text-xs`}>{g.note}</td>
                    <td className={table.td}>
                      <StepChain steps={g.suggestedSteps} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Card>
  );
}

/** A step chain rendered as op chips joined by arrows. */
export function StepChain({ steps }: { steps: readonly Step[] }) {
  if (steps.length === 0) return <span className="text-xs text-slate-400">no steps</span>;
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Transform steps">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className="text-slate-400">→</span>}
          <OpChip step={s} />
        </li>
      ))}
    </ol>
  );
}

const MAX_PARAM_CHARS = 48;

export function OpChip({ step }: { step: Step }) {
  const params = paramText(step.params as Record<string, unknown>);
  const short = params.length > MAX_PARAM_CHARS ? `${params.slice(0, MAX_PARAM_CHARS)}…` : params;
  return (
    <span
      title={params ? `${step.op}(${params})` : step.op}
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 font-mono text-xs text-indigo-800 ring-1 ring-inset ring-indigo-200"
    >
      <span className="font-semibold">{step.op}</span>
      {short && <span className="truncate text-indigo-700/80">({short})</span>}
    </span>
  );
}

function paramText(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}: ${paramValue(v)}`)
    .join(', ');
}

function paramValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(paramValue).join(', ')}]`;
  if (v && typeof v === 'object' && 'from' in v && 'to' in v) {
    const p = v as { from: unknown; to: unknown };
    return `${paramValue(p.from)}→${paramValue(p.to)}`;
  }
  // Strings are quoted so empty strings and separators stay visible.
  return JSON.stringify(v) ?? String(v);
}
