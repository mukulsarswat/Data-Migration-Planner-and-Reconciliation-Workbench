// Field profiles of the raw source extract: emptiness, cardinality, key-likeness, format signatures and value frequencies.
import type { FieldProfile } from '../api.ts';
import { Badge, Card, fmt, table } from './ui.tsx';

const SHOWN_FORMATS = 4;
const SHOWN_VALUES = 6;

export function ProfilesCard({ profiles }: { profiles: FieldProfile[] }) {
  return (
    <Card
      title="Field profiles"
      subtitle="Deterministic statistics over every source record. Format signatures: 9 = digit, Aa = capitalised word, A = upper-case run, a = lower-case run, ∅ = empty. Hover a signature for an example (PII examples are masked)."
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col" className={table.th}>Field</th>
              <th scope="col" className={table.th}>Empty</th>
              <th scope="col" className={table.th}>Distinct</th>
              <th scope="col" className={table.th}>Key-like</th>
              <th scope="col" className={table.th}>Length</th>
              <th scope="col" className={table.th}>Top formats</th>
              <th scope="col" className={table.th}>Top values</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {profiles.map((p) => (
              <tr key={p.field} className={table.tr}>
                <td className={table.td}>
                  <code className="font-mono text-xs font-semibold text-slate-900">{p.field}</code>
                  {p.pii && (
                    <span className="ml-1.5">
                      <Badge tone="amber">PII</Badge>
                    </span>
                  )}
                </td>
                <td className={`${table.td} whitespace-nowrap tabular-nums`}>
                  <span className={p.empty > 0 ? 'font-medium text-amber-700' : ''}>{p.empty}</span>
                  <span className="text-xs text-slate-400"> / {p.total} ({fmt.pct(p.total ? (p.empty / p.total) * 100 : 0)})</span>
                </td>
                <td className={`${table.td} whitespace-nowrap tabular-nums`}>
                  {p.distinct}
                  <span className="text-xs text-slate-400"> ({p.distinctRatio.toFixed(2)})</span>
                </td>
                <td className={table.td}>
                  {p.keyLike ? (
                    <Badge tone="green" title="Almost every value is distinct: a candidate business key">key-like</Badge>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className={`${table.td} whitespace-nowrap tabular-nums text-xs`}>
                  {p.minLength}–{p.maxLength}
                </td>
                <td className={`${table.td} min-w-56`}>
                  <ChipList
                    items={p.formats.map((f) => ({ key: f.signature, label: f.signature, count: f.count, title: `e.g. ${fmt.value(f.example)}` }))}
                    shown={SHOWN_FORMATS}
                  />
                </td>
                <td className={`${table.td} min-w-56`}>
                  <TopValues profile={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TopValues({ profile: p }: { profile: FieldProfile }) {
  if (p.pii) return <span className="text-xs text-slate-400">hidden (PII)</span>;
  if (p.topValues.length === 0) return <span className="text-xs text-slate-400">too many distinct values</span>;
  return (
    <ChipList
      items={p.topValues.map((v) => ({ key: v.value, label: v.value === '' ? '""' : v.value, count: v.count, title: JSON.stringify(v.value) }))}
      shown={SHOWN_VALUES}
    />
  );
}

type Chip = { key: string; label: string; count: number; title: string };

function ChipList({ items, shown }: { items: Chip[]; shown: number }) {
  const head = items.slice(0, shown);
  const rest = items.slice(shown);
  return (
    <div className="flex flex-wrap gap-1">
      {head.map((c) => (
        <ValueChip key={c.key} chip={c} />
      ))}
      {rest.length > 0 && (
        <details className="w-full text-xs">
          <summary className="cursor-pointer text-indigo-700 hover:underline">+{rest.length} more</summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {rest.map((c) => (
              <ValueChip key={c.key} chip={c} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ValueChip({ chip }: { chip: Chip }) {
  return (
    <span title={chip.title} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs ring-1 ring-inset ring-slate-200">
      <code className="whitespace-pre font-mono text-slate-800">{chip.label}</code>
      <span className="tabular-nums text-slate-500">×{chip.count}</span>
    </span>
  );
}
