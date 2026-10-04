// App-wide navigation + reviewer identity. Kept in React context (the URL hash mirrors the step for reloads).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export const STEPS = [
  { id: 'inputs', label: 'Inputs' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'review', label: 'Review & approve' },
  { id: 'dryrun', label: 'Dry run' },
  { id: 'execute', label: 'Execute' },
  { id: 'reconcile', label: 'Reconcile & rollback' },
  { id: 'history', label: 'History' },
  { id: 'logs', label: 'Logs' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

type Nav = {
  step: StepId;
  go: (step: StepId) => void;
  /** Plan version selected across Review / Dry run / Execute. */
  version: number | null;
  selectVersion: (v: number | null) => void;
  logsFilter: string;
  showLogs: (requestId: string) => void;
  setLogsFilter: (f: string) => void;
  reviewer: string;
  setReviewer: (name: string) => void;
};

const NavContext = createContext<Nav | null>(null);

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

const stepFromHash = (): StepId => {
  const h = (typeof location !== 'undefined' ? location.hash.slice(1) : '') as StepId;
  return STEPS.some((s) => s.id === h) ? h : 'inputs';
};

export function NavProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<StepId>(stepFromHash);
  const [version, selectVersion] = useState<number | null>(null);
  const [logsFilter, setLogsFilter] = useState('');
  const [reviewer, setReviewerState] = useState(() => readStored('mw.reviewer', ''));

  useEffect(() => {
    const onHash = () => setStep(stepFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((s: StepId) => {
    setStep(s);
    if (location.hash !== `#${s}`) history.replaceState(null, '', `#${s}`);
    window.scrollTo({ top: 0 });
  }, []);
  const showLogs = useCallback(
    (requestId: string) => {
      setLogsFilter(requestId);
      go('logs');
    },
    [go],
  );
  const setReviewer = useCallback((name: string) => {
    setReviewerState(name);
    try {
      localStorage.setItem('mw.reviewer', name);
    } catch {
      /* storage unavailable: keep in memory */
    }
  }, []);

  const value = useMemo(
    () => ({ step, go, version, selectVersion, logsFilter, showLogs, setLogsFilter, reviewer, setReviewer }),
    [step, go, version, logsFilter, showLogs, reviewer, setReviewer],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav outside NavProvider');
  return ctx;
}

/** Name used as `actor` on mutations (falls back to "reviewer"). */
export function useActor(): string {
  return useNav().reviewer.trim() || 'reviewer';
}

/** After any mutation every view may be stale; there are few queries, so refresh them all. */
export function useRefreshAll(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries(), [qc]);
}
