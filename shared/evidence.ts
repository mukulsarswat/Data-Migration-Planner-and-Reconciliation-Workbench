// Field-level error evidence and run-outcome contracts (long format, AWS DMS / pandera style).
import type { Value } from './schemas.ts';
import type { Step } from './dsl.ts';

export const ERROR_CODES = [
  'MISSING_REQUIRED',
  'TRANSFORM_FAILED',
  'AMBIGUOUS_DATE',
  'TYPE_MISMATCH',
  'ENUM_VIOLATION',
  'PATTERN_VIOLATION',
  'MAX_LENGTH',
  'DUPLICATE_TARGET_KEY',
  'TARGET_CONFLICT',
  'LOAD_CONSTRAINT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Stage = 'transform' | 'validation' | 'dedupe' | 'load';

export type Evidence = {
  sourceKey: string;
  stage: Stage;
  targetField: string | null;
  sourceFields: string[];
  /** Raw source values involved (exactly as extracted). */
  rawValues: Record<string, string | null>;
  /** Index of the failing step in the mapping's chain (transform stage only). */
  stepIndex: number | null;
  op: string | null;
  code: ErrorCode;
  message: string;
  /** For DUPLICATE_TARGET_KEY: the other source rows sharing the key. */
  siblings?: string[];
};

/** A transformed target row keyed by target field name (JS values; see shared/targetRow.ts for DB binding). */
export type TransformedRow = Record<string, Value>;

export type DryRunOutcome = 'accepted' | 'transform_failed' | 'validation_rejected';
export type LoadOutcome = 'inserted' | 'skipped_existing' | 'conflict' | 'load_rejected';

export type RecordResult = {
  sourceKey: string;
  outcome: DryRunOutcome;
  /** null when any transform failed (the row is not "transformed"). */
  row: TransformedRow | null;
  errors: Evidence[];
};

export type FieldCounts = { total: number; valid: number; error: number; empty: number };

/**
 * Dry-run partition (identities hold for every run):
 *   source      = transformFailed + transformed
 *   transformed = accepted + validationRejected
 *   rejected    = transformFailed + validationRejected
 */
export type DryRunCounts = {
  source: number;
  transformed: number;
  accepted: number;
  rejected: number;
  transformFailed: number;
  validationRejected: number;
  byCode: Partial<Record<ErrorCode, number>>;
  byField: Record<string, FieldCounts>;
};

export type ExecuteCounts = {
  accepted: number;
  processed: number;
  inserted: number;
  skippedExisting: number;
  conflict: number;
  loadRejected: number;
  /** accepted records not reached (failed/interrupted run). */
  pending: number;
};

/** Result of running one mapping's step chain over one record. */
export type MappingResult =
  | { ok: true; value: Value }
  | { ok: false; stepIndex: number; op: string; code: 'TRANSFORM_FAILED' | 'AMBIGUOUS_DATE'; message: string };

/** Injected wherever analysis code needs to evaluate a mapping (implemented by server/src/engine/transforms.ts `runMapping`). */
export type MappingRunner = (
  values: Readonly<Record<string, string>>,
  mapping: { readonly sources: readonly string[]; readonly steps: readonly Step[] },
) => MappingResult;
