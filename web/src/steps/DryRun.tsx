// Step 4: deterministic dry run of a plan version — counts, partition identities, determinism, error budget,
// conflict preflight, rejects by code/field and the quarantine with field-level evidence.
import type { ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type DryRunResponse, type Run, type VersionSummary } from '../api.ts';
import { useActor, useNav, useRefreshAll } from '../nav.tsx';
import { AsyncPanel, Banner, Button, Card, CountTile, EmptyState, ErrorBanner, Skeleton, fmt } from '../components/ui.tsx';
import { IdentityList, Section, VersionSelect, dryRunCountsOf, pctOf } from '../components/runCommon.tsx';
import { ByCodeTable, ByFieldTable, ConflictPreflightPanel, DeterminismPanel, ErrorBudgetPanel } from '../components/runDryRunPanels.tsx';
import { RunRecordsPanel } from '../components/runRecords.tsx';

// Full dry-run responses from this browser session, by run id. They add what the stored run lacks
// (the preflight key list); everything else is re-derived from GET /api/runs so reloads look the same.
const sessionResults = new Map<number, DryRunResponse>();

export function DryRunStep() {
  const nav = useNav();
  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans });
  return (
    <div className="space-y-4">
      <AsyncPanel
        query={plans}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            title="No plan version yet"
            description="A dry run needs a mapping plan. Draft one with the agent or the heuristic first."
            action={<Button variant="primary" onClick={() => nav.go('proposal')}>Go to proposal</Button>}
          />
        }
      >
        {(d) => <DryRunWorkspace versions={d.items} />}
      </AsyncPanel>
    </div>
  );
}

function DryRunWorkspace({ versions }: { versions: VersionSummary[] }) {
  const nav = useNav();
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const selected = versions.find((v) => v.version === nav.version) ?? latest;
  const v = selected.version;

  const runs = useQuery({ queryKey: ['runs', 'dry_run'], queryFn: () => api.runs('dry_run') });
  const run = useMutation({
    mutationFn: () => api.dryRun(v, actor),
    onSuccess: (res) => {
      sessionResults.set(res.run.id, res);
      void refreshAll();
    },
  });
  const justRan = run.data && run.data.run.version === v ? run.data : null;

  const runButton = (
    <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>
      {run.isPending ? 'Running…' : `Run dry run of v${v}`}
    </Button>
  );

  return (
    <>
      <Card
        title="4. Dry run"
        subtitle="Transforms and validates every source record against the target schema. Nothing is written to the target."
        actions={
          <>
            <VersionSelect
              id="dryrun-version"
              versions={versions}
              value={v}
              onChange={(next) => {
                nav.selectVersion(next);
                run.reset();
              }}
            />
            {runButton}
          </>
        }
      >
        <div className="space-y-3">
          {run.isError && <ErrorBanner error={run.error} title={`Dry run of v${v} failed`} />}
          {justRan && (
            <Banner tone="success" title={`Dry run #${justRan.run.id} of v${v} finished`}>
              {justRan.counts.accepted} accepted, {justRan.counts.rejected} rejected of {justRan.counts.source} source records · result{' '}
              <code className="font-mono">{fmt.hash(justRan.resultHash)}</code>
              {justRan.deterministicMatch === true && ' · identical to the previous dry run'}
            </Banner>
          )}
          <AsyncPanel query={runs} lines={4}>
            {(d) => <LatestDryRun version={selected} runs={d.items} justRan={justRan} runButton={runButton} />}
          </AsyncPanel>
        </div>
      </Card>
      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={() => {
            nav.selectVersion(v);
            nav.go('execute');
          }}
        >
          Next: execute →
        </Button>
      </div>
    </>
  );
}

function LatestDryRun({
  version,
  runs,
  justRan,
  runButton,
}: {
  version: VersionSummary;
  runs: Run[];
  justRan: DryRunResponse | null;
  runButton: ReactNode;
}) {
  const dryRuns = runs.filter((r) => r.kind === 'dry_run' && r.version === version.version);
  // Right after a run, show it even before the refetched list contains it.
  const listed = dryRuns[0] ?? null;
  const current = justRan && (!listed || justRan.run.id > listed.id) ? justRan.run : listed;
  if (!current) {
    return (
      <EmptyState
        title={`No dry run yet for v${version.version}`}
        description="Run one to see how many records would load, which would be quarantined and why, and whether the reject rate fits the error budget."
        action={runButton}
      />
    );
  }
  const session = sessionResults.get(current.id) ?? (justRan?.run.id === current.id ? justRan : null);
  const previous =
    runs.find((r) => r.kind === 'dry_run' && r.status === 'succeeded' && r.planHash === current.planHash && r.id < current.id) ?? null;
  return <DryRunReport run={current} session={session} previous={previous} />;
}

