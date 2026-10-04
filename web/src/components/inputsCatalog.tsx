// Supported transformation rules: the closed DSL catalog every mapping is built from, plus parse_date formats.
import type { MigrationInfo } from '../api.ts';
import { Badge, Card, table } from './ui.tsx';

export function CatalogCard({ catalog }: { catalog: MigrationInfo['catalog'] }) {
  return (
    <Card
      title="Supported transforms"
      subtitle="A mapping is a chain of these ops with validated parameters: no expressions, no code. Plans that use anything else are rejected."
      actions={<Badge>{catalog.ops.length} ops</Badge>}
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col" className={table.th}>Op</th>
              <th scope="col" className={table.th}>In → out</th>
              <th scope="col" className={table.th}>Nulls</th>
              <th scope="col" className={table.th}>Description</th>
              <th scope="col" className={table.th}>Example</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {catalog.ops.map((op) => (
              <tr key={op.name} className={table.tr}>
                <td className={table.td}>
                  <code className="font-mono text-xs font-semibold text-indigo-800">{op.name}</code>
                  {op.params.length > 0 && (
                    <p className="mt-0.5 font-mono text-xs text-slate-500">{op.params.join(', ')}</p>
                  )}
                </td>
                <td className={`${table.td} whitespace-nowrap font-mono text-xs`}>
                  {op.in} <span className="text-slate-400">→</span> {op.out === 'same' ? 'same as input' : op.out}
                </td>
                <td className={table.td}>
                  {op.nulls === 'handles' ? (
                    <Badge tone="blue" title="The op defines its own behaviour for null input">handles</Badge>
                  ) : (
                    <Badge title="null in ⇒ null out (op not applied)">passthrough</Badge>
                  )}
                </td>
                <td className={`${table.td} min-w-64 text-xs`}>{op.description}</td>
                <td className={`${table.td} min-w-48 font-mono text-xs text-slate-600`}>{op.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          Supported date formats <span className="font-normal normal-case text-slate-500">(for <code className="font-mono">parse_date</code>)</span>
        </h3>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {catalog.dateFormats.map((f) => (
            <li key={f}>
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800 ring-1 ring-inset ring-slate-200">{f}</code>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          MM and dd accept one or two digits; MMM is an English month abbreviation. If two listed formats give different dates for the same value,
          the record fails with AMBIGUOUS_DATE instead of guessing.
        </p>
      </div>
    </Card>
  );
}
