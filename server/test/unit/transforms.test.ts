import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, TargetSchema, Value } from '../../../shared/schemas.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';
import type { FieldMapping } from '../../../shared/plan.ts';
import type { DateFormat, OpName, Step } from '../../../shared/dsl.ts';
import {
  applyStep,
  normalizeUsPhone,
  parseCurrencyToCents,
  parseDate,
  runMapping,
  splitFullName,
  transformRecord,
} from '../../src/engine/transforms.ts';
import type { StepResult } from '../../src/engine/transforms.ts';

const load = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../../src/dataset/${name}`, import.meta.url), 'utf8'));

/** Expected-failure marker for the tables below. */
const FAIL = { fail: 'TRANSFORM_FAILED' } as const;
type Expected = Value | typeof FAIL;

function expectResult(result: StepResult, expected: Expected): void {
  if (expected === FAIL) {
    expect(result).toMatchObject({ ok: false, code: 'TRANSFORM_FAILED' });
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  } else {
    expect(result).toEqual({ ok: true, value: expected });
    // toEqual alone would not tell 0 from -0.
    if (result.ok) expect(Object.is(result.value, expected)).toBe(true);
  }
}

/** One representative, valid step per op. */
const STEP = {
  copy: { op: 'copy', params: {} },
  trim: { op: 'trim', params: {} },
  lowercase: { op: 'lowercase', params: {} },
  uppercase: { op: 'uppercase', params: {} },
  null_if_empty: { op: 'null_if_empty', params: {} },
  default: { op: 'default', params: { value: 'US' } },
  split_full_name: { op: 'split_full_name', params: { part: 'first' } },
  concat: { op: 'concat', params: { separator: ' ' } },
  parse_date: { op: 'parse_date', params: { formats: ['MM/dd/yyyy'] } },
  parse_currency_to_cents: { op: 'parse_currency_to_cents', params: {} },
  to_integer: { op: 'to_integer', params: {} },
  to_boolean: { op: 'to_boolean', params: { true_values: ['Y'], false_values: ['N'] } },
  map_values: { op: 'map_values', params: { pairs: [{ from: 'A', to: 'active' }], fallback: null } },
  normalize_phone: { op: 'normalize_phone', params: { default_country: 'US' } },
} satisfies Record<OpName, Step>;

describe('applyStep: null, empty, whitespace and array inputs for every op', () => {
  // [op, null, '', '   ', ['a', null]]
  const TABLE: [OpName, Expected, Expected, Expected, Expected][] = [
    ['copy', null, '', '   ', FAIL],
    ['trim', null, '', '', FAIL],
    ['lowercase', null, '', '   ', FAIL],
    ['uppercase', null, '', '   ', FAIL],
    ['null_if_empty', null, null, null, FAIL],
    ['default', 'US', '', '   ', FAIL],
    ['split_full_name', null, null, null, FAIL],
    ['concat', FAIL, FAIL, FAIL, 'a'],
    ['parse_date', null, FAIL, FAIL, FAIL],
    ['parse_currency_to_cents', null, FAIL, FAIL, FAIL],
    ['to_integer', null, FAIL, FAIL, FAIL],
    ['to_boolean', null, FAIL, FAIL, FAIL],
    ['map_values', null, FAIL, FAIL, FAIL],
    ['normalize_phone', null, FAIL, FAIL, FAIL],
  ];
  const cases = TABLE.flatMap(([op, onNull, onEmpty, onBlank, onArray]) => [
    { op, input: null, expected: onNull },
    { op, input: '', expected: onEmpty },
    { op, input: '   ', expected: onBlank },
    { op, input: ['a', null], expected: onArray },
  ]);
  it.each(cases)('$op($input)', ({ op, input, expected }) => {
    expectResult(applyStep(input, STEP[op]), expected);
  });
});

describe('applyStep: wrong input types fail instead of throwing', () => {
  it.each([
    ['trim', 42],
    ['lowercase', true],
    ['null_if_empty', 7],
    ['default', 7],
    ['parse_date', false],
    ['concat', 'a'],
    ['map_values', 1],
  ] as [OpName, Value][])('%s(%j)', (op, input) => {
    expectResult(applyStep(input, STEP[op]), FAIL);
  });

  it('copy passes any scalar value through', () => {
    expectResult(applyStep(42, STEP.copy), 42);
    expectResult(applyStep(false, STEP.copy), false);
    expectResult(applyStep('abc', STEP.copy), 'abc');
  });

  it('an unvalidated step (unknown op or missing params) fails instead of throwing', () => {
    expectResult(applyStep('x', { op: 'eval', params: {} } as unknown as Step), FAIL);
    expectResult(applyStep('x', { op: 'constructor', params: {} } as unknown as Step), FAIL);
    expectResult(applyStep('x', { op: 'map_values', params: null } as unknown as Step), FAIL);
  });
});

describe('string ops', () => {
  it.each([
    ['trim', '  a b  ', 'a b'],
    ['trim', '\t x \n', 'x'],
    ['lowercase', 'A@B.COM', 'a@b.com'],
    ['uppercase', 'c-001', 'C-001'],
    ['null_if_empty', 'x', 'x'],
    ['null_if_empty', ' x ', ' x '],
    ['null_if_empty', '\t\n ', null],
    ['default', 'CA', 'CA'],
  ] as [OpName, string, Value][])('%s(%j) = %j', (op, input, expected) => {
    expectResult(applyStep(input, STEP[op]), expected);
  });

  it.each([
    [['Jane', 'Doe'], ' ', 'Jane Doe'],
    [['Jane', null, 'Doe'], ' ', 'Jane Doe'],
    [[null, null], ' ', null],
    [[], ' ', null],
    [['', 'x'], '-', '-x'],
    [['a', 'b'], '', 'ab'],
  ] as [(string | null)[], string, Value][])('concat(%j, %j) = %j', (input, separator, expected) => {
    expectResult(applyStep(input, { op: 'concat', params: { separator } }), expected);
  });
});

describe('split_full_name', () => {
  it.each([
    ['Jane Doe', 'Jane', 'Doe'],
    ['Doe, Jane', 'Jane', 'Doe'],
    ['Doe,Jane', 'Jane', 'Doe'],
    ['Doe ,  Jane', 'Jane', 'Doe'],
    ['Chloe Ray Patel', 'Chloe', 'Patel'],
    ['Patel, Chloe Ray', 'Chloe', 'Patel'],
    ['Van der Berg, Jan', 'Jan', 'Van der Berg'],
    ['Doe, Jane, Jr.', 'Jane', 'Doe'],
    ['  Jane \t  Q   Doe  ', 'Jane', 'Doe'],
    ['Prince', 'Prince', null],
    ['Doe,', null, 'Doe'],
    [', Jane', 'Jane', null],
    [',', null, null],
    ['', null, null],
    ['   ', null, null],
  ] as [string, string | null, string | null][])('%j ⇒ first %j, last %j', (input, first, last) => {
    expect(splitFullName(input, 'first')).toBe(first);
    expect(splitFullName(input, 'last')).toBe(last);
    expectResult(applyStep(input, { op: 'split_full_name', params: { part: 'first' } }), first);
    expectResult(applyStep(input, { op: 'split_full_name', params: { part: 'last' } }), last);
  });
});

/** Date assertions, run once per timezone below. */
function dateSuite(): void {
  it.each([
    ['03/14/2019', 'MM/dd/yyyy', '2019-03-14'],
    ['7/4/2012', 'MM/dd/yyyy', '2012-07-04'],
    ['7/14/2012', 'MM/dd/yyyy', '2012-07-14'],
    ['12/31/1999', 'MM/dd/yyyy', '1999-12-31'],
    ['14/03/2019', 'dd/MM/yyyy', '2019-03-14'],
    ['4/7/2012', 'dd/MM/yyyy', '2012-07-04'],
    ['2019-03-14', 'yyyy-MM-dd', '2019-03-14'],
    ['2019-3-4', 'yyyy-MM-dd', '2019-03-04'],
    ['14-Mar-2019', 'dd-MMM-yyyy', '2019-03-14'],
    ['14-mar-2019', 'dd-MMM-yyyy', '2019-03-14'],
    ['14-MAR-2019', 'dd-MMM-yyyy', '2019-03-14'],
    ['4-Sep-2020', 'dd-MMM-yyyy', '2020-09-04'],
    ['01-Jan-1970', 'dd-MMM-yyyy', '1970-01-01'],
    ['20190314', 'yyyyMMdd', '2019-03-14'],
    ['02/29/2020', 'MM/dd/yyyy', '2020-02-29'],
    ['2020-02-29', 'yyyy-MM-dd', '2020-02-29'],
    ['29-Feb-2000', 'dd-MMM-yyyy', '2000-02-29'],
    ['0001-01-01', 'yyyy-MM-dd', '0001-01-01'],
    ['0096-02-29', 'yyyy-MM-dd', '0096-02-29'],
    ['9999-12-31', 'yyyy-MM-dd', '9999-12-31'],
  ] as [string, DateFormat, string][])('%j as %s = %s', (input, format, iso) => {
    expectResult(parseDate(input, [format]), iso);
    expectResult(applyStep(input, { op: 'parse_date', params: { formats: [format] } }), iso);
  });

  it.each([
    ['2019-02-29', 'yyyy-MM-dd'],
    ['02/29/2019', 'MM/dd/yyyy'],
    ['29-Feb-1900', 'dd-MMM-yyyy'],
    ['2019-02-30', 'yyyy-MM-dd'],
    ['13/45/2020', 'MM/dd/yyyy'],
    ['00/10/2020', 'MM/dd/yyyy'],
    ['04/31/2020', 'MM/dd/yyyy'],
    ['04/00/2020', 'MM/dd/yyyy'],
    ['20191301', 'yyyyMMdd'],
  ] as [string, DateFormat][])('%j as %s does not exist', (input, format) => {
    const result = parseDate(input, [format]);
    expectResult(result, FAIL);
    if (!result.ok) expect(result.message).toMatch(/does not exist/);
  });

  it.each([
    [' 03/14/2019', 'MM/dd/yyyy'],
    ['03/14/2019 ', 'MM/dd/yyyy'],
    ['03/14/19', 'MM/dd/yyyy'],
    ['003/14/2019', 'MM/dd/yyyy'],
    ['03-14-2019', 'MM/dd/yyyy'],
    ['2019/03/14', 'yyyy-MM-dd'],
    ['14-March-2019', 'dd-MMM-yyyy'],
    ['31-Foo-2019', 'dd-MMM-yyyy'],
    ['14-03-2019', 'dd-MMM-yyyy'],
    ['2019314', 'yyyyMMdd'],
    ['2019-03-14T00:00:00Z', 'yyyy-MM-dd'],
    ['sometime 2018', 'MM/dd/yyyy'],
    ['', 'yyyy-MM-dd'],
  ] as [string, DateFormat][])('%j does not match %s', (input, format) => {
    const result = parseDate(input, [format]);
    expectResult(result, FAIL);
    if (!result.ok) expect(result.message).toContain(format);
  });

  it('names every format tried when nothing matches', () => {
    const result = parseDate('sometime 2018', ['MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MMM-yyyy']);
    expect(result).toMatchObject({ ok: false, code: 'TRANSFORM_FAILED' });
    if (!result.ok) {
      for (const f of ['MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MMM-yyyy']) expect(result.message).toContain(f);
    }
  });

  it('flags two formats that give different dates as AMBIGUOUS_DATE', () => {
    const result = parseDate('03/04/2019', ['MM/dd/yyyy', 'dd/MM/yyyy']);
    expect(result).toMatchObject({ ok: false, code: 'AMBIGUOUS_DATE' });
    if (!result.ok) {
      expect(result.message).toContain('2019-03-04');
      expect(result.message).toContain('2019-04-03');
    }
  });

  it('accepts several matching formats that agree on the date', () => {
    expectResult(parseDate('05/05/2019', ['MM/dd/yyyy', 'dd/MM/yyyy']), '2019-05-05');
    expectResult(parseDate('2019-03-14', ['yyyy-MM-dd', 'yyyy-MM-dd']), '2019-03-14');
  });

  it('uses the only format that yields a real date', () => {
    expectResult(parseDate('25/12/2019', ['MM/dd/yyyy', 'dd/MM/yyyy']), '2019-12-25');
    expectResult(parseDate('25/12/2019', ['MM/dd/yyyy']), FAIL);
  });
}

describe('parse_date is timezone independent', () => {
  const original = process.env.TZ;
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // [zone, getTimezoneOffset() at the epoch] — proves the zone switch really took effect.
  describe.each([
    ['UTC', 0],
    ['Asia/Kolkata', -330],
    ['America/Los_Angeles', 480],
  ])('TZ=%s', (zone, epochOffset) => {
    beforeAll(() => {
      process.env.TZ = zone;
    });
    it('is active', () => {
      expect(new Date(0).getTimezoneOffset()).toBe(epochOffset);
    });
    dateSuite();
  });
});

describe('parse_currency_to_cents', () => {
  it.each([
    ['$1,234.50', 123450],
    ['1234.5', 123450],
    ['-$12.00', -1200],
    ['(45.00)', -4500],
    ['($45.00)', -4500],
    ['0', 0],
    ['$0.00', 0],
    ['-0.00', 0],
    ['(0.00)', 0],
    ['0.5', 50],
    ['0.05', 5],
    ['12', 1200],
    ['$999', 99900],
    ['1,000', 100000],
    ['$1,234,567.89', 123456789],
    ['-1,234.56', -123456],
    ['4316.49', 431649],
    ['007.10', 710],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
    ['-90071992547409.91', -Number.MAX_SAFE_INTEGER],
  ] as [string, number][])('%j = %d', (input, cents) => {
    expectResult(parseCurrencyToCents(input), cents);
    expectResult(applyStep(input, STEP.parse_currency_to_cents), cents);
  });

  it.each([
    '$1,23',
    '12.3.4',
    'N/A',
    '',
    '1,2345',
    '1,234,56',
    '12,00',
    ',123',
    '0,123',
    '(45.00',
    '45.00)',
    '-(45.00)',
    '$-12.00',
    '+12.00',
    '1.',
    '.5',
    '1.234',
    '$',
    '-',
    '()',
    ' 12.00',
    '12.00 ',
    '$ 12.00',
    '1e3',
    '0x10',
    '90071992547409.92',
    '9007199254740991',
  ])('%j fails', (input) => {
    expectResult(parseCurrencyToCents(input), FAIL);
  });
});

describe('to_integer', () => {
  it.each([
    ['42', 42],
    ['-7', -7],
    ['+7', 7],
    ['007', 7],
    ['-0', 0],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['-9007199254740991', -Number.MAX_SAFE_INTEGER],
  ] as [string, number][])('%j = %d', (input, n) => {
    expectResult(applyStep(input, STEP.to_integer), n);
  });

  it.each(['9007199254740992', '4.0', '1e3', ' 4', '4 ', '', '-', '0x1F', '٤'])('%j fails', (input) => {
    expectResult(applyStep(input, STEP.to_integer), FAIL);
  });
});

describe('to_boolean', () => {
  const step: Step = { op: 'to_boolean', params: { true_values: ['Y', ' Yes '], false_values: ['n', 'NO', ''] } };
  it.each([
    ['Y', true],
    ['y', true],
    [' YES ', true],
    ['yes', true],
    ['N', false],
    ['no', false],
    ['', false],
    ['   ', false],
  ] as [string, boolean][])('%j = %s', (input, expected) => {
    expectResult(applyStep(input, step), expected);
  });

  it.each(['maybe', 'VIP?', 'true', '1'])('%j is listed in neither ⇒ fails', (input) => {
    expectResult(applyStep(input, step), FAIL);
  });

  it('fails when a value is listed as both true and false', () => {
    const both: Step = { op: 'to_boolean', params: { true_values: ['x', 'Y'], false_values: ['X', 'N'] } };
    const result = applyStep('x', both);
    expectResult(result, FAIL);
    if (!result.ok) expect(result.message).toMatch(/both/);
    expectResult(applyStep('y', both), true);
  });
});

describe('map_values', () => {
  const strict: Step = {
    op: 'map_values',
    params: { pairs: [{ from: 'A', to: 'active' }, { from: 'I', to: 'inactive' }], fallback: null },
  };
  const lenient: Step = { op: 'map_values', params: { pairs: strict.params.pairs, fallback: 'unknown' } } as Step;

  it('maps exact, case-sensitive hits', () => {
    expectResult(applyStep('A', strict), 'active');
    expectResult(applyStep('I', strict), 'inactive');
  });

  it('fails on a miss without fallback, naming the value', () => {
    expect(applyStep('a', strict)).toEqual({ ok: false, code: 'TRANSFORM_FAILED', message: "value 'a' has no mapping" });
  });

  it('uses the fallback on a miss (even an empty-string fallback)', () => {
    expectResult(applyStep('X', lenient), 'unknown');
    expectResult(applyStep('X', { op: 'map_values', params: { pairs: [{ from: 'A', to: 'a' }], fallback: '' } }), '');
  });

  it('can map the empty string', () => {
    expectResult(applyStep('', { op: 'map_values', params: { pairs: [{ from: '', to: 'none' }], fallback: null } }), 'none');
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'prototype key %j behaves like any unmapped value',
    (key) => {
      expect(applyStep(key, strict)).toEqual({ ok: false, code: 'TRANSFORM_FAILED', message: `value '${key}' has no mapping` });
      expectResult(applyStep(key, lenient), 'unknown');
      expectResult(applyStep(key, { op: 'map_values', params: { pairs: [{ from: key, to: 'mapped' }], fallback: null } }), 'mapped');
    },
  );
});

describe('normalize_phone', () => {
  it.each([
    ['(555) 123-4567', '+15551234567'],
    ['555.123.4567', '+15551234567'],
    ['555-123-4567', '+15551234567'],
    ['5551234567', '+15551234567'],
    ['+1 555 123 4567', '+15551234567'],
    ['1 (555) 123-4567', '+15551234567'],
    ['15551234567', '+15551234567'],
    ['+1-555-123-4567', '+15551234567'],
    // Formats seen in the fixtures.
    ['974-961-5838', '+19749615838'],
    ['+1 556 511 8386', '+15565118386'],
    ['(593) 439-4555', '+15934394555'],
    ['854.240.4216', '+18542404216'],
  ])('%j = %s', (input, e164) => {
    expectResult(normalizeUsPhone(input), e164);
    expectResult(applyStep(input, STEP.normalize_phone), e164);
  });

  it.each([
    '12345',
    '555-1234',
    '(555) 123-45678',
    '055-123-4567',
    '155-123-4567',
    '+2 555 123 4567',
    '1 055 123 4567',
    '+44 20 7946 0958',
    '555-CALL-NOW',
    '555-123-4567 ext 89',
    '',
    '()-.',
  ])('%j fails', (input) => {
    expectResult(normalizeUsPhone(input), FAIL);
  });

  it('does not echo the (PII) number in its message', () => {
    const result = normalizeUsPhone('(555) 123-45678');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).not.toMatch(/555|123|45678/);
  });
});

describe('runMapping', () => {
  const values = { cust_id: ' c-11025 ', first: 'Jane', last: 'Doe', empty: '', status: 'X', dt: '03/04/2019' };

  it('0 sources: the chain starts from null', () => {
    expect(runMapping(values, { sources: [], steps: [STEP.default] })).toEqual({ ok: true, value: 'US' });
    expect(runMapping(values, { sources: [], steps: [] })).toEqual({ ok: true, value: null });
  });

  it('1 source: the chain starts from that string', () => {
    expect(runMapping(values, { sources: ['cust_id'], steps: [STEP.trim, STEP.uppercase] })).toEqual({
      ok: true,
      value: 'C-11025',
    });
    expect(runMapping(values, { sources: ['empty'], steps: [STEP.default] })).toEqual({ ok: true, value: '' });
  });

  it('1 source absent from the record: the chain starts from null', () => {
    expect(runMapping(values, { sources: ['missing'], steps: [STEP.trim] })).toEqual({ ok: true, value: null });
    const steps: Step[] = [STEP.null_if_empty, { op: 'default', params: { value: '0' } }, STEP.parse_currency_to_cents];
    expect(runMapping(values, { sources: ['missing'], steps })).toEqual({ ok: true, value: 0 });
  });

  it('source names that are Object.prototype keys are treated as absent', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(runMapping(values, { sources: [key], steps: [STEP.copy] })).toEqual({ ok: true, value: null });
      expect(runMapping(values, { sources: [key, 'first'], steps: [STEP.concat] })).toEqual({ ok: true, value: 'Jane' });
    }
  });

  it('≥2 sources: the chain starts from an array (absent ⇒ null)', () => {
    expect(runMapping(values, { sources: ['first', 'last'], steps: [STEP.concat] })).toEqual({ ok: true, value: 'Jane Doe' });
    expect(runMapping(values, { sources: ['first', 'missing', 'last'], steps: [STEP.concat] })).toEqual({
      ok: true,
      value: 'Jane Doe',
    });
    expect(runMapping(values, { sources: ['missing', 'gone'], steps: [STEP.concat] })).toEqual({ ok: true, value: null });
  });

  it('reports the first failing step and stops there', () => {
    const steps: Step[] = [STEP.trim, STEP.uppercase, STEP.map_values, STEP.default];
    expect(runMapping(values, { sources: ['status'], steps })).toEqual({
      ok: false,
      stepIndex: 2,
      op: 'map_values',
      code: 'TRANSFORM_FAILED',
      message: "value 'X' has no mapping",
    });
    expect(runMapping(values, { sources: ['first'], steps: [STEP.to_integer, STEP.trim] })).toMatchObject({
      ok: false,
      stepIndex: 0,
      op: 'to_integer',
    });
  });

  it('propagates AMBIGUOUS_DATE', () => {
    const steps: Step[] = [STEP.trim, { op: 'parse_date', params: { formats: ['MM/dd/yyyy', 'dd/MM/yyyy'] } }];
    expect(runMapping(values, { sources: ['dt'], steps })).toMatchObject({
      ok: false,
      stepIndex: 1,
      op: 'parse_date',
      code: 'AMBIGUOUS_DATE',
    });
  });

  it('fails (without throwing) when several sources are never combined', () => {
    expect(runMapping(values, { sources: ['first', 'last'], steps: [] })).toMatchObject({ ok: false, code: 'TRANSFORM_FAILED' });
    expect(runMapping(values, { sources: ['first', 'last'], steps: [STEP.trim] })).toMatchObject({
      ok: false,
      stepIndex: 0,
      op: 'trim',
    });
  });

  it('does not mutate its inputs', () => {
    const before = structuredClone(values);
    const mapping = { sources: ['cust_id'], steps: [STEP.trim, STEP.uppercase] };
    const mappingBefore = structuredClone(mapping);
    runMapping(values, mapping);
    expect(values).toEqual(before);
    expect(mapping).toEqual(mappingBefore);
  });
});

describe('transformRecord', () => {
  const target: TargetSchema = {
    name: 't',
    description: '',
    keyField: 'ref',
    fields: [
      { name: 'ref', type: 'string', required: true, unique: true, description: '' },
      { name: 'n', type: 'integer', required: true, unique: false, description: '' },
      { name: 'unmapped', type: 'string', required: true, unique: false, description: '' },
      { name: 'country', type: 'string', required: true, unique: false, description: '' },
    ],
  };
  const mapping = (target: string, sources: string[], steps: Step[]): FieldMapping => ({
    target,
    sources,
    steps,
    origin: 'human',
    confidence: 'high',
    rationale: '',
  });
  const record: SourceRecord = { sourceKey: 'r0007', values: { id: ' c-1 ', amount: '12.3.4' } };

  it('fills every target field in schema order; failures become null + transform Evidence', () => {
    const mappings = [
      mapping('n', ['amount'], [STEP.trim, STEP.parse_currency_to_cents]),
      mapping('ref', ['id'], [STEP.trim, STEP.uppercase]),
      mapping('country', [], [STEP.default]),
      mapping('ref', ['id'], [STEP.copy]), // second mapping for the same target is ignored
      mapping('not_in_schema', ['id'], [STEP.copy]),
    ];
    const { row, errors } = transformRecord(record, mappings, target);
    expect(Object.keys(row)).toEqual(['ref', 'n', 'unmapped', 'country']);
    expect(row).toEqual({ ref: 'C-1', n: null, unmapped: null, country: 'US' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sourceKey: 'r0007',
      stage: 'transform',
      targetField: 'n',
      sourceFields: ['amount'],
      rawValues: { amount: '12.3.4' },
      stepIndex: 1,
      op: 'parse_currency_to_cents',
      code: 'TRANSFORM_FAILED',
    });
    expect(errors[0]!.message.length).toBeGreaterThan(0);
  });

  it('records absent sources as null raw values', () => {
    const { errors } = transformRecord(record, [mapping('n', ['nope', 'id'], [STEP.concat, STEP.to_integer])], target);
    expect(errors[0]).toMatchObject({ targetField: 'n', sourceFields: ['nope', 'id'], rawValues: { nope: null, id: ' c-1 ' } });
  });

  it('an unmapped target is null with no error (validation reports it)', () => {
    const { row, errors } = transformRecord(record, [], target);
    expect(row).toEqual({ ref: null, n: null, unmapped: null, country: null });
    expect(errors).toEqual([]);
  });
});

describe('gold plan over the 200 fixture records', () => {
  const target = TargetSchemaSchema.parse(load('target-schema.json'));
  const gold = MigrationPlanSchema.parse(load('gold-plan.json'));
  const records = load('source-records.json') as SourceRecord[];
  const manifest = load('defect-manifest.json') as Record<string, string[]>;
  const results = records.map((r) => ({ sourceKey: r.sourceKey, ...transformRecord(r, gold.mappings, target) }));

  /** Manifest categories that must fail at the transform stage, with the target field they fail on. */
  const TRANSFORM_DEFECTS: Record<string, string> = {
    unparseable_date: 'created_on',
    day_first_date: 'created_on',
    unknown_status: 'status',
    empty_status: 'status',
    malformed_balance: 'balance_cents',
    invalid_phone: 'phone_e164',
    unknown_vip: 'is_vip',
  };

  it('transforms all 200 records', () => {
    expect(results).toHaveLength(200);
  });

  it.each(Object.entries(TRANSFORM_DEFECTS))('%s rows fail on %s', (category, field) => {
    const keys = manifest[category]!;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const { row, errors } = results.find((r) => r.sourceKey === key)!;
      expect(errors.some((e) => e.stage === 'transform' && e.targetField === field)).toBe(true);
      expect(row[field]).toBeNull();
    }
  });

  it('no other record or field fails at the transform stage', () => {
    const expected = Object.entries(TRANSFORM_DEFECTS)
      .flatMap(([category, field]) => manifest[category]!.map((key) => `${key}:${field}`))
      .sort();
    const actual = results.flatMap((r) => r.errors.map((e) => `${e.sourceKey}:${e.targetField}`)).sort();
    expect(actual).toEqual(expected);
  });

  it('produces values of the declared target type', () => {
    for (const { row } of results) {
      expect(Object.keys(row)).toEqual(target.fields.map((f) => f.name));
      for (const field of target.fields) {
        const v = row[field.name];
        if (v === null) continue;
        if (field.type === 'string') expect(typeof v).toBe('string');
        if (field.type === 'integer') expect(Number.isSafeInteger(v)).toBe(true);
        if (field.type === 'boolean') expect(typeof v).toBe('boolean');
        if (field.type === 'date') expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('transforms a clean record exactly', () => {
    expect(results[0]).toEqual({
      sourceKey: 'r0001',
      errors: [],
      row: {
        external_ref: 'C-10041',
        first_name: 'Yuki',
        last_name: 'Ivanova',
        email: 'yuki.ivanova73@example.com',
        phone_e164: '+19749615838',
        status: 'active',
        created_on: '2012-07-14',
        balance_cents: 320131,
        is_vip: false,
        country: 'US',
      },
    });
  });

  it('reports a non-existent date with full evidence', () => {
    const r0002 = results.find((r) => r.sourceKey === 'r0002')!;
    expect(r0002.errors).toHaveLength(1);
    expect(r0002.errors[0]).toMatchObject({
      sourceKey: 'r0002',
      stage: 'transform',
      targetField: 'created_on',
      sourceFields: ['signup_dt'],
      rawValues: { signup_dt: '2019-02-30' },
      stepIndex: 1,
      op: 'parse_date',
      code: 'TRANSFORM_FAILED',
    });
  });
});
