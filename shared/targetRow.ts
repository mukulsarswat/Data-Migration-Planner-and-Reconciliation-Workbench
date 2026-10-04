// Single conversion from transformed JS values to SQLite-bindable primitives.
// Used for BOTH insert binding and row hashes so reconcile compares like with like.
import type { TargetSchema, Value } from './schemas.ts';
import type { TransformedRow } from './evidence.ts';

export type DbPrimitive = string | number | null;

export function toDbValue(value: Value | undefined): DbPrimitive {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Business columns in target-schema order (excludes surrogate id and lineage columns). */
export function businessColumns(schema: TargetSchema): string[] {
  return schema.fields.map((f) => f.name);
}

/** Map a transformed row to an ordered array of DB primitives in `businessColumns` order. */
export function toTargetRow(schema: TargetSchema, row: TransformedRow): DbPrimitive[] {
  return schema.fields.map((f) => toDbValue(row[f.name]));
}

/** Same shape built from a SELECTed DB row (object keyed by column), for hashing target rows. */
export function dbRowToPrimitives(schema: TargetSchema, dbRow: Record<string, unknown>): DbPrimitive[] {
  return schema.fields.map((f) => {
    const v = dbRow[f.name];
    if (v === undefined || v === null) return null;
    if (typeof v === 'bigint') return Number(v);
    return v as DbPrimitive;
  });
}
