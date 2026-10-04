// Destructive actions on the Reconcile step, each behind a confirmation Dialog: the ledger-scoped rollback and
// "start a new workspace" (which first rolls back as a normal, recorded rollback run).
import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../api.ts';
import { useActor, useNav, useRefreshAll } from '../nav.tsx';
import { Banner, Button, Card, Dialog, ErrorBanner } from './ui.tsx';

const rows = (n: number) => `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;

export function ReconActions({ loadedActive, workspaceName }: { loadedActive: number; workspaceName: string | null }) {
  return (
    <Card title="Rollback & workspace" subtitle="Both actions are recorded in History and never touch rows this workspace did not insert.">
      <div className="grid gap-6 md:grid-cols-2">
        <RollbackAction loadedActive={loadedActive} />
        <NewWorkspaceAction loadedActive={loadedActive} workspaceName={workspaceName} />
      </div>
    </Card>
  );
}

function RollbackAction({ loadedActive }: { loadedActive: number }) {
  const actor = useActor();
  const nav = useNav();
  const refreshAll = useRefreshAll();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const rollback = useMutation({
    mutationFn: (why: string) => api.rollback(actor, why),
    onSuccess: () => {
      setOpen(false);
      void refreshAll();
    },
  });
  const start = () => {
    rollback.reset();
    setReason('');
    setOpen(true);
  };

  const outcome = rollback.isSuccess ? (
    <Banner tone="success" title={`Rolled back ${rows(rollback.data.counts.deleted)}`} actions={<Button size="sm" onClick={() => nav.go('execute')}>Go to Execute</Button>}>
      Rollback run #{rollback.data.run.id} is recorded in History. Pre-existing rows were not touched; you can execute again from step 5.
    </Banner>
  ) : rollback.isError ? (
    <RollbackError error={rollback.error} />
  ) : null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-900">Roll back loaded rows</h3>
      <p className="text-xs text-slate-600">
        {loadedActive > 0
          ? `This workspace currently has ${rows(loadedActive)} loaded into the target.`
          : 'This workspace has no loaded rows right now, so there is nothing to roll back.'}
      </p>
      <Button variant="danger" onClick={start} loading={rollback.isPending}>
        Roll back this workspace's loaded rows…
      </Button>
      {!open && outcome}

      <Dialog
        open={open}
        title="Roll back this workspace's loaded rows?"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={rollback.isPending}>
              Cancel
            </Button>
            <Button variant="danger" loading={rollback.isPending} onClick={() => rollback.mutate(reason.trim())}>
              {loadedActive > 0 ? `Roll back ${rows(loadedActive)}` : 'Roll back'}
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Deletes <strong>only</strong> the target rows this workspace inserted, as recorded in the load ledger
            {loadedActive > 0 ? ` (${rows(loadedActive)})` : ''}.
          </li>
          <li>Pre-existing rows and rows loaded by other workspaces are left untouched.</li>
          <li>Runs in one transaction and is recorded in History as a rollback run.</li>
          <li>You can execute the approved plan again afterwards.</li>
        </ul>
        <label htmlFor={reasonId} className="mt-4 block text-xs font-medium text-slate-700">
          Reason (optional, shown in History)
        </label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="e.g. balances mismatched; reloading after fixing the currency mapping"
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        {open && outcome && <div className="mt-3">{outcome}</div>}
      </Dialog>
    </div>
  );
}

/** 409 NOTHING_TO_ROLL_BACK is an expected state, not a failure: show it as information. */
function RollbackError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'NOTHING_TO_ROLL_BACK') {
    return (
      <Banner tone="info" title="Nothing to roll back">
        {error.message}. The target already holds no rows from this workspace.
      </Banner>
    );
  }
  return <ErrorBanner error={error} title="Rollback failed" />;
}

function NewWorkspaceAction({ loadedActive, workspaceName }: { loadedActive: number; workspaceName: string | null }) {
  const actor = useActor();
  const nav = useNav();
  const refreshAll = useRefreshAll();
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: () => api.newWorkspace(actor),
    onSuccess: () => {
      setOpen(false);
      nav.selectVersion(null); // plan versions belong to the old workspace
      void refreshAll();
    },
  });
  const start = () => {
    create.reset();
    setOpen(true);
  };

  const outcome = create.isSuccess ? (
    <Banner tone="success" title={`Started ${create.data.workspace.name}`} actions={<Button size="sm" onClick={() => nav.go('proposal')}>Draft a plan</Button>}>
      {create.data.rolledBack > 0
        ? `Rolled back ${rows(create.data.rolledBack)} from the previous workspace first (recorded in History). `
        : 'The previous workspace had no loaded rows, so nothing was rolled back. '}
      Its history is preserved under "All workspaces".
    </Banner>
  ) : create.isError ? (
    <ErrorBanner error={create.error} title="Could not start a new workspace" />
  ) : null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-900">Start over in a clean workspace</h3>
      <p className="text-xs text-slate-600">Begin a fresh plan → approve → execute cycle against the same dataset.</p>
      <Button onClick={start} loading={create.isPending}>
        Start a new workspace…
      </Button>
      {!open && outcome}

      <Dialog
        open={open}
        title="Start a new workspace?"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Start new workspace
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {loadedActive > 0
              ? `First rolls back the ${rows(loadedActive)} ${workspaceName ? `“${workspaceName}”` : 'the current workspace'} loaded, as a recorded rollback run.`
              : 'The current workspace has no loaded rows, so nothing needs to be rolled back.'}
          </li>
          <li>Then makes a new, empty workspace current: no plan versions, runs or loaded rows.</li>
          <li>Nothing is deleted from history: plans, approvals, runs and events of earlier workspaces stay visible in History.</li>
        </ul>
        {open && outcome && <div className="mt-3">{outcome}</div>}
      </Dialog>
    </div>
  );
}
