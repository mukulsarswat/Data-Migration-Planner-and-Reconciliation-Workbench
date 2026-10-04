// Loads and validates the bounded dataset fixtures in this folder (one source, one target, ≤ MAX_SAMPLE_SIZE records).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MAX_SAMPLE_SIZE, SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, SourceSchema, TargetSchema } from '../../../shared/schemas.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';
import type { MigrationPlan } from '../../../shared/plan.ts';
import type { TransformedRow } from '../../../shared/evidence.ts';

export type Dataset = {
  source: SourceSchema;
  target: TargetSchema;
  records: SourceRecord[];
  /** Pre-existing target rows (not owned by any migration; rollback must spare them). */
  targetSeed: TransformedRow[];
  /** Hand-written reference plan (evaluation baseline). */
  goldPlan: MigrationPlan;
  dir: string;
};

const RecordsSchema = z.array(
  z.object({ sourceKey: z.string().min(1), values: z.record(z.string(), z.string()) }).strict(),
);
const TargetSeedSchema = z.array(
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
);

function readJson<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid dataset file ${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadDataset(dir: string = import.meta.dirname): Dataset {
  const records = readJson(dir, 'source-records.json', RecordsSchema);
  if (records.length > MAX_SAMPLE_SIZE) {
    throw new Error(`Dataset has ${records.length} records; the documented maximum is ${MAX_SAMPLE_SIZE}`);
  }
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.sourceKey)) throw new Error(`Duplicate sourceKey in source-records.json: ${r.sourceKey}`);
    seen.add(r.sourceKey);
  }
  return {
    source: readJson(dir, 'source-schema.json', SourceSchemaSchema),
    target: readJson(dir, 'target-schema.json', TargetSchemaSchema),
    records,
    targetSeed: readJson(dir, 'target-seed.json', TargetSeedSchema),
    goldPlan: readJson(dir, 'gold-plan.json', MigrationPlanSchema),
    dir,
  };
}
