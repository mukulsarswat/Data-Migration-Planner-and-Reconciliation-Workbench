import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { maskRecord, maskValue } from '../../src/engine/mask.ts';
import { SourceSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord } from '../../../shared/schemas.ts';

const DATASET = path.resolve(import.meta.dirname, '../../src/dataset');
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(DATASET, name), 'utf8'));
const source = SourceSchemaSchema.parse(readJson('source-schema.json'));
const records = readJson('source-records.json') as SourceRecord[];

describe('maskValue', () => {
  it('keeps the first character of an e-mail local part and the domain', () => {
    expect(maskValue('Yuki.Ivanova73@Example.Com')).toBe('Y***@Example.Com');
    expect(maskValue('a@b.co')).toBe('a***@b.co');
  });

  it('replaces every digit but the last 4 when the value has at least 7 digits', () => {
    expect(maskValue('(555) 123-4567')).toBe('(***) ***-4567');
    expect(maskValue('+1 555 123 4567')).toBe('+* *** *** 4567');
    expect(maskValue('555.123.4567')).toBe('***.***.4567');
    expect(maskValue('123-4567')).toBe('***-4567');
  });

  it('keeps the first letter of each letter run and preserves punctuation, spaces and short digit runs', () => {
    expect(maskValue('Doe, Jane')).toBe('D**, J***');
    expect(maskValue('Jane Doe')).toBe('J*** D**');
    expect(maskValue("Mary O'Brien")).toBe("M*** O'B****");
    expect(maskValue('Apt 12B')).toBe('A** 12B');
    expect(maskValue('jane.doe@')).toBe('j***.d**@'); // not an e-mail (no domain)
    expect(maskValue('Zoë')).toBe('Z**');
  });

  it("returns '' and whitespace unchanged", () => {
    expect(maskValue('')).toBe('');
    expect(maskValue('   ')).toBe('   ');
  });

  it('does not let the prompt-injection note (marker INJECT-7f3a) survive', () => {
    const note = records.find((r) => r.values.notes?.includes('INJECT-7f3a'))!.values.notes!;
    const masked = maskValue(note);
    expect(masked).not.toContain('INJECT-7f3a');
    expect(masked).not.toContain('INJECT');
    expect(masked).not.toContain('IGNORE');
    expect(masked).not.toContain('admin');
    expect(masked).toHaveLength(note.length);
  });
});

describe('maskRecord', () => {
  it('masks only pii fields and does not mutate the input', () => {
    const record: SourceRecord = {
      sourceKey: 'r9999',
      values: {
        cust_id: 'C-00042',
        full_name: 'Doe, Jane',
        email_addr: 'Jane.Doe@Example.com',
        phone: '(555) 123-4567',
        status: 'A',
        signup_dt: '03/14/2019',
        bal: '$1,234.50',
        vip_flag: 'Y',
        fax: '',
        notes: 'Call back',
      },
    };
    const before = structuredClone(record);
    const masked = maskRecord(record, source);
    expect(record).toEqual(before);
    expect(masked).toEqual({
      sourceKey: 'r9999',
      values: {
        cust_id: 'C-00042',
        full_name: 'D**, J***',
        email_addr: 'J***@Example.com',
        phone: '(***) ***-4567',
        status: 'A',
        signup_dt: '03/14/2019',
        bal: '$1,234.50',
        vip_flag: 'Y',
        fax: '',
        notes: 'C*** b***',
      },
    });
  });

  it('never leaves a populated pii name or e-mail value in clear across the fixture', () => {
    for (const r of records) {
      const m = maskRecord(r, source);
      for (const f of ['full_name', 'email_addr']) {
        const raw = r.values[f]!;
        if (/[A-Za-z]{2}/.test(raw)) expect(m.values[f]).not.toBe(raw);
      }
    }
  });
});
