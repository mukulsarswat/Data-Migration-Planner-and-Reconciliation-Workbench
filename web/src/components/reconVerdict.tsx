// The one-glance answer to "does the target hold exactly what the executed plan version should have loaded?"
import type { ReactNode } from 'react';
import type { Reconciliation, Verdict } from '../api.ts';
import { useNav } from '../nav.tsx';
import { Badge, Button, cx } from './ui.tsx';

type VerdictStyle = { label: string; icon: string; box: string; icon_: string; title: string; description: string };

const VERDICTS: Record<Verdict, VerdictStyle> = {
  NOT_EXECUTED: {
    label: 'Not executed yet',
    icon: '○',
    box: 'border-slate-300 bg-white',
    icon_: 'bg-slate-100 text-slate-500',
    title: 'text-slate-900',
    description: 'Nothing has been loaded into the target from this workspace. Execute an approved, dry-run plan version, then come back to reconcile it.',
  },
  MATCHED: {
    label: 'Matched',
    icon: '✓',
    box: 'border-emerald-300 bg-emerald-50',
    icon_: 'bg-emerald-600 text-white',
    title: 'text-emerald-900',
    description: 'Every accepted record is in the target with identical values, all balance equations hold and the money check agrees to the cent.',
  },
  INCOMPLETE: {
    label: 'Incomplete',
    icon: '!',
    box: 'border-amber-300 bg-amber-50',
    icon_: 'bg-amber-500 text-white',
    title: 'text-amber-900',
    description: 'The last execution stopped before every accepted record was loaded. The rows that were loaded are correct; retry the failed run to load the rest (already-loaded rows are skipped).',
  },
  ROLLED_BACK_CLEAN: {
    label: 'Rolled back cleanly',
    icon: '↺',
    box: 'border-sky-300 bg-sky-50',
    icon_: 'bg-sky-600 text-white',
    title: 'text-sky-900',
    description: 'Every row this workspace loaded has been removed and the pre-existing rows are untouched. You can execute again whenever you are ready.',
  },
  MISMATCHED: {
    label: 'Mismatched',
    icon: '✗',
    box: 'border-rose-300 bg-rose-50',
    icon_: 'bg-rose-600 text-white',
    title: 'text-rose-900',
    description: 'The target does not match what the executed plan version should have produced. Check the failing equations and the exceptions below; rolling back restores the target.',
  },
};

export function ReconVerdict({ r, onShowExceptions }: { r: Reconciliation; onShowExceptions: () => void }) {
  const nav = useNav();
  const s = VERDICTS[r.verdict];
  const actions: Record<Verdict, ReactNode> = {
    NOT_EXECUTED: (
      <Button variant="primary" onClick={() => nav.go('execute')}>
        Go to Execute
      </Button>
    ),
    INCOMPLETE: (
      <Button variant="primary" onClick={() => nav.go('execute')}>
        Retry the failed run
      </Button>
    ),
    ROLLED_BACK_CLEAN: <Button onClick={() => nav.go('execute')}>Execute again</Button>,
    MISMATCHED: <Button onClick={onShowExceptions}>Review exceptions</Button>,
    MATCHED: <Button onClick={() => nav.go('history')}>View audit history</Button>,
  };
  const run = r.lastLoadRun;
  return (
    <section className={cx('rounded-lg border-2 p-5 shadow-sm', s.box)} aria-labelledby="recon-verdict">
      <div className="flex flex-wrap items-start gap-4">
        <span className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl font-bold', s.icon_)} aria-hidden>
          {s.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Reconciliation verdict</p>
          <h3 id="recon-verdict" className={cx('text-2xl font-semibold', s.title)}>
            {s.label} <span className="align-middle font-mono text-xs font-normal text-slate-500">{r.verdict}</span>
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-slate-700">{s.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            {r.version !== null ? <Badge tone="violet">plan v{r.version}</Badge> : <Badge>no version executed</Badge>}
            {run && (
              <Badge tone={run.status === 'succeeded' ? 'green' : run.status === 'running' ? 'amber' : 'red'}>
                last {run.kind === 'rollback' ? 'rollback' : 'load'}: run #{run.id} {run.status}
              </Badge>
            )}
            <Badge tone={r.preExistingIntact ? 'green' : 'red'}>{r.preExistingIntact ? '✓ pre-existing rows intact' : '✗ pre-existing rows changed'}</Badge>
          </div>
        </div>
        <div className="shrink-0">{actions[r.verdict]}</div>
      </div>
    </section>
  );
}
