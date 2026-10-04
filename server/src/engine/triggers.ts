// Clarification triggers: deterministic questions about a plan, each answer a deterministic plan patch.
// Answering applies the patch server-side (no LLM call); the route stores the result as a new `human` version.
import type { SourceRecord, SourceSchema, TargetField, TargetSchema } from '../../../shared/schemas.ts';
import type { Clarification, FieldMapping, MigrationPlan, PlanPatch, TriggerKind } from '../../../shared/plan.ts';
import type { Step } from '../../../shared/dsl.ts';
import type { MappingRunner } from '../../../shared/evidence.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';
import { suggestCandidates } from './candidates.ts';
import { maskValue } from './mask.ts';
import { countFormats } from './profile.ts';
import type { FieldProfile } from './profile.ts';

export type AnalysisContext = {
  source: SourceSchema;
  target: TargetSchema;
  records: readonly SourceRecord[];
  profiles: readonly FieldProfile[];
  /** Evaluates one mapping over one record (engine/transforms.ts `runMapping` in production). */
  run: MappingRunner;
};

type PlanMappings = Pick<MigrationPlan, 'mappings' | 'ignored'>;
type Option = Clarification['options'][number];

const MAX_CLARIFICATIONS = 8;
const LOW_MARGIN = 0.1;
const MAX_SHOWN_VALUES = 8;
const COUNTRY_CODE_PATTERN = '^[A-Z]{2}$';
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/;
const NO_CHANGE: PlanPatch = { kind: 'no_change' };

/**
 * Run every trigger over the plan's mappings (target-schema order) and return at most 8 unresolved clarifications,
 * blocking first, then by id. Ids are 'clr-<trigger>-<target field>' so re-running yields the same ids.
 */
export function computeClarifications(plan: PlanMappings, ctx: AnalysisContext): Clarification[] {
  const found: Clarification[] = [];
  for (const t of ctx.target.fields) {
    const mapping = plan.mappings.find((m) => m.target === t.name);
    if (!mapping) {
      if (t.required) found.push(requiredTargetUnmapped(t, ctx));
      continue;
    }
    for (const check of [unmappedEnumValues, ambiguousDateFormat, emptyRequiredValues, lowMarginCandidate]) {
      const c = check(t, mapping, ctx);
      if (c) found.push(c);
    }
  }
  return found.sort(byImpactThenId).slice(0, MAX_CLARIFICATIONS);
}

// ---- Triggers ----

/** Blocking: a required target with no mapping (every row would fail MISSING_REQUIRED). */
function requiredTargetUnmapped(t: TargetField, ctx: AnalysisContext): Clarification {
  const lead = `${t.name} is required but nothing maps to it, so all ${ctx.records.length} rows would be rejected (MISSING_REQUIRED).`;
  if (t.pattern !== COUNTRY_CODE_PATTERN) {
    return clarification('required_target_unmapped', t.name, 'blocking', `${lead} Map a source field or add a default step by editing the plan.`, []);
  }
  const na = northAmericanPhones(ctx);
  const evidence = na !== null && na.matching * 2 > na.nonBlank;
  const codes = evidence ? ['US', 'CA', 'GB'] : ['CA', 'GB', 'US'];
  const options = codes.map((code) => ({
    label:
      code === 'US' && evidence
        ? `Default to 'US' (${na.matching} of ${na.nonBlank} phone numbers have North-American formats)`
        : `Default to '${code}'`,
    patch: setMapping(
      { target: t.name, sources: [], steps: [{ op: 'default', params: { value: code } }] },
      `Constant '${code}' for every row (reviewer's answer: no source column holds ${t.name}).`,
    ),
  }));
  return clarification('required_target_unmapped', t.name, 'blocking', `${lead} Which country code should every row get?`, options);
}

