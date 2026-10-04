import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyClarification, computeClarifications, mergeClarifications } from '../../src/engine/triggers.ts';
import type { AnalysisContext } from '../../src/engine/triggers.ts';
import { profileFields } from '../../src/engine/profile.ts';
import { SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema, TargetSchema, Value } from '../../../shared/schemas.ts';
import { ClarificationSchema, MigrationPlanSchema } from '../../../shared/plan.ts';
import type { Clarification, FieldMapping, MigrationPlan } from '../../../shared/plan.ts';
import type { Step } from '../../../shared/dsl.ts';
import type { MappingResult, MappingRunner } from '../../../shared/evidence.ts';

const DATASET = path.resolve(import.meta.dirname, '../../src/dataset');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DATASET, name), 'utf8'));
const source = SourceSchemaSchema.parse(readJson('source-schema.json'));
const target = TargetSchemaSchema.parse(readJson('target-schema.json'));
const records = readJson('source-records.json') as SourceRecord[];
const gold = MigrationPlanSchema.parse(readJson('gold-plan.json'));

// ---- Fake MappingRunner (engine/transforms.ts is owned elsewhere): single-source chains, the ops these tests touch. ----
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function isoDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseWith(v: string, format: string): string | null {
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const mon = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(v);
  if (format === 'MM/dd/yyyy') return slash ? isoDate(+slash[3]!, +slash[1]!, +slash[2]!) : null;
  if (format === 'dd/MM/yyyy') return slash ? isoDate(+slash[3]!, +slash[2]!, +slash[1]!) : null;
  if (format === 'yyyy-MM-dd') return iso ? isoDate(+iso[1]!, +iso[2]!, +iso[3]!) : null;
  if (format === 'dd-MMM-yyyy') return mon ? isoDate(+mon[3]!, MONTHS.indexOf(mon[2]!.toLowerCase()) + 1, +mon[1]!) : null;
  throw new Error(`fake runner: format ${format}`);
}
const fakeRun: MappingRunner = (values, mapping): MappingResult => {
  if (mapping.sources.length > 1) throw new Error('fake runner: concat not supported');
  let v: Value = mapping.sources.length === 0 ? null : (values[mapping.sources[0]!] ?? null);
  for (let i = 0; i < mapping.steps.length; i++) {
    const step: Step = mapping.steps[i]!;
    const fail = (message: string, code: 'TRANSFORM_FAILED' | 'AMBIGUOUS_DATE' = 'TRANSFORM_FAILED'): MappingResult => ({
      ok: false,
      stepIndex: i,
      op: step.op,
      code,
      message,
    });
    if (v === null && step.op !== 'null_if_empty' && step.op !== 'default') continue;
    const s = v as string;
    switch (step.op) {
      case 'trim':
        v = s.trim();
        break;
      case 'uppercase':
        v = s.toUpperCase();
        break;
      case 'lowercase':
        v = s.toLowerCase();
        break;
      case 'null_if_empty':
        v = v === null || s.trim() === '' ? null : s;
        break;
      case 'default':
        v = v ?? step.params.value;
        break;
      case 'map_values': {
        const hit = step.params.pairs.find((p) => p.from === s);
        if (hit) v = hit.to;
        else if (step.params.fallback !== null) v = step.params.fallback;
        else return fail(`no mapping for '${s}'`);
        break;
      }
      case 'to_boolean': {
        const k = s.trim().toUpperCase();
        if (step.params.true_values.some((t) => t.toUpperCase() === k)) v = true;
        else if (step.params.false_values.some((t) => t.toUpperCase() === k)) v = false;
        else return fail(`not a boolean: '${s}'`);
        break;
      }
      case 'parse_currency_to_cents': {
        const m = /^(-)?(\()?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\))?$/.exec(s);
        if (!m || Boolean(m[2]) !== Boolean(m[5])) return fail(`not money: '${s}'`);
        const cents = Number(m[3]!.replaceAll(',', '')) * 100 + Number((m[4] ?? '').padEnd(2, '0'));
        v = m[1] || m[2] ? -cents : cents;
        break;
      }
      case 'parse_date': {
        const dates = new Set(step.params.formats.map((f) => parseWith(s, f)).filter((d) => d !== null));
        if (dates.size > 1) return fail(`ambiguous date '${s}'`, 'AMBIGUOUS_DATE');
        const [d] = dates;
        if (d === undefined) return fail(`unparseable date '${s}'`);
        v = d;
        break;
      }
      default:
        throw new Error(`fake runner: op ${step.op} not supported`);
    }
  }
  return { ok: true, value: v };
};
// ---------------------------------------------------------------------------------------------------------------------

