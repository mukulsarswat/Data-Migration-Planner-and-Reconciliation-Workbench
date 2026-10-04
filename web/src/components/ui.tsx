// Small UI kit (Tailwind + native elements). AsyncPanel gives every panel the same loading / empty / error / success
// behaviour, which is how the app covers the required UI states consistently.
import { useEffect, useRef, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../api.ts';
import { useNav } from '../nav.tsx';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
};
export function Button({ variant = 'secondary', size = 'md', loading, disabled, className, children, ...rest }: ButtonProps) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300',
    secondary: 'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-300',
    ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
  }[variant];
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium shadow-sm transition disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        styles,
        className,
      )}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export type Tone = 'neutral' | 'green' | 'red' | 'amber' | 'blue' | 'violet';
const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', TONES[tone])}>
      {children}
    </span>
  );
}

export function Card({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Banner({ tone, title, children, actions }: { tone: 'success' | 'error' | 'info' | 'warning'; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const styles = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-md border px-3 py-2 text-sm', styles)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          {children && <div className="mt-1 text-xs opacity-90">{children}</div>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Failure state for any API error: message, code, request id (links to Logs), optional retry. */
export function ErrorBanner({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const nav = useNav();
  const e = error instanceof ApiError ? error : null;
  const message = e?.message ?? (error instanceof Error ? error.message : 'Something went wrong');
  return (
    <Banner
      tone="error"
      title={title ?? message}
      actions={onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    >
      {title && <p>{message}</p>}
      {e && (
        <p className="mt-1 font-mono">
          {e.code}
          {e.requestId && (
            <>
              {' · request '}
              <button className="underline" onClick={() => nav.showLogs(e.requestId!)}>
                {e.requestId.slice(0, 8)}
              </button>
            </>
          )}
        </p>
      )}
      {e?.code === 'VALIDATION_FAILED' && Array.isArray(e.details) && (
        <ul className="mt-1 list-disc pl-4">
          {(e.details as { path?: (string | number)[]; message: string }[]).slice(0, 5).map((d, i) => (
            <li key={i}>
              {(d.path ?? []).join('.')} {d.message}
            </li>
          ))}
        </ul>
      )}
      {e?.code === 'PLAN_NOT_APPROVABLE' && Array.isArray((e.details as { issues?: unknown[] })?.issues) && (
        <ul className="mt-1 list-disc pl-4">
          {((e.details as { issues: { field: string | null; message: string }[] }).issues).map((i, k) => (
            <li key={k}>{i.field ? `${i.field}: ` : ''}{i.message}</li>
          ))}
        </ul>
      )}
    </Banner>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-2" aria-label="Loading" role="status">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-3 rounded bg-slate-200" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-slate-300 px-4 py-8 text-center">
      <p className="text-sm font-medium text-slate-800">{title}</p>
      {description && <p className="max-w-md text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Loading → error (with retry) → empty (with next action) → content. */
export function AsyncPanel<T>({
  query,
  isEmpty,
  empty,
  children,
  lines,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
  lines?: number;
}) {
  if (query.isPending) return <Skeleton lines={lines} />;
  if (query.isError) return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />;
  if (isEmpty && isEmpty(query.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(query.data)}</>;
}

export function CountTile({ label, value, tone = 'neutral', hint }: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode }) {
  const ring = { neutral: 'border-slate-200', green: 'border-emerald-200', red: 'border-rose-200', amber: 'border-amber-200', blue: 'border-sky-200', violet: 'border-violet-200' }[tone];
  return (
    <div className={cx('rounded-lg border bg-white px-3 py-2', ring)}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Confirmation dialog on the native <dialog> element (no window.confirm). */
export function Dialog({
  open,
  title,
  children,
  onClose,
  footer,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="w-[min(36rem,92vw)] rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40">
      <div className="border-b border-slate-100 px-5 py-3">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-5 py-4 text-sm text-slate-700">{children}</div>
      <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
        {footer ?? <Button onClick={onClose}>Close</Button>}
      </div>
    </dialog>
  );
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  if (total <= limit) return <p className="text-xs text-slate-500">{total} row{total === 1 ? '' : 's'}</p>;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <Button size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </Button>
      <span className="tabular-nums">
        {offset + 1}–{Math.min(total, offset + limit)} of {total}
      </span>
      <Button size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </Button>
    </div>
  );
}

export const table = {
  wrap: 'overflow-x-auto rounded-md border border-slate-200',
  table: 'min-w-full divide-y divide-slate-200 text-sm',
  th: 'bg-slate-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500',
  td: 'px-3 py-2 align-top text-slate-700',
  tr: 'divide-x divide-slate-100 odd:bg-white even:bg-slate-50/50',
};

export const fmt = {
  time: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—'),
  cents: (c: number) => (c / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' }),
  hash: (h: string | null | undefined) => (h ? h.slice(0, 10) : '—'),
  pct: (n: number) => `${n.toFixed(1)}%`,
  value: (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? (v === '' ? '""' : v) : JSON.stringify(v)),
};

export { cx };