/** Blocking: the chain ends in map_values without a fallback and some rows hit an unlisted value. */
function unmappedEnumValues(t: TargetField, m: FieldMapping, ctx: AnalysisContext): Clarification | null {
  const last = m.steps.at(-1);
  if (last?.op !== 'map_values' || last.params.fallback !== null) return null;
  const lastIndex = m.steps.length - 1;
  const counts = new Map<string, number>();
  for (const r of ctx.records) {
    const res = ctx.run(r.values, m);
    if (res.ok || res.stepIndex !== lastIndex) continue;
    const raw = m.sources.map((s) => rawOf(r.values, s)).join(' + ');
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const rows = [...counts.values()].reduce((a, b) => a + b, 0);
  const pii = isPii(m.sources, ctx.source);
  const shown = [...counts]
    .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
    .map(([v, n]) => `'${pii ? maskValue(v) : v}' ×${n}`);
  const more = shown.length > MAX_SHOWN_VALUES ? `, +${shown.length - MAX_SHOWN_VALUES} more` : '';
  const values = t.enum ?? unique(last.params.pairs.map((p) => p.to));
  const question =
    `${rows} rows have ${m.sources.join(' + ')} values not listed in the ${t.name} mapping: ${shown.slice(0, MAX_SHOWN_VALUES).join(', ')}${more}. ` +
    `Quarantine them or map them all to one value?`;
  const options: Option[] = [
    { label: `Quarantine the ${rows} rows (current plan)`, patch: NO_CHANGE },
    ...values.map((v) => ({
      label: `Map them to '${v}'`,
      patch: setMapping(
        { ...m, steps: [...m.steps.slice(0, lastIndex), { op: 'map_values', params: { pairs: last.params.pairs, fallback: v } }] },
        `Listed codes map as before; every other value maps to '${v}' (reviewer's choice).`,
      ),
    })),
  ];
  return clarification('unmapped_enum_values', t.name, 'blocking', question, options);
}

/** Advisory: a date chain parses month-first only while some raw values are clearly day-first. */
function ambiguousDateFormat(t: TargetField, m: FieldMapping, ctx: AnalysisContext): Clarification | null {
  if (t.type !== 'date' || m.sources.length !== 1) return null;
  const at = m.steps.findIndex((s) => s.op === 'parse_date');
  const step = m.steps[at];
  if (step?.op !== 'parse_date' || step.params.formats.includes('dd/MM/yyyy')) return null;
  const src = m.sources[0]!;
  const dayFirst = ctx.records.filter((r) => isDayFirst(rawOf(r.values, src)));
  if (dayFirst.length === 0) return null;

  const patched = { ...m, steps: m.steps.map((s, i): Step => (i === at ? { op: 'parse_date', params: { formats: [...step.params.formats, 'dd/MM/yyyy'] } } : s)) };
  const ambiguous = ctx.records.filter((r) => {
    const res = ctx.run(r.values, patched);
    return !res.ok && res.code === 'AMBIGUOUS_DATE';
  }).length;
  const rescued = dayFirst.filter((r) => ctx.run(r.values, patched).ok).length;
  const question =
    `${dayFirst.length} rows have day-first ${src} dates (first number > 12) that ${step.params.formats.join(', ')} cannot parse, so they are quarantined. ` +
    `Also accept day/month when unambiguous?`;
  return clarification('ambiguous_date_format', t.name, 'advisory', question, [
    { label: `Keep US month/day; the ${dayFirst.length} day-first rows stay quarantined`, patch: NO_CHANGE },
    {
      label: `Also accept dd/MM/yyyy: ${rescued} day-first rows load, but ${ambiguous} rows become AMBIGUOUS_DATE`,
      patch: setMapping(patched, `Parses ${step.params.formats.join(', ')} and also dd/MM/yyyy; dates that differ between the two readings fail as AMBIGUOUS_DATE (reviewer's choice).`),
    },
  ]);
}

/**
 * Blocking: a required, typed (date/integer/boolean) single-source target whose chain has no `default` and rejects rows whose
 * source value is blank (checked with ctx.run, so e.g. to_boolean listing '' as false does not fire). String targets are left
 * to the dry run: a blank name is a plain MISSING_REQUIRED and there is no constant worth offering.
 */
function emptyRequiredValues(t: TargetField, m: FieldMapping, ctx: AnalysisContext): Clarification | null {
  if (!t.required || t.type === 'string' || m.sources.length !== 1 || m.steps.some((s) => s.op === 'default')) return null;
  const src = m.sources[0]!;
  const rejected = ctx.records.filter((r) => {
    if (rawOf(r.values, src).trim() !== '') return false;
    const res = ctx.run(r.values, m);
    return !res.ok || res.value === null;
  }).length;
  if (rejected === 0) return null;

  const options: Option[] = [{ label: `Quarantine the ${rejected} rows (current plan)`, patch: NO_CHANGE }];
  if (t.type === 'integer') {
    options.push({ label: 'Treat empty as 0', patch: setMapping({ ...m, steps: withZeroDefault(m.steps) }, `An empty ${src} means 0 (reviewer's choice).`) });
  }
  const question = `${rejected} rows have an empty ${src}; ${t.name} is required and the current steps reject them. Quarantine those rows${
    t.type === 'integer' ? ' or treat empty as 0' : ''
  }?`;
  return clarification('empty_required_values', t.name, 'blocking', question, options);
}

/** Advisory: a required target mapped from the runner-up candidate when the top two are within 0.1. */
function lowMarginCandidate(t: TargetField, m: FieldMapping, ctx: AnalysisContext): Clarification | null {
  if (!t.required || m.sources.length !== 1) return null;
  const [top, second] = suggestCandidates(t, ctx.source, ctx.profiles);
  if (!top || !second || m.sources[0] !== second.source) return null;
  const margin = Math.round((top.score - second.score) * 1000) / 1000;
  if (margin >= LOW_MARGIN) return null;
  const question =
    `${t.name} is mapped from ${second.source} (score ${second.score}) but ${top.source} scores ${top.score}; ` +
    `the margin ${margin} is below ${LOW_MARGIN}. Which source holds ${t.name}?`;
  return clarification('low_margin_candidate', t.name, 'advisory', question, [
    { label: `Keep ${second.source}`, patch: NO_CHANGE },
    { label: `Switch to ${top.source} (same steps)`, patch: setMapping({ ...m, sources: [top.source] }, `${top.source} holds ${t.name} rather than ${second.source} (reviewer's choice).`) },
  ]);
}

// ---- Answering and merging ----

/**
 * Apply option `choice` (or dismiss an advisory question) and record the resolution. Pure: returns a new plan.
 * set_mapping replaces the mapping for its target in place, or appends it; ignore_source adds (or updates) an ignored entry
 * and leaves mappings untouched; no_change only records the answer.
 */
export function applyClarification(plan: MigrationPlan, clarificationId: string, choice: number | 'dismissed', by: string): MigrationPlan {
  const index = plan.clarifications.findIndex((c) => c.id === clarificationId);
  const c = plan.clarifications[index];
  if (!c) throw new Error('UNKNOWN_CLARIFICATION');
  if (c.resolution !== null) throw new Error('ALREADY_RESOLVED');
  let next: MigrationPlan = plan;
  if (choice === 'dismissed') {
    if (c.impact === 'blocking') throw new Error('CANNOT_DISMISS_BLOCKING');
  } else {
    const option = Number.isInteger(choice) ? c.options[choice] : undefined;
    if (!option) throw new Error('BAD_CHOICE');
    next = applyPatch(plan, option.patch);
  }
  return { ...next, clarifications: plan.clarifications.map((x, i) => (i === index ? { ...x, resolution: { choice, by } } : x)) };
}

function applyPatch(plan: MigrationPlan, patch: PlanPatch): MigrationPlan {
  switch (patch.kind) {
    case 'set_mapping': {
      const mapping = structuredClone(patch.mapping);
      const i = plan.mappings.findIndex((m) => m.target === mapping.target);
      return { ...plan, mappings: i < 0 ? [...plan.mappings, mapping] : plan.mappings.map((m, j) => (j === i ? mapping : m)) };
    }
    case 'ignore_source': {
      const entry = { source: patch.source, reason: patch.reason };
      const i = plan.ignored.findIndex((g) => g.source === patch.source);
      return { ...plan, ignored: i < 0 ? [...plan.ignored, entry] : plan.ignored.map((g, j) => (j === i ? entry : g)) };
    }
    case 'no_change':
      return plan;
  }
}

/**
 * Carry clarifications across plan versions: keep every resolved entry, keep unresolved entries that are still computed
 * (existing wording wins) or come from the agent, drop the rest, and add newly computed ids. Blocking first, then id.
 */
export function mergeClarifications(existing: readonly Clarification[], computed: readonly Clarification[]): Clarification[] {
  // Answered entries and agent questions are history: keep them. Every other open question is re-derived from the
  // current plan, so its wording and option patches are never stale (a stale "set_mapping" option could otherwise
  // overwrite a reviewer's later edit of that mapping).
  const kept = existing.filter((c) => c.resolution !== null || c.trigger === 'agent_question');
  const keptIds = new Set(kept.map((c) => c.id));
  return [...kept, ...computed.filter((c) => !keptIds.has(c.id))].sort(byImpactThenId);
}

// ---- Helpers ----

function byImpactThenId(a: Clarification, b: Clarification): number {
  if (a.impact !== b.impact) return a.impact === 'blocking' ? -1 : 1;
  return compareCodeUnits(a.id, b.id);
}

const PHONE_TOKENS = new Set(['phone', 'tel', 'telephone', 'mobile', 'cell', 'cellphone']);

/** Clip to `max` UTF-16 units without splitting a surrogate pair. */
const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
};
/** Own-property read of a raw value ('' when absent; never an inherited Object.prototype member). */
const rawOf = (values: Readonly<Record<string, string>>, field: string): string => (Object.hasOwn(values, field) ? (values[field] ?? '') : '');

