// Field-level gap analysis ("incompatible or missing fields"): which source fields have no target, which required targets have no
// source, and which matches need a type conversion — with a suggested, statically valid step chain for each conversion.
import type { SourceSchema, TargetField, TargetSchema } from '../../../shared/schemas.ts';
import type { FieldGaps } from '../../../shared/plan.ts';
import type { DateFormat, Step } from '../../../shared/dsl.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';
import { suggestCandidates } from './candidates.ts';
import type { Candidate } from './candidates.ts';
import { countFormats, isCurrencySignature, signatureDateFormats } from './profile.ts';
import type { FieldProfile } from './profile.ts';

/** A target "has a source" when its best candidate scores at least this. */
export const MATCH_THRESHOLD = 0.5;

/** Spellings `to_boolean` maps (it trims and ignores case), in the order they are listed. */
const TRUE_WORDS = ['Y', 'YES', 'TRUE', '1'];
const FALSE_WORDS = ['N', 'NO', 'FALSE', '0', ''];
/** Used when the profile shows no slash dates or no date-like signature at all. */
const FALLBACK_DATE_FORMATS: DateFormat[] = ['yyyy-MM-dd', 'MM/dd/yyyy', 'dd-MMM-yyyy', 'yyyyMMdd'];

/** Best candidate for `target` if it reaches MATCH_THRESHOLD, else null. */
export function bestCandidate(target: TargetField, source: SourceSchema, profiles: readonly FieldProfile[]): Candidate | null {
  const best = suggestCandidates(target, source, profiles)[0];
  return best && best.score >= MATCH_THRESHOLD ? best : null;
}

export function computeFieldGaps(source: SourceSchema, target: TargetSchema, profiles: readonly FieldProfile[]): FieldGaps {
  const profileOf = (name: string) => profiles.find((p) => p.field === name);
  const best = new Map<string, Candidate>();
  for (const t of target.fields) {
    const c = bestCandidate(t, source, profiles);
    if (c) best.set(t.name, c);
  }
  const matched = new Set([...best.values()].map((c) => c.source));

  const sourceWithoutTarget = source.fields
    .filter((f) => !matched.has(f.name))
    .map((f) => {
      const p = profileOf(f.name);
      const fill = p ? `; ${p.total - p.empty} of ${p.total} rows populated` : '';
      return { source: f.name, reason: `No target field matches ${f.name} (no candidate ≥ ${MATCH_THRESHOLD})${fill}.` };
    });

  const requiredTargetWithoutSource = target.fields
    .filter((t) => t.required && !best.has(t.name))
    .map((t) => {
      const near = suggestCandidates(t, source, profiles)[0];
      const nearText = near ? ` (closest: ${near.source} at ${near.score})` : '';
      return {
        target: t.name,
        reason: `${t.name} is required but no source field scores ≥ ${MATCH_THRESHOLD}${nearText}; it needs a constant default or a new source column.`,
      };
    });

  const typeIncompatible: FieldGaps['typeIncompatible'] = [];
  for (const t of target.fields) {
    const c = best.get(t.name);
    if (!c || (t.type === 'string' && !t.enum)) continue;
    const { steps, note } = conversion(t, c.source, profileOf(c.source));
    typeIncompatible.push({
      source: c.source,
      target: t.name,
      sourceType: 'string',
      targetType: t.type === 'string' && t.enum ? `enum(${t.enum.join('|')})` : t.type,
      note,
      suggestedSteps: steps,
    });
  }
  return { sourceWithoutTarget, requiredTargetWithoutSource, typeIncompatible };
}

const trim: Step = { op: 'trim', params: {} };
const quoteAll = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/** Suggested chain (always `trim` first) that turns the source text into the target type. */
function conversion(t: TargetField, src: string, profile: FieldProfile | undefined): { steps: Step[]; note: string } {
  if (t.type === 'date') {
    const formats = dateFormats(profile);
    return {
      steps: [trim, { op: 'parse_date', params: { formats } }],
      note: `${src} holds dates as text; parse_date with ${formats.join(', ')} yields YYYY-MM-DD (day-first slash dates are not assumed).`,
    };
  }
  if (t.type === 'integer') {
    const currency = profile ? countFormats(profile, isCurrencySignature).matching > 0 : false;
    // No null_if_empty/default prefix: whether a blank means 0 is a business decision (empty_required_values clarification).
    return currency
      ? {
          steps: [trim, { op: 'parse_currency_to_cents', params: {} }],
          note: `${src} holds money as display text ($, thousands commas, minus or parentheses); parse_currency_to_cents yields integer cents. Blank values fail.`,
        }
      : { steps: [trim, { op: 'to_integer', params: {} }], note: `${src} holds integers as text; to_integer parses them. Blank values fail.` };
  }
  const observed = new Set((profile?.topValues ?? []).map((v) => v.value.trim().toUpperCase()));
  if (t.type === 'boolean') {
    const seenTrue = TRUE_WORDS.filter((w) => observed.has(w));
    const seenFalse = FALSE_WORDS.filter((w) => observed.has(w));
    const true_values = seenTrue.length ? seenTrue : TRUE_WORDS;
    const false_values = seenFalse.length ? seenFalse : FALSE_WORDS;
    return {
      steps: [trim, { op: 'to_boolean', params: { true_values, false_values } }],
      note: `${src} holds flag text; ${quoteAll(true_values)} ⇒ true and ${quoteAll(false_values)} ⇒ false (case-insensitive); other values fail.`,
    };
  }
  // Enum target: map each observed code (trimmed, upper-cased) that is a prefix of exactly one enum value.
  const allowed = t.enum ?? [];
  const pairs = [...observed]
    .sort(compareCodeUnits)
    .flatMap((code) => {
      const hits = allowed.filter((e) => e.toUpperCase().startsWith(code));
      return code !== '' && hits.length === 1 ? [{ from: code, to: hits[0]! }] : [];
    });
  const unmatched = [...observed].filter((code) => !pairs.some((p) => p.from === code)).sort(compareCodeUnits);
  if (pairs.length === 0) {
    return { steps: [trim], note: `No observed ${src} value matches ${allowed.join('|')} by prefix; add a map_values step by hand.` };
  }
  return {
    steps: [trim, { op: 'uppercase', params: {} }, { op: 'map_values', params: { pairs, fallback: null } }],
    note:
      `${src} holds codes; ${pairs.map((p) => `${p.from} ⇒ ${p.to}`).join(', ')} by prefix.` +
      (unmatched.length ? ` Unmatched codes ${quoteAll(unmatched)} fail until a fallback is chosen.` : ''),
  };
}

/**
 * parse_date formats in order of observed frequency. A slash signature means MM/dd/yyyy (the US default) unless the
 * slash dates (counted over ALL values by the profiler) show only day-first evidence: first number > 12, none month-first.
 */
function dateFormats(profile: FieldProfile | undefined): DateFormat[] {
  if (!profile) return FALLBACK_DATE_FORMATS;
  const dayFirstOnly = profile.slashDates.dayFirst > 0 && profile.slashDates.monthFirst === 0 && profile.slashDates.either === 0;
  const formats: DateFormat[] = [];
  for (const f of profile.formats) {
    for (const df of signatureDateFormats(f.signature)) {
      const wanted = df === 'dd/MM/yyyy' ? dayFirstOnly : df === 'MM/dd/yyyy' ? !dayFirstOnly : true;
      if (wanted && !formats.includes(df)) formats.push(df);
    }
  }
  return formats.length ? formats : FALLBACK_DATE_FORMATS;
}
