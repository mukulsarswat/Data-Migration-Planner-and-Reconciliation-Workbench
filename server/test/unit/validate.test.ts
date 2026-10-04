import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TargetSchemaSchema } from '../../../shared/schemas.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';
import type { TransformedRow } from '../../../shared/evidence.ts';
import { findDuplicateKeys, isValidIsoDate, validateRow } from '../../src/engine/validate.ts';

const load = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../../src/dataset/${name}`, import.meta.url), 'utf8'));
const target = TargetSchemaSchema.parse(load('target-schema.json'));
const { mappings } = MigrationPlanSchema.parse(load('gold-plan.json'));

const RAW: Record<string, string> = {
  cust_id: 'C-00042',
  full_name: 'Doe, Jane',
  email_addr: 'Jane@Example.com',
  phone: '(555) 123-4567',
  status: 'A',
  signup_dt: '03/14/2019',
  bal: '$1,234.50',
  vip_flag: 'N',
  fax: '',
  notes: '',
};

const GOOD: TransformedRow = {
  external_ref: 'C-00042',
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane@example.com',
  phone_e164: '+15551234567',
  status: 'active',
  created_on: '2019-03-14',
  balance_cents: 123450,
  is_vip: false,
  country: 'US',
};

const check = (patch: TransformedRow) => validateRow('r0042', { ...GOOD, ...patch }, target, mappings, RAW);
/** [targetField, code] pairs, in emission order. */
const codes = (patch: TransformedRow) => check(patch).map((e) => [e.targetField, e.code]);

describe('validateRow', () => {
  it('accepts a fully valid row', () => {
    expect(check({})).toEqual([]);
  });

  describe('MISSING_REQUIRED', () => {
    it.each([null, '', '   '])('flags required field value %j and names the field', (v) => {
      const errors = check({ first_name: v });
      expect(errors).toEqual([
        {
          sourceKey: 'r0042',
          stage: 'validation',
          targetField: 'first_name',
          sourceFields: ['full_name'],
          rawValues: { full_name: 'Doe, Jane' },
          stepIndex: null,
          op: null,
          code: 'MISSING_REQUIRED',
          message: expect.stringContaining('first_name'),
        },
      ]);
    });

    it('treats an absent (undefined) key as null', () => {
      const { first_name: _drop, ...rest } = GOOD;
      const errors = validateRow('r0042', rest, target, mappings, RAW);
      expect(errors.map((e) => [e.targetField, e.code])).toEqual([['first_name', 'MISSING_REQUIRED']]);
    });

    it('skips further checks on a missing field (no PATTERN/ENUM noise)', () => {
      expect(codes({ status: '' })).toEqual([['status', 'MISSING_REQUIRED']]);
      expect(codes({ external_ref: ' ' })).toEqual([['external_ref', 'MISSING_REQUIRED']]);
    });

    it('uses empty sourceFields/rawValues for a constant (0-source) mapping', () => {
      const [e] = check({ country: null });
      expect(e).toMatchObject({ targetField: 'country', code: 'MISSING_REQUIRED', sourceFields: [], rawValues: {} });
    });

    it('uses empty sourceFields when no mapping targets the field', () => {
      const unmapped = mappings.filter((m) => m.target !== 'country');
      const [e] = validateRow('r0042', { ...GOOD, country: null }, target, unmapped, RAW);
      expect(e).toMatchObject({ code: 'MISSING_REQUIRED', sourceFields: [], rawValues: {} });
    });

    it('reports a raw value absent from the source record as null', () => {
      const { full_name: _drop, ...raw } = RAW;
      const [e] = validateRow('r0042', { ...GOOD, last_name: null }, target, mappings, raw);
      expect(e?.rawValues).toEqual({ full_name: null });
    });
  });

  describe('nullable fields', () => {
    it('accepts null and undefined for a non-required field', () => {
      expect(check({ email: null, phone_e164: null })).toEqual([]);
      const { email: _drop, ...rest } = GOOD;
      expect(validateRow('r0042', rest, target, mappings, RAW)).toEqual([]);
    });

    it("does not treat '' as null: '' email ⇒ PATTERN_VIOLATION hinting at null_if_empty", () => {
      const errors = check({ email: '' });
      expect(errors.map((e) => e.code)).toEqual(['PATTERN_VIOLATION']);
      expect(errors[0]).toMatchObject({ targetField: 'email', sourceFields: ['email_addr'], rawValues: { email_addr: 'Jane@Example.com' } });
      expect(errors[0]?.message).toContain('null_if_empty');
    });
  });

  describe('TYPE_MISMATCH', () => {
    it.each([1.5, Number.NaN, 2 ** 60, Number.POSITIVE_INFINITY, '100'])('integer field rejects %s', (v) => {
      const errors = check({ balance_cents: v });
      expect(errors.map((e) => [e.targetField, e.code])).toEqual([['balance_cents', 'TYPE_MISMATCH']]);
      expect(errors[0]?.message).toContain('balance_cents');
      expect(errors[0]?.message).toContain(String(v));
    });

    it('integer field accepts negative and zero safe integers', () => {
      expect(check({ balance_cents: -1200 })).toEqual([]);
      expect(check({ balance_cents: 0 })).toEqual([]);
    });

    it.each(['true', 1, 0])('boolean field rejects %j', (v) => {
      expect(codes({ is_vip: v })).toEqual([['is_vip', 'TYPE_MISMATCH']]);
    });

    it.each(['2019-02-29', '2019-3-14', '03/14/2019', 20190314])('date field rejects %j', (v) => {
      expect(codes({ created_on: v })).toEqual([['created_on', 'TYPE_MISMATCH']]);
    });

    it('date field accepts a leap day in a leap year', () => {
      expect(check({ created_on: '2020-02-29' })).toEqual([]);
    });

    it('string field rejects a number and skips enum/pattern checks', () => {
      expect(codes({ first_name: 42 })).toEqual([['first_name', 'TYPE_MISMATCH']]);
      expect(codes({ status: 5 })).toEqual([['status', 'TYPE_MISMATCH']]);
      expect(codes({ email: true })).toEqual([['email', 'TYPE_MISMATCH']]);
    });
  });

  describe('ENUM_VIOLATION', () => {
    it('flags a value outside the enum, naming field and value', () => {
      const errors = check({ status: 'actve' });
      expect(errors.map((e) => [e.targetField, e.code, e.sourceFields])).toEqual([['status', 'ENUM_VIOLATION', ['status']]]);
      expect(errors[0]?.message).toContain('status');
      expect(errors[0]?.message).toContain('"actve"');
    });

    it('is case-sensitive', () => {
      expect(codes({ status: 'Active' })).toEqual([['status', 'ENUM_VIOLATION']]);
    });
  });

  describe('MAX_LENGTH (code points, like SQLite length())', () => {
    it('allows exactly maxLength and flags maxLength + 1', () => {
      expect(check({ first_name: 'a'.repeat(50) })).toEqual([]);
      const errors = check({ first_name: 'a'.repeat(51) });
      expect(errors.map((e) => [e.targetField, e.code])).toEqual([['first_name', 'MAX_LENGTH']]);
      expect(errors[0]?.message).toContain('first_name');
      expect(errors[0]?.message).toContain('50');
    });

    it("counts 'é' as one character", () => {
      expect(check({ first_name: 'é'.repeat(50) })).toEqual([]);
      expect(codes({ first_name: 'é'.repeat(51) })).toEqual([['first_name', 'MAX_LENGTH']]);
    });

    it('counts an astral emoji (2 UTF-16 units) as one character', () => {
      expect('😀'.repeat(50).length).toBe(100);
      expect(check({ first_name: '😀'.repeat(50) })).toEqual([]);
      expect(codes({ first_name: '😀'.repeat(51) })).toEqual([['first_name', 'MAX_LENGTH']]);
    });

    it('truncates long offending values to 80 characters in the message', () => {
      const [e] = check({ first_name: 'x'.repeat(200) });
      expect(e?.message).toContain('x'.repeat(80));
      expect(e?.message).not.toContain('x'.repeat(81));
    });
  });

  describe('PATTERN_VIOLATION (patterns from target-schema.json)', () => {
    it.each([
      ['external_ref', 'C-00042', true],
      ['external_ref', 'c-00042', false],
      ['external_ref', 'C-0042', false],
      ['email', 'jane.doe+x@mail.example.org', true],
      ['email', 'Jane@Example.com', false],
      ['email', 'jane@example', false],
      ['email', 'jane example.com', false],
      ['phone_e164', '+442071234567', true],
      ['phone_e164', '5551234567', false],
      ['phone_e164', '+05551234567', false],
      ['phone_e164', '+1555', false],
      ['country', 'US', true],
      ['country', 'us', false],
      ['country', 'U1', false],
    ] as const)('%s %j valid=%s', (field, value, valid) => {
      const errors = check({ [field]: value });
      expect(errors.map((e) => [e.targetField, e.code])).toEqual(valid ? [] : [[field, 'PATTERN_VIOLATION']]);
      if (!valid) expect(errors[0]?.message).toContain(field);
    });

    it('collects both MAX_LENGTH and PATTERN_VIOLATION on one field', () => {
      expect(codes({ external_ref: 'C-123456' })).toEqual([
        ['external_ref', 'MAX_LENGTH'],
        ['external_ref', 'PATTERN_VIOLATION'],
      ]);
      expect(codes({ country: 'USA' })).toEqual([
        ['country', 'MAX_LENGTH'],
        ['country', 'PATTERN_VIOLATION'],
      ]);
    });
  });

  it('collects every error across fields, in target-schema order', () => {
    const errors = check({ first_name: null, email: 'BAD', status: 'X', created_on: '2019-02-29', is_vip: 'Y' });
    expect(errors.map((e) => [e.targetField, e.code])).toEqual([
      ['first_name', 'MISSING_REQUIRED'],
      ['email', 'PATTERN_VIOLATION'],
      ['status', 'ENUM_VIOLATION'],
      ['created_on', 'TYPE_MISMATCH'],
      ['is_vip', 'TYPE_MISMATCH'],
    ]);
    expect(errors.every((e) => e.sourceKey === 'r0042' && e.stage === 'validation')).toBe(true);
    expect(errors.find((e) => e.targetField === 'created_on')?.rawValues).toEqual({ signup_dt: '03/14/2019' });
  });

  it('ignores row keys that are not target fields', () => {
    expect(check({ nickname: 'JJ' })).toEqual([]);
  });
});

describe('isValidIsoDate', () => {
  it.each([
    ['2020-02-29', true],
    ['2000-02-29', true],
    ['2019-12-31', true],
    ['2019-02-29', false],
    ['1900-02-29', false],
    ['2019-04-31', false],
    ['2019-13-01', false],
    ['2019-00-10', false],
    ['2019-01-00', false],
    ['2019-1-01', false],
    [' 2019-01-01', false],
    ['2019-01-01T00:00', false],
    ['19-01-01', false],
    ['', false],
  ])('%j ⇒ %s', (s, ok) => {
    expect(isValidIsoDate(s)).toBe(ok);
  });
});

describe('findDuplicateKeys', () => {
  const entries = [
    { sourceKey: 'r01', key: 'C-00001' },
    { sourceKey: 'r02', key: 'C-00002' },
    { sourceKey: 'r03', key: 'C-00003' },
    { sourceKey: 'r04', key: 'C-00003' },
    { sourceKey: 'r05', key: 'C-00001' },
    { sourceKey: 'r06', key: 'C-00006' },
    { sourceKey: 'r07', key: null },
    { sourceKey: 'r08', key: null },
    { sourceKey: 'r09', key: 'C-00002' },
    { sourceKey: 'r10', key: 'C-00003' },
  ];
  const expected = new Map([
    ['r01', ['r05']],
    ['r02', ['r09']],
    ['r03', ['r04', 'r10']],
    ['r04', ['r03', 'r10']],
    ['r05', ['r01']],
    ['r09', ['r02']],
    ['r10', ['r03', 'r04']],
  ]);

  it('maps every member of a duplicate group to its sorted siblings; nulls and singletons are absent', () => {
    const result = findDuplicateKeys(entries);
    expect(result).toEqual(expected);
    expect([...result.keys()]).toEqual([...expected.keys()]);
  });

  it('is independent of input order (rotations and reversals)', () => {
    for (let shift = 0; shift < entries.length; shift++) {
      const rotated = [...entries.slice(shift), ...entries.slice(0, shift)];
      for (const order of [rotated, [...rotated].reverse()]) {
        const result = findDuplicateKeys(order);
        expect([...result.entries()]).toEqual([...expected.entries()]);
      }
    }
  });

  it('returns an empty map when nothing collides', () => {
    expect(findDuplicateKeys([]).size).toBe(0);
    expect(findDuplicateKeys([{ sourceKey: 'a', key: null }, { sourceKey: 'b', key: null }]).size).toBe(0);
  });
});
