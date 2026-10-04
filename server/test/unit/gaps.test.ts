import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeFieldGaps } from '../../src/engine/gaps.ts';
import { profileFields } from '../../src/engine/profile.ts';
import { SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema, TargetSchema } from '../../../shared/schemas.ts';
import { FieldGapsSchema } from '../../../shared/plan.ts';
import { chainType } from '../../../shared/dsl.ts';

const DATASET = path.resolve(import.meta.dirname, '../../src/dataset');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DATASET, name), 'utf8'));
const source = SourceSchemaSchema.parse(readJson('source-schema.json'));
const target = TargetSchemaSchema.parse(readJson('target-schema.json'));
const records = readJson('source-records.json') as SourceRecord[];
const profiles = profileFields(records, source);

describe('computeFieldGaps on the fixture', () => {
  const gaps = computeFieldGaps(source, target, profiles);

  it('parses with FieldGapsSchema', () => {
    expect(FieldGapsSchema.parse(gaps)).toEqual(gaps);
  });

  it('finds exactly fax and notes without a target', () => {
    expect(gaps.sourceWithoutTarget.map((g) => g.source)).toEqual(['fax', 'notes']);
    for (const g of gaps.sourceWithoutTarget) expect(g.reason.length).toBeGreaterThan(10);
  });

  it('finds exactly country as a required target without a source', () => {
    expect(gaps.requiredTargetWithoutSource.map((g) => g.target)).toEqual(['country']);
    expect(gaps.requiredTargetWithoutSource[0]!.reason).toMatch(/country/);
  });

  it('lists the four conversions in target-schema order with exact suggested steps', () => {
    expect(gaps.typeIncompatible.map((g) => `${g.source}→${g.target}`)).toEqual([
      'status→status',
      'signup_dt→created_on',
      'bal→balance_cents',
      'vip_flag→is_vip',
    ]);
    const steps = Object.fromEntries(gaps.typeIncompatible.map((g) => [g.target, g.suggestedSteps]));
    expect(steps.status).toEqual([
      { op: 'trim', params: {} },
      { op: 'uppercase', params: {} },
      {
        op: 'map_values',
        params: {
          pairs: [
            { from: 'A', to: 'active' },
            { from: 'I', to: 'inactive' },
            { from: 'P', to: 'pending' },
          ],
          fallback: null,
        },
      },
    ]);
    expect(steps.created_on).toEqual([
      { op: 'trim', params: {} },
      { op: 'parse_date', params: { formats: ['MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MMM-yyyy'] } },
    ]);
    expect(steps.balance_cents).toEqual([
      { op: 'trim', params: {} },
      { op: 'parse_currency_to_cents', params: {} },
    ]);
    expect(steps.is_vip).toEqual([
      { op: 'trim', params: {} },
      { op: 'to_boolean', params: { true_values: ['Y', 'YES'], false_values: ['N', 'NO', ''] } },
    ]);
  });

  it('suggests chains that type-check and end in the target type', () => {
    for (const g of gaps.typeIncompatible) {
      const t = target.fields.find((f) => f.name === g.target)!;
      expect(chainType(1, g.suggestedSteps), g.target).toEqual({ ok: true, type: t.type });
      expect(g.note.length).toBeGreaterThan(10);
      expect(g.sourceType).toBe('string');
    }
  });
});

describe('computeFieldGaps on synthetic data', () => {
  const schemaOf = (fields: string[]): SourceSchema => ({
    name: 's',
    description: '',
    keyField: fields[0]!,
    fields: fields.map((name) => ({ name, type: 'string' as const, description: '', pii: false })),
  });
  const targetOf = (fields: TargetSchema['fields']): TargetSchema => ({ name: 't', description: '', keyField: fields[0]!.name, fields });

  it('uses dd/MM/yyyy only when the slash dates show day-first evidence alone', () => {
    const s = schemaOf(['signup']);
    const t = targetOf([{ name: 'created_on', type: 'date', required: true, unique: false, description: '' }]);
    const rows = ['25/12/2019', '13/07/2018', '2019-01-01'].map((v, i) => ({ sourceKey: `r${i}`, values: { signup: v } }));
    const gaps = computeFieldGaps(s, t, profileFields(rows, s));
    expect(gaps.typeIncompatible[0]!.suggestedSteps[1]).toEqual({
      op: 'parse_date',
      params: { formats: ['dd/MM/yyyy', 'yyyy-MM-dd'] },
    });
  });

  it('parses plain integers with to_integer and falls back to the full boolean vocabulary', () => {
    const s = schemaOf(['balance', 'vip']);
    const t = targetOf([
      { name: 'balance_cents', type: 'integer', required: true, unique: false, description: '' },
      { name: 'is_vip', type: 'boolean', required: true, unique: false, description: '' },
    ]);
    const rows = ['12', '-3', '400'].map((v, i) => ({ sourceKey: `r${i}`, values: { balance: v, vip: 'maybe' } }));
    const gaps = computeFieldGaps(s, t, profileFields(rows, s));
    expect(gaps.typeIncompatible.map((g) => g.suggestedSteps)).toEqual([
      [
        { op: 'trim', params: {} },
        { op: 'to_integer', params: {} },
      ],
      [
        { op: 'trim', params: {} },
        { op: 'to_boolean', params: { true_values: ['Y', 'YES', 'TRUE', '1'], false_values: ['N', 'NO', 'FALSE', '0', ''] } },
      ],
    ]);
  });
});
