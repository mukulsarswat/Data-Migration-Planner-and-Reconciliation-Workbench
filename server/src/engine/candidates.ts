// Mapping candidates for one target field: name similarity × type compatibility (deterministic, Magneto/Parciak-style).
// Used by gaps, triggers (top-2 margin), the heuristic draft and the agent's `suggest_candidates` tool.
import type { SourceSchema, TargetField } from '../../../shared/schemas.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';
import { countFormats, isNumericSignature, signatureDateFormats } from './profile.ts';
import type { FieldProfile } from './profile.ts';

export type Candidate = { source: string; score: number; reasons: string[] };

/*
 * Scoring
 *   name   = 1.0 when the normalized names are equal (lower-case, non-alphanumerics stripped: 'Email_Addr' ⇒ 'emailaddr');
 *          = 0.9 when the pair is in SYNONYMS;
 *          = 0.8 × Dice similarity of the character-3-gram sets of the normalized names otherwise.
 *   factor = type compatibility from the source profile (1 when it fits or there is no profile, 0.5 when it contradicts):
 *            date target    ⇒ most non-blank values have a date-like signature (see signatureDateFormats);
 *            integer target ⇒ most non-blank values look numeric or like currency;
 *            boolean target ⇒ at most 10 distinct values.
 *   score  = round(name × factor, 3). Only score > 0 is kept; top 3 by score desc, then source name asc.
 */
const MAX_CANDIDATES = 3;
const MAX_FLAG_DISTINCT = 10;

/** Normalized target name ⇒ normalized source names that mean the same thing in CRM extracts. */
const SYNONYMS = new Map<string, readonly string[]>([
  ['externalref', ['custid', 'customerid', 'id']],
  ['email', ['emailaddr', 'mail']],
  ['phonee164', ['phone', 'tel', 'mobile']],
  ['createdon', ['signupdt', 'createdat', 'signup']],
  ['balancecents', ['bal', 'balance']],
  ['isvip', ['vipflag', 'vip']],
  ['firstname', ['fullname', 'name']],
  ['lastname', ['fullname', 'name']],
  ['country', ['country', 'countrycode']],
]);

export function suggestCandidates(target: TargetField, source: SourceSchema, profiles: readonly FieldProfile[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const field of source.fields) {
    const name = nameScore(target.name, field.name);
    if (name.score <= 0) continue;
    const type = typeFactor(target, profiles.find((p) => p.field === field.name));
    const score = Math.round(name.score * type.factor * 1000) / 1000;
    if (score <= 0) continue;
    candidates.push({ source: field.name, score, reasons: type.reason ? [name.reason, type.reason] : [name.reason] });
  }
  return candidates.sort((a, b) => b.score - a.score || compareCodeUnits(a.source, b.source)).slice(0, MAX_CANDIDATES);
}

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function nameScore(targetName: string, sourceName: string): { score: number; reason: string } {
  const t = normalize(targetName);
  const s = normalize(sourceName);
  if (t !== '' && t === s) return { score: 1, reason: `same name as ${targetName}` };
  if (SYNONYMS.get(t)?.includes(s)) return { score: 0.9, reason: `${sourceName} is a known synonym of ${targetName}` };
  const d = dice(t, s);
  return { score: 0.8 * d, reason: `name similarity ${Math.round(d * 1000) / 1000} (character 3-gram Dice)` };
}

function trigrams(s: string): Set<string> {
  if (s.length < 3) return new Set(s === '' ? [] : [s]);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) grams.add(s.slice(i, i + 3));
  return grams;
}

function dice(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

function typeFactor(target: TargetField, profile: FieldProfile | undefined): { factor: number; reason: string | null } {
  if (!profile) return { factor: 1, reason: null };
  if (target.type === 'date' || target.type === 'integer') {
    const isDate = target.type === 'date';
    const looksRight = isDate ? (sig: string) => signatureDateFormats(sig).length > 0 : isNumericSignature;
    const { matching, nonBlank } = countFormats(profile, looksRight);
    const fits = matching * 2 > nonBlank;
    const what = isDate ? 'dates' : 'numbers or currency';
    return {
      factor: fits ? 1 : 0.5,
      reason: `${matching} of ${nonBlank} non-empty values (top formats) look like ${what}${fits ? '' : ' (score halved)'}`,
    };
  }
  if (target.type === 'boolean') {
    const fits = profile.distinct <= MAX_FLAG_DISTINCT;
    return {
      factor: fits ? 1 : 0.5,
      reason: fits ? `${profile.distinct} distinct values fit a flag` : `${profile.distinct} distinct values are too many for a flag (score halved)`,
    };
  }
  return { factor: 1, reason: null };
}
