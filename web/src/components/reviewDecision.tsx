// Approve / Reject dialogs. Approval is a human gate bound to the exact plan hash; the server re-checks every blocker.
import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type DryRunResponse, type PlanIssue, type VersionDetail } from '../api.ts';
import { useNav, useRefreshAll } from '../nav.tsx';
import { Banner, Button, Dialog, ErrorBanner, cx, fmt } from './ui.tsx';
import { DryRunSummary } from './reviewDryRun.tsx';

const inputCls = 'mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

function ReviewerFields({
  reviewer,
  setReviewer,
  comment,
  setComment,
  commentLabel,
}: {
  reviewer: string;
  setReviewer: (s: string) => void;
  comment: string;
  setComment: (s: string) => void;
  commentLabel: string;
}) {
  const missing = reviewer.trim() === '';
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-xs font-medium text-slate-700">
        Reviewer name <span className="text-rose-600">*</span>
        <input
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          maxLength={60}
          required
          aria-required
          aria-invalid={missing || undefined}
          placeholder="your name"
          className={inputCls}
          autoFocus
        />
        {missing && <span className="mt-1 block font-normal text-rose-700">Required: decisions are attributed to a named reviewer.</span>}
      </label>
      <label className="block text-xs font-medium text-slate-700 sm:col-span-2">
        {commentLabel}
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} className={inputCls} />
      </label>
    </div>
  );
}

function CheckItem({ state, label, children }: { state: 'ok' | 'fail' | 'advice'; label: ReactNode; children?: ReactNode }) {
  const icon = { ok: '✓', fail: '✗', advice: '!' }[state];
  const tone = { ok: 'bg-emerald-100 text-emerald-700', fail: 'bg-rose-100 text-rose-700', advice: 'bg-amber-100 text-amber-800' }[state];
  const sr = { ok: 'Passed', fail: 'Blocking', advice: 'Recommended' }[state];
  return (
    <li className="flex gap-2">
      <span aria-hidden className={cx('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', tone)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-800">
          <span className="sr-only">{sr}: </span>
          {label}
        </p>
        {children}
      </div>
    </li>
  );
}

function IssueList({ issues }: { issues: PlanIssue[] }) {
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
      {issues.map((i, k) => (
        <li key={k}>
          <code className="text-[11px] text-slate-500">{i.code}</code>
          {i.field && <code className="ml-1 text-[11px]">{i.field}</code>} — {i.message}
        </li>
      ))}
    </ul>
  );
}

export function ApproveDialog({
  detail,
  dryRun,
  dryRunPending,
  dryRunError,
  onDryRun,
  onClose,
  onDone,
}: {
  detail: VersionDetail;
  dryRun: DryRunResponse | null;
  dryRunPending: boolean;
  dryRunError: unknown;
  onDryRun: () => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const nav = useNav();
  const refreshAll = useRefreshAll();
  const [reviewer, setReviewer] = useState(nav.reviewer);
  const [comment, setComment] = useState('');
  const blockers = detail.approvalIssues.filter((i) => i.severity === 'blocker');
  const warnings = detail.approvalIssues.filter((i) => i.severity === 'warning');
  const approve = useMutation({
    mutationFn: () => api.approve(detail.version, reviewer.trim(), comment.trim()),
    onSuccess: (res) => {
      // Remember the reviewer for later actions if the header field was blank.
      if (!nav.reviewer.trim()) nav.setReviewer(reviewer.trim());
      onDone(`v${res.version} approved by ${res.approval?.reviewer ?? reviewer.trim()} — bound to plan hash ${fmt.hash(res.planHash)}.`);
      void refreshAll();
    },
  });
  const canApprove = reviewer.trim() !== '' && blockers.length === 0;
  return (
    <Dialog
      open
      title={`Approve v${detail.version}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={approve.isPending} disabled={!canApprove} onClick={() => approve.mutate()}>
            Approve v{detail.version}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ReviewerFields reviewer={reviewer} setReviewer={setReviewer} comment={comment} setComment={setComment} commentLabel="Comment (optional)" />
        <section aria-label="Approval checklist">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Checklist</h4>
          <ul className="space-y-2">
            <CheckItem
              state={blockers.length ? 'fail' : 'ok'}
              label={
                blockers.length
                  ? `${blockers.length} blocking issue${blockers.length === 1 ? '' : 's'} — fix them in a new version (edit the plan or answer the clarifications)`
                  : 'No blocking issues: references, types, required targets, source accounting and clarifications all check out'
              }
            >
              {blockers.length > 0 && <IssueList issues={blockers} />}
            </CheckItem>
            {warnings.length > 0 && (
              <CheckItem state="advice" label={`${warnings.length} warning${warnings.length === 1 ? '' : 's'} (do not block approval)`}>
                <IssueList issues={warnings} />
              </CheckItem>
            )}
            <CheckItem state={reviewer.trim() ? 'ok' : 'fail'} label="Reviewer named" />
            <CheckItem
              state={dryRun ? (dryRun.withinErrorBudget ? 'ok' : 'advice') : 'advice'}
              label={dryRun ? 'Dry run of this version (this session)' : 'Not dry-run in this session yet — recommended before approving'}
            >
              <div className="mt-1.5 space-y-2">
                {dryRun ? (
                  <DryRunSummary result={dryRun} version={detail.version} showLink={false} />
                ) : (
                  <Button size="sm" loading={dryRunPending} onClick={onDryRun}>
                    Dry run v{detail.version} now
                  </Button>
                )}
                {dryRunError != null && <ErrorBanner error={dryRunError} title="Dry run failed" />}
              </div>
            </CheckItem>
          </ul>
        </section>
        <Banner tone="info" title={<>Approval binds to plan hash <code className="font-mono">{fmt.hash(detail.planHash)}</code></>}>
          The decision is final for v{detail.version}. Execution re-checks this hash; any later change creates a new version that needs its own approval.
        </Banner>
        {approve.isError && <ErrorBanner error={approve.error} title="Approval was not recorded" />}
      </div>
    </Dialog>
  );
}

export function RejectDialog({ detail, onClose, onDone }: { detail: VersionDetail; onClose: () => void; onDone: (message: string) => void }) {
  const nav = useNav();
  const refreshAll = useRefreshAll();
  const [reviewer, setReviewer] = useState(nav.reviewer);
  const [comment, setComment] = useState('');
  const reject = useMutation({
    mutationFn: () => api.reject(detail.version, reviewer.trim(), comment.trim()),
    onSuccess: (res) => {
      if (!nav.reviewer.trim()) nav.setReviewer(reviewer.trim());
      onDone(`v${res.version} rejected by ${res.approval?.reviewer ?? reviewer.trim()}.`);
      void refreshAll();
    },
  });
  return (
    <Dialog
      open
      title={`Reject v${detail.version}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={reject.isPending} disabled={!reviewer.trim()} onClick={() => reject.mutate()}>
            Reject v{detail.version}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ReviewerFields
          reviewer={reviewer}
          setReviewer={setReviewer}
          comment={comment}
          setComment={setComment}
          commentLabel="What should change? (recommended — recorded in history)"
        />
        <p className="text-xs text-slate-600">
          Rejection is final for v{detail.version}. To move forward, edit the plan or answer its clarifications — each creates a new version for review.
        </p>
        {reject.isError && <ErrorBanner error={reject.error} title="Rejection was not recorded" />}
      </div>
    </Dialog>
  );
}
