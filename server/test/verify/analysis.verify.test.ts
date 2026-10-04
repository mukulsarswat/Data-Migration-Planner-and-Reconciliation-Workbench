// Adversarial verification of module C (analysis: mask, profile, candidates, gaps, triggers, heuristic) against its spec
// and the shared contracts. Uses the real engine/transforms.ts `runMapping` (production MappingRunner) instead of a fake.
// Tests named "[DEFECT] …" reproduce confirmed spec violations and are expected to fail until the module is fixed.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema, TargetField, TargetSchema } from '../../../shared/schemas.ts';
import { ClarificationSchema, FieldGapsSchema, MigrationPlanSchema } from '../../../shared/plan.ts';
import type { Clarification, FieldMapping, MigrationPlan } from '../../../shared/plan.ts';
import { chainType } from '../../../shared/dsl.ts';
import type { Step } from '../../../shared/dsl.ts';
import { maskRecord, maskValue } from '../../src/engine/mask.ts';
import { formatSignature, profileFields } from '../../src/engine/profile.ts';
import { suggestCandidates } from '../../src/engine/candidates.ts';
import { computeFieldGaps } from '../../src/engine/gaps.ts';
import { applyClarification, computeClarifications, mergeClarifications } from '../../src/engine/triggers.ts';
import type { AnalysisContext } from '../../src/engine/triggers.ts';
import { buildHeuristicPlan } from '../../src/engine/heuristic.ts';
import { runMapping } from '../../src/engine/transforms.ts';
import { validatePlanStatic } from '../../src/engine/staticValidate.ts';
import { dryRun } from '../../src/engine/dryRun.ts';

// ---- Fixtures and helpers ----

