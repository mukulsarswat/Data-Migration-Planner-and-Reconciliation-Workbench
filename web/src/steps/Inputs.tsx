// Step 1 — the provided inputs (read-only): schemas, gaps, profiles, raw sample records and the transform catalog.
import { useQuery } from '@tanstack/react-query';
import { api, type MigrationInfo } from '../api.ts';
import { useNav } from '../nav.tsx';
import { AsyncPanel, Button, Card, CountTile, EmptyState } from '../components/ui.tsx';
import { SourceSchemaCard, TargetSchemaCard } from '../components/inputsSchema.tsx';
import { GapsCard } from '../components/inputsGaps.tsx';
import { ProfilesCard } from '../components/inputsProfiles.tsx';
import { SampleRecordsCard } from '../components/inputsRecords.tsx';
import { CatalogCard } from '../components/inputsCatalog.tsx';

export function InputsStep() {
  const nav = useNav();
  const info = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  return (
    <div className="space-y-5">
      <AsyncPanel
        query={info}
        lines={8}
        isEmpty={(d) => d.source.fields.length === 0 || d.target.fields.length === 0}
        empty={
          <EmptyState
            title="No dataset loaded"
            description="The server has no source or target schema. Reset the local database (npm run db:reset), restart the server and reload."
            action={<Button onClick={() => void info.refetch()}>Reload</Button>}
          />
        }
      >
        {(d) => <InputsContent info={d} />}
      </AsyncPanel>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
        <p className="text-xs text-slate-500">Inputs are fixed. The next step drafts a mapping plan from them.</p>
        <Button variant="primary" onClick={() => nav.go('proposal')}>
          Next: get a plan proposal →
        </Button>
      </div>
    </div>
  );
}

function InputsContent({ info }: { info: MigrationInfo }) {
  const { source, target, gaps, limits } = info;
  const pii = source.fields.filter((f) => f.pii).length;
  const required = target.fields.filter((f) => f.required).length;
  const gapCount = gaps.sourceWithoutTarget.length + gaps.requiredTargetWithoutSource.length + gaps.typeIncompatible.length;
  return (
    <>
      <Card title="1. Inputs" subtitle="Read-only. Every plan, whether drafted by the AI agent, the heuristic or a human, is built and validated against exactly these inputs.">
        <p className="text-sm text-slate-700">
          One source extract (<code className="font-mono">{source.name}</code>) migrates into one target table (<code className="font-mono">{target.name}</code>).
          Source values are untyped legacy text with drifting formats; the target is strongly typed and constrained by the database.
        </p>
        <p className="mt-1 text-xs font-medium text-slate-600">
          Limits: {limits.records} of max {limits.maxSampleSize} records; one source, one target.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <CountTile label="Source records" value={limits.records} hint={`max ${limits.maxSampleSize}`} />
          <CountTile label="Source fields" value={source.fields.length} hint={`${pii} PII (masked for the AI)`} />
          <CountTile label="Target fields" value={target.fields.length} hint={`${required} required`} />
          <CountTile label="Gaps to resolve" value={gapCount} tone={gapCount ? 'amber' : 'green'} hint="see below" />
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <SourceSchemaCard source={source} />
        <TargetSchemaCard target={target} />
      </div>

      <GapsCard gaps={gaps} />
      <ProfilesCard profiles={info.profiles} />
      <SampleRecordsCard source={source} />
      <CatalogCard catalog={info.catalog} />
    </>
  );
}
