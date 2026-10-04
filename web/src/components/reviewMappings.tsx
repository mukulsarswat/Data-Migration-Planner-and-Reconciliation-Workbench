// Mapping table in target-schema order with provenance, rationale and per-mapping pass rate over the whole dataset.
// Each row expands to sample before→after values and the first failures.
import { useId, useState } from 'react';
import type { FieldMapping, PassRate, VersionDetail } from '../api.ts';
import type { TargetField, TargetSchema } from '../../../shared/schemas.ts';
import { Badge, Card, fmt, table } from './ui.tsx';
import { AiBadge, ConfidenceBadge, OriginBadge, RawValues, SourceList, StepChain, passRateTone } from './reviewShared.tsx';

type Row = { key: string; target: string; field: TargetField | null; mapping: FieldMapping | null };

function buildRows(mappings: FieldMapping[], target: TargetSchema): Row[] {
  const rows: Row[] = [];
  for (const f of target.fields) {
    const ms = mappings.filter((m) => m.target === f.name);
    if (!ms.length) rows.push({ key: f.name, target: f.name, field: f, mapping: null });
    // Duplicates are a blocker but must stay visible.
    ms.forEach((m, i) => rows.push({ key: `${f.name}#${i}`, target: f.name, field: f, mapping: m }));
  }
  const known = new Set(target.fields.map((f) => f.name));
  mappings.forEach((m, i) => {
    if (!known.has(m.target)) rows.push({ key: `unknown:${m.target}#${i}`, target: m.target, field: null, mapping: m });
  });
  return rows;
}

export function MappingsCard({ detail, target }: { detail: VersionDetail; target: TargetSchema }) {
  const rows = buildRows(detail.plan.mappings, target);
  const mappedTargets = new Set(detail.plan.mappings.map((m) => m.target)).size;
  const total = Object.values(detail.passRates)[0]?.total;
  return (
    <Card
      title={`Mappings (${mappedTargets} of ${target.fields.length} target fields mapped)`}
      subtitle={`Target-schema order. Pass rate = share of ${total ?? 'all'} source records whose value transforms without error; expand a rate for samples and failures.`}
    >
      <div className={table.wrap}>
        <table className={table.table}>
          <thead>
            <tr>
              <th scope="col" className={table.th}>Target</th>
              <th scope="col" className={table.th}>Sources</th>
              <th scope="col" className={table.th}>Steps</th>
              <th scope="col" className={table.th}>Provenance</th>
              <th scope="col" className={table.th}>Rationale</th>
              <th scope="col" className={table.th}>Pass rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <MappingRow key={r.key} row={r} rate={detail.passRates[r.target] ?? null} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TargetCell({ row }: { row: Row }) {
  const f = row.field;
  return (
    <td className={table.td}>
      <div className="font-mono text-xs font-semibold text-slate-900">{row.target}</div>
      {f ? (
        <div className="text-[11px] text-slate-500">
          {f.type}
          {f.required ? ' · required' : ' · optional'}
          {f.unique ? ' · unique' : ''}
        </div>
      ) : (
        <Badge tone="red" title="This field does not exist in the target schema">
          unknown target
        </Badge>
      )}
    </td>
  );
}

function MappingRow({ row, rate }: { row: Row; rate: PassRate | null }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const m = row.mapping;
  if (!m) {
    const required = row.field?.required ?? false;
    return (
      <tr className={required ? 'bg-rose-50/40' : 'bg-slate-50/60'}>
        <TargetCell row={row} />
        <td className={table.td} colSpan={5}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={required ? 'red' : 'neutral'}>unmapped</Badge>
            <span className="text-xs text-slate-600">
              {required
                ? 'Required field with no mapping — approval is blocked. Map a source or supply a constant with `default` (Edit plan).'
                : 'Optional field — every row will load it as null.'}
            </span>
          </div>
        </td>
      </tr>
    );
  }
  return (
    <>
      <tr className="align-top">
        <TargetCell row={row} />
        <td className={table.td}>
          <SourceList sources={m.sources} />
        </td>
        <td className={`${table.td} min-w-[12rem]`}>
          <StepChain steps={m.steps} />
        </td>
        <td className={table.td}>
          <div className="flex flex-col items-start gap-1">
            <OriginBadge origin={m.origin} />
            <ConfidenceBadge confidence={m.confidence} />
          </div>
        </td>
        <td className={`${table.td} min-w-[10rem] max-w-[14rem]`}>
          {m.rationale ? (
            <>
              {m.origin === 'agent' && (
                <div className="mb-1">
                  <AiBadge />
                </div>
              )}
              <p className="line-clamp-3 text-xs text-slate-700" title={m.rationale}>
                {m.rationale}
              </p>
            </>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </td>
        <td className={table.td}>
          {rate ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Badge tone={passRateTone(rate.passRatePct)}>{fmt.pct(rate.passRatePct)}</Badge>
              <span className="text-[11px] tabular-nums text-slate-500">
                {rate.ok}/{rate.total}
              </span>
              <span aria-hidden className="text-slate-400">
                {open ? '▾' : '▸'}
              </span>
              <span className="sr-only">{open ? 'Hide' : 'Show'} samples and failures for {row.target}</span>
            </button>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </td>
      </tr>
      {open && rate && (
        <tr id={panelId}>
          <td colSpan={6} className="bg-slate-50 px-3 py-3">
            <MappingEvidence mapping={m} rate={rate} />
          </td>
        </tr>
      )}
    </>
  );
}

function MappingEvidence({ mapping, rate }: { mapping: FieldMapping; rate: PassRate }) {
  const failed = rate.total - rate.ok;
  return (
    <div className="space-y-3">
      {mapping.rationale && (
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Rationale {mapping.origin === 'agent' && <AiBadge />}
          </h4>
          <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-700">{mapping.rationale}</p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Samples (before → after)</h4>
          {rate.samples.length ? (
            <ul className="mt-1 space-y-1">
              {rate.samples.slice(0, 3).map((s) => (
                <li key={s.sourceKey} className="text-xs">
                  <code className="mr-1 text-[11px] text-slate-400">{s.sourceKey}</code>
                  <RawValues raw={s.raw} />
                  <span aria-hidden className="mx-1 text-slate-400">
                    →
                  </span>
                  <span className="sr-only"> becomes </span>
                  <code className="rounded bg-emerald-50 px-1 text-[11px] text-emerald-800">{fmt.value(s.value)}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">No record transformed successfully.</p>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Failures {failed > 0 && `(first ${Math.min(5, rate.failures.length)} of ${failed})`}
          </h4>
          {rate.failures.length ? (
            <ul className="mt-1 space-y-1">
              {rate.failures.slice(0, 5).map((f) => (
                <li key={f.sourceKey} className="text-xs">
                  <code className="mr-1 text-[11px] text-slate-400">{f.sourceKey}</code>
                  <RawValues raw={f.raw} />
                  <span className="ml-1 text-rose-700">— {f.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-emerald-700">No failures: every record transforms.</p>
          )}
        </div>
      </div>
    </div>
  );
}
