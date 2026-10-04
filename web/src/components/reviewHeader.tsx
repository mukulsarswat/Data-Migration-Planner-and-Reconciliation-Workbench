// Header of the selected version: identity, decision state, and the actions (dry run, edit, approve, reject).
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type DryRunResponse, type VersionDetail } from '../api.ts';
import { useActor, useNav, useRefreshAll } from '../nav.tsx';
import { Badge, Banner, Button, ErrorBanner, fmt } from './ui.tsx';
import { ApprovalBadge, AuthorBadge } from './reviewShared.tsx';
import { DryRunSummary } from './reviewDryRun.tsx';
import { ApproveDialog, RejectDialog } from './reviewDecision.tsx';

export function VersionHeader({
  detail,
  dryRun,
  onDryRun,
  onEdit,
}: {
  detail: VersionDetail;
  dryRun: DryRunResponse | null;
  onDryRun: (result: DryRunResponse) => void;
  onEdit: () => void;
}) {
  const nav = useNav();
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  const dry = useMutation({
    mutationFn: () => api.dryRun(detail.version, actor),
    onSuccess: (res) => {
      onDryRun(res);
      void refreshAll();
    },
  });
  const decision = detail.approval;
  const approvalBlockers = detail.approvalIssues.filter((i) => i.severity === 'blocker').length;

  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm" aria-label={`Plan version ${detail.version}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold tabular-nums text-slate-900">v{detail.version}</h3>
            <AuthorBadge author={detail.author} />
            <ApprovalBadge approval={decision} />
            {!decision &&
              (approvalBlockers ? (
                <Badge tone="red">
                  {approvalBlockers} approval blocker{approvalBlockers === 1 ? '' : 's'}
                </Badge>
              ) : (
                <Badge tone="green">ready to approve</Badge>
              ))}
          </div>
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            <div>
              <dt className="inline text-slate-400">by </dt>
              <dd className="inline">{detail.actor}</dd>
            </div>
            <div>
              <dt className="inline text-slate-400">created </dt>
              <dd className="inline">{fmt.time(detail.createdAt)}</dd>
            </div>
            <div>
              <dt className="inline text-slate-400">plan hash </dt>
              <dd className="inline font-mono" title={detail.planHash}>
                {fmt.hash(detail.planHash)}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-400">parent </dt>
              <dd className="inline">
                {detail.parentVersion === null ? (
                  'none (first draft)'
                ) : (
                  <button type="button" className="text-indigo-700 underline" onClick={() => nav.selectVersion(detail.parentVersion)}>
                    v{detail.parentVersion}
                  </button>
                )}
              </dd>
            </div>
            {detail.agentRunId !== null && (
              <div>
                <dt className="inline text-slate-400">agent run </dt>
                <dd className="inline">#{detail.agentRunId}</dd>
              </div>
            )}
          </dl>
          {detail.changeNote && <p className="mt-1.5 text-sm text-slate-700">{detail.changeNote}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => dry.mutate()} loading={dry.isPending}>
            Dry run this version
          </Button>
          <Button onClick={onEdit} title="Saving an edit creates a new version; this one never changes">
            Edit plan
          </Button>
          <Button
            variant="primary"
            disabled={decision !== null}
            title={decision ? `Already ${decision.decision}` : undefined}
            onClick={() => {
              setDecided(null);
              setDialog('approve');
            }}
          >
            Approve…
          </Button>
          <Button
            variant="danger"
            disabled={decision !== null}
            title={decision ? `Already ${decision.decision}` : undefined}
            onClick={() => {
              setDecided(null);
              setDialog('reject');
            }}
          >
            Reject…
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-100 px-4 py-3 empty:hidden">
        {decided && <Banner tone="success" title={decided} />}
        {decision && (
          <Banner
            tone={decision.decision === 'approved' ? 'success' : 'warning'}
            title={`${decision.decision === 'approved' ? 'Approved' : 'Rejected'} by ${decision.reviewer} · ${fmt.time(decision.createdAt)}`}
            actions={
              decision.decision === 'approved' && (
                <Button
                  size="sm"
                  onClick={() => {
                    nav.selectVersion(detail.version);
                    nav.go('execute');
                  }}
                >
                  Go to Execute →
                </Button>
              )
            }
          >
            {decision.comment && <p className="whitespace-pre-wrap">“{decision.comment}”</p>}
            <p className="mt-1">
              This decision is final and bound to plan hash <code className="font-mono">{fmt.hash(decision.planHash)}</code>. Changes require a new
              version: use <strong>Edit plan</strong> or answer a clarification.
            </p>
          </Banner>
        )}
        {dry.isError && <ErrorBanner error={dry.error} title="Dry run failed" onRetry={() => dry.mutate()} />}
        {dryRun && <DryRunSummary result={dryRun} version={detail.version} />}
      </div>

      {dialog === 'approve' && (
        <ApproveDialog
          detail={detail}
          dryRun={dryRun}
          dryRunPending={dry.isPending}
          dryRunError={dry.error}
          onDryRun={() => dry.mutate()}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setDecided(msg);
          }}
        />
      )}
      {dialog === 'reject' && (
        <RejectDialog
          detail={detail}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setDecided(msg);
          }}
        />
      )}
    </section>
  );
}
