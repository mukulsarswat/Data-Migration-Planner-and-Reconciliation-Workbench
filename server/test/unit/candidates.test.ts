import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { suggestCandidates } from '../../src/engine/candidates.ts';
import { profileFields } from '../../src/engine/profile.ts';
import { SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema, TargetField } from '../../../shared/schemas.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';

const DATASET = path.resolve(import.meta.dirname, '../../src/dataset');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DATASET, name), 'utf8'));
const source = SourceSchemaSchema.parse(readJson('source-schema.json'));
const target = TargetSchemaSchema.parse(readJson('target-schema.json'));
const records = readJson('source-records.json') as SourceRecord[];
const gold = MigrationPlanSchema.parse(readJson('gold-plan.json'));
const profiles = profileFields(records, source);
const targetField = (name: string) => target.fields.find((f) => f.name === name)!;

/** One-field source schema + profile built from the given values. */
function singleSource(name: string, values: string[]) {
  const schema: SourceSchema = {
    name: 's',
    description: '',
    keyField: name,
    fields: [{ name, type: 'string', description: '', pii: false }],
  };
  const rows = values.map((v, i) => ({ sourceKey: `r${i}`, values: { [name]: v } }));
  return { schema, profiles: profileFields(rows, schema) };
}

describe('suggestCandidates on the fixture', () => {
  it('ranks the gold-plan source first for every target that has one', () => {
    for (const m of gold.mappings) {
      const candidates = suggestCandidates(targetField(m.target), source, profiles);
      if (m.sources.length === 0) {
        expect(candidates.every((c) => c.score < 0.5), m.target).toBe(true);
        continue;
      }
      expect(candidates[0]?.source, m.target).toBe(m.sources[0]);
      expect(candidates[0]!.score, m.target).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('scores exact names 1.0 and synonyms 0.9, with readable reasons', () => {
    expect(suggestCandidates(targetField('status'), source, profiles)[0]).toMatchObject({ source: 'status', score: 1 });
    const ext = suggestCandidates(targetField('external_ref'), source, profiles)[0]!;
    expect(ext).toMatchObject({ source: 'cust_id', score: 0.9 });
    expect(ext.reasons.join(' ')).toMatch(/synonym/i);
    const created = suggestCandidates(targetField('created_on'), source, profiles)[0]!;
    expect(created).toMatchObject({ source: 'signup_dt', score: 0.9 });
    expect(created.reasons.join(' ')).toMatch(/date/i);
  });

  it('returns at most 3 positive candidates, score desc then source asc, rounded to 3 decimals', () => {
    for (const f of target.fields) {
      const cs = suggestCandidates(f, source, profiles);
      expect(cs.length).toBeLessThanOrEqual(3);
      for (const c of cs) {
        expect(c.score).toBeGreaterThan(0);
        expect(Math.round(c.score * 1000) / 1000).toBe(c.score);
        expect(c.reasons.length).toBeGreaterThan(0);
      }
      for (let i = 1; i < cs.length; i++) {
        const a = cs[i - 1]!;
        const b = cs[i]!;
        expect(a.score > b.score || (a.score === b.score && a.source < b.source)).toBe(true);
      }
    }
  });
});

describe('suggestCandidates scoring rules', () => {
  it('falls back to 0.8 × character-3-gram Dice similarity', () => {
    const { schema, profiles: p } = singleSource('e_mail_address', ['a@b.co']);
    // grams(email)=3, grams(emailaddress)=10, shared=3 ⇒ dice 6/13 ⇒ 0.8 × 0.4615 = 0.369
    expect(suggestCandidates(targetField('email'), schema, p)).toEqual([
      { source: 'e_mail_address', score: 0.369, reasons: [expect.stringMatching(/similar/i)] },
    ]);
  });

  it('halves date targets whose source values do not look like dates', () => {
    const dates = singleSource('created_at', ['2019-01-02', '01/02/2019', '']);
    expect(suggestCandidates(targetField('created_on'), dates.schema, dates.profiles)[0]!.score).toBe(0.9);
    const text = singleSource('created_at', ['hello', 'world', '2019-01-02']);
    const c = suggestCandidates(targetField('created_on'), text.schema, text.profiles)[0]!;
    expect(c.score).toBe(0.45);
    expect(c.reasons.join(' ')).toMatch(/date/i);
  });

  it('halves integer targets whose source values do not look numeric', () => {
    const money = singleSource('balance', ['$1,234.50', '(45.00)', '12']);
    expect(suggestCandidates(targetField('balance_cents'), money.schema, money.profiles)[0]!.score).toBe(0.9);
    const text = singleSource('balance', ['n/a', 'none', '12']);
    expect(suggestCandidates(targetField('balance_cents'), text.schema, text.profiles)[0]!.score).toBe(0.45);
  });

  it('halves boolean targets whose source has more than 10 distinct values', () => {
    const flags = singleSource('vip', ['Y', 'N', '']);
    expect(suggestCandidates(targetField('is_vip'), flags.schema, flags.profiles)[0]!.score).toBe(0.9);
    const many = singleSource('vip', Array.from({ length: 11 }, (_, i) => `v${i}`));
    expect(suggestCandidates(targetField('is_vip'), many.schema, many.profiles)[0]!.score).toBe(0.45);
  });

  it('returns nothing when no source name resembles the target', () => {
    const t: TargetField = { name: 'zzz', type: 'string', required: false, unique: false, description: '' };
    expect(suggestCandidates(t, source, profiles)).toEqual([]);
  });
});