const ctx: AnalysisContext = { source, target, records, profiles: profileFields(records, source), run: fakeRun };
const withMapping = (plan: MigrationPlan, target: string, change: Partial<FieldMapping> | null): MigrationPlan => ({
  ...plan,
  mappings: change === null
    ? plan.mappings.filter((m) => m.target !== target)
    : plan.mappings.map((m) => (m.target === target ? { ...m, ...change } : m)),
});
const ids = (cs: readonly Clarification[]) => cs.map((c) => c.id);
const byId = (cs: readonly Clarification[], id: string) => cs.find((c) => c.id === id)!;
const goldBal = gold.mappings.find((m) => m.target === 'balance_cents')!;

describe('computeClarifications on the gold plan', () => {
  const cs = computeClarifications(gold, ctx);

  it('raises only the enum and date questions (gold already defaults bal and country)', () => {
    expect(ids(cs)).toEqual(['clr-unmapped_enum_values-status', 'clr-ambiguous_date_format-created_on']);
    for (const c of cs) {
      expect(ClarificationSchema.parse(c)).toEqual(c);
      expect(c.resolution).toBeNull();
    }
  });

  it('unmapped_enum_values: lists X, Z, blank and whitespace codes with counts and offers quarantine or a fallback', () => {
    const c = byId(cs, 'clr-unmapped_enum_values-status');
    expect(c).toMatchObject({ impact: 'blocking', trigger: 'unmapped_enum_values', field: 'status' });
    expect(c.question).toContain('5 rows');
    for (const part of ["'X' ×2", "'Z' ×1", "'' ×1", "' ' ×1"]) expect(c.question).toContain(part);
    expect(c.options[0]!.patch).toEqual({ kind: 'no_change' });
    expect(c.options[0]!.label).toMatch(/quarantine/i);
    const fallbacks = c.options.slice(1).map((o) => {
      if (o.patch.kind !== 'set_mapping') throw new Error('expected set_mapping');
      const last = o.patch.mapping.steps.at(-1)!;
      expect(o.patch.mapping).toMatchObject({ target: 'status', sources: ['status'], origin: 'human', confidence: 'high' });
      return last.op === 'map_values' ? last.params.fallback : 'wrong op';
    });
    expect(fallbacks).toEqual(['active', 'inactive', 'pending']);
    expect(c.options[1]!.label).toBe("Map them to 'active'");
  });

  it('ambiguous_date_format: counts the 3 day-first rows and the rows that would become AMBIGUOUS_DATE', () => {
    const c = byId(cs, 'clr-ambiguous_date_format-created_on');
    expect(c).toMatchObject({ impact: 'advisory', trigger: 'ambiguous_date_format', field: 'created_on' });
    expect(c.question).toContain('3 rows');
    expect(c.options[0]!.patch).toEqual({ kind: 'no_change' });
    const accept = c.options[1]!;
    expect(accept.label).toContain('39 rows');
    expect(accept.label).toContain('AMBIGUOUS_DATE');
    if (accept.patch.kind !== 'set_mapping') throw new Error('expected set_mapping');
    expect(accept.patch.mapping.steps[1]).toEqual({
      op: 'parse_date',
      params: { formats: ['MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MMM-yyyy', 'dd/MM/yyyy'] },
    });
  });
});

