// Runtime for the closed transform DSL (shared/dsl.ts): one pure function per op, chained per mapping.
// Deterministic and timezone independent: no Date parsing of strings, no local time, no locale-dependent calls.
// Nothing here throws on bad data — every failure is a StepResult that becomes field-level Evidence.
import type { SourceRecord, TargetSchema, Value } from '../../../shared/schemas.ts';
import type { DateFormat, Step } from '../../../shared/dsl.ts';
import type { FieldMapping } from '../../../shared/plan.ts';
import type { Evidence, MappingResult, TransformedRow } from '../../../shared/evidence.ts';

export type StepResult = { ok: true; value: Value } | { ok: false; code: 'TRANSFORM_FAILED' | 'AMBIGUOUS_DATE'; message: string };

/** A value flowing through a chain: a scalar, or the source values of a multi-source mapping (before `concat`). */
type ChainValue = Value | (string | null)[];

const ok = (value: Value): StepResult => ({ ok: true, value });
const fail = (message: string): StepResult => ({ ok: false, code: 'TRANSFORM_FAILED', message });

function describeInput(input: unknown): string {
  if (Array.isArray(input)) return 'several values';
  return input === null ? 'null' : `a ${typeof input}`;
}

/** Apply one step. Never throws: wrong input types and unvalidated steps fail with TRANSFORM_FAILED. */
export function applyStep(input: ChainValue, step: Step): StepResult {
  try {
    return dispatch(input, step);
  } catch (err) {
    // Only reachable with a step that bypassed StepSchema validation (e.g. missing params).
    return fail(`\`${String(step?.op)}\` could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function dispatch(input: ChainValue, step: Step): StepResult {
  // concat is the only op that takes several values; it drops nulls and yields null when nothing is left.
  if (step.op === 'concat') {
    if (!Array.isArray(input) || !input.every((v) => v === null || typeof v === 'string')) {
      return fail(`\`concat\` expects several source values but got ${describeInput(input)}`);
    }
    const present = input.filter((v) => v !== null);
    return ok(present.length > 0 ? present.join(step.params.separator) : null);
  }
  if (Array.isArray(input)) return fail(`\`${step.op}\` cannot take several values; start with \`concat\``);
  if (step.op === 'copy') return ok(input);
  if (input !== null && typeof input !== 'string') return fail(`\`${step.op}\` expects a string but got ${describeInput(input)}`);

  // From here on the input is string | null. These two ops define their own null behaviour…
  if (step.op === 'null_if_empty') return ok(input === null || input.trim() === '' ? null : input);
  if (step.op === 'default') return ok(input ?? step.params.value);
  // …every other op passes null through unchanged.
  if (input === null) return ok(null);

  switch (step.op) {
    case 'trim':
      return ok(input.trim());
    case 'lowercase':
      return ok(input.toLowerCase());
    case 'uppercase':
      return ok(input.toUpperCase());
    case 'split_full_name':
      return ok(splitFullName(input, step.params.part));
    case 'parse_date':
      return parseDate(input, step.params.formats);
    case 'parse_currency_to_cents':
      return parseCurrencyToCents(input);
    case 'to_integer':
      return toInteger(input);
    case 'to_boolean':
      return toBoolean(input, step.params.true_values, step.params.false_values);
    case 'map_values':
      return mapValues(input, step.params.pairs, step.params.fallback);
    case 'normalize_phone':
      return normalizeUsPhone(input);
    default:
      return fail(`unknown op \`${String((step as { op: unknown }).op)}\``);
  }
}

/** Chain input: 0 sources ⇒ null; 1 ⇒ that value; ≥2 ⇒ array. Absent fields (own properties only) ⇒ null. */
function sourceValue(values: Readonly<Record<string, string>>, field: string): string | null {
  return Object.hasOwn(values, field) ? values[field]! : null;
}

