// Read-only sections of a plan version: summary & risks, ignored fields, static issues, diff vs parent.
import type { FieldMapping, MigrationPlan, PlanDiff, PlanIssue } from '../api.ts';
import { Badge, Card, table } from './ui.tsx';
import { AiBadge, SourceList, StepChain, severityTone } from './reviewShared.tsx';

const RISK_RANK = { high: 0, medium: 1, low: 2 } as const;

export function SummaryRisksCard({ plan, aiText }: { plan: MigrationPlan; aiText: boolean }) {
  const risks = [...plan.risks].sort((a, b) => RISK_RANK[a.severity] - RISK_RANK[b.severity]);
  return (
    <Card title="Summary & risks" actions={aiText ? <AiBadge /> : undefined}>
      {plan.summary ? (
        <p className="whitespace-pre-wrap text-sm text-slate-800">{plan.summary}</p>
      ) : (
        <p className="text-sm text-slate-500">No summary for this version.</p>
      )}
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Risks ({risks.length})</h3>
      {risks.length ? (
        <ul className="mt-1.5 space-y-1.5">
          {risks.map((r, i) => (
            <li key={i} className="flex flex-wrap items-start gap-2 text-sm">
              <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
              {r.field && <code className="rounded bg-slate-100 px-1 text-[11px] text-slate-700">{r.field}</code>}
              <span className="min-w-0 flex-1 text-slate-700">{r.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-slate-500">No risks recorded.</p>
      )}
    </Card>
  );
}

export function IgnoredCard({ plan, aiText }: { plan: MigrationPlan; aiText: boolean }) {
  return (
    <Card
      title={`Ignored source fields (${plan.ignored.length})`}
      subtitle="Every source field must be mapped or explicitly ignored with a reason."
      actions={aiText && plan.ignored.length ? <AiBadge /> : undefined}
    >
      {plan.ignored.length ? (
        <div className={table.wrap}>
          <table className={table.table}>
            <thead>
              <tr>
                <th scope="col" className={table.th}>Source field</th>
                <th scope="col" className={table.th}>Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plan.ignored.map((g, i) => (
                <tr key={`${g.source}#${i}`}>
                  <td className={`${table.td} font-mono text-xs`}>{g.source}</td>
                  <td className={`${table.td} text-xs`}>{g.reason || <span className="text-slate-400">no reason given</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">No source fields are ignored.</p>
      )}
    </Card>
  );
}

export function IssuesCard({ issues }: { issues: PlanIssue[] }) {
  const blockers = issues.filter((i) => i.severity === 'blocker');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return (
    <Card
      title="Static validation"
      subtitle="References, op params, arity, type chain, required targets and source accounting. Approval also needs every clarification answered or dismissed."
    >
      {issues.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-emerald-800">
          <Badge tone="green">no issues</Badge> The plan passes static validation.
        </p>
      ) : (
        <div className="space-y-3">
          <IssueGroup label="Blockers" tone="red" issues={blockers} />
          <IssueGroup label="Warnings" tone="amber" issues={warnings} />
        </div>
      )}
    </Card>
  );
}

function IssueGroup({ label, tone, issues }: { label: string; tone: 'red' | 'amber'; issues: PlanIssue[] }) {
  if (!issues.length) return null;
  return (
    <section>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label} <Badge tone={tone}>{issues.length}</Badge>
      </h3>
      <ul className="mt-1.5 space-y-1">
        {issues.map((i, k) => (
          <li key={k} className="text-sm text-slate-700">
            <code className="mr-1.5 text-[11px] text-slate-500">{i.code}</code>
            {i.field && <code className="mr-1.5 rounded bg-slate-100 px-1 text-[11px]">{i.field}</code>}
            {i.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

const CHANGE_TONE = { added: 'green', removed: 'red', modified: 'amber' } as const;

/** Which parts of a mapping changed (both sides come from the server in canonical form). */
function changedParts(a: FieldMapping, b: FieldMapping): string[] {
  const parts: string[] = [];
  if (JSON.stringify(a.sources) !== JSON.stringify(b.sources)) parts.push('sources');
  if (JSON.stringify(a.steps) !== JSON.stringify(b.steps)) parts.push('steps');
  if (a.origin !== b.origin) parts.push('origin');
  if (a.confidence !== b.confidence) parts.push('confidence');
  if (a.rationale !== b.rationale) parts.push('rationale');
  return parts;
}

function MappingBrief({ m }: { m: FieldMapping | null }) {
  if (!m) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="space-y-1">
      <SourceList sources={m.sources} />
      <StepChain steps={m.steps} />
    </div>
  );
}

export function DiffCard({ diff, plan }: { diff: PlanDiff; plan: MigrationPlan }) {
  if (diff.from === null) {
    return (
      <Card title="Changes vs parent">
        <p className="text-sm text-slate-500">v{diff.to} is a first draft: there is no parent version to compare against.</p>
      </Card>
    );
  }
  const questions = new Map(plan.clarifications.map((c) => [c.id, c]));
  const empty =
    !diff.changedTargets.length && !diff.ignoredAdded.length && !diff.ignoredRemoved.length && !diff.clarificationsResolved.length && !diff.errorBudgetChanged;
  return (
    <Card title={`Changes vs v${diff.from}`} subtitle={`What v${diff.to} changes relative to its parent.`}>
      {empty ? (
        <p className="text-sm text-slate-500">No differences in mappings, ignored fields, clarifications or error budget.</p>
      ) : (
        <div className="space-y-4">
          {diff.changedTargets.length > 0 && (
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th scope="col" className={table.th}>Target</th>
                    <th scope="col" className={table.th}>Change</th>
                    <th scope="col" className={table.th}>Before (v{diff.from})</th>
                    <th scope="col" className={table.th}>After (v{diff.to})</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {diff.changedTargets.map((c) => (
                    <tr key={c.target} className="align-top">
                      <td className={`${table.td} font-mono text-xs font-semibold`}>{c.target}</td>
                      <td className={table.td}>
                        <div className="flex flex-col items-start gap-1">
                          <Badge tone={CHANGE_TONE[c.change]}>{c.change}</Badge>
                          {c.before && c.after && <span className="text-[11px] text-slate-500">{changedParts(c.before, c.after).join(', ')}</span>}
                        </div>
                      </td>
                      <td className={`${table.td} bg-rose-50/30`}>
                        <MappingBrief m={c.before} />
                      </td>
                      <td className={`${table.td} bg-emerald-50/30`}>
                        <MappingBrief m={c.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {diff.ignoredAdded.length > 0 && <DiffLine label="Now ignored" values={diff.ignoredAdded} />}
            {diff.ignoredRemoved.length > 0 && <DiffLine label="No longer ignored" values={diff.ignoredRemoved} />}
            {diff.errorBudgetChanged && (
              <>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Error budget</dt>
                <dd className="tabular-nums text-slate-700">
                  {diff.errorBudgetChanged.before}% → {diff.errorBudgetChanged.after}%
                </dd>
              </>
            )}
            {diff.clarificationsResolved.length > 0 && (
              <>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resolved</dt>
                <dd>
                  <ul className="space-y-1">
                    {diff.clarificationsResolved.map((id) => {
                      const c = questions.get(id);
                      const choice = c?.resolution?.choice;
                      const answer =
                        choice === 'dismissed' ? 'dismissed' : choice !== undefined ? (c?.options[choice]?.label ?? `option ${choice + 1}`) : '';
                      return (
                        <li key={id} className="text-slate-700">
                          <code className="mr-1 text-[11px] text-slate-400">{id}</code>
                          {c?.trigger === 'agent_question' && (
                            <span className="mr-1">
                              <AiBadge />
                            </span>
                          )}
                          {c?.question ?? ''}
                          {answer && <strong className="ml-1">→ {answer}</strong>}
                          {c?.resolution && <span className="ml-1 text-xs text-slate-500">(by {c.resolution.by})</span>}
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </Card>
  );
}

function DiffLine({ label, values }: { label: string; values: string[] }) {
  return (
    <>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="flex flex-wrap gap-1">
        {values.map((v) => (
          <code key={v} className="rounded bg-slate-100 px-1 text-[11px] text-slate-700">
            {v}
          </code>
        ))}
      </dd>
    </>
  );
}
