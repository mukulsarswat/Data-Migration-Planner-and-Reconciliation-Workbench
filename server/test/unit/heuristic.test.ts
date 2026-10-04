import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildHeuristicPlan } from '../../src/engine/heuristic.ts';
import { applyClarification, computeClarifications } from '../../src/engine/triggers.ts';
import type { AnalysisContext } from '../../src/engine/triggers.ts';
import { profileFields } from '../../src/engine/profile.ts';
import { SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema, TargetSchema, Value } from '../../../shared/schemas.ts';
import { DEFAULT_ERROR_BUDGET_PCT, MigrationPlanSchema } from '../../../shared/plan.ts';
import { chainType } from '../../../shared/dsl.ts';
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
const ops = (steps: readonly Step[]) => steps.map((s) => s.op);

describe('buildHeuristicPlan on the fixture', () => {
  const plan = buildHeuristicPlan(ctx);
  const mapping = (t: string) => plan.mappings.find((m) => m.target === t)!;

  it('parses with MigrationPlanSchema and uses the server-owned error budget', () => {
    expect(MigrationPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.errorBudgetPct).toBe(DEFAULT_ERROR_BUDGET_PCT);
  });

  it('maps the same source fields as gold-plan.json for all 9 non-country targets, in schema order', () => {
    const expected = gold.mappings.filter((m) => m.sources.length > 0);
    expect(expected).toHaveLength(9);
    expect(plan.mappings.map((m) => m.target)).toEqual(target.fields.map((f) => f.name).filter((n) => n !== 'country'));
    for (const g of expected) expect(mapping(g.target).sources, g.target).toEqual(g.sources);
  });

  it('builds recipe steps that type-check into the target type', () => {
    expect(ops(mapping('external_ref').steps)).toEqual(['trim', 'uppercase']);
    expect(ops(mapping('email').steps)).toEqual(['trim', 'null_if_empty', 'lowercase']);
    expect(mapping('phone_e164').steps).toEqual(gold.mappings.find((m) => m.target === 'phone_e164')!.steps);
    expect(mapping('first_name').steps).toEqual([
      { op: 'trim', params: {} },
      { op: 'split_full_name', params: { part: 'first' } },
    ]);
    expect(mapping('last_name').steps[1]).toEqual({ op: 'split_full_name', params: { part: 'last' } });
    expect(mapping('status').steps).toEqual(gold.mappings.find((m) => m.target === 'status')!.steps);
    expect(mapping('created_on').steps).toEqual(gold.mappings.find((m) => m.target === 'created_on')!.steps);
    expect(ops(mapping('balance_cents').steps)).toEqual(['trim', 'parse_currency_to_cents']);
    expect(ops(mapping('is_vip').steps)).toEqual(['trim', 'to_boolean']);
    for (const m of plan.mappings) {
      const t = target.fields.find((f) => f.name === m.target)!;
      expect(chainType(m.sources.length, m.steps), m.target).toEqual({ ok: true, type: t.type });
      expect(m.origin).toBe('heuristic');
      expect(m.confidence).toBe('high');
      expect(m.rationale).toContain(m.sources[0]!);
    }
  });

  it('ignores fax and notes with reasons', () => {
    expect(plan.ignored.map((i) => i.source)).toEqual(['fax', 'notes']);
    for (const i of plan.ignored) expect(i.reason.length).toBeGreaterThan(10);
  });

  it('asks the trigger questions, country first among the blocking ones by id', () => {
    expect(plan.clarifications.map((c) => c.id)).toEqual([
      'clr-empty_required_values-balance_cents',
      'clr-required_target_unmapped-country',
      'clr-unmapped_enum_values-status',
      'clr-ambiguous_date_format-created_on',
    ]);
    expect(plan.clarifications).toEqual(computeClarifications(plan, ctx));
  });

  it('records one risk per clarification and a 2–3 sentence summary', () => {
    expect(plan.risks.map((r) => r.field)).toEqual(plan.clarifications.map((c) => c.field));
    expect(plan.risks[0]!.severity).toBe('high');
    expect(plan.risks.at(-1)!.severity).toBe('medium');
    const sentences = plan.summary.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(3);
  });

  it('is deterministic', () => {
    expect(buildHeuristicPlan(ctx)).toEqual(plan);
  });

  it('answering the country and bal questions clears those triggers', () => {
    let next = applyClarification(plan, 'clr-required_target_unmapped-country', 0, 'alice');
    next = applyClarification(next, 'clr-empty_required_values-balance_cents', 1, 'alice');
    expect(next.mappings.find((m) => m.target === 'country')!.steps).toEqual([{ op: 'default', params: { value: 'US' } }]);
    expect(computeClarifications(next, ctx).map((c) => c.id)).toEqual([
      'clr-unmapped_enum_values-status',
      'clr-ambiguous_date_format-created_on',
    ]);
  });
});

describe('buildHeuristicPlan confidence', () => {
  it('marks weak name matches low confidence and records a risk', () => {
    const s: SourceSchema = {
      name: 's',
      description: '',
      keyField: 'external_rf',
      fields: [{ name: 'external_rf', type: 'string', description: '', pii: false }],
    };
    const t: TargetSchema = { ...target, fields: target.fields.filter((f) => f.name === 'external_ref') };
    const rows = [{ sourceKey: 'r1', values: { external_rf: 'C-00001' } }];
    const plan = buildHeuristicPlan({ source: s, target: t, records: rows, profiles: profileFields(rows, s), run: fakeRun });
    // dice(externalref, externalrf) = 14/17 ⇒ 0.8 × 0.824 = 0.659 ⇒ low
    expect(plan.mappings).toEqual([expect.objectContaining({ target: 'external_ref', sources: ['external_rf'], confidence: 'low' })]);
    expect(plan.risks).toEqual([expect.objectContaining({ field: 'external_ref', severity: 'medium' })]);
    expect(plan.ignored).toEqual([]);
    expect(MigrationPlanSchema.parse(plan)).toEqual(plan);
  });
});