function clarification(trigger: TriggerKind, field: string, impact: Clarification['impact'], question: string, options: Option[]): Clarification {
  return {
    id: `clr-${trigger}-${field}`,
    question: clip(question, 400),
    impact,
    trigger,
    field,
    options: options.map((o) => ({ label: clip(o.label, 160), patch: o.patch })),
    resolution: null,
  };
}

/** A set_mapping patch carrying a reviewer-chosen mapping (origin human, confidence high). */
function setMapping(m: { target: string; sources: readonly string[]; steps: readonly Step[] }, rationale: string): PlanPatch {
  return {
    kind: 'set_mapping',
    mapping: { target: m.target, sources: [...m.sources], steps: structuredClone([...m.steps]), origin: 'human', confidence: 'high', rationale: clip(rationale.trim(), 600) },
  };
}

/** Insert null_if_empty + default '0' right after a leading trim (or at the start); reuse an existing null_if_empty there. */
function withZeroDefault(steps: readonly Step[]): Step[] {
  let at = steps[0]?.op === 'trim' ? 1 : 0;
  const insert: Step[] = [];
  if (steps[at]?.op === 'null_if_empty') at++;
  else insert.push({ op: 'null_if_empty', params: {} });
  insert.push({ op: 'default', params: { value: '0' } });
  return [...steps.slice(0, at), ...insert, ...steps.slice(at)];
}

/** Clearly day-first slash date: first number > 12 and second a valid month. */
function isDayFirst(raw: string): boolean {
  const m = SLASH_DATE.exec(raw.trim());
  return m !== null && Number(m[1]) > 12 && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** Phone-like source field's non-blank format counts that look North American (10 digits, or 11 with a leading country digit). */
function northAmericanPhones(ctx: AnalysisContext): { matching: number; nonBlank: number } | null {
  const field = ctx.source.fields.find((f) => f.name.toLowerCase().split(/[^a-z0-9]+/).some((tok) => PHONE_TOKENS.has(tok)));
  const profile = field && ctx.profiles.find((p) => p.field === field.name);
  if (!profile) return null;
  return countFormats(profile, (sig) => {
    const digits = sig.replace(/[^9]/g, '').length;
    return digits === 10 || (digits === 11 && /^\+?9\D/.test(sig));
  });
}

function isPii(sources: readonly string[], source: SourceSchema): boolean {
  return sources.some((s) => source.fields.find((f) => f.name === s)?.pii === true);
}

function unique(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) === i);
}
