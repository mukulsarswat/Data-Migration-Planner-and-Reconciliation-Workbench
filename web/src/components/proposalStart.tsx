// The two ways to get a draft plan: run the AI agent (optionally revising a version, with reviewer notes) or the
// deterministic heuristic. Both create a new plan version that a human must review and approve.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api, type AgentRun, type MigrationInfo } from '../api.ts';
import { useActor, useRefreshAll } from '../nav.tsx';
import { AsyncPanel, Badge, Banner, Button, Card, ErrorBanner } from './ui.tsx';
import { AgentFailurePanel, HeuristicDraftButton } from './proposalShared.tsx';

const MAX_NOTES = 1000;

type StartProps = { activeRun: AgentRun | null; onStarted: (id: number) => void; onShowRun: (id: number) => void };

export function AgentStartCard(props: StartProps) {
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  const llm = info.data?.status.llm;
  return (
    <Card
      title="Run AI agent"
      subtitle="The agent inspects schemas, profiles and masked samples, previews candidate mappings, then submits a plan that the server re-validates."
      actions={llm && <Badge tone={llm.configured ? 'blue' : 'neutral'}>{llm.configured ? llm.model : 'not configured'}</Badge>}
    >
      <AsyncPanel query={info} lines={4}>
        {(d) => <AgentStartForm llm={d.status.llm} {...props} />}
      </AsyncPanel>
    </Card>
  );
}

function AgentStartForm({ llm, activeRun, onStarted, onShowRun }: StartProps & { llm: MigrationInfo['status']['llm'] }) {
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const [base, setBase] = useState('');
  const [notes, setNotes] = useState('');
  const start = useMutation({
    mutationFn: () => api.startAgent(actor, base ? Number(base) : null, notes.trim() || null),
    onSuccess: (run) => {
      onStarted(run.id);
      void refreshAll();
    },
  });

  const disabledReason = !llm.configured
    ? 'Unavailable: no ANTHROPIC_API_KEY is configured on the server. Use the heuristic draft instead.'
    : activeRun
      ? `Agent run #${activeRun.id} is ${activeRun.status}; only one run at a time.`
      : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabledReason) start.mutate();
      }}
    >
      {!llm.configured && (
        <Banner tone="warning" title="AI agent not configured on this deployment">
          The server has no ANTHROPIC_API_KEY, so only the deterministic heuristic draft is available. The rest of the workbench works the same.
        </Banner>
      )}

      <PlanBaseSelect value={base} onChange={setBase} disabled={!llm.configured} />

      <div>
        <label htmlFor="agent-notes" className="text-xs font-medium text-slate-700">
          Reviewer notes <span className="font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id="agent-notes"
          rows={3}
          maxLength={MAX_NOTES}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={!llm.configured}
          aria-describedby="agent-notes-hint"
          placeholder="e.g. Unknown status codes should become inactive; fax is out of scope."
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
        />
        <p id="agent-notes-hint" className="mt-0.5 flex justify-between gap-2 text-xs text-slate-500">
          <span>Guidance for the agent. It cannot change which tools the agent may use.</span>
          <span className="tabular-nums">
            {notes.length}/{MAX_NOTES}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={start.isPending}
          disabled={disabledReason !== null}
          aria-describedby={disabledReason ? 'agent-disabled-reason' : undefined}
        >
          {start.isPending ? 'Starting…' : 'Run AI agent'}
        </Button>
        {activeRun && llm.configured && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onShowRun(activeRun.id)}>
            Show run #{activeRun.id}
          </Button>
        )}
      </div>
      {disabledReason && (
        <p id="agent-disabled-reason" className="text-xs text-slate-600">
          {disabledReason}
        </p>
      )}

      {start.isError && <StartError error={start.error} onRetry={() => start.mutate()} />}
      {start.isSuccess && (
        <Banner tone="success" title={`Agent run #${start.data.id} started`}>
          Follow its live trace under Agent runs below. A new plan version is created when it succeeds.
        </Banner>
      )}
    </form>
  );
}

/** Agent-specific refusals (409 in progress / not configured, 429 cap) get the explained failure state with the heuristic fallback. */
function StartError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const agentRefusal = error instanceof ApiError && (error.status === 409 || error.status === 429 || error.status >= 500);
  if (!agentRefusal) return <ErrorBanner error={error} title="The AI agent could not start" onRetry={onRetry} />;
  return <AgentFailurePanel title="The AI agent could not start" code={error.code} message={error.message} requestId={error.requestId} />;
}

function PlanBaseSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans });
  return (
    <div>
      <label htmlFor="agent-base" className="text-xs font-medium text-slate-700">
        Revise version <span className="font-normal text-slate-500">(optional)</span>
      </label>
      <AsyncPanel query={plans} lines={1}>
        {(d) => {
          const versions = [...d.items].sort((a, b) => b.version - a.version);
          return (
            <>
              <select
                id="agent-base"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:bg-slate-50"
              >
                <option value="">Fresh proposal (no base version)</option>
                {versions.map((v) => (
                  <option key={v.version} value={String(v.version)}>
                    {`v${v.version} · ${v.author}${v.approval ? ` · ${v.approval.decision}` : ''}${
                      v.unresolvedClarifications ? ` · ${v.unresolvedClarifications} open question(s)` : ''
                    }`}
                  </option>
                ))}
              </select>
              <p className="mt-0.5 text-xs text-slate-500">
                {versions.length === 0
                  ? 'No versions yet: the agent drafts from scratch.'
                  : 'The agent receives the selected version (including answered clarifications) and proposes a revision as a new version.'}
              </p>
            </>
          );
        }}
      </AsyncPanel>
    </div>
  );
}

export function HeuristicCard() {
  return (
    <Card title="Generate heuristic draft (no AI)" subtitle="Always available · deterministic · instant">
      <p className="text-sm text-slate-700">
        Builds a plan without any language model: target fields are matched to source fields by name and synonym similarity, field profiles
        (formats, value sets, key-likeness) pick the conversion recipe, and unresolved gaps become clarification questions for you.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
        <li>Same inputs always produce the same plan: no API key, no cost.</li>
        <li>A useful baseline to compare against the agent’s proposal.</li>
        <li>Like any draft, it must be reviewed and approved by a human.</li>
      </ul>
      <div className="mt-4">
        <HeuristicDraftButton label="Generate heuristic draft" />
      </div>
    </Card>
  );
}
