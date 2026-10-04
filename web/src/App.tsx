import { Component, Suspense, lazy, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';
import { NavProvider, STEPS, useNav, type StepId } from './nav.tsx';
import { Badge, Banner, Button, ErrorBanner, Skeleton, cx } from './components/ui.tsx';
// Each step is its own chunk: the first paint only loads the shell + the active step.
const InputsStep = lazy(() => import('./steps/Inputs.tsx').then((m) => ({ default: m.InputsStep })));
const ProposalStep = lazy(() => import('./steps/Proposal.tsx').then((m) => ({ default: m.ProposalStep })));
const ReviewStep = lazy(() => import('./steps/Review.tsx').then((m) => ({ default: m.ReviewStep })));
const DryRunStep = lazy(() => import('./steps/DryRun.tsx').then((m) => ({ default: m.DryRunStep })));
const ExecuteStep = lazy(() => import('./steps/Execute.tsx').then((m) => ({ default: m.ExecuteStep })));
const ReconcileStep = lazy(() => import('./steps/Reconcile.tsx').then((m) => ({ default: m.ReconcileStep })));
const HistoryStep = lazy(() => import('./steps/History.tsx').then((m) => ({ default: m.HistoryStep })));
const LogsStep = lazy(() => import('./steps/Logs.tsx').then((m) => ({ default: m.LogsStep })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // Don't hammer the server on client errors (4xx); retry transient failures once.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
    },
  },
});

const VIEWS: Record<StepId, () => ReactNode> = {
  inputs: () => <InputsStep />,
  proposal: () => <ProposalStep />,
  review: () => <ReviewStep />,
  dryrun: () => <DryRunStep />,
  execute: () => <ExecuteStep />,
  reconcile: () => <ReconcileStep />,
  history: () => <HistoryStep />,
  logs: () => <LogsStep />,
};

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NavProvider>
        <Shell />
      </NavProvider>
    </QueryClientProvider>
  );
}

function Shell() {
  const nav = useNav();
  return (
    <div className="workbench-shell min-h-screen text-slate-900">
      <header className="workbench-header">
        <div className="workbench-header-inner mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">MW</span>
            <div>
              <p className="brand-eyebrow">DATA OPERATIONS / MIGRATION 01</p>
              <h1 className="brand-title">Migration Workbench</h1>
              <p className="brand-description">legacy_customers <span aria-hidden="true">→</span> accounts <span className="brand-divider">/</span> AI-assisted planning, human-approved execution</p>
            </div>
          </div>
          <label className="reviewer-field flex items-center gap-2 text-xs">
            Reviewer
            <input
              value={nav.reviewer}
              onChange={(e) => nav.setReviewer(e.target.value)}
              placeholder="your name"
              maxLength={60}
              className="reviewer-input w-40 rounded-md border px-3 py-2 text-sm"
            />
          </label>
        </div>
        <StatusBar />
        <nav className="workbench-nav-desktop mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4" aria-label="Workflow steps">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => nav.go(s.id)}
              aria-current={nav.step === s.id ? 'page' : undefined}
              className={cx(
                'workbench-step whitespace-nowrap border-b-2 px-3 py-3 text-sm',
                nav.step === s.id ? 'workbench-step-active font-semibold' : 'border-transparent text-slate-600 hover:text-slate-900',
              )}
            >
              {i < 6 && <span className="step-number">{i + 1}</span>}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="workbench-nav-mobile">
          <label htmlFor="workflow-step">Workflow</label>
          <select id="workflow-step" value={nav.step} onChange={(e) => nav.go(e.target.value as StepId)}>
            {STEPS.map((s, i) => <option key={s.id} value={s.id}>Step {i + 1} · {s.label}</option>)}
          </select>
        </div>
      </header>
      <main className="workbench-main mx-auto max-w-7xl px-4 py-6">
        <ErrorBoundary key={nav.step}>
          <Suspense fallback={<Skeleton lines={6} />}>{VIEWS[nav.step]()}</Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function StatusBar() {
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  if (info.isError) {
    return (
      <div className="mx-auto max-w-7xl px-4 pb-2">
        <ErrorBanner error={info.error} onRetry={() => void info.refetch()} title="Cannot load the workbench" />
      </div>
    );
  }
  if (!info.data) return <div className="mx-auto h-7 max-w-7xl px-4" />;
  const s = info.data.status;
  const v = s.latestVersion;
  return (
    <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 pb-2 text-xs text-slate-600">
      <Badge tone="violet">{info.data.workspace.name}</Badge>
      {v ? (
        <>
          <span>
            latest plan <strong>v{v.version}</strong> ({v.author})
          </span>
          {v.approval ? (
            <Badge tone={v.approval.decision === 'approved' ? 'green' : 'red'}>
              {v.approval.decision} by {v.approval.reviewer}
            </Badge>
          ) : (
            <Badge tone="amber">awaiting review</Badge>
          )}
        </>
      ) : (
        <span>no plan yet</span>
      )}
      <span>· {s.activeLoadedRows} rows loaded</span>
      <span>·</span>
      <Badge tone={s.llm.configured ? 'blue' : 'neutral'} title={s.llm.configured ? 'Anthropic API key configured' : 'No API key: heuristic drafts only'}>
        {s.llm.configured ? `AI: ${s.llm.model}` : 'AI not configured'}
      </Badge>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <Banner tone="error" title="This view crashed" actions={<Button size="sm" onClick={() => this.setState({ error: null })}>Try again</Button>}>
          {this.state.error.message}
        </Banner>
      );
    }
    return this.props.children;
  }
}