/** Run a mapping's steps in order; the first failing step ends the chain. Satisfies `MappingRunner`. */
export function runMapping(
  values: Readonly<Record<string, string>>,
  mapping: { readonly sources: readonly string[]; readonly steps: readonly Step[] },
): MappingResult {
  const { sources, steps } = mapping;
  let current: ChainValue =
    sources.length === 0 ? null : sources.length === 1 ? sourceValue(values, sources[0]!) : sources.map((s) => sourceValue(values, s));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const result = applyStep(current, step);
    if (!result.ok) return { ok: false, stepIndex: i, op: step.op, code: result.code, message: result.message };
    current = result.value;
  }
  // Only possible for a multi-source mapping with no steps (static validation rejects it): point at the missing concat.
  if (Array.isArray(current)) {
    const message = 'several source values must be combined with `concat`';
    return { ok: false, stepIndex: steps.length, op: 'concat', code: 'TRANSFORM_FAILED', message };
  }
  return { ok: true, value: current };
}

/**
 * Transform one record: every target field in schema order, using the first mapping that targets it.
 * A failed mapping leaves the field null and adds transform-stage Evidence; an unmapped field is null with no
 * error (validation reports MISSING_REQUIRED).
 */
export function transformRecord(
  record: SourceRecord,
  mappings: readonly FieldMapping[],
  target: TargetSchema,
): { row: TransformedRow; errors: Evidence[] } {
  const entries: [string, Value][] = [];
  const errors: Evidence[] = [];
  for (const { name } of target.fields) {
    const mapping = mappings.find((m) => m.target === name);
    if (!mapping) {
      entries.push([name, null]);
      continue;
    }
    const result = runMapping(record.values, mapping);
    if (result.ok) {
      entries.push([name, result.value]);
      continue;
    }
    entries.push([name, null]);
    errors.push({
      sourceKey: record.sourceKey,
      stage: 'transform',
      targetField: name,
      sourceFields: [...mapping.sources],
      rawValues: Object.fromEntries(mapping.sources.map((s) => [s, sourceValue(record.values, s)])),
      stepIndex: result.stepIndex,
      op: result.op,
      code: result.code,
      message: result.message,
    });
  }
  // fromEntries always creates own properties (a field named "__proto__" must not touch the prototype).
  const row: TransformedRow = Object.fromEntries(entries);
  return { row, errors };
}

// ---- split_full_name ------------------------------------------------------------------------------------------

/** First/last name from "Last, First [Middle]" or "First [Middle] Last". Missing parts are null, never ''. */
export function splitFullName(s: string, part: 'first' | 'last'): string | null {
  const name = s.replace(/\s+/g, ' ').trim();
  const comma = name.indexOf(',');
  let first: string | undefined;
  let last: string | undefined;
  if (comma >= 0) {
    last = name.slice(0, comma).trim();
    // Further commas (e.g. "Doe, Jane, Jr.") separate tokens too.
    first = name.slice(comma + 1).split(/[ ,]+/).find((t) => t !== '');
  } else {
    const tokens = name.split(' ').filter((t) => t !== '');
    first = tokens[0];
    last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
  }
  return (part === 'first' ? first : last) || null;
}

// ---- parse_date -----------------------------------------------------------------------------------------------

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Whole-string shape of each format. yyyy = 4 digits; MM/dd = 1–2 digits; MMM = 3 letters (checked against
 * MONTH_ABBR). The separator-less yyyyMMdd needs exactly two digits each, or its fields would be ambiguous.
 */
const DATE_SHAPES: Record<DateFormat, RegExp> = {
  'yyyy-MM-dd': /^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})$/,
  'MM/dd/yyyy': /^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})$/,
  'dd/MM/yyyy': /^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})$/,
  'dd-MMM-yyyy': /^(?<d>\d{1,2})-(?<mon>[A-Za-z]{3})-(?<y>\d{4})$/,
  yyyyMMdd: /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/,
};

