// Left column of the Review step: every plan version (newest first) with provenance and approval readiness.
import type { VersionSummary } from '../api.ts';
import { Badge, Card, cx, fmt } from './ui.tsx';
import { ApprovalBadge, AuthorBadge } from './reviewShared.tsx';

export function VersionList({
  versions,
  selected,
  onSelect,
}: {
  versions: VersionSummary[];
  selected: number;
  onSelect: (v: number) => void;
}) {
  return (
    <Card title="Plan versions" subtitle={`${versions.length} version${versions.length === 1 ? '' : 's'} · newest first · immutable`}>
      <ul className="-mx-2 -my-1 space-y-1 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto" aria-label="Plan versions">
        {versions.map((v) => (
          <li key={v.version}>
            <VersionItem v={v} active={v.version === selected} onSelect={() => onSelect(v.version)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function VersionItem({ v, active, onSelect }: { v: VersionSummary; active: boolean; onSelect: () => void }) {
  // In approval mode every unanswered clarification is one blocker, so the remainder are validation blockers.
  const validationBlockers = Math.max(0, v.blockers - v.unresolvedClarifications);
  const ready = !v.approval && v.blockers === 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cx(
        'w-full rounded-md px-2.5 py-2 text-left ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
        active ? 'bg-indigo-50 ring-indigo-300' : 'ring-transparent hover:bg-slate-50',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold tabular-nums text-slate-900">v{v.version}</span>
        <AuthorBadge author={v.author} />
        <ApprovalBadge approval={v.approval} />
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-slate-700">{v.changeNote || <span className="italic text-slate-400">No change note</span>}</p>
      <p className="mt-1 truncate text-[11px] text-slate-500">
        {v.actor} · {fmt.time(v.createdAt)}
        {v.parentVersion !== null && ` · from v${v.parentVersion}`}
      </p>
      {(validationBlockers > 0 || v.unresolvedClarifications > 0 || ready) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {validationBlockers > 0 && <Badge tone="red">{validationBlockers} blocker{validationBlockers === 1 ? '' : 's'}</Badge>}
          {v.unresolvedClarifications > 0 && (
            <Badge tone="amber">
              {v.unresolvedClarifications} open question{v.unresolvedClarifications === 1 ? '' : 's'}
            </Badge>
          )}
          {ready && <Badge tone="green">ready to approve</Badge>}
        </div>
      )}
    </button>
  );
}
