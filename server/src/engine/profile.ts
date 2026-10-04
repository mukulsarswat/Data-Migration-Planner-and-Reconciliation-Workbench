// Deterministic field profiling of the raw source extract: counts, key-likeness, length range, format signatures and
// (non-PII, low-cardinality) value frequencies. Feeds candidates, gaps, triggers, the agent tools and the Inputs step.
import type { SourceField, SourceRecord, SourceSchema } from '../../../shared/schemas.ts';
import type { DateFormat } from '../../../shared/dsl.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';
import { maskValue } from './mask.ts';

export type FormatStat = { signature: string; count: number; example: string };

export type FieldProfile = {
  field: string;
  pii: boolean;
  total: number;
  /** Values that are '' or whitespace only. */
  empty: number;
  /** Distinct raw values (no trimming or case folding). */
  distinct: number;
  /** distinct / total, rounded to 3 decimals. */
  distinctRatio: number;
  keyLike: boolean;
  minLength: number;
  maxLength: number;
  /** Top format signatures; `example` is the first value seen with that signature (masked for PII fields). */
  formats: FormatStat[];
  /** Every value with its count — only for non-PII fields with few distinct values, else []. */
  topValues: { value: string; count: number }[];
  /** Slash dates (a/b/yyyy) over ALL values: day-first only (a > 12), month-first only (b > 12), either reading. */
  slashDates: { dayFirst: number; monthFirst: number; either: number };
};

const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/;

const KEY_LIKE_RATIO = 0.9;
const MAX_FORMATS = 8;
const MAX_TOP_VALUES = 20;
const EMPTY_SIGNATURE = '∅';

// Letter runs: Capitalised ('Doe' ⇒ Aa), UPPER ('MAR' ⇒ A), lower ('yes' ⇒ a), other scripts ⇒ a. Digits one by one, whitespace runs.
const TOKEN = /\p{Lu}\p{Ll}+|\p{Lu}+|\p{Ll}+|\p{L}+|\p{Nd}|\s+/gu;

/** Shape of a value: '03/14/2019' ⇒ '99/99/9999', 'Doe, Jane' ⇒ 'Aa, Aa', '(555) 123-4567' ⇒ '(999) 999-9999', '' ⇒ '∅'. */
export function formatSignature(v: string): string {
  if (v === '') return EMPTY_SIGNATURE;
  return v.replace(TOKEN, (t) => {
    if (/^\p{Nd}$/u.test(t)) return '9'; // any script's decimal digit (no PII digits leak via signatures)
    if (/^\s/.test(t)) return ' ';
    if (/^\p{Lu}\p{Ll}/u.test(t)) return 'Aa';
    return /^\p{Lu}/u.test(t) ? 'A' : 'a';
  });
}

/** Profile every source field (schema order). A value missing from a record counts as ''. */
export function profileFields(records: readonly SourceRecord[], source: SourceSchema): FieldProfile[] {
  return source.fields.map((field) => profileField(field, records.map((r) => (Object.hasOwn(r.values, field.name) ? (r.values[field.name] ?? '') : ''))));
}

function profileField(field: SourceField, values: readonly string[]): FieldProfile {
  const total = values.length;
  const valueCounts = new Map<string, number>();
  const formats = new Map<string, FormatStat>();
  const raw = new Map<string, string>(); // signature ⇒ smallest raw value (deterministic example, independent of order)
  let empty = 0;
  let minLength = total === 0 ? 0 : Infinity;
  let maxLength = 0;
  const slashDates = { dayFirst: 0, monthFirst: 0, either: 0 };
  for (const v of values) {
    const slash = SLASH_DATE.exec(v.trim());
    if (slash) {
      const [a, b] = [Number(slash[1]), Number(slash[2])];
      if (a > 12 && b <= 12) slashDates.dayFirst++;
      else if (b > 12 && a <= 12) slashDates.monthFirst++;
      else if (a <= 12 && b <= 12) slashDates.either++;
    }
    if (v.trim() === '') empty++;
    minLength = Math.min(minLength, v.length);
    maxLength = Math.max(maxLength, v.length);
    valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
    const signature = formatSignature(v);
    const stat = formats.get(signature);
    if (stat) {
      stat.count++;
      if (compareCodeUnits(v, raw.get(signature)!) < 0) raw.set(signature, v);
    } else {
      formats.set(signature, { signature, count: 1, example: '' });
      raw.set(signature, v);
    }
  }
  for (const [signature, stat] of formats) {
    const v = raw.get(signature)!;
    stat.example = field.pii ? maskValue(v) : v;
  }
  const distinct = valueCounts.size;
  const distinctRatio = total === 0 ? 0 : Math.round((distinct / total) * 1000) / 1000;
  const topValues =
    !field.pii && distinct <= MAX_TOP_VALUES
      ? [...valueCounts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || compareCodeUnits(a.value, b.value))
      : [];
  return {
    field: field.name,
    pii: field.pii,
    total,
    empty,
    distinct,
    distinctRatio,
    keyLike: distinctRatio >= KEY_LIKE_RATIO,
    minLength,
    maxLength,
    formats: [...formats.values()]
      .sort((a, b) => b.count - a.count || compareCodeUnits(a.signature, b.signature))
      .slice(0, MAX_FORMATS),
    topValues,
    slashDates,
  };
}

// ---- Signature classifiers shared by candidates, gaps and triggers ----

/** DATE_FORMATS that can parse values of this signature. Slash dates fit both month-first and day-first. */
export function signatureDateFormats(raw: string): DateFormat[] {
  const signature = raw.trim(); // suggested chains always trim first
  if (/^9{1,2}\/9{1,2}\/9999$/.test(signature)) return ['MM/dd/yyyy', 'dd/MM/yyyy'];
  if (/^9999-9{1,2}-9{1,2}$/.test(signature)) return ['yyyy-MM-dd'];
  if (/^9{1,2}-(Aa|A|a)-9999$/.test(signature)) return ['dd-MMM-yyyy'];
  if (signature === '99999999') return ['yyyyMMdd'];
  return [];
}

/** Plain or money-looking number: optional sign / accounting parentheses / '$', digits with thousands commas, decimals. */
export function isNumericSignature(signature: string): boolean {
  return /^[-+]?\(?[-+]?\$?9[9,]*(\.9+)?\)?$/.test(signature.trim());
}

/** A numeric signature that carries currency punctuation ('$', ',', '.', parentheses) rather than a bare integer. */
export function isCurrencySignature(signature: string): boolean {
  return isNumericSignature(signature) && /[$,.()]/.test(signature);
}

/** Of the non-blank values counted in `profile.formats` (top signatures only), how many have a signature passing `test`. */
export function countFormats(profile: FieldProfile, test: (signature: string) => boolean): { matching: number; nonBlank: number } {
  let matching = 0;
  let nonBlank = 0;
  for (const f of profile.formats) {
    if (f.signature === EMPTY_SIGNATURE || f.signature.trim() === '') continue;
    nonBlank += f.count;
    if (test(f.signature)) matching += f.count;
  }
  return { matching, nonBlank };
}