describe('computeClarifications triggers', () => {
  it('required_target_unmapped: offers US first (phones look North American), then CA and GB', () => {
    const cs = computeClarifications(withMapping(gold, 'country', null), ctx);
    const c = byId(cs, 'clr-required_target_unmapped-country');
    expect(c).toMatchObject({ impact: 'blocking', trigger: 'required_target_unmapped', field: 'country', resolution: null });
    expect(c.question).toContain('200 rows');
    expect(c.options[0]!.label).toMatch(/North[- ]American/);
    expect(c.options[0]!.label).toContain('162 of 165');
    expect(c.options.map((o) => (o.patch.kind === 'set_mapping' ? o.patch.mapping : null))).toEqual(
      ['US', 'CA', 'GB'].map((code) => ({
        target: 'country',
        sources: [],
        steps: [{ op: 'default', params: { value: code } }],
        origin: 'human',
        confidence: 'high',
        rationale: expect.stringContaining(code),
      })),
    );
  });

  it('required_target_unmapped: no constant options for a target without a sensible default', () => {
    const cs = computeClarifications(withMapping(gold, 'created_on', null), ctx);
    const c = byId(cs, 'clr-required_target_unmapped-created_on');
    expect(c.options).toEqual([]);
  });

  it('empty_required_values: 6 empty bal rows; "Treat empty as 0" rebuilds the gold chain', () => {
    const plan = withMapping(gold, 'balance_cents', {
      steps: [
        { op: 'trim', params: {} },
        { op: 'parse_currency_to_cents', params: {} },
      ],
    });
    const c = byId(computeClarifications(plan, ctx), 'clr-empty_required_values-balance_cents');
    expect(c).toMatchObject({ impact: 'blocking', trigger: 'empty_required_values', field: 'balance_cents' });
    expect(c.question).toContain('6 rows');
    expect(c.question).toContain('bal');
    expect(c.options[0]!.patch).toEqual({ kind: 'no_change' });
    expect(c.options[1]!.label).toBe('Treat empty as 0');
    if (c.options[1]!.patch.kind !== 'set_mapping') throw new Error('expected set_mapping');
    expect(c.options[1]!.patch.mapping.steps).toEqual(goldBal.steps);
  });

  it('empty_required_values: inserts at the start when the chain has no leading trim', () => {
    const plan = withMapping(gold, 'balance_cents', { steps: [{ op: 'parse_currency_to_cents', params: {} }] });
    const c = byId(computeClarifications(plan, ctx), 'clr-empty_required_values-balance_cents');
    if (c.options[1]!.patch.kind !== 'set_mapping') throw new Error('expected set_mapping');
    expect(c.options[1]!.patch.mapping.steps.map((s) => s.op)).toEqual(['null_if_empty', 'default', 'parse_currency_to_cents']);
  });

  it('empty_required_values: only fires when the typed chain actually rejects the blanks', () => {
    // gold's to_boolean lists '' as false ⇒ the 62 blank vip_flag rows load fine.
    expect(ids(computeClarifications(gold, ctx)).some((id) => id.startsWith('clr-empty_required_values'))).toBe(false);
    const strictVip = withMapping(gold, 'is_vip', {
      steps: [
        { op: 'trim', params: {} },
        { op: 'to_boolean', params: { true_values: ['Y', 'YES'], false_values: ['N', 'NO'] } },
      ],
    });
    const c = byId(computeClarifications(strictVip, ctx), 'clr-empty_required_values-is_vip');
    expect(c.question).toContain('62 rows');
    expect(c.options.map((o) => o.patch.kind)).toEqual(['no_change']);
  });

  it('low_margin_candidate: fires when the mapping uses the runner-up of a close pair', () => {
    const s: SourceSchema = {
      name: 's',
      description: '',
      keyField: 'cust_id',
      fields: ['cust_id', 'customer_id'].map((name) => ({ name, type: 'string' as const, description: '', pii: false })),
    };
    const t: TargetSchema = { ...target, fields: target.fields.filter((f) => f.name === 'external_ref') };
    const rows = [{ sourceKey: 'r1', values: { cust_id: 'C-00001', customer_id: 'C-00001' } }];
    const steps: Step[] = [
      { op: 'trim', params: {} },
      { op: 'uppercase', params: {} },
    ];
    const mapping: FieldMapping = { target: 'external_ref', sources: ['customer_id'], steps, origin: 'agent', confidence: 'medium', rationale: '' };
    const lctx: AnalysisContext = { source: s, target: t, records: rows, profiles: profileFields(rows, s), run: fakeRun };
    const cs = computeClarifications({ mappings: [mapping], ignored: [{ source: 'cust_id', reason: 'dup' }] }, lctx);
    expect(ids(cs)).toEqual(['clr-low_margin_candidate-external_ref']);
    const c = cs[0]!;
    expect(c.impact).toBe('advisory');
    expect(c.options[0]!.patch).toEqual({ kind: 'no_change' });
    expect(c.options[1]!.patch).toEqual({ kind: 'set_mapping', mapping: expect.objectContaining({ sources: ['cust_id'], steps, origin: 'human' }) });
    // Using the top candidate does not fire.
    expect(computeClarifications({ mappings: [{ ...mapping, sources: ['cust_id'] }], ignored: [] }, lctx)).toEqual([]);
  });

  it('orders blocking first then by id, and caps the list at 8', () => {
    const t: TargetSchema = {
      ...target,
      fields: Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, type: 'string' as const, required: true, unique: false, description: '' })),
    };
    const cs = computeClarifications({ mappings: [], ignored: [] }, { ...ctx, target: t });
    expect(ids(cs)).toEqual(Array.from({ length: 8 }, (_, i) => `clr-required_target_unmapped-f${i}`));

    const all = computeClarifications(withMapping(withMapping(gold, 'country', null), 'balance_cents', { steps: [{ op: 'parse_currency_to_cents', params: {} }] }), ctx);
    expect(ids(all)).toEqual([
      'clr-empty_required_values-balance_cents',
      'clr-required_target_unmapped-country',
      'clr-unmapped_enum_values-status',
      'clr-ambiguous_date_format-created_on',
    ]);
  });
});

