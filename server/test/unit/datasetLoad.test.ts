import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDataset } from '../../src/dataset/load.ts';
import { MAX_SAMPLE_SIZE } from '../../../shared/schemas.ts';

const DATASET_DIR = path.resolve(import.meta.dirname, '../../src/dataset');
const FILES = ['source-schema.json', 'target-schema.json', 'source-records.json', 'target-seed.json', 'gold-plan.json'];

const tempDirs: string[] = [];

/** Copy the real fixtures into a temp dir, replacing source-records.json with `records`. */
function datasetWithRecords(records: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-dataset-'));
  tempDirs.push(dir);
  for (const f of FILES) fs.copyFileSync(path.join(DATASET_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'source-records.json'), JSON.stringify(records));
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('loadDataset', () => {
  it('loads the shipped dataset: 200 records, both schemas, target seed and gold plan', () => {
    const ds = loadDataset();
    expect(ds.dir).toBe(DATASET_DIR);
    expect(ds.records).toHaveLength(200);
    expect(ds.records[0]).toEqual({ sourceKey: 'r0001', values: expect.objectContaining({ cust_id: 'C-10041' }) });
    expect(ds.source.name).toBe('legacy_customers');
    expect(ds.source.fields.map((f) => f.name)).toContain('notes');
    expect(ds.target.name).toBe('accounts');
    expect(ds.target.keyField).toBe('external_ref');
    expect(ds.targetSeed).toHaveLength(5);
    expect(ds.goldPlan.mappings.map((m) => m.target)).toContain('external_ref');
  });

  it(`throws when the source has more than MAX_SAMPLE_SIZE (${MAX_SAMPLE_SIZE}) records`, () => {
    const records = Array.from({ length: MAX_SAMPLE_SIZE + 1 }, (_, i) => ({
      sourceKey: `r${String(i + 1).padStart(4, '0')}`,
      values: { cust_id: `C-${String(i).padStart(5, '0')}` },
    }));
    expect(() => loadDataset(datasetWithRecords(records))).toThrow(/500/);
  });

  it('accepts exactly MAX_SAMPLE_SIZE records', () => {
    const records = Array.from({ length: MAX_SAMPLE_SIZE }, (_, i) => ({ sourceKey: `k${i}`, values: {} }));
    expect(loadDataset(datasetWithRecords(records)).records).toHaveLength(MAX_SAMPLE_SIZE);
  });

  it('throws on duplicate sourceKeys', () => {
    const records = [
      { sourceKey: 'r0001', values: { cust_id: 'C-00001' } },
      { sourceKey: 'r0001', values: { cust_id: 'C-00002' } },
    ];
    expect(() => loadDataset(datasetWithRecords(records))).toThrow(/r0001/);
  });

  it('throws when a record does not match {sourceKey, values: Record<string,string>}', () => {
    expect(() => loadDataset(datasetWithRecords([{ sourceKey: 'r1', values: { a: 1 } }]))).toThrow();
    expect(() => loadDataset(datasetWithRecords([{ values: {} }]))).toThrow();
  });
});
