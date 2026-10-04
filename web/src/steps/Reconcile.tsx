// Step 6: reconcile the target against what the executed plan version should have produced, and roll back if needed.
import { useQuery } from '@tanstack/react-query';
import { api, type Reconciliation } from '../api.ts';
import { AsyncPanel, Button } from '../components/ui.tsx';
import { ReconVerdict } from '../components/reconVerdict.tsx';
import { ReconEquations, ReconMoneyCheck, ReconTotals } from '../components/reconSummary.tsx';
import { ReconExceptions } from '../components/reconExceptions.tsx';
import { ReconActions } from '../components/reconActions.tsx';
import { ReconTargetTable } from '../components/reconTargetTable.tsx';

export function ReconcileStep() {
  const recon = useQuery({ queryKey: ['reconciliation'], queryFn: api.reconciliation });
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">6. Reconcile & rollback</h2>
          <p className="text-sm text-slate-500">
            Compares the dry-run's accepted records with the load ledger and the live target table, key by key and in total.
          </p>
        </div>
        <Button size="sm" onClick={() => void recon.refetch()} loading={recon.isFetching && !recon.isPending}>
          Recompute
        </Button>
      </div>

      <AsyncPanel query={recon} lines={8}>
        {(r) => <ReconReport r={r} workspaceName={info.data?.workspace.name ?? null} />}
      </AsyncPanel>

      <ReconTargetTable />
    </div>
  );
}

function ReconReport({ r, workspaceName }: { r: Reconciliation; workspaceName: string | null }) {
  const showExceptions = () => document.getElementById('recon-exceptions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="space-y-5">
      <ReconVerdict r={r} onShowExceptions={showExceptions} />
      <ReconTotals r={r} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ReconEquations r={r} />
        </div>
        <ReconMoneyCheck r={r} />
      </div>
      {r.verdict !== 'NOT_EXECUTED' && <ReconExceptions r={r} />}
      <ReconActions loadedActive={r.totals.loadedActive} workspaceName={workspaceName} />
    </div>
  );
}
