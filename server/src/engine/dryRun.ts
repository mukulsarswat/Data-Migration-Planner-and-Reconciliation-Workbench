// Deterministic dry run: a pure function of (plan, source records, target schema).
// Same inputs ⇒ byte-identical outcomes and result hash, independent of input order, clock or timezone.
import type { SourceRecord, TargetSchema } from '../../../shared/schemas.ts';
import type { MigrationPlan } from '../../../shared/plan.ts';
import type { DryRunCounts, ErrorCode, Evidence, FieldCounts, RecordResult } from '../../../shared/evidence.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';
import { toTargetRow } from '../../../shared/targetRow.ts';
import { runMapping, transformRecord } from './transforms.ts';
import { findDuplicateKeys, validateRow } from './validate.ts';
import { hashCanonical } from './hash.ts';

export type DryRunResult = {
  results: RecordResult[];
  counts: DryRunCounts;
  sourceHash: string;
  /** Hash of transform/validation outcomes only (target state is never an input). */
  resultHash: string;
};

export function sortRecords(records: readonly SourceRecord[]): SourceRecord[] {
  return [...records].sort((a, b) => compareCodeUnits(a.sourceKey, b.sourceKey));
}

// The bounded source set is immutable for the process lifetime, so its hash is computed once per records array.
const sourceHashCache = new WeakMap<readonly SourceRecord[], string>();

export function sourceHash(records: readonly SourceRecord[]): string {
  let h = sourceHashCache.get(records);
  if (h === undefined) {
    h = hashCanonical(sortRecords(records));
    sourceHashCache.set(records, h);
  }
  return h;
}

export function dryRun(records: readonly SourceRecord[], plan: MigrationPlan, target: TargetSchema, planHash: string): DryRunResult {
  const sorted = sortRecords(records);
  const results: RecordResult[] = sorted.map((record) => {
    const { row, errors: transformErrors } = transformRecord(record, plan.mappings, target);
    // Don't double-report fields whose transform already failed (they are null in `row`).
    const failedFields = new Set(transformErrors.map((e) => e.targetField));
    const validationErrors = validateRow(record.sourceKey, row, target, plan.mappings, record.values).filter(
      (e) => !failedFields.has(e.targetField),
    );
    const errors = [...transformErrors, ...validationErrors];
    const outcome = transformErrors.length ? 'transform_failed' : validationErrors.length ? 'validation_rejected' : 'accepted';
    return { sourceKey: record.sourceKey, outcome, row: transformErrors.length ? null : row, errors };
  });

  // Whole-dataset duplicate check on the transformed business key. Every member of a duplicate group is rejected:
  // identity is ambiguous, so neither row may be loaded (order-independent by construction).
  const keyField = target.keyField;
  const keyMapping = plan.mappings.find((m) => m.target === keyField);
  const byKey = new Map(sorted.map((r) => [r.sourceKey, r]));
  // The business key of EVERY record (also rows whose other fields failed): a duplicate's sibling must never load
  // just because its twin failed for an unrelated reason.
  const keyOf = (r: RecordResult): string | null => {
    let key: unknown = r.row?.[keyField];
    if (r.row === null && keyMapping) {
      const res = runMapping(byKey.get(r.sourceKey)!.values, keyMapping);
      key = res.ok ? res.value : null;
    }
    return typeof key === 'string' && key !== '' ? key : null;
  };
  const duplicates = findDuplicateKeys(results.map((r) => ({ sourceKey: r.sourceKey, key: keyOf(r) })));
  for (const result of results) {
    const siblings = duplicates.get(result.sourceKey);
    if (!siblings) continue;
    const raw = byKey.get(result.sourceKey)!.values;
    const sourceFields = keyMapping ? [...keyMapping.sources] : [];
    const evidence: Evidence = {
      sourceKey: result.sourceKey,
      stage: 'dedupe',
      targetField: keyField,
      sourceFields,
      rawValues: Object.fromEntries(sourceFields.map((s) => [s, raw[s] ?? null])),
      stepIndex: null,
      op: null,
      code: 'DUPLICATE_TARGET_KEY',
      message: `${keyField} '${String(keyOf(result))}' is shared with ${siblings.join(', ')}; all copies are quarantined`,
      siblings,
    };
    result.errors.push(evidence);
    if (result.outcome === 'accepted') result.outcome = 'validation_rejected';
  }

  const counts = countResults(results, target);
  const sHash = sourceHash(records);
  const resultHash = hashCanonical({
    planHash,
    sourceHash: sHash,
    results: results.map((r) => [
      r.sourceKey,
      r.outcome,
      r.row ? toTargetRow(target, r.row) : null,
      r.errors.map((e) => [e.stage, e.targetField, e.code]),
    ]),
  });
  return { results, counts, sourceHash: sHash, resultHash };
}

export function countResults(results: readonly RecordResult[], target: TargetSchema): DryRunCounts {
  const byCode: Partial<Record<ErrorCode, number>> = {};
  const byField: Record<string, FieldCounts> = {};
  for (const f of target.fields) byField[f.name] = { total: results.length, valid: 0, error: 0, empty: 0 };
  let accepted = 0;
  let transformFailed = 0;
  let validationRejected = 0;
  for (const r of results) {
    if (r.outcome === 'accepted') accepted++;
    else if (r.outcome === 'transform_failed') transformFailed++;
    else validationRejected++;
    // Count records (not error rows) per code and per field.
    for (const code of new Set(r.errors.map((e) => e.code))) byCode[code] = (byCode[code] ?? 0) + 1;
    const errorFields = new Set(r.errors.map((e) => e.targetField));
    for (const f of target.fields) {
      const fc = byField[f.name]!;
      if (errorFields.has(f.name)) fc.error++;
      else if (r.row && r.row[f.name] === null) fc.empty++;
    }
  }
  for (const f of target.fields) {
    const fc = byField[f.name]!;
    fc.valid = fc.total - fc.error;
  }
  const source = results.length;
  return {
    source,
    transformed: source - transformFailed,
    accepted,
    rejected: transformFailed + validationRejected,
    transformFailed,
    validationRejected,
    byCode,
    byField,
  };
}
