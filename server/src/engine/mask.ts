// PII masking for everything that leaves the engine toward the LLM or the UI profile (samples, format examples, questions).
// Shape-preserving: lengths, punctuation and separators survive so formats stay recognisable; identifying content does not.
import type { SourceRecord, SourceSchema } from '../../../shared/schemas.ts';

const EMAIL = /^([^@\s]+)@([^@\s]+)$/;
const MIN_DIGITS_FOR_NUMBER = 7;
const KEEP_LAST_DIGITS = 4;

/**
 * Mask one value:
 * - e-mail ⇒ first character (code point) of the local part + '***@' + domain ('Jane.Doe@x.com' ⇒ 'J***@x.com');
 * - ≥7 digits (phones, account numbers; any script's decimal digits) ⇒ every digit except the last 4 becomes '*',
 *   and letters are masked too ('Call 555-123-4567' ⇒ 'C*** ***-***-4567');
 * - otherwise each letter run keeps its first letter, the rest become '*' ('Doe, Jane' ⇒ 'D**, J***'); other characters are kept.
 */
export function maskValue(value: string): string {
  if (value === '') return '';
  const email = EMAIL.exec(value);
  if (email) return `${Array.from(email[1]!)[0]}***@${email[2]}`;

  const digits = (value.match(/\p{Nd}/gu) ?? []).length;
  if (digits >= MIN_DIGITS_FOR_NUMBER) {
    let toMask = digits - KEEP_LAST_DIGITS;
    return maskLetters(value.replace(/\p{Nd}/gu, (d) => (toMask-- > 0 ? '*' : d)));
  }
  return maskLetters(value);
}

function maskLetters(value: string): string {
  return value.replace(/\p{L}+/gu, (run) => {
    const chars = Array.from(run); // code points, so 'Zoë' ⇒ 'Z**'
    return chars[0] + '*'.repeat(chars.length - 1);
  });
}

/** Copy of `record` with every `pii: true` field masked; other fields (and unknown keys) are left as they are. */
export function maskRecord(record: SourceRecord, source: SourceSchema): SourceRecord {
  const values: Record<string, string> = { ...record.values };
  for (const field of source.fields) {
    const v = values[field.name];
    if (field.pii && v !== undefined) values[field.name] = maskValue(v);
  }
  return { sourceKey: record.sourceKey, values };
}
