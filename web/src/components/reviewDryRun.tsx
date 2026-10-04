// Compact dry-run result shown in the Review header and inside the Approve dialog.
import type { DryRunResponse } from '../api.ts';
import { useNav } from '../nav.tsx';
import { Badge, Banner, Button, fmt } from './ui.tsx';

export function DeterminismBadge({ match, hash }: { match: boolean | null; hash: string }) {
  if (match === null) {
    return (
      <Badge tone="neutral" title={`Result hash ${hash}`}>
        first run of this plan hash
      </Badge>
    );
  }
  return match ? (
    <Badge tone="green" title={`Result hash ${hash} equals the previous dry run of this plan hash`}>
      deterministic ✓
    </Badge>
  ) : (
    <Badge tone="red" title={`Result hash ${hash} differs from the previous dry run of this plan hash`}>
      result differs from previous run
    </Badge>
  );
}

export function DryRunSummary({ result, version, showLink = true }: { result: DryRunResponse; version: number; showLink?: boolean }) {
  const nav = useNav();
  const c = result.counts;
  const within = result.withinErrorBudget;
  return (
    <Banner
      tone={within ? 'success' : 'warning'}
      title={`Dry run #${result.run.id} of v${version}: ${c.accepted} accepted · ${c.rejected} rejected of ${c.source} records`}
      actions={
        showLink && (
          <Button
            size="sm"
            onClick={() => {
              nav.selectVersion(version);
              nav.go('dryrun');
            }}
          >
            Open dry run →
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span>
          Reject rate <strong className="tabular-nums">{fmt.pct(result.rejectRatePct)}</strong> vs error budget{' '}
          <strong className="tabular-nums">{result.errorBudgetPct}%</strong>
        </span>
        <Badge tone={within ? 'green' : 'red'}>{within ? 'within budget' : 'over budget'}</Badge>
        <DeterminismBadge match={result.deterministicMatch} hash={result.resultHash} />
        {result.conflictPreflight.length > 0 && (
          <Badge tone="amber" title={result.conflictPreflight.slice(0, 10).join(', ')}>
            {result.conflictPreflight.length} key conflict{result.conflictPreflight.length === 1 ? '' : 's'} in target
          </Badge>
        )}
      </div>
      {!within && <p className="mt-1">Execution would be blocked: fix mappings or raise the error budget in a new version.</p>}
    </Banner>
  );
}
