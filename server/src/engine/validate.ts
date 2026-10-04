// Target-row validation (stage 'validation') and whole-dataset duplicate-key detection.
// Mirrors the target table's constraints so the dry run predicts what the load will accept.
import type { TargetField, TargetSchema, Value, ValueType } from '../../../shared/schemas.ts';
import type { FieldMapping } from '../../../shared/plan.ts';
import type { ErrorCode, Evidence, TransformedRow } from '../../../shared/evidence.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SHOWN = 80;

const TYPE_NAMES: Record<ValueType, string> = {
  string: 'a string',
  integer: 'a safe integer',
  boolean: 'a boolean',
  date: 'a real calendar date (YYYY-MM-DD)',
};

/** True for an existing calendar date written exactly 'YYYY-MM-DD' (proleptic Gregorian, integer arithmetic only). */
export function isValidIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Check one transformed row against the target schema. Every failing field is reported (all errors collected);
 * within a field, MISSING_REQUIRED and TYPE_MISMATCH stop further checks, while ENUM/MAX_LENGTH/PATTERN all apply.
 * A non-required '' is NOT null: it fails its pattern, which tells the user to add `null_if_empty`.
 */
export function validateRow(
  sourceKey: string,
  row: TransformedRow,
  target: TargetSchema,
  mappings: readonly FieldMapping[],
  rawValues: Readonly<Record<string, string>>,
): Evidence[] {
  const errors: Evidence[] = [];
  for (const field of target.fields) {
    const v = Object.hasOwn(row, field.name) ? (row[field.name] ?? null) : null;
    const fail = (code: ErrorCode, message: string) => {
      const sources = mappings.find((m) => m.target === field.name)?.sources ?? [];
      errors.push({
        sourceKey,
        stage: 'validation',
        targetField: field.name,
        sourceFields: [...sources],
        rawValues: Object.fromEntries(sources.map((s) => [s, Object.hasOwn(rawValues, s) ? (rawValues[s] ?? null) : null])),
        stepIndex: null,
        op: null,
        code,
        message,
      });
    };

    const empty = v === null || (typeof v === 'string' && v.trim() === '');
    if (field.required && empty) {
      fail('MISSING_REQUIRED', `"${field.name}" is required but is empty (got ${show(v)}).`);
      continue;
    }
    if (v === null) continue;
    if (!hasType(field, v)) {
      fail('TYPE_MISMATCH', `"${field.name}" must be ${TYPE_NAMES[field.type]} but got ${show(v)}.`);
      continue;
    }
    // Remaining constraints apply to text values (string and date fields).
    if (typeof v !== 'string') continue;
    if (field.enum && !field.enum.includes(v)) {
      fail('ENUM_VIOLATION', `"${field.name}" must be one of ${field.enum.join(', ')} but got ${show(v)}.`);
    }
    const length = [...v].length; // code points, like SQLite length()
    if (field.maxLength !== undefined && length > field.maxLength) {
      fail('MAX_LENGTH', `"${field.name}" allows at most ${field.maxLength} characters but got ${length}: ${show(v)}.`);
    }
    if (field.pattern !== undefined && !compiled(field.pattern).test(v)) {
      const hint = empty ? ' An empty string is not null; add `null_if_empty` to the mapping.' : '';
      fail('PATTERN_VIOLATION', `"${field.name}" does not match ${field.pattern}: got ${show(v)}.${hint}`);
    }
  }
  return errors;
}

/**
 * Duplicate business keys across the whole dataset. Rows with a null key are skipped.
 * Every member of a group of ≥2 maps to its sorted siblings; the map itself iterates in sourceKey order,
 * so the result does not depend on input order.
 */
export function findDuplicateKeys(entries: readonly { sourceKey: string; key: string | null }[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { sourceKey, key } of entries) {
    if (key === null) continue;
    const members = groups.get(key);
    if (members) members.push(sourceKey);
    else groups.set(key, [sourceKey]);
  }
  const pairs: [string, string[]][] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(compareCodeUnits);
    for (const k of sorted) pairs.push([k, sorted.filter((s) => s !== k)]);
  }
  return new Map(pairs.sort((a, b) => compareCodeUnits(a[0], b[0])));
}

function hasType(field: TargetField, v: string | number | boolean): boolean {
  switch (field.type) {
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'string' && isValidIsoDate(v);
  }
}

const regexCache = new Map<string, RegExp>();
function compiled(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

/** Render a value for a message: strings quoted and truncated to MAX_SHOWN code points. */
function show(v: Value): string {
  if (typeof v !== 'string') return String(v);
  const cps = [...v];
  return JSON.stringify(cps.length > MAX_SHOWN ? `${cps.slice(0, MAX_SHOWN).join('')}…` : v);
}
