// Step 2 — get a draft plan: run the tool-restricted AI agent (live trace) or generate the deterministic heuristic draft.
import { useEffect, useRef, useState } from 'react';
import type { AgentRun } from '../api.ts';
import { useRefreshAll } from '../nav.tsx';
import { AsyncPanel, Card, EmptyState } from '../components/ui.tsx';
import { AgentStartCard, HeuristicCard } from '../components/proposalStart.tsx';
import { RunDetail, RunsList, useAgentRuns } from '../components/proposalRuns.tsx';
import { isActive, isStalled } from '../components/proposalShared.tsx';

export function ProposalStep() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const runs = useAgentRuns();
  useRefreshWhenRunsSettle(runs.data?.items);
  const items = runs.data?.items ?? [];
  const activeRun = items.find((r) => isActive(r) && !isStalled(r, Date.now())) ?? null;
  // Default to the latest run so a fresh visit shows the most recent trace.
  const shownId = selectedId ?? items[0]?.id ?? null;

  return (
    <div className="space-y-5">
      <Card title="2. Proposal" subtitle="Get a draft migration plan. Every draft becomes a new, immutable plan version.">
        <p className="text-sm text-slate-700">
          <strong className="font-semibold">Guardrails:</strong> the AI agent can only call read-only inspection and validation tools (PII is
          masked) and never writes data; a human must review and approve every plan, AI or heuristic, before anything runs.
        </p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <AgentStartCard activeRun={activeRun} onStarted={setSelectedId} onShowRun={setSelectedId} />
        <HeuristicCard />
      </div>

      <Card title="Agent runs" subtitle="The latest 20 runs in this workspace. Select a run to see its full trace: the visible AI-workflow log.">
        <AsyncPanel
          query={runs}
          lines={4}
          isEmpty={(d) => d.items.length === 0 && selectedId === null}
          empty={
            <EmptyState
              title="No agent runs yet"
              description="Use “Run AI agent” above to watch the agent’s live trace here, or generate the heuristic draft, which needs no AI."
            />
          }
        >
          {(d) => (
            <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
              <RunsList runs={d.items} selectedId={shownId} onSelect={setSelectedId} />
              {shownId !== null && <RunDetail key={shownId} id={shownId} />}
            </div>
          )}
        </AsyncPanel>
      </Card>
    </div>
  );
}

/** When a run this page saw in flight reaches a terminal status, refresh every view (a new plan version may exist). */
function useRefreshWhenRunsSettle(runs: AgentRun[] | undefined) {
  const refreshAll = useRefreshAll();
  const inFlight = useRef(new Set<number>());
  useEffect(() => {
    if (!runs) return;
    let settled = false;
    for (const r of runs) {
      if (isActive(r)) inFlight.current.add(r.id);
      else if (inFlight.current.delete(r.id)) settled = true;
    }
    if (settled) void refreshAll();
  }, [runs, refreshAll]);
}