describe('applyClarification', () => {
  const base = withMapping(gold, 'country', null);
  const plan: MigrationPlan = { ...base, clarifications: computeClarifications(base, ctx) };

  it('country option 0 appends the default-US human mapping and records the resolution, without mutating the input', () => {
    const before = structuredClone(plan);
    const next = applyClarification(plan, 'clr-required_target_unmapped-country', 0, 'alice');
    expect(plan).toEqual(before);
    expect(next.mappings.at(-1)).toMatchObject({
      target: 'country',
      sources: [],
      steps: [{ op: 'default', params: { value: 'US' } }],
      origin: 'human',
      confidence: 'high',
    });
    expect(byId(next.clarifications, 'clr-required_target_unmapped-country').resolution).toEqual({ choice: 0, by: 'alice' });
    expect(MigrationPlanSchema.parse(next)).toEqual(next);
  });

  it('set_mapping replaces an existing mapping in place', () => {
    const next = applyClarification(plan, 'clr-unmapped_enum_values-status', 2, 'bob');
    const i = plan.mappings.findIndex((m) => m.target === 'status');
    expect(next.mappings).toHaveLength(plan.mappings.length);
    expect(next.mappings[i]!.steps.at(-1)).toMatchObject({ op: 'map_values', params: { fallback: 'inactive' } });
    expect(next.mappings[i]!.origin).toBe('human');
  });

  it('no_change and dismissal only record the resolution', () => {
    const kept = applyClarification(plan, 'clr-unmapped_enum_values-status', 0, 'bob');
    expect(kept.mappings).toEqual(plan.mappings);
    const dismissed = applyClarification(plan, 'clr-ambiguous_date_format-created_on', 'dismissed', 'carol');
    expect(dismissed.mappings).toEqual(plan.mappings);
    expect(byId(dismissed.clarifications, 'clr-ambiguous_date_format-created_on').resolution).toEqual({ choice: 'dismissed', by: 'carol' });
  });

  it('ignore_source appends to ignored', () => {
    const q: Clarification = {
      id: 'clr-agent_question-fax',
      question: 'Drop fax?',
      impact: 'advisory',
      trigger: 'agent_question',
      field: 'fax',
      options: [{ label: 'Ignore fax', patch: { kind: 'ignore_source', source: 'fax', reason: 'unused' } }],
      resolution: null,
    };
    const p: MigrationPlan = { ...plan, ignored: [], clarifications: [q] };
    expect(applyClarification(p, q.id, 0, 'dan').ignored).toEqual([{ source: 'fax', reason: 'unused' }]);
  });

  it('rejects unknown ids, repeated answers, bad choices and dismissing blocking questions', () => {
    expect(() => applyClarification(plan, 'clr-nope', 0, 'x')).toThrow('UNKNOWN_CLARIFICATION');
    const once = applyClarification(plan, 'clr-unmapped_enum_values-status', 0, 'x');
    expect(() => applyClarification(once, 'clr-unmapped_enum_values-status', 1, 'x')).toThrow('ALREADY_RESOLVED');
    for (const bad of [4, -1, 1.5]) expect(() => applyClarification(plan, 'clr-unmapped_enum_values-status', bad, 'x')).toThrow('BAD_CHOICE');
    expect(() => applyClarification(plan, 'clr-required_target_unmapped-country', 'dismissed', 'x')).toThrow('CANNOT_DISMISS_BLOCKING');
  });
});

describe('mergeClarifications', () => {
  const c = (id: string, impact: Clarification['impact'], extra: Partial<Clarification> = {}): Clarification => ({
    id,
    question: `q ${id}`,
    impact,
    trigger: 'required_target_unmapped',
    field: null,
    options: [],
    resolution: null,
    ...extra,
  });

  it('keeps resolved entries and agent questions, refreshes still-relevant open ones, drops stale ones, adds new ones', () => {
    const existing = [
      c('clr-a', 'advisory', { resolution: { choice: 'dismissed', by: 'x' } }), // resolved, no longer computed ⇒ kept
      c('clr-b', 'blocking'), // unresolved, still computed ⇒ replaced by the fresh computed entry (no stale options)
      c('clr-c', 'blocking'), // unresolved, no longer computed ⇒ dropped
      c('clr-d', 'advisory', { trigger: 'agent_question' }), // agent question ⇒ kept
    ];
    const computed = [c('clr-b', 'blocking', { question: 'fresh' }), c('clr-e', 'blocking'), c('clr-a', 'advisory')];
    const merged = mergeClarifications(existing, computed);
    expect(ids(merged)).toEqual(['clr-b', 'clr-e', 'clr-a', 'clr-d']);
    expect(merged[0]!.question).toBe('fresh');
    expect(merged[2]!.resolution).toEqual({ choice: 'dismissed', by: 'x' });
  });
});
