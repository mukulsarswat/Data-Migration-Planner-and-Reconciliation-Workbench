import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/canonical.ts';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** SHA-256 of the canonical JSON form: equal content ⇒ equal hash, regardless of key order. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
