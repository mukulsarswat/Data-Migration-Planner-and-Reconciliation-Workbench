// Source and target schema tables for the Inputs step (read-only).
import type { MigrationInfo } from '../api.ts';
import { Badge, Card, table, type Tone } from './ui.tsx';

type Source = MigrationInfo['source'];
type Target = MigrationInfo['target'];

const TYPE_TONE: Record<string, Tone> = { string: 'neutral', integer: 'blue', boolean: 'violet', date: 'green' };

export function SourceSchemaCard({ source }: { source: Source }) {
  return (
    <Card
      title={
        <>
          Source schema · <code className="font-mono">{source.name}</code>
        </>
      }
      subtitle={source.description}
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col" className={table.th}>Field</th>
              <th scope="col" className={table.th}>Description</th>
              <th scope="col" className={table.th}>PII</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {source.fields.map((f) => (
              <tr key={f.name} className={table.tr}>
                <td className={table.td}>
                  <code className="font-mono text-xs font-semibold text-slate-900">{f.name}</code>
                  {f.name === source.keyField && (
                    <div className="mt-1">
                      <Badge tone="blue" title="Business key in the legacy system (not guaranteed unique)">legacy key</Badge>
                    </div>
                  )}
                </td>
                <td className={`${table.td} text-xs`}>{f.description}</td>
                <td className={table.td}>
                  {f.pii ? (
                    <Badge tone="amber" title="Personally identifiable: values are masked before they reach the AI agent">PII</Badge>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">Legacy extracts are untyped: every source value is raw text.</p>
    </Card>
  );
}

export function TargetSchemaCard({ target }: { target: Target }) {
  return (
    <Card
      title={
        <>
          Target schema · <code className="font-mono">{target.name}</code>
        </>
      }
      subtitle={target.description}
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col" className={table.th}>Field</th>
              <th scope="col" className={table.th}>Type</th>
              <th scope="col" className={table.th}>Required</th>
              <th scope="col" className={table.th}>Unique</th>
              <th scope="col" className={table.th}>Constraints</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {target.fields.map((f) => (
              <tr key={f.name} className={table.tr}>
                <td className={table.td}>
                  <code className="font-mono text-xs font-semibold text-slate-900">{f.name}</code>
                  {f.name === target.keyField && (
                    <span className="ml-1.5">
                      <Badge tone="blue" title="Unique business key; idempotent loads conflict on it">key</Badge>
                    </span>
                  )}
                  <p className="mt-0.5 text-xs text-slate-500">{f.description}</p>
                </td>
                <td className={table.td}>
                  <Badge tone={TYPE_TONE[f.type] ?? 'neutral'}>{f.type}</Badge>
                </td>
                <td className={table.td}>
                  {f.required ? <Badge tone="red">required</Badge> : <span className="text-xs text-slate-400">optional</span>}
                </td>
                <td className={table.td}>
                  {f.unique ? <Badge tone="violet">unique</Badge> : <span className="text-xs text-slate-400">—</span>}
                </td>
                <td className={table.td}>
                  <Constraints field={f} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">Constraints are enforced by both the validator and the database (CHECK / UNIQUE).</p>
    </Card>
  );
}

function Constraints({ field }: { field: Target['fields'][number] }) {
  const parts = [
    field.enum && (
      <div key="enum" className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-500">one of</span>
        {field.enum.map((v) => (
          <code key={v} className="rounded bg-slate-100 px-1 font-mono text-xs">{v}</code>
        ))}
      </div>
    ),
    field.pattern && (
      <div key="pattern" className="text-xs">
        <span className="text-slate-500">pattern </span>
        <code className="break-all font-mono text-slate-800">{field.pattern}</code>
      </div>
    ),
    field.maxLength !== undefined && (
      <div key="max" className="text-xs">
        <span className="text-slate-500">max length </span>
        <span className="tabular-nums">{field.maxLength}</span>
      </div>
    ),
  ].filter(Boolean);
  return parts.length ? <div className="space-y-1">{parts}</div> : <span className="text-xs text-slate-400">—</span>;
}
