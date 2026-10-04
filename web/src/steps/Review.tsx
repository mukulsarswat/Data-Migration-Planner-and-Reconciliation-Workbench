// Step 3 — Review & approve: the human-in-the-loop core. Left: immutable plan versions. Right: the selected version with
// its evidence (pass rates, samples, diff), clarifications, editing into a new version, dry run and the decision.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DryRunResponse, type VersionSummary } from '../api.ts';
import { useNav } from '../nav.tsx';
import { AsyncPanel, Banner, Button, EmptyState } from '../components/ui.tsx';
import { VersionList } from '../components/reviewVersionList.tsx';
import { VersionHeader } from '../components/reviewHeader.tsx';
import { ClarificationsCard } from '../components/reviewClarifications.tsx';
import { MappingsCard } from '../components/reviewMappings.tsx';
import { DiffCard, IgnoredCard, IssuesCard, SummaryRisksCard } from '../components/reviewSections.tsx';
import { PlanEditor } from '../components/reviewEditor.tsx';
import { contentAuthor } from '../components/reviewShared.tsx';

type Notice = { version: number; detail: string };

export function ReviewStep() {
  const nav = useNav();
  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans });
  // Dry runs started here in this session, per version: shown in the header and offered in the Approve dialog.
  const [dryRuns, setDryRuns] = useState<Record<number, DryRunResponse>>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const onNewVersion = (version: number, detail: string) => {
    nav.selectVersion(version);
    setNotice({ version, detail });
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">3. Review &amp; approve</h2>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-600">
          Check every mapping against the real data, answer open questions, edit into a new version if needed, dry-run, then approve or reject.
          Versions are immutable and an approval binds to the exact plan hash.
        </p>
      </div>
      <AsyncPanel
        query={plans}
        lines={6}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            title="No plan versions yet"
            description="Draft a plan first: run the AI agent or create a deterministic heuristic draft on the Proposal step."
            action={
              <Button variant="primary" onClick={() => nav.go('proposal')}>
                Go to Proposal
              </Button>
            }
          />
        }
      >
        {(data) => {
          const latest = data.items.reduce((max, v) => Math.max(max, v.version), 0);
          const selected = nav.version !== null && data.items.some((v) => v.version === nav.version) ? nav.version : latest;
          return (
            <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
              <div className="lg:sticky lg:top-4">
                <VersionList versions={data.items} selected={selected} onSelect={nav.selectVersion} />
              </div>
              <div className="min-w-0 space-y-4">
                {notice?.version === selected && (
                  <Banner
                    tone="success"
                    title={`Saved as v${notice.version}`}
                    actions={
                      <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
                        Dismiss
                      </Button>
                    }
                  >
                    {notice.detail}
                  </Banner>
                )}
                <VersionDetail
                  key={selected}
                  version={selected}
                  versions={data.items}
                  dryRun={dryRuns[selected] ?? null}
                  onDryRun={(r) => setDryRuns((prev) => ({ ...prev, [selected]: r }))}
                  onNewVersion={onNewVersion}
                />
              </div>
            </div>
          );
        }}
      </AsyncPanel>
    </div>
  );
}

function VersionDetail({
  version,
  versions,
  dryRun,
  onDryRun,
  onNewVersion,
}: {
  version: number;
  versions: VersionSummary[];
  dryRun: DryRunResponse | null;
  onDryRun: (r: DryRunResponse) => void;
  onNewVersion: (version: number, detail: string) => void;
}) {
  const detail = useQuery({ queryKey: ['plan', version], queryFn: () => api.plan(version) });
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  const [editing, setEditing] = useState(false);
  const aiText = contentAuthor(versions, version) === 'agent';

  return (
    <AsyncPanel query={detail} lines={10}>
      {(d) =>
        editing ? (
          <AsyncPanel query={info} lines={8}>
            {(i) => (
              <PlanEditor
                detail={d}
                info={i}
                onCancel={() => setEditing(false)}
                onSaved={(v) => {
                  onNewVersion(v, `Your edit of v${d.version} is saved as a new version and is now selected for review.`);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            )}
          </AsyncPanel>
        ) : (
          <div className="space-y-4">
            <VersionHeader detail={d} dryRun={dryRun} onDryRun={onDryRun} onEdit={() => setEditing(true)} />
            <SummaryRisksCard plan={d.plan} aiText={aiText} />
            <ClarificationsCard detail={d} onNewVersion={onNewVersion} />
            <AsyncPanel query={info} lines={6}>
              {(i) => <MappingsCard detail={d} target={i.target} />}
            </AsyncPanel>
            <IgnoredCard plan={d.plan} aiText={aiText} />
            <IssuesCard issues={d.issues} />
            <DiffCard diff={d.diff} plan={d.plan} />
          </div>
        )
      }
    </AsyncPanel>
  );
}