const load = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../../src/dataset/${name}`, import.meta.url), 'utf8'));
const source = SourceSchemaSchema.parse(load('source-schema.json'));
const target = TargetSchemaSchema.parse(load('target-schema.json'));
const records = load('source-records.json') as SourceRecord[];
const gold = (): MigrationPlan => MigrationPlanSchema.parse(load('gold-plan.json'));
const profiles = profileFields(records, source);
const ctx: AnalysisContext = { source, target, records, profiles, run: runMapping };
const MARKER = 'INJECT-7f3a';

const sourceOf = (fields: readonly (string | [string, boolean])[]): SourceSchema => {
  const list = fields.map((f) => (typeof f === 'string' ? { name: f, pii: false } : { name: f[0], pii: f[1] }));
  return {
    name: 's',
    description: '',
    keyField: list[0]!.name,
    fields: list.map((f) => ({ name: f.name, type: 'string' as const, pii: f.pii, description: '' })),
  };
};
const field = (name: string, type: TargetField['type'], extra: Partial<TargetField> = {}): TargetField => ({
  name,
  type,
  required: true,
  unique: false,
  description: '',
  ...extra,
});
const targetOf = (fields: TargetField[]): TargetSchema => ({ name: 't', description: '', keyField: fields[0]!.name, fields });
const targetField = (name: string): TargetField => target.fields.find((f) => f.name === name)!;
const rowsOf = (values: Record<string, string>[]): SourceRecord[] =>
  values.map((v, i) => ({ sourceKey: `r${String(i + 1).padStart(4, '0')}`, values: v }));
const ctxOf = (s: SourceSchema, t: TargetSchema, rs: readonly SourceRecord[]): AnalysisContext => ({
  source: s,
  target: t,
  records: rs,
  profiles: profileFields(rs, s),
  run: runMapping,
});
const ids = (cs: readonly Clarification[]) => cs.map((c) => c.id);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/** A UTF-16 high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Deterministic PRNG (mulberry32) for reproducible shuffles. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: readonly T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Raw PII values of the fixture that masking actually changes (identity-masked values like '' carry nothing). */
const identifyingPii = records.flatMap((r) =>
  source.fields.filter((f) => f.pii).map((f) => r.values[f.name] ?? '').filter((v) => maskValue(v) !== v),
);
function expectNoRawPii(json: string): void {
  expect(json).not.toContain(MARKER);
  for (const v of identifyingPii) expect(json, `raw PII value ${JSON.stringify(v)} leaked`).not.toContain(JSON.stringify(v));
}

// ---- mask.ts ----

describe('maskValue (verify)', () => {
  it("'' and blank values pass through", () => {
    expect(maskValue('')).toBe('');
    expect(maskValue('   ')).toBe('   ');
  });

  it('digit threshold boundary: 6 digits keep their digits, 7 digits mask all but the last 4', () => {
    expect(maskValue('123-456')).toBe('123-456');
    expect(maskValue('123-4567')).toBe('***-4567');
  });

  it('is idempotent on e-mails, phones and names', () => {
    for (const v of ['Jane.Doe@Example.com', '(555) 123-4567', 'Doe, Jane', 'Zoë Ångström']) {
      expect(maskValue(maskValue(v))).toBe(maskValue(v));
    }
  });

  it('an e-mail with surrounding whitespace or a display name never reveals its local part', () => {
    expect(maskValue(' jane.doe@x.com ')).not.toContain('jane');
    expect(maskValue('Jane <jane.doe@x.com>')).not.toMatch(/Jane|jane/);
  });

  it('[DEFECT] free text with ≥7 digits still masks its letters: the injection marker must not survive', () => {
    const masked = maskValue(`Call 555-123-4567 re ${MARKER}`);
    expect(masked).not.toContain(MARKER);
    expect(masked).not.toContain('555-123');
  });

  it('[DEFECT] the fixture injection note plus a phone number keeps neither the instructions nor the marker', () => {
    const note = records.find((r) => r.sourceKey === 'r0167')!.values.notes!;
    const masked = maskValue(`${note} Call back 555-123-4567`);
    expect(masked).not.toContain(MARKER);
    expect(masked).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  });

  it('[DEFECT] names next to a phone number in a PII value are masked', () => {
    expect(maskValue('Jane Doe 5551234567')).not.toMatch(/Jane|Doe/);
  });

  it('[DEFECT] an astral first character of an e-mail local part is kept whole (no lone surrogate)', () => {
    const masked = maskValue('😀abc@x.com');
    expect(LONE_SURROGATE.test(masked)).toBe(false);
    expect(masked).toBe('😀***@x.com');
  });

  it('[DEFECT] non-ASCII decimal digits count as digits: a full-width phone number is masked', () => {
    expect(maskValue('５５５１２３４５６７')).not.toContain('５５５１２３');
  });
});

describe('maskRecord (verify)', () => {
  it('does not touch a frozen input, masks only pii fields, keeps unknown keys and absent fields absent', () => {
    const rec = deepFreeze({ sourceKey: 'r1', values: { cust_id: 'C-00001', full_name: 'Jane Doe', extra: 'Jane Doe' } });
    const out = maskRecord(rec, source);
    expect(out).toEqual({ sourceKey: 'r1', values: { cust_id: 'C-00001', full_name: 'J*** D**', extra: 'Jane Doe' } });
    expect(Object.hasOwn(out.values, 'email_addr')).toBe(false);
  });
});

// ---- profile.ts ----

describe('formatSignature (verify)', () => {
  it("whitespace runs of any kind collapse to one space; only '' is ∅", () => {
    expect(formatSignature('\t\n ')).toBe(' ');
    expect(formatSignature('a \t b')).toBe('a a');
    expect(formatSignature(' ')).toBe(' ');
  });

  it('accented letters follow the same case rules', () => {
    expect(formatSignature('Zoë')).toBe('Aa');
    expect(formatSignature('ÉCOLE')).toBe('A');
    expect(formatSignature('José-María')).toBe('Aa-Aa');
  });

  it('[DEFECT] non-ASCII decimal digits map to 9', () => {
    expect(formatSignature('٠١٢٣')).toBe('9999');
    expect(formatSignature('５５５-１２３４')).toBe('999-9999');
  });
});

describe('profileFields (verify)', () => {
  it('no raw PII value or the injection marker appears anywhere in the fixture profiles', () => {
    expectNoRawPii(JSON.stringify(profiles));
  });

  it('[DEFECT] a PII phone written in non-ASCII digits does not leak through its format signature', () => {
    const s = sourceOf([['phone', true]]);
    expect(JSON.stringify(profileFields(rowsOf([{ phone: '٥٥٥١٢٣٤٥٦٧' }]), s))).not.toContain('٥٥٥١٢٣');
  });

  it('[DEFECT] a field named like an Object.prototype member and missing from a record counts as empty', () => {
    const s = sourceOf(['constructor', 'toString']);
    const rs = rowsOf([{}, { constructor: 'x', toString: 'y' }]);
    const run = () => profileFields(rs, s);
    expect(run).not.toThrow();
    const [c, t] = run();
    expect(c).toMatchObject({ total: 2, empty: 1, distinct: 2 });
    expect(t).toMatchObject({ total: 2, empty: 1, distinct: 2 });
  });

  it('an empty extract profiles to zeros (no NaN or Infinity)', () => {
    expect(profileFields([], sourceOf(['a']))).toEqual([
      { field: 'a', pii: false, total: 0, empty: 0, distinct: 0, distinctRatio: 0, keyLike: false, minLength: 0, maxLength: 0, formats: [], topValues: [], slashDates: { dayFirst: 0, monthFirst: 0, either: 0 } },
    ]);
  });

  it('keyLike boundary: 9 of 10 distinct is key-like, 8 of 10 is not', () => {
    const s = sourceOf(['k']);
    const vals = (distinct: number) => rowsOf(Array.from({ length: 10 }, (_, i) => ({ k: `v${Math.min(i, distinct - 1)}` })));
    expect(profileFields(vals(9), s)[0]).toMatchObject({ distinct: 9, distinctRatio: 0.9, keyLike: true });
    expect(profileFields(vals(8), s)[0]).toMatchObject({ distinct: 8, distinctRatio: 0.8, keyLike: false });
  });

  it('formats: count desc, ties by signature in code-unit order, at most 8', () => {
    const s = sourceOf(['f']);
    const rs = rowsOf(['1', '2', '3', 'a', 'A', 'Ab', '-', '.', '#', '$', '%', '&'].map((f) => ({ f })));
    expect(profileFields(rs, s)[0]!.formats.map((f) => f.signature)).toEqual(['9', '#', '$', '%', '&', '-', '.', 'A']);
  });

  it('a PII field never gets topValues, even with very few distinct values', () => {
    const s = sourceOf([['code', true]]);
    expect(profileFields(rowsOf([{ code: 'Jane' }, { code: 'Jane' }]), s)[0]!.topValues).toEqual([]);
    expect(profiles.find((p) => p.field === 'fax')!.topValues).toEqual([]);
  });
});

// ---- candidates.ts ----

describe('suggestCandidates (verify)', () => {
  it('[DEFECT] whitespace-padded dates still look like dates (every suggested chain trims first)', () => {
    const s = sourceOf(['signup_dt']);
    const rs = rowsOf(Array.from({ length: 30 }, (_, i) => ({ signup_dt: `03/${String((i % 28) + 1).padStart(2, '0')}/2019 ` })));
    const p = profileFields(rs, s);
    expect(suggestCandidates(field('created_on', 'date'), s, p)[0]).toMatchObject({ source: 'signup_dt', score: 0.9 });
    // Consequence: the required date target is reported as having no source at all.
    expect(computeFieldGaps(s, targetOf([field('created_on', 'date')]), p).requiredTargetWithoutSource).toEqual([]);
  });

  it('[DEFECT] whitespace-padded money still looks numeric', () => {
    const s = sourceOf(['bal']);
    const rs = rowsOf(['  $1.00', '  $2.50', ' (3.00)'].map((bal) => ({ bal })));
    expect(suggestCandidates(field('balance_cents', 'integer'), s, profileFields(rs, s))[0]).toMatchObject({ source: 'bal', score: 0.9 });
  });

  it('Dice fallback: created_on vs create_date = round(0.8 × 10/14, 3)', () => {
    expect(suggestCandidates(field('created_on', 'string'), sourceOf(['create_date']), [])).toEqual([
      { source: 'create_date', score: 0.571, reasons: [expect.any(String)] },
    ]);
  });

  it('boolean factor boundary: 10 distinct values fit a flag, 11 halve the score', () => {
    const s = sourceOf(['vip_flag']);
    const withDistinct = (n: number) => profileFields(rowsOf(Array.from({ length: n }, (_, i) => ({ vip_flag: `v${i}` }))), s);
    expect(suggestCandidates(field('is_vip', 'boolean'), s, withDistinct(10))[0]!.score).toBe(0.9);
    expect(suggestCandidates(field('is_vip', 'boolean'), s, withDistinct(11))[0]!.score).toBe(0.45);
  });

  it('date factor needs a strict majority: exactly half date-like values halve the score', () => {
    const s = sourceOf(['created_on']);
    const rs = rowsOf([{ created_on: '2019-01-02' }, { created_on: 'n/a' }]);
    expect(suggestCandidates(field('created_on', 'date'), s, profileFields(rs, s))[0]!.score).toBe(0.5);
  });

  it('keeps the top 3 with score > 0, ties broken by source name', () => {
    const s = sourceOf(['zz', 'name', 'full_name', 'nom', 'first_name']);
    expect(suggestCandidates(field('first_name', 'string'), s, []).map((c) => [c.source, c.score])).toEqual([
      ['first_name', 1],
      ['full_name', 0.9],
      ['name', 0.9],
    ]);
    expect(suggestCandidates(field('country', 'string'), sourceOf(['zz']), [])).toEqual([]);
  });
});

// ---- gaps.ts ----

describe('computeFieldGaps (verify)', () => {
  const formatsFor = (values: readonly string[]) => {
    const s = sourceOf(['signup_dt']);
    const gaps = computeFieldGaps(s, targetOf([field('created_on', 'date')]), profileFields(rowsOf(values.map((signup_dt) => ({ signup_dt }))), s));
    const step = gaps.typeIncompatible[0]!.suggestedSteps.find((x) => x.op === 'parse_date');
    return step?.op === 'parse_date' ? step.params.formats : null;
  };

  it('[DEFECT] keeps MM/dd/yyyy (and excludes dd/MM/yyyy) while month-first values exist, whatever the record order', () => {
    // One day-first row first, then 29 clearly month-first rows (second number > 12); > 20 distinct ⇒ no topValues.
    const values = ['25/12/2019', ...Array.from({ length: 29 }, (_, i) => `12/${13 + (i % 16)}/${2000 + i}`)];
    expect(formatsFor(values)).toEqual(['MM/dd/yyyy']);
    expect(formatsFor([...values].reverse())).toEqual(['MM/dd/yyyy']);
  });

  it('suggests dd/MM/yyyy when every visible slash date is day-first', () => {
    expect(formatsFor(['25/12/2019', '13/01/2020', '31/03/2021'])).toEqual(['dd/MM/yyyy']);
  });

  it('every suggested chain type-checks and ends in the target type on awkward synthetic data', () => {
    const s = sourceOf(['d', 'n', 'b', 'e', ['p', true]]);
    const t = targetOf([
      field('d', 'date'),
      field('n', 'integer'),
      field('b', 'boolean'),
      field('e', 'string', { enum: ['alpha', 'beta', 'alphabet'] }),
      field('p', 'boolean'),
    ]);
    const rs = rowsOf([
      { d: '', n: '', b: '', e: '', p: 'Y' },
      { d: '2019-01-02', n: '42', b: 'maybe', e: 'A', p: 'N' },
      { d: '20190103', n: '-7', b: 'T', e: 'AL', p: 'Y' },
      { d: '1-Jan-2019', n: '1,000', b: 'Y', e: 'b', p: 'N' },
      { d: '2019-02-03', n: '5', b: 'N', e: 'gamma', p: 'Y' },
    ]);
    const gaps = computeFieldGaps(s, t, profileFields(rs, s));
    expect(FieldGapsSchema.parse(gaps)).toEqual(gaps);
    const want: Record<string, string> = { d: 'date', n: 'integer', b: 'boolean', e: 'string', p: 'boolean' };
    expect(gaps.typeIncompatible.map((g) => g.target)).toEqual(['d', 'n', 'b', 'e', 'p']);
    for (const g of gaps.typeIncompatible) {
      expect(chainType(1, g.suggestedSteps), g.target).toEqual({ ok: true, type: want[g.target] });
    }
    // 'A' and 'AL' are prefixes of both alpha and alphabet ⇒ only 'B' ⇒ beta is safe.
    const mv = gaps.typeIncompatible.find((g) => g.target === 'e')!.suggestedSteps.at(-1)!;
    expect(mv).toEqual({ op: 'map_values', params: { pairs: [{ from: 'B', to: 'beta' }], fallback: null } });
  });

  it('never echoes raw PII values', () => {
    expectNoRawPii(JSON.stringify(computeFieldGaps(source, target, profiles)));
  });
});

// ---- triggers.ts ----

describe('computeClarifications with the real runMapping (verify)', () => {
  it('gold plan: only the enum (5 rows) and date (3 day-first, 39 ambiguous) questions', () => {
    const cs = computeClarifications(gold(), ctx);
    expect(ids(cs)).toEqual(['clr-unmapped_enum_values-status', 'clr-ambiguous_date_format-created_on']);
    expect(cs[0]!.question).toContain('5 rows');
    expect(cs[1]!.question).toContain('3 rows');
    expect(cs[1]!.options[1]!.label).toContain('39 rows');
    for (const c of cs) expect(ClarificationSchema.parse(c)).toEqual(c);
  });

  it('is independent of record order and never mutates its inputs', () => {
    const g = gold();
    const plan = deepFreeze({
      mappings: g.mappings
        .filter((m) => m.target !== 'country')
        .map((m) => (m.target === 'balance_cents' ? { ...m, steps: [{ op: 'trim' as const, params: {} }, { op: 'parse_currency_to_cents' as const, params: {} }] } : m)),
      ignored: g.ignored,
    });
    const frozenRecords = deepFreeze(structuredClone(records));
    const a = computeClarifications(plan, ctxOf(source, target, frozenRecords));
    expect(ids(a)).toEqual([
      'clr-empty_required_values-balance_cents',
      'clr-required_target_unmapped-country',
      'clr-unmapped_enum_values-status',
      'clr-ambiguous_date_format-created_on',
    ]);
    for (const seed of [1, 2, 3]) expect(computeClarifications(plan, ctxOf(source, target, shuffle(records, rng(seed))))).toEqual(a);
  });

  it('[DEFECT] country: the phone profile is found even when an earlier column name merely contains "tel"', () => {
    const s = sourceOf(['hotel_code', ['phone', true]]);
    const rs = rowsOf(Array.from({ length: 10 }, (_, i) => ({ hotel_code: `HTL${i}`, phone: `(555) 123-456${i}` })));
    const [c] = computeClarifications({ mappings: [], ignored: [] }, ctxOf(s, targetOf([targetField('country')]), rs));
    expect(c!.options[0]!.label).toMatch(/North[- ]American/);
    expect(c!.options[0]!.patch).toMatchObject({ kind: 'set_mapping', mapping: { steps: [{ op: 'default', params: { value: 'US' } }] } });
  });

  it('[DEFECT] a clipped question stays well-formed UTF-16 (no split surrogate pair)', () => {
    const s = sourceOf(['st']);
    const rs = rowsOf([{ st: `x${'😀'.repeat(300)}` }]);
    const m: FieldMapping = {
      target: 'status',
      sources: ['st'],
      steps: [{ op: 'map_values', params: { pairs: [{ from: 'A', to: 'active' }], fallback: null } }],
      origin: 'agent',
      confidence: 'high',
      rationale: '',
    };
    const [c] = computeClarifications({ mappings: [m], ignored: [] }, ctxOf(s, targetOf([targetField('status')]), rs));
    expect(c!.question.length).toBeLessThanOrEqual(400);
    expect(LONE_SURROGATE.test(c!.question)).toBe(false);
  });

  it('low_margin_candidate: a margin of exactly 0.1 (1.0 vs 0.9) does not fire despite float error', () => {
    const s = sourceOf(['external_ref', 'cust_id']);
    const rs = rowsOf([{ external_ref: 'C-00001', cust_id: 'C-00001' }]);
    const m: FieldMapping = { target: 'external_ref', sources: ['cust_id'], steps: [{ op: 'trim', params: {} }], origin: 'agent', confidence: 'high', rationale: '' };
    expect(computeClarifications({ mappings: [m], ignored: [] }, ctxOf(s, targetOf([targetField('external_ref')]), rs))).toEqual([]);
  });

  it('optional unmapped targets raise nothing', () => {
    const cs = computeClarifications({ ...gold(), mappings: gold().mappings.filter((m) => m.target !== 'email' && m.target !== 'phone_e164') }, ctx);
    expect(ids(cs)).toEqual(['clr-unmapped_enum_values-status', 'clr-ambiguous_date_format-created_on']);
  });

  it('the cap of 8 is applied after sorting, so a blocking question survives many advisory ones', () => {
    const names = Array.from({ length: 9 }, (_, i) => `d${i + 1}`);
    const s = sourceOf(names);
    const t = targetOf([...names.map((n) => field(n, 'date')), field('zz', 'string')]);
    const rs = rowsOf([Object.fromEntries(names.map((n) => [n, '25/12/2019']))]);
    const steps: Step[] = [
      { op: 'trim', params: {} },
      { op: 'parse_date', params: { formats: ['MM/dd/yyyy'] } },
    ];
    const mappings: FieldMapping[] = names.map((n) => ({
      target: n,
      sources: [n],
      steps,
      origin: 'agent',
      confidence: 'high',
      rationale: '',
    }));
    const cs = computeClarifications({ mappings, ignored: [] }, ctxOf(s, t, rs));
    expect(ids(cs)).toEqual(['clr-required_target_unmapped-zz', ...names.slice(0, 7).map((n) => `clr-ambiguous_date_format-${n}`)]);
  });
});

describe('applyClarification (verify)', () => {
  const base = { ...gold(), mappings: gold().mappings.filter((m) => m.target !== 'country') };
  const plan = deepFreeze({ ...base, clarifications: computeClarifications(base, ctx) });
  const code = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? e.message : `non-Error ${String(e)}`;
    }
    return 'no throw';
  };

  it('works on a deeply frozen plan and returns a schema-valid plan', () => {
    const next = applyClarification(plan, 'clr-required_target_unmapped-country', 0, 'rev');
    expect(MigrationPlanSchema.parse(next)).toEqual(next);
    expect(next.mappings.at(-1)).toMatchObject({ target: 'country', sources: [], steps: [{ op: 'default', params: { value: 'US' } }], origin: 'human' });
  });

  it('throws Errors whose message is exactly the code, with a stable precedence', () => {
    expect(code(() => applyClarification(plan, 'nope', 0, 'x'))).toBe('UNKNOWN_CLARIFICATION');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0.5, 4, -1]) {
      expect(code(() => applyClarification(plan, 'clr-unmapped_enum_values-status', bad, 'x')), String(bad)).toBe('BAD_CHOICE');
    }
    expect(code(() => applyClarification(plan, 'clr-required_target_unmapped-country', 'dismissed', 'x'))).toBe('CANNOT_DISMISS_BLOCKING');
    const once = applyClarification(plan, 'clr-required_target_unmapped-country', 0, 'x');
    expect(code(() => applyClarification(once, 'clr-required_target_unmapped-country', 'dismissed', 'x'))).toBe('ALREADY_RESOLVED');
    expect(code(() => applyClarification(once, 'clr-required_target_unmapped-country', 99, 'x'))).toBe('ALREADY_RESOLVED');
  });

  it('the applied mapping is a copy of the option patch, not a shared reference', () => {
    const next = applyClarification(plan, 'clr-unmapped_enum_values-status', 1, 'rev');
    const option = plan.clarifications.find((c) => c.id === 'clr-unmapped_enum_values-status')!.options[1]!.patch;
    if (option.kind !== 'set_mapping') throw new Error('expected set_mapping');
    const applied = next.mappings.find((m) => m.target === 'status')!;
    expect(applied).toEqual(option.mapping);
    expect(applied).not.toBe(option.mapping);
    expect(applied.steps).not.toBe(option.mapping.steps);
  });
});

describe('mergeClarifications (verify)', () => {
  it('is order-independent, pure, keeps resolved and agent entries, drops stale ones, yields unique ids', () => {
    const base = { ...gold(), mappings: gold().mappings.filter((m) => m.target !== 'country') };
    const computed = computeClarifications(base, ctx);
    const answered = applyClarification({ ...base, clarifications: computed }, 'clr-unmapped_enum_values-status', 0, 'rev');
    const resolved = answered.clarifications.filter((c) => c.resolution !== null);
    const agentQ: Clarification = {
      id: 'clr-agent_question-fax',
      question: 'Drop fax?',
      impact: 'advisory',
      trigger: 'agent_question',
      field: 'fax',
      options: [],
      resolution: null,
    };
    const stale: Clarification = { ...computed[0]!, id: 'clr-required_target_unmapped-gone', field: 'gone' };
    const existing = deepFreeze([...resolved, agentQ, stale]);
    const frozenComputed = deepFreeze(structuredClone(computed));
    const out = mergeClarifications(existing, frozenComputed);
    expect(new Set(ids(out)).size).toBe(out.length);
    expect(ids(out)).not.toContain('clr-required_target_unmapped-gone');
    expect(ids(out)).toContain('clr-agent_question-fax');
    expect(out.find((c) => c.id === 'clr-unmapped_enum_values-status')!.resolution).toEqual({ choice: 0, by: 'rev' });
    for (const seed of [1, 2, 3, 4]) {
      const next = rng(seed);
      expect(mergeClarifications(shuffle(existing, next), shuffle(frozenComputed, next))).toEqual(out);
    }
  });
});

// ---- heuristic.ts ----

describe('buildHeuristicPlan (verify)', () => {
  it("answering its questions gives an approvable plan with exactly gold's dry-run counts (real runner)", () => {
    let p = buildHeuristicPlan(ctx);
    p = applyClarification(p, 'clr-required_target_unmapped-country', 0, 'rev');
    const bal = p.clarifications.find((c) => c.id === 'clr-empty_required_values-balance_cents')!;
    p = applyClarification(p, bal.id, bal.options.findIndex((o) => o.label === 'Treat empty as 0'), 'rev');
    p = applyClarification(p, 'clr-unmapped_enum_values-status', 0, 'rev');
    p = applyClarification(p, 'clr-ambiguous_date_format-created_on', 'dismissed', 'rev');
    expect(MigrationPlanSchema.parse(p)).toEqual(p);
    expect(validatePlanStatic(p, source, target, { forApproval: true, reviewer: 'rev' })).toEqual([]);
    expect(dryRun(records, p, target, 'h').counts).toEqual(dryRun(records, gold(), target, 'h').counts);
  });

  it('is independent of record order on the fixtures', () => {
    const expected = buildHeuristicPlan(ctx);
    for (const seed of [1, 2, 3, 4, 5]) expect(buildHeuristicPlan(ctxOf(source, target, shuffle(records, rng(seed))))).toEqual(expected);
  });

  it('never puts raw PII or the injection marker into the plan; risks mirror clarifications', () => {
    const p = buildHeuristicPlan(ctx);
    expectNoRawPii(JSON.stringify(p));
    expect(p.risks.map((r) => r.field)).toEqual(p.clarifications.map((c) => c.field));
    expect(p.summary.split(/(?<=[.!?])\s+/).filter((x) => x !== '').length).toBe(3);
  });

  it('[DEFECT] separate first/last name source columns are copied, not split', () => {
    const s = sourceOf([['first_name', true], ['last_name', true]]);
    const t = targetOf([field('first_name', 'string'), field('last_name', 'string')]);
    const rs = rowsOf([{ first_name: 'Mary Ann', last_name: 'Doe' }]);
    const p = buildHeuristicPlan(ctxOf(s, t, rs));
    const run = (name: string) => runMapping(rs[0]!.values, p.mappings.find((m) => m.target === name)!);
    expect(run('first_name')).toEqual({ ok: true, value: 'Mary Ann' });
    expect(run('last_name')).toEqual({ ok: true, value: 'Doe' });
  });

  it('[DEFECT] a pattern that forbids upper case (negated class) gets no uppercase step', () => {
    const pattern = '^[^A-Z]+$';
    const s = sourceOf(['code']);
    const rs = rowsOf([{ code: 'abc' }]);
    const p = buildHeuristicPlan(ctxOf(s, targetOf([field('code', 'string', { pattern })]), rs));
    const res = runMapping(rs[0]!.values, p.mappings[0]!);
    expect(res.ok && typeof res.value === 'string' && new RegExp(pattern).test(res.value)).toBe(true);
  });

  it('confidence boundaries: 0.7 ⇒ medium; 0.5 ⇒ mapped, low, with a risk; summary has 2–3 sentences', () => {
    // 0.8 × Dice(abcdefghij, abcdefghik) = 0.8 × 14/16 = 0.7; created_on: exact name 1.0 × non-date factor 0.5 = 0.5.
    const s = sourceOf(['abcdefghik', 'created_on']);
    const t = targetOf([field('abcdefghij', 'string'), field('created_on', 'date')]);
    const p = buildHeuristicPlan(ctxOf(s, t, rowsOf([{ abcdefghik: 'v', created_on: 'not a date' }])));
    expect(MigrationPlanSchema.parse(p)).toEqual(p);
    expect(p.mappings.map((m) => [m.target, m.sources[0], m.confidence])).toEqual([
      ['abcdefghij', 'abcdefghik', 'medium'],
      ['created_on', 'created_on', 'low'],
    ]);
    expect(p.risks.some((r) => r.field === 'created_on')).toBe(true);
    const sentences = p.summary.split(/(?<=[.!?])\s+/).filter((x) => x !== '').length;
    expect(sentences).toBeGreaterThanOrEqual(2);
    expect(sentences).toBeLessThanOrEqual(3);
  });
});
