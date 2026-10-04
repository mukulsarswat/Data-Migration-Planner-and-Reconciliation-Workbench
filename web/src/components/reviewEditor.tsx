// Edit mode: builds a complete MigrationPlan client-side and saves it as a NEW child version (the parent never changes).
// Steps are edited as JSON and checked with the shared zod StepSchema (blocks saving) and chainType (warns: it would
// block approval, but a work-in-progress version may still be saved).
import { useId, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { api, type FieldMapping, type MigrationInfo, type MigrationPlan, type OpInfo, type VersionDetail } from '../api.ts';
import { OP_NAMES, StepSchema, chainType, type OpName, type Step } from '../../../shared/dsl.ts';
import { MAX_ERROR_BUDGET_PCT } from '../../../shared/plan.ts';
import { canonicalJson } from '../../../shared/canonical.ts';
import type { SourceSchema, TargetField, TargetSchema } from '../../../shared/schemas.ts';
import { useActor, useRefreshAll } from '../nav.tsx';
import { Badge, Banner, Button, Card, Dialog, ErrorBanner, cx, table } from './ui.tsx';
import { OriginBadge } from './reviewShared.tsx';

type Draft = {
  key: string;
  target: string;
  field: TargetField | null;
  /** Mapping in the parent version (null = added in this edit) and its index there (keeps mapping order stable). */
  original: FieldMapping | null;
  order: number;
  mapped: boolean;
  sources: string[];
  stepsText: string;
  rationale: string;
};
type IgnoreDraft = { source: string; known: boolean; ignored: boolean; reason: string };
type StepsCheck = { ok: true; steps: Step[]; produces: string | null; warning: string | null } | { ok: false; errors: string[] };

const StepsSchema = z.array(StepSchema);
const inputCls =
  'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-400';

const OP_TEMPLATES: Record<OpName, Step> = {
  copy: { op: 'copy', params: {} },
  trim: { op: 'trim', params: {} },
  lowercase: { op: 'lowercase', params: {} },
  uppercase: { op: 'uppercase', params: {} },
  null_if_empty: { op: 'null_if_empty', params: {} },
  default: { op: 'default', params: { value: '' } },
  split_full_name: { op: 'split_full_name', params: { part: 'first' } },
  concat: { op: 'concat', params: { separator: ' ' } },
  parse_date: { op: 'parse_date', params: { formats: ['yyyy-MM-dd'] } },
  parse_currency_to_cents: { op: 'parse_currency_to_cents', params: {} },
  to_integer: { op: 'to_integer', params: {} },
  to_boolean: { op: 'to_boolean', params: { true_values: ['Y'], false_values: ['N'] } },
  map_values: { op: 'map_values', params: { pairs: [{ from: '', to: '' }], fallback: null } },
  normalize_phone: { op: 'normalize_phone', params: { default_country: 'US' } },
};

const stepsToText = (steps: readonly unknown[]) => (steps.length ? `[\n${steps.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n]` : '[]');

/** Append an op template to the JSON text, or null when the text is not a JSON array yet. */
function appendStep(text: string, op: OpName): string | null {
  try {
    const arr: unknown = JSON.parse(text);
    return Array.isArray(arr) ? stepsToText([...arr, OP_TEMPLATES[op]]) : null;
  } catch {
    return null;
  }
}

function issuePrefix(path: readonly PropertyKey[]): string {
  if (!path.length) return '';
  const [head, ...rest] = path;
  const where = typeof head === 'number' ? `Step ${head + 1}` : String(head);
  return `${where}${rest.length ? ` · ${rest.map(String).join('.')}` : ''}: `;
}

function checkSteps(text: string, sourceCount: number, field: TargetField | null): StepsCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON — ${e instanceof Error ? e.message : 'parse error'}`] };
  }
  const parsed = StepsSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 5).map((i) => `${issuePrefix(i.path)}${i.message}`) };
  const chain = chainType(sourceCount, parsed.data);
  if (!chain.ok) {
    const at = chain.stepIndex === null ? '' : `Step ${chain.stepIndex + 1}: `;
    return { ok: true, steps: parsed.data, produces: null, warning: `${at}${chain.message}` };
  }
  const warning = field && chain.type !== field.type ? `Produces ${chain.type} but ${field.name} is ${field.type}.` : null;
  return { ok: true, steps: parsed.data, produces: chain.type, warning };
}

function initialDrafts(plan: MigrationPlan, target: TargetSchema): Draft[] {
  const fromMapping = (m: FieldMapping, field: TargetField | null): Draft => {
    const order = plan.mappings.indexOf(m);
    return { key: `m${order}`, target: m.target, field, original: m, order, mapped: true, sources: [...m.sources], stepsText: stepsToText(m.steps), rationale: m.rationale };
  };
  const drafts: Draft[] = [];
  target.fields.forEach((f, i) => {
    const ms = plan.mappings.filter((m) => m.target === f.name);
    if (ms.length) drafts.push(...ms.map((m) => fromMapping(m, f)));
    else drafts.push({ key: `t${i}`, target: f.name, field: f, original: null, order: plan.mappings.length + i, mapped: false, sources: [], stepsText: '[]', rationale: '' });
  });
  const known = new Set(target.fields.map((f) => f.name));
  for (const m of plan.mappings) if (!known.has(m.target)) drafts.push(fromMapping(m, null));
  return drafts;
}

function initialIgnores(plan: MigrationPlan, source: SourceSchema): IgnoreDraft[] {
  const reasons = new Map(plan.ignored.map((g) => [g.source, g.reason]));
  const rows: IgnoreDraft[] = source.fields.map((f) => ({ source: f.name, known: true, ignored: reasons.has(f.name), reason: reasons.get(f.name) ?? '' }));
  const known = new Set(source.fields.map((f) => f.name));
  for (const g of plan.ignored) if (!known.has(g.source)) rows.push({ source: g.source, known: false, ignored: true, reason: g.reason });
  return rows;
}

function toMapping(d: Draft, steps: Step[]): FieldMapping {
  // Keep the proposer's provenance only while its text is untouched; the server re-labels changed mappings 'human' too.
  const keep = d.original !== null && d.rationale === d.original.rationale;
  return {
    target: d.target,
    sources: d.sources,
    steps,
    origin: keep && d.original ? d.original.origin : 'human',
    confidence: keep && d.original ? d.original.confidence : 'high',
    rationale: d.rationale,
  };
}

function buildPlan(base: MigrationPlan, drafts: Draft[], checks: (StepsCheck | null)[], ignores: IgnoreDraft[], budget: number): MigrationPlan {
  const mapped: { order: number; mapping: FieldMapping }[] = [];
  drafts.forEach((d, i) => {
    const c = checks[i];
    if (d.mapped && c?.ok) mapped.push({ order: d.order, mapping: toMapping(d, c.steps) });
  });
  // Parent order first so an untouched plan hashes identically; added mappings follow in target-schema order.
  mapped.sort((a, b) => a.order - b.order);
  const reasons = new Map(ignores.filter((g) => g.ignored).map((g) => [g.source, g.reason]));
  const kept = base.ignored.filter((g) => reasons.has(g.source)).map((g) => ({ source: g.source, reason: reasons.get(g.source) ?? '' }));
  const keptNames = new Set(kept.map((g) => g.source));
  const added = ignores.filter((g) => g.ignored && !keptNames.has(g.source)).map((g) => ({ source: g.source, reason: g.reason }));
  return { ...base, mappings: mapped.map((m) => m.mapping), ignored: [...kept, ...added], errorBudgetPct: budget };
}

export function PlanEditor({
  detail,
  info,
  onCancel,
  onSaved,
}: {
  detail: VersionDetail;
  info: MigrationInfo;
  onCancel: () => void;
  onSaved: (version: number) => void;
}) {
  const actor = useActor();
  const refreshAll = useRefreshAll();
  const [drafts, setDrafts] = useState(() => initialDrafts(detail.plan, info.target));
  const [ignores, setIgnores] = useState(() => initialIgnores(detail.plan, info.source));
  const [budget, setBudget] = useState(String(detail.plan.errorBudgetPct));
  const [note, setNote] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const budgetId = useId();

  const checks = useMemo(() => drafts.map((d) => (d.mapped ? checkSteps(d.stepsText, d.sources.length, d.field) : null)), [drafts]);
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of drafts) if (d.mapped) for (const s of d.sources) m.set(s, [...(m.get(s) ?? []), d.target]);
    return m;
  }, [drafts]);

  const budgetValue = Number(budget);
  const budgetError = /^\d+$/.test(budget.trim()) && budgetValue <= MAX_ERROR_BUDGET_PCT ? null : `Enter a whole number from 0 to ${MAX_ERROR_BUDGET_PCT}.`;
  const errorCount = checks.filter((c) => c && !c.ok).length + (budgetError ? 1 : 0);
  const warningCount =
    checks.filter((c) => c?.ok && c.warning).length +
    ignores.filter((g) => g.ignored === usedBy.has(g.source)).length + // both mapped and ignored, or neither
    drafts.filter((d) => !d.mapped && d.field?.required && !drafts.some((o) => o.mapped && o.target === d.target)).length;

  const plan = errorCount === 0 ? buildPlan(detail.plan, drafts, checks, ignores, budgetValue) : null;
  const changed = plan !== null && canonicalJson(plan) !== canonicalJson(detail.plan);
  const dirty = plan === null || changed || note.trim() !== '';

  const save = useMutation({
    mutationFn: (p: MigrationPlan) => api.saveEdit(detail.version, p, note.trim(), actor),
    // Wait for the version list to include the new version before selecting it.
    onSuccess: async (res) => {
      await refreshAll();
      onSaved(res.version);
    },
  });

  const update = (key: string, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const toggleSource = (key: string, source: string) =>
    setDrafts((ds) =>
      ds.map((d) => (d.key !== key ? d : { ...d, sources: d.sources.includes(source) ? d.sources.filter((s) => s !== source) : [...d.sources, source] })),
    );
  const updateIgnore = (source: string, patch: Partial<IgnoreDraft>) => setIgnores((gs) => gs.map((g) => (g.source === source ? { ...g, ...patch } : g)));
  const sourceNames = info.source.fields.map((f) => f.name);

  return (
    <div className="space-y-4">
      <Banner tone="info" title={`Editing v${detail.version} — saving creates a new version`}>
        v{detail.version} itself never changes. Mappings you change become origin “human”; the server re-validates the whole plan and re-derives its
        clarifications.
      </Banner>

      <Card title="Mappings" subtitle="Target-schema order. Steps are a JSON array of {op, params}, validated as you type.">
        <OpReference ops={info.catalog.ops} />
        <ul className="mt-3 space-y-3">
          {drafts.map((d, i) => (
            <MappingEditor
              key={d.key}
              draft={d}
              check={checks[i] ?? null}
              sourceNames={sourceNames}
              onChange={(patch) => update(d.key, patch)}
              onToggleSource={(s) => toggleSource(d.key, s)}
            />
          ))}
        </ul>
      </Card>

      <Card title="Source accounting" subtitle="Every source field must be mapped or ignored with a reason; doing both is a warning.">
        <IgnoreEditor ignores={ignores} usedBy={usedBy} onChange={updateIgnore} />
      </Card>

      <Card title="Execution gate">
        <label htmlFor={budgetId} className="block text-xs font-medium text-slate-700">
          Error budget — maximum dry-run reject rate (%)
        </label>
        <input
          id={budgetId}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_ERROR_BUDGET_PCT}
          step={1}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          aria-invalid={budgetError ? true : undefined}
          aria-describedby={`${budgetId}-hint`}
          className={cx(inputCls, 'mt-1 max-w-[8rem] tabular-nums')}
        />
        <p id={`${budgetId}-hint`} className={cx('mt-1 text-xs', budgetError ? 'text-rose-700' : 'text-slate-500')}>
          {budgetError ?? `Execution is blocked when a dry run rejects more than this share of source records (0–${MAX_ERROR_BUDGET_PCT}; v${detail.version} uses ${detail.plan.errorBudgetPct}%).`}
        </p>
      </Card>

      <div className="sticky bottom-0 z-10 rounded-lg border border-slate-200 bg-white/95 p-3 shadow-md backdrop-blur">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-1 text-xs font-medium text-slate-700">
            Change note
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="What changed and why (recorded in history)"
              className={cx(inputCls, 'mt-1')}
            />
          </label>
          <div className="flex gap-2">
            <Button onClick={() => (dirty ? setConfirmDiscard(true) : onCancel())} disabled={save.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} disabled={!plan || !changed} onClick={() => plan && save.mutate(plan)}>
              Save as new version
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-xs" aria-live="polite">
          {errorCount > 0 ? (
            <span className="text-rose-700">
              {errorCount} problem{errorCount === 1 ? '' : 's'} to fix before saving.
            </span>
          ) : !changed ? (
            <span className="text-slate-500">No changes yet.</span>
          ) : warningCount > 0 ? (
            <span className="text-amber-800">
              {warningCount} warning{warningCount === 1 ? '' : 's'} will block approval — you can still save and fix them in a later version.
            </span>
          ) : (
            <span className="text-emerald-700">Ready to save as a child of v{detail.version}.</span>
          )}
        </p>
        {save.isError && (
          <div className="mt-2">
            <ErrorBanner error={save.error} title="The new version was not saved" />
          </div>
        )}
      </div>

      {confirmDiscard && (
        <Dialog
          open
          title="Discard your edits?"
          onClose={() => setConfirmDiscard(false)}
          footer={
            <>
              <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
              <Button variant="danger" onClick={onCancel}>
                Discard edits
              </Button>
            </>
          }
        >
          <p>Nothing has been saved; v{detail.version} stays exactly as it is.</p>
        </Dialog>
      )}
    </div>
  );
}

function MappingEditor({
  draft: d,
  check,
  sourceNames,
  onChange,
  onToggleSource,
}: {
  draft: Draft;
  check: StepsCheck | null;
  sourceNames: string[];
  onChange: (patch: Partial<Draft>) => void;
  onToggleSource: (source: string) => void;
}) {
  const id = useId();
  const typeLabel = d.field ? `${d.field.type}${d.field.required ? ' · required' : ''}` : 'unknown target';

  if (!d.mapped) {
    const required = d.field?.required ?? false;
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-800">{d.target}</span>
          <span className="text-[11px] text-slate-500">{typeLabel}</span>
          <Badge tone={required ? 'red' : 'neutral'}>{d.original ? 'removed' : 'unmapped'}</Badge>
        </div>
        <Button size="sm" onClick={() => onChange({ mapped: true })}>
          {d.original ? 'Restore mapping' : 'Add mapping'}
        </Button>
      </li>
    );
  }

  const edited =
    d.original !== null &&
    check?.ok === true &&
    canonicalJson({ s: d.sources, t: check.steps, r: d.rationale }) !== canonicalJson({ s: d.original.sources, t: d.original.steps, r: d.original.rationale });
  const options = [...sourceNames, ...d.sources.filter((s) => !sourceNames.includes(s))];
  const rows = Math.min(12, Math.max(3, d.stepsText.split('\n').length));
  const canAppend = appendStep(d.stepsText, 'copy') !== null;

  return (
    <li className={cx('rounded-md border p-3', check && !check.ok ? 'border-rose-300' : 'border-slate-200')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-900">{d.target}</span>
          <span className="text-[11px] text-slate-500">{typeLabel}</span>
          {d.original ? <OriginBadge origin={d.original.origin} /> : <Badge tone="green">new</Badge>}
          {edited && <Badge tone="amber">edited</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onChange({ mapped: false })}>
          Remove mapping
        </Button>
      </div>

      <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <fieldset>
          <legend className="text-xs font-medium text-slate-700">Source fields</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {options.map((name) => {
              const checked = d.sources.includes(name);
              return (
                <label
                  key={name}
                  className={cx(
                    'inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]',
                    checked ? 'border-indigo-300 bg-indigo-50 text-indigo-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                  )}
                >
                  <input type="checkbox" className="h-3 w-3 accent-indigo-600" checked={checked} onChange={() => onToggleSource(name)} />
                  {name}
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {d.sources.length === 0
              ? 'No source: steps must start with `default` (a constant).'
              : d.sources.length >= 2
                ? `Concat order (selection order): ${d.sources.join(' + ')}`
                : null}
          </p>
        </fieldset>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${id}-steps`} className="text-xs font-medium text-slate-700">
              Steps (JSON)
            </label>
            <select
              aria-label={`Append a step to ${d.target}`}
              value=""
              disabled={!canAppend}
              onChange={(e) => {
                const next = appendStep(d.stepsText, e.target.value as OpName);
                if (next !== null) onChange({ stepsText: next });
              }}
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 disabled:text-slate-400"
            >
              <option value="">+ append step…</option>
              {OP_NAMES.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </div>
          <textarea
            id={`${id}-steps`}
            value={d.stepsText}
            onChange={(e) => onChange({ stepsText: e.target.value })}
            rows={rows}
            spellCheck={false}
            aria-invalid={check && !check.ok ? true : undefined}
            aria-describedby={`${id}-steps-msg`}
            className={cx(inputCls, 'mt-1 font-mono text-xs leading-5')}
          />
          <div id={`${id}-steps-msg`} className="mt-1 text-xs" aria-live="polite">
            {check && !check.ok && (
              <ul className="space-y-0.5 text-rose-700">
                {check.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            {check?.ok && check.warning && <p className="text-amber-800">⚠ {check.warning} (blocks approval)</p>}
            {check?.ok && !check.warning && <p className="text-emerald-700">Valid · produces {check.produces}</p>}
          </div>
        </div>
      </div>

      <label className="mt-2 block text-xs font-medium text-slate-700">
        Rationale
        <input value={d.rationale} onChange={(e) => onChange({ rationale: e.target.value })} maxLength={600} className={cx(inputCls, 'mt-1 text-xs')} />
      </label>
    </li>
  );
}

function IgnoreEditor({
  ignores,
  usedBy,
  onChange,
}: {
  ignores: IgnoreDraft[];
  usedBy: Map<string, string[]>;
  onChange: (source: string, patch: Partial<IgnoreDraft>) => void;
}) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col" className={table.th}>Ignore</th>
            <th scope="col" className={table.th}>Source field</th>
            <th scope="col" className={table.th}>Mapped to</th>
            <th scope="col" className={table.th}>Reason (when ignored)</th>
            <th scope="col" className={table.th}>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ignores.map((g) => {
            const used = usedBy.get(g.source) ?? [];
            return (
              <tr key={g.source} className="align-middle">
                <td className={table.td}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-indigo-600"
                    checked={g.ignored}
                    onChange={(e) => onChange(g.source, { ignored: e.target.checked })}
                    aria-label={`Ignore ${g.source}`}
                  />
                </td>
                <td className={`${table.td} font-mono text-xs`}>
                  {g.source} {!g.known && <Badge tone="red">unknown</Badge>}
                </td>
                <td className={`${table.td} font-mono text-[11px]`}>{used.length ? used.join(', ') : <span className="text-slate-400">—</span>}</td>
                <td className={table.td}>
                  <input
                    value={g.reason}
                    onChange={(e) => onChange(g.source, { reason: e.target.value })}
                    disabled={!g.ignored}
                    maxLength={300}
                    placeholder={g.ignored ? 'Why it is not migrated' : ''}
                    aria-label={`Reason for ignoring ${g.source}`}
                    className={cx(inputCls, 'min-w-[12rem] text-xs')}
                  />
                </td>
                <td className={table.td}>
                  {g.ignored && used.length ? (
                    <Badge tone="amber">mapped and ignored</Badge>
                  ) : g.ignored ? (
                    <Badge tone="neutral">ignored</Badge>
                  ) : used.length ? (
                    <Badge tone="green">mapped</Badge>
                  ) : (
                    <Badge tone="red">not accounted</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OpReference({ ops }: { ops: OpInfo[] }) {
  return (
    <details className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-slate-700">Op reference ({ops.length} ops)</summary>
      <ul className="mt-2 grid gap-x-6 gap-y-1.5 md:grid-cols-2">
        {ops.map((o) => (
          <li key={o.name}>
            <code className="font-semibold text-slate-900">{o.name}</code>
            <span className="ml-1 text-slate-500">
              {o.in} → {o.out}
              {o.params.length > 0 && ` · params: ${o.params.join(', ')}`}
            </span>
            <p className="text-slate-600">
              {o.description} <span className="font-mono text-slate-500">{o.example}</span>
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
