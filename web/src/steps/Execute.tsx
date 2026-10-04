// Step 5: gated execution of an approved plan version, optional fault injection, retry of failed attempts,
// and per-run counts + load records.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api, type VersionSummary } from '../api.ts';
import { useActor, useNav, useRefreshAll, type StepId } from '../nav.tsx';
import { AsyncPanel, Button, Card, EmptyState, ErrorBanner } from '../components/ui.tsx';
import { VersionSelect } from '../components/runCommon.tsx';
import { GateChecklist, RunDetail, RunOutcomeBanner, RunsTable } from '../components/runExecutePanels.tsx';

const DEFAULT_FAIL_AFTER = 75;

export function ExecuteStep() {
  const nav = useNav();
  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans });
  return (
    <div className="space-y-4">
      <AsyncPanel
        query={plans}
        isEmpty={(d) => !d.items.some((v) => v.approval?.decision === 'approved')}
        empty={
          <EmptyState
            title="Approve a plan version first"
            description="Only an approved version can be executed. Review a version, dry run it, and approve it."
            action={<Button variant="primary" onClick={() => nav.go('review')}>Go to review</Button>}
          />
        }
      >
        {(d) => <ExecuteWorkspace approved={d.items.filter((v) => v.approval?.decision === 'approved')} />}
      </AsyncPanel>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => nav.go('reconcile')}>
          Next: reconcile →
        </Button>
      </div>
    </div>
  );
}

function ExecuteWorkspace({ approved }: { approved: VersionSummary[] }) {
  const nav = useNav();
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const latest = approved.reduce((a, b) => (b.version > a.version ? b : a));
  const selected = approved.find((v) => v.version === nav.version) ?? latest;
  const v = selected.version;

  const migration = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  const runs = useQuery({ queryKey: ['runs', 'execute,rollback'], queryFn: () => api.runs('execute,rollback') });
  const faultInjection = migration.data?.status.faultInjection ?? false;

  const [simulate, setSimulate] = useState(false);
  const [failAfterText, setFailAfterText] = useState(String(DEFAULT_FAIL_AFTER));
  const failAfter = Number(failAfterText);
  const failAfterValid = Number.isInteger(failAfter) && failAfter >= 1 && failAfter <= 10_000;
  const useFault = faultInjection && simulate;

  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const execute = useMutation({
    mutationFn: () => api.execute(v, actor, useFault ? failAfter : null),
    onSuccess: (run) => {
      setSelectedRunId(run.id);
      void refreshAll();
    },
  });
  const retry = useMutation({
    mutationFn: (runId: number) => api.retry(runId, actor),
    onSuccess: (run) => {
      setSelectedRunId(run.id);
      void refreshAll();
    },
  });

  const loadRuns = (runs.data?.items ?? []).filter((r) => r.kind === 'execute' || r.kind === 'rollback');
  const detailRun = loadRuns.find((r) => r.id === selectedRunId) ?? loadRuns[0] ?? null;

  return (
    <>
      <Card
        title="5. Execute"
        subtitle="Loads the accepted records of an approved plan version into the target, in committed batches, with every load recorded in a ledger."
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Execution gates for v{v}</h3>
            <p className="text-xs text-slate-500">
              Execution needs an approved version, a dry run of that exact plan hash, a dry-run reject rate within the error budget, and no rows still
              loaded by a different version.
            </p>
            <AsyncPanel query={runs} lines={5}>
              {(d) => <GateChecklist version={selected} runs={d.items} activeLoadedRows={migration.data?.status.activeLoadedRows ?? null} />}
            </AsyncPanel>
          </div>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              execute.mutate();
            }}
          >
            <VersionSelect
              id="execute-version"
              label="Approved version"
              versions={approved}
              value={v}
              onChange={(next) => {
                nav.selectVersion(next);
                execute.reset();
              }}
            />
            {faultInjection && (
              <fieldset className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3">
                <legend className="px-1 text-xs font-semibold text-amber-900">Crash-safety demo</legend>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <input id="simulate-failure" type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} className="h-4 w-4" />
                  <label htmlFor="simulate-failure">Simulate a failure after</label>
                  <label htmlFor="fail-after" className="sr-only">
                    Number of records before the simulated failure
                  </label>
                  <input
                    id="fail-after"
                    type="number"
                    min={1}
                    max={10_000}
                    step={1}
                    value={failAfterText}
                    disabled={!simulate}
                    onChange={(e) => setFailAfterText(e.target.value)}
                    aria-invalid={simulate && !failAfterValid}
                    aria-describedby="fail-after-help"
                    className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400"
                  />
                  <span>records</span>
                </div>
                <p id="fail-after-help" className="text-xs text-amber-900/80">
                  The run stops mid-load and is marked failed. Batches already committed stay loaded; Retry then finishes the job without duplicating
                  rows.
                </p>
                {simulate && !failAfterValid && <p className="text-xs font-medium text-rose-700">Enter a whole number between 1 and 10,000.</p>}
              </fieldset>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" loading={execute.isPending} disabled={(useFault && !failAfterValid) || retry.isPending}>
                {execute.isPending ? 'Executing…' : useFault ? `Execute v${v} (fail after ${failAfter})` : `Execute v${v}`}
              </Button>
              <span className="text-xs text-slate-500">as {actor}</span>
            </div>
            {execute.isError && <GateError error={execute.error} />}
            {execute.data && <RunOutcomeBanner run={execute.data} what="Execute" />}
          </form>
        </div>
      </Card>

      <Card
        title="Runs"
        subtitle="Executions, retries and rollbacks in this workspace (newest first)."
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-600">
            <strong className="font-medium text-slate-800">Why a retry never duplicates rows:</strong> the target's business key is UNIQUE (inserts use
            ON CONFLICT DO NOTHING) and the load ledger records every source record already loaded, so a retry skips those as skipped_existing.
          </p>
          {retry.isError && <GateError error={retry.error} title={`Retry of run #${retry.variables} was refused`} />}
          {retry.data && <RunOutcomeBanner run={retry.data} what={`Retry of #${retry.data.parentRunId}`} />}
          <AsyncPanel query={runs} lines={4}>
            {() => (
              <RunsTable
                runs={loadRuns}
                selectedId={detailRun?.id ?? null}
                onSelect={setSelectedRunId}
                onRetry={(id) => retry.mutate(id)}
                retryingId={retry.isPending ? (retry.variables ?? null) : null}
                retryBusy={retry.isPending || execute.isPending}
              />
            )}
          </AsyncPanel>
        </div>
      </Card>

      {detailRun && (
        <Card title={`Run #${detailRun.id} · ${detailRun.kind}${detailRun.version !== null ? ` · v${detailRun.version}` : ''}`} subtitle={`attempt ${detailRun.attempt} · by ${detailRun.actor}`}>
          <RunDetail run={detailRun} runs={runs.data?.items ?? []} />
        </Card>
      )}
    </>
  );
}