function DryRunReport({ run, session, previous }: { run: Run; session: DryRunResponse | null; previous: Run | null }) {
  const c = session ? { ...session.counts, conflictPreflight: session.conflictPreflight.length } : dryRunCountsOf(run);
  const match = session ? session.deterministicMatch : previous ? previous.resultHash === run.resultHash : null;
  const rejectRatePct = session?.rejectRatePct ?? pctOf(c.rejected, c.source);
  const initialOutcome = c.transformFailed > 0 ? 'transform_failed' : c.validationRejected > 0 ? 'validation_rejected' : 'accepted';

  return (
    <div className="space-y-6">
      <p className="text-xs text-slate-500">
        Showing dry run <strong className="text-slate-700">#{run.id}</strong> of v{run.version} by {run.actor} · {fmt.time(run.finishedAt ?? run.startedAt)}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <CountTile label="Source" value={c.source} hint="records read" />
        <CountTile label="Transformed" value={c.transformed} tone="blue" hint={`${c.transformFailed} transform_failed`} />
        <CountTile label="Accepted" value={c.accepted} tone="green" hint="would load" />
        <CountTile
          label="Rejected"
          value={c.rejected}
          tone={c.rejected > 0 ? 'red' : 'neutral'}
          hint={`${c.transformFailed} transform_failed · ${c.validationRejected} validation_rejected`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Partition" hint="Every source record ends in exactly one outcome.">
          <IdentityList
            items={[
              { lhs: ['source', c.source], rhs: [['transform_failed', c.transformFailed], ['transformed', c.transformed]] },
              { lhs: ['transformed', c.transformed], rhs: [['accepted', c.accepted], ['validation_rejected', c.validationRejected]] },
              { lhs: ['rejected', c.rejected], rhs: [['transform_failed', c.transformFailed], ['validation_rejected', c.validationRejected]] },
            ]}
          />
        </Section>
        <DeterminismPanel
          resultHash={run.resultHash}
          planHash={run.planHash}
          previousResultHash={session?.previousResultHash ?? previous?.resultHash ?? null}
          match={match}
        />
        <BudgetFor version={run.version} session={session} rejectRatePct={rejectRatePct} rejected={c.rejected} source={c.source} />
        <ConflictPreflightPanel keys={session?.conflictPreflight ?? null} count={c.conflictPreflight} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ByCodeTable byCode={c.byCode} />
        <ByFieldTable byField={c.byField} />
      </div>

      <Section
        title="Quarantine"
        hint="Each record with its raw source values (fields involved in an error are highlighted) and one evidence row per problem."
      >
        <RunRecordsPanel
          key={run.id}
          runId={run.id}
          initial={initialOutcome}
          options={[
            { value: 'transform_failed', label: 'transform_failed', count: c.transformFailed },
            { value: 'validation_rejected', label: 'validation_rejected', count: c.validationRejected },
            { value: 'accepted', label: 'accepted', count: c.accepted },
          ]}
          emptyHint={(o) => (o === 'accepted' ? 'Every record was rejected; fix the mappings in Review.' : 'Nothing was quarantined for this reason.')}
        />
      </Section>
    </div>
  );
}

/** The budget lives in the plan (it is part of the plan hash); a stored run needs the plan to know it. */
function BudgetFor({
  version,
  session,
  rejectRatePct,
  rejected,
  source,
}: {
  version: number | null;
  session: DryRunResponse | null;
  rejectRatePct: number;
  rejected: number;
  source: number;
}) {
  const plan = useQuery({
    queryKey: ['plan', version],
    queryFn: () => api.plan(version!),
    enabled: !session && version !== null,
  });
  if (session) return <ErrorBudgetPanel rejectRatePct={rejectRatePct} budgetPct={session.errorBudgetPct} rejected={rejected} source={source} />;
  if (version === null) return null;
  if (plan.isError) return <ErrorBanner error={plan.error} title="Cannot load the error budget" onRetry={() => void plan.refetch()} />;
  if (!plan.data) return <Skeleton lines={3} />;
  return <ErrorBudgetPanel rejectRatePct={rejectRatePct} budgetPct={plan.data.plan.errorBudgetPct} rejected={rejected} source={source} />;
}
