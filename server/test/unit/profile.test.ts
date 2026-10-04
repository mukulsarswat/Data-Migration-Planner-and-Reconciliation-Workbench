import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatSignature, profileFields } from '../../src/engine/profile.ts';
import { SourceSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema } from '../../../shared/schemas.ts';

const DATASET = path.resolve(import.meta.dirname, '../../src/dataset');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DATASET, name), 'utf8'));
const source = SourceSchemaSchema.parse(readJson('source-schema.json'));
const records = readJson('source-records.json') as SourceRecord[];

describe('formatSignature', () => {
  it.each([
    ['03/14/2019', '99/99/9999'],
    ['2019-03-14', '9999-99-99'],
    ['14-Mar-2019', '99-Aa-9999'],
    ['Doe, Jane', 'Aa, Aa'],
    ['(555) 123-4567', '(999) 999-9999'],
    ['$1,234.50', '$9,999.99'],
    ['C-00042', 'A-99999'],
    ["O'Brien", "A'Aa"],
    ['yes', 'a'],
    ['YES', 'A'],
    ['Yes', 'Aa'],
    ['  a \t b ', ' a a '],
    ['', '∅'],
  ])('%j ⇒ %j', (value, signature) => {
    expect(formatSignature(value)).toBe(signature);
  });
});

describe('profileFields on the fixture', () => {
  const profiles = profileFields(records, source);
  const byField = (name: string) => profiles.find((p) => p.field === name)!;

  it('returns one profile per source field in schema order', () => {
    expect(profiles.map((p) => p.field)).toEqual(source.fields.map((f) => f.name));
    for (const p of profiles) expect(p.total).toBe(200);
  });

  it('lists every status value, including the undocumented X/Z codes and blanks', () => {
    const status = byField('status');
    expect(status.pii).toBe(false);
    expect(status.empty).toBe(2);
    expect(status.distinct).toBe(9);
    expect(status.topValues).toEqual([
      { value: 'A', count: 122 },
      { value: 'I', count: 38 },
      { value: 'P', count: 27 },
      { value: 'a', count: 4 },
      { value: 'i', count: 4 },
      { value: 'X', count: 2 },
      { value: '', count: 1 },
      { value: ' ', count: 1 },
      { value: 'Z', count: 1 },
    ]);
    expect(status.formats.map((f) => [f.signature, f.count])).toEqual([
      ['A', 190],
      ['a', 8],
      [' ', 1],
      ['∅', 1],
    ]);
  });

  it('shows the drifting date formats of signup_dt', () => {
    const signup = byField('signup_dt');
    const sigs = signup.formats.map((f) => f.signature);
    expect(sigs).toContain('99/99/9999');
    expect(sigs).toContain('9999-99-99');
    expect(sigs).toContain('99-Aa-9999');
    expect(signup.formats[0]).toMatchObject({ signature: '99/99/9999', count: 95 });
    expect(signup.topValues).toEqual([]); // too many distinct values
  });

  it('flags cust_id as key-like', () => {
    const cust = byField('cust_id');
    expect(cust).toMatchObject({ distinct: 198, distinctRatio: 0.99, keyLike: true, minLength: 5, maxLength: 9 }); // 'C-123' (malformed) … ' c-00042 '
    expect(byField('status').keyLike).toBe(false);
  });

  it('keeps pii out of profiles: no top values and masked format examples', () => {
    for (const name of ['full_name', 'email_addr', 'phone', 'fax', 'notes']) {
      const p = byField(name);
      expect(p.pii).toBe(true);
      expect(p.topValues).toEqual([]);
    }
    for (const name of ['full_name', 'email_addr']) {
      for (const f of byField(name).formats) {
        if (f.example.trim() !== '') expect(f.example).toContain('*');
      }
    }
    const rawPhones = new Set(records.map((r) => r.values.phone));
    for (const f of byField('phone').formats) {
      if ((f.example.match(/\d|\*/g) ?? []).length >= 7) expect(rawPhones.has(f.example)).toBe(false);
    }
  });

  it('caps formats at 8, ordered by count desc then signature asc', () => {
    for (const p of profiles) {
      expect(p.formats.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < p.formats.length; i++) {
        const a = p.formats[i - 1]!;
        const b = p.formats[i]!;
        expect(a.count > b.count || (a.count === b.count && a.signature < b.signature)).toBe(true);
      }
    }
  });
});

describe('profileFields on a small table', () => {
  const schema: SourceSchema = {
    name: 't',
    description: '',
    keyField: 'x',
    fields: [
      { name: 'x', type: 'string', description: '', pii: false },
      { name: 'secret', type: 'string', description: '', pii: true },
    ],
  };
  const rows: SourceRecord[] = [
    { sourceKey: 'r1', values: { x: 'bb', secret: 'Jane Doe' } },
    { sourceKey: 'r2', values: { x: 'a', secret: 'John Roe' } },
    { sourceKey: 'r3', values: { x: '  ', secret: 'Jo' } },
  ];

  it('computes counts, lengths and rounded ratios', () => {
    const [x, secret] = profileFields(rows, schema);
    expect(x).toEqual({
      field: 'x',
      pii: false,
      total: 3,
      empty: 1,
      distinct: 3,
      distinctRatio: 1,
      keyLike: true,
      minLength: 1,
      maxLength: 2,
      formats: [
        { signature: 'a', count: 2, example: 'a' }, // example = smallest value with the signature (order-independent)
        { signature: ' ', count: 1, example: '  ' },
      ],
      topValues: [
        { value: '  ', count: 1 },
        { value: 'a', count: 1 },
        { value: 'bb', count: 1 },
      ],
      slashDates: { dayFirst: 0, monthFirst: 0, either: 0 },
    });
    expect(secret!.formats).toEqual([
      { signature: 'Aa Aa', count: 2, example: 'J*** D**' },
      { signature: 'Aa', count: 1, example: 'J*' },
    ]);
    expect(secret!.topValues).toEqual([]);
  });

  it('rounds the distinct ratio to 3 decimals and treats missing values as empty', () => {
    const p = profileFields(
      [
        { sourceKey: 'r1', values: { x: 'a' } },
        { sourceKey: 'r2', values: { x: 'a' } },
        { sourceKey: 'r3', values: {} },
      ],
      schema,
    )[0]!;
    expect(p.distinctRatio).toBe(0.667);
    expect(p.empty).toBe(1);
    expect(p.keyLike).toBe(false);
  });

  it('handles an empty record set', () => {
    expect(profileFields([], schema)[0]).toMatchObject({ total: 0, distinct: 0, distinctRatio: 0, minLength: 0, maxLength: 0 });
  });
});
