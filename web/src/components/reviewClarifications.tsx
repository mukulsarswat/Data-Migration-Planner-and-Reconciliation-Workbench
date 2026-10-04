// Clarifications: questions the plan cannot answer by itself. Choosing an option applies its deterministic patch on the
// server (no LLM call) and returns a NEW version, which the caller selects.
import { useMutation } from '@tanstack/react-query';
import { api, type Clarification, type VersionDetail } from '../api.ts';
import { useActor, useRefreshAll } from '../nav.tsx';
import { Badge, Button, Card, ErrorBanner } from './ui.tsx';
import { AiBadge } from './reviewShared.tsx';

type Answer = { id: string; choice: number | 'dismissed' };

function patchSummary(option: Clarification['options'][number]): string {
  const p = option.patch;
  if (p.kind === 'set_mapping') {
    const src = p.mapping.sources.length ? p.mapping.sources.join(' + ') : 'constant';
    return `Sets ${p.mapping.target} ← ${src} via ${p.mapping.steps.map((s) => s.op).join(' → ') || 'no steps'}`;
  }
  if (p.kind === 'ignore_source') return `Ignores source ${p.source}: ${p.reason}`;
  return 'Keeps the plan as it is';
}

export function ClarificationsCard({ detail, onNewVersion }: { detail: VersionDetail; onNewVersion: (version: number, message: string) => void }) {
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const answer = useMutation({
    mutationFn: (a: Answer) => api.answerClarification(detail.version, a.id, a.choice, actor),
    // Wait for the version list to include the new version before selecting it.
    onSuccess: async (res) => {
      await refreshAll();
      onNewVersion(res.version, `Answer applied deterministically (no AI call); you are now reviewing v${res.version}, a child of v${detail.version}.`);
    },
  });
  const items = detail.plan.clarifications;
  const open = items.filter((c) => !c.resolution);
  const resolved = items.filter((c) => c.resolution);

  return (
    <Card
      title={`Clarifications (${open.length} open · ${resolved.length} resolved)`}
      subtitle="Answering applies the option's plan patch deterministically (no AI call) and saves a new version."
    >
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">No clarifications for this version.</p>
      ) : (
        <ul className="space-y-2">
          {[...open, ...resolved].map((c) => (
            <ClarificationItem
              key={c.id}
              c={c}
              pending={answer.isPending ? (answer.variables ?? null) : null}
              busy={answer.isPending}
              error={answer.isError && answer.variables?.id === c.id ? answer.error : null}
              onAnswer={(choice) => answer.mutate({ id: c.id, choice })}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClarificationItem({
  c,
  pending,
  busy,
  error,
  onAnswer,
}: {
  c: Clarification;
  pending: Answer | null;
  busy: boolean;
  error: unknown;
  onAnswer: (choice: number | 'dismissed') => void;
}) {
  const isPending = (choice: number | 'dismissed') => pending?.id === c.id && pending.choice === choice;
  const ai = c.trigger === 'agent_question';
  return (
    <li className={c.resolution ? 'rounded-md border border-slate-200 bg-slate-50/60 p-3' : 'rounded-md border border-slate-300 bg-white p-3'}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={c.impact === 'blocking' ? 'red' : 'amber'} title={c.impact === 'blocking' ? 'Must be answered before approval' : 'May be dismissed'}>
          {c.impact}
        </Badge>
        <Badge tone="neutral" title="What raised this question">
          {c.trigger.replaceAll('_', ' ')}
        </Badge>
        {c.field && <code className="rounded bg-slate-100 px-1 text-[11px] text-slate-700">{c.field}</code>}
        {ai && <AiBadge />}
        <code className="ml-auto text-[11px] text-slate-400">{c.id}</code>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-900">{c.question}</p>

      {c.resolution ? (
        <p className="mt-1.5 text-xs text-emerald-800">
          <span aria-hidden>✓ </span>
          {c.resolution.choice === 'dismissed' ? (
            <>Dismissed</>
          ) : (
            <>
              Answered: <strong>“{c.options[c.resolution.choice]?.label ?? `option ${c.resolution.choice + 1}`}”</strong>
            </>
          )}{' '}
          by {c.resolution.by}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Answers for ${c.id}`}>
          {c.options.map((o, i) => (
            <Button key={i} size="sm" title={patchSummary(o)} loading={isPending(i)} disabled={busy} onClick={() => onAnswer(i)}>
              {o.label}
            </Button>
          ))}
          {c.impact === 'advisory' && (
            <Button size="sm" variant="ghost" loading={isPending('dismissed')} disabled={busy} onClick={() => onAnswer('dismissed')}>
              Dismiss
            </Button>
          )}
        </div>
      )}
      {error != null && (
        <div className="mt-2">
          <ErrorBanner error={error} title="Answer was not saved" />
        </div>
      )}
    </li>
  );
}