/** Calendar check by a Date.UTC round trip (rejects Feb 30, month 13, day 0; leap years follow the Gregorian rule). */
function isCalendarDate(y: number, m: number, d: number): boolean {
  // Date.UTC reads years 0–99 as 1900–1999; the Gregorian calendar repeats every 400 years, so check y + 400 instead.
  const year = y < 100 ? y + 400 : y;
  const t = new Date(Date.UTC(year, m - 1, d));
  return t.getUTCFullYear() === year && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Parse with every listed format; exactly one distinct real date ⇒ 'YYYY-MM-DD', several ⇒ AMBIGUOUS_DATE. */
export function parseDate(s: string, formats: readonly DateFormat[]): StepResult {
  const readings: { format: DateFormat; iso: string }[] = [];
  const impossible: DateFormat[] = [];
  for (const format of formats) {
    const g = DATE_SHAPES[format].exec(s)?.groups;
    if (!g) continue;
    const m = g.mon === undefined ? Number(g.m) : MONTH_ABBR.indexOf(g.mon.toLowerCase()) + 1;
    if (g.mon !== undefined && m === 0) continue; // unknown month name: no match
    const y = Number(g.y);
    const d = Number(g.d);
    if (isCalendarDate(y, m, d)) readings.push({ format, iso: `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}` });
    else impossible.push(format);
  }
  const distinct = new Set(readings.map((r) => r.iso));
  if (distinct.size === 1) return ok(readings[0]!.iso);
  if (distinct.size > 1) {
    const options = readings.map((r) => `${r.iso} (${r.format})`).join(' or ');
    return { ok: false, code: 'AMBIGUOUS_DATE', message: `ambiguous date: could be ${options}` };
  }
  if (impossible.length > 0) return fail(`matches ${impossible.join(', ')} but that date does not exist`);
  return fail(`does not match any of the formats ${formats.join(', ')}`);
}

// ---- parse_currency_to_cents ----------------------------------------------------------------------------------

/** [-] [(] [$] digits-or-grouped-digits [.d or .dd] [)] — whole string, no spaces. */
const CURRENCY = /^(?<minus>-)?(?<open>\()?\$?(?<int>\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(?<frac>\d{1,2}))?(?<close>\))?$/;

/** Money text to integer cents, assembled from digit strings (no float arithmetic). */
export function parseCurrencyToCents(s: string): StepResult {
  const g = CURRENCY.exec(s)?.groups;
  const parens = g?.open !== undefined;
  if (!g || parens !== (g.close !== undefined) || (parens && g.minus !== undefined)) {
    return fail('not a currency amount (expected e.g. $1,234.50, -12.00 or (45.00))');
  }
  const cents = Number(g.int!.replaceAll(',', '') + (g.frac ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return fail('amount is too large to represent exactly in cents');
  return ok((g.minus !== undefined || parens) && cents !== 0 ? -cents : cents);
}

// ---- to_integer / to_boolean / map_values ---------------------------------------------------------------------

function toInteger(s: string): StepResult {
  if (!/^[+-]?\d+$/.test(s)) return fail('not a base-10 integer');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return fail('integer is outside the safe range');
  return ok(n === 0 ? 0 : n); // '-0' ⇒ 0, never -0
}

const fold = (v: string): string => v.trim().toLowerCase();

function toBoolean(s: string, trueValues: readonly string[], falseValues: readonly string[]): StepResult {
  const v = fold(s);
  const isTrue = trueValues.some((t) => fold(t) === v);
  const isFalse = falseValues.some((f) => fold(f) === v);
  if (isTrue && isFalse) return fail(`value '${s}' is listed as both true and false`);
  if (isTrue || isFalse) return ok(isTrue);
  return fail(`value '${s}' is not a listed true/false spelling`);
}

function mapValues(s: string, pairs: readonly { from: string; to: string }[], fallback: string | null): StepResult {
  // A Map, not an object, so 'constructor' / '__proto__' are ordinary keys.
  const hit = new Map(pairs.map((p) => [p.from, p.to])).get(s);
  if (hit !== undefined) return ok(hit);
  return fallback !== null ? ok(fallback) : fail(`value '${s}' has no mapping`);
}

// ---- normalize_phone ------------------------------------------------------------------------------------------

/**
 * North American number to E.164: 10 digits (area code 2–9…) ⇒ '+1…', or 11 digits '1' + that ⇒ '+1…'.
 * Only digits and phone punctuation are allowed. Messages never echo the number (PII).
 */
export function normalizeUsPhone(s: string): StepResult {
  if (!/^[\d\s().+-]*$/.test(s)) return fail('phone number contains characters other than digits and punctuation');
  const digits = s.replace(/\D/g, '');
  if (/^[2-9]\d{9}$/.test(digits)) return ok(`+1${digits}`);
  if (/^1[2-9]\d{9}$/.test(digits)) return ok(`+${digits}`);
  return fail(`not a North American number: expected 10 digits (or 11 starting with 1) with an area code starting 2–9, got ${digits.length} digits`);
}