/** Next action for each gate refusal (409) so the message is actionable from where it is shown. */
const GATE_ACTIONS: Record<string, { label: string; step: StepId }> = {
  NOT_APPROVED: { label: 'Review and approve', step: 'review' },
  PLAN_REJECTED: { label: 'Review versions', step: 'review' },
  HASH_MISMATCH: { label: 'Review versions', step: 'review' },
  DRY_RUN_REQUIRED: { label: 'Run the dry run', step: 'dryrun' },
  ERROR_BUDGET_EXCEEDED: { label: 'Fix mappings or budget', step: 'review' },
  ROLLBACK_REQUIRED: { label: 'Roll back', step: 'reconcile' },
};

function GateError({ error, title }: { error: unknown; title?: string }) {
  const nav = useNav();
  const refreshAll = useRefreshAll();
  const code = error instanceof ApiError ? error.code : null;
  const isGate = error instanceof ApiError && error.status === 409;
  const action = code ? GATE_ACTIONS[code] : undefined;
  return (
    <div className="space-y-2">
      <ErrorBanner error={error} title={title ?? (isGate ? 'Execution blocked by a gate' : undefined)} />
      {action && (
        <Button size="sm" onClick={() => nav.go(action.step)}>
          {action.label} →
        </Button>
      )}
      {(code === 'RUN_IN_PROGRESS' || code === 'ALREADY_RETRIED') && (
        <Button size="sm" onClick={() => void refreshAll()}>
          Refresh runs
        </Button>
      )}
    </div>
  );
}
