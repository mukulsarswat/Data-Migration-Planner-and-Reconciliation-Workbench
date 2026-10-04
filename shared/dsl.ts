// The closed, declarative transformation DSL ("supported transformation rules").
// No expressions and no code: a mapping is a list of ops chosen from this catalog with validated params.
import { z } from 'zod';
import type { ValueType } from './schemas.ts';

/** Supported date formats for `parse_date`. `MM`/`dd` accept 1–2 digits; `MMM` is an English month abbreviation. */
export const DATE_FORMATS = ['yyyy-MM-dd', 'MM/dd/yyyy', 'dd/MM/yyyy', 'dd-MMM-yyyy', 'yyyyMMdd'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/**
 * Chain value types. `string[]` exists only as the input of a multi-source mapping and must be consumed by `concat`.
 * `same` (as an op output) means "same type as the input".
 */
export type ChainType = ValueType | 'string[]';
type OpIn = 'string' | 'string[]' | 'any';
type OpOut = ValueType | 'same';

const NoParams = z.object({}).strict();

export const OP_PARAMS = {
  copy: NoParams,
  trim: NoParams,
  lowercase: NoParams,
  uppercase: NoParams,
  null_if_empty: NoParams,
  default: z.object({ value: z.string() }).strict(),
  split_full_name: z.object({ part: z.enum(['first', 'last']) }).strict(),
  concat: z.object({ separator: z.string() }).strict(),
  parse_date: z.object({ formats: z.array(z.enum(DATE_FORMATS)).min(1) }).strict(),
  parse_currency_to_cents: NoParams,
  to_integer: NoParams,
  to_boolean: z
    .object({ true_values: z.array(z.string()).min(1), false_values: z.array(z.string()).min(1) })
    .strict(),
  map_values: z
    .object({
      pairs: z.array(z.object({ from: z.string(), to: z.string() }).strict()).min(1),
      fallback: z.string().nullable(),
    })
    .strict(),
  normalize_phone: z.object({ default_country: z.literal('US') }).strict(),
} as const;

export type OpName = keyof typeof OP_PARAMS;
export const OP_NAMES = Object.keys(OP_PARAMS) as OpName[];

export type OpSpec = {
  in: OpIn;
  out: OpOut;
  /** passthrough: null in ⇒ null out (op not applied). handles: the op defines its own null behaviour. */
  nulls: 'passthrough' | 'handles';
  description: string;
  example: string;
};

/** Signature table: drives static plan validation, agent tool docs and the UI catalog. */
export const OP_SPECS: Record<OpName, OpSpec> = {
  copy: { in: 'any', out: 'same', nulls: 'passthrough', description: 'Pass the value through unchanged.', example: '"abc" → "abc"' },
  trim: { in: 'string', out: 'string', nulls: 'passthrough', description: 'Remove leading/trailing whitespace.', example: '"  a b " → "a b"' },
  lowercase: { in: 'string', out: 'string', nulls: 'passthrough', description: 'Lower-case the string.', example: '"A@B.COM" → "a@b.com"' },
  uppercase: { in: 'string', out: 'string', nulls: 'passthrough', description: 'Upper-case the string.', example: '"c-001" → "C-001"' },
  null_if_empty: {
    in: 'string',
    out: 'string',
    nulls: 'handles',
    description: 'Turn an empty or whitespace-only string into null (null stays null).',
    example: '"  " → null',
  },
  default: {
    in: 'string',
    out: 'string',
    nulls: 'handles',
    description: 'Replace null with a constant string; non-null values pass through. With zero sources it supplies a constant.',
    example: 'null → "US"',
  },
  split_full_name: {
    in: 'string',
    out: 'string',
    nulls: 'passthrough',
    description: 'Take the first or last name from "Last, First" or "First [Middle] Last". Single-token names have no last name (null).',
    example: '"Doe, Jane" (first) → "Jane"',
  },
  concat: {
    in: 'string[]',
    out: 'string',
    nulls: 'handles',
    description: 'Join several source values with a separator, skipping nulls; all-null ⇒ null. Required first step for multi-source mappings.',
    example: '["Jane","Doe"] → "Jane Doe"',
  },
  parse_date: {
    in: 'string',
    out: 'date',
    nulls: 'passthrough',
    description:
      'Parse a calendar date using the listed formats into YYYY-MM-DD. Fails if no format matches, the date does not exist, or two formats give different dates (AMBIGUOUS_DATE).',
    example: '"03/14/2019" [MM/dd/yyyy] → "2019-03-14"',
  },
  parse_currency_to_cents: {
    in: 'string',
    out: 'integer',
    nulls: 'passthrough',
    description: 'Parse money like "$1,234.50", "-$12.00" or "(45.00)" into integer cents. Fails on anything else (including "").',
    example: '"$1,234.50" → 123450',
  },
  to_integer: { in: 'string', out: 'integer', nulls: 'passthrough', description: 'Parse an optionally signed base-10 integer.', example: '"42" → 42' },
  to_boolean: {
    in: 'string',
    out: 'boolean',
    nulls: 'passthrough',
    description: 'Map listed true/false spellings (trimmed, case-insensitive) to a boolean. Unlisted values fail.',
    example: '"yes" → true',
  },
  map_values: {
    in: 'string',
    out: 'string',
    nulls: 'passthrough',
    description: 'Exact-match lookup table (from → to). Unlisted values use the fallback, or fail when fallback is null.',
    example: '"A" → "active"',
  },
  normalize_phone: {
    in: 'string',
    out: 'string',
    nulls: 'passthrough',
    description: 'Normalize a North American number to E.164 (+1XXXXXXXXXX). Fails if it is not 10 digits (or 11 starting with 1).',
    example: '"(555) 123-4567" → "+15551234567"',
  },
};

export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('copy'), params: OP_PARAMS.copy }).strict(),
  z.object({ op: z.literal('trim'), params: OP_PARAMS.trim }).strict(),
  z.object({ op: z.literal('lowercase'), params: OP_PARAMS.lowercase }).strict(),
  z.object({ op: z.literal('uppercase'), params: OP_PARAMS.uppercase }).strict(),
  z.object({ op: z.literal('null_if_empty'), params: OP_PARAMS.null_if_empty }).strict(),
  z.object({ op: z.literal('default'), params: OP_PARAMS.default }).strict(),
  z.object({ op: z.literal('split_full_name'), params: OP_PARAMS.split_full_name }).strict(),
  z.object({ op: z.literal('concat'), params: OP_PARAMS.concat }).strict(),
  z.object({ op: z.literal('parse_date'), params: OP_PARAMS.parse_date }).strict(),
  z.object({ op: z.literal('parse_currency_to_cents'), params: OP_PARAMS.parse_currency_to_cents }).strict(),
  z.object({ op: z.literal('to_integer'), params: OP_PARAMS.to_integer }).strict(),
  z.object({ op: z.literal('to_boolean'), params: OP_PARAMS.to_boolean }).strict(),
  z.object({ op: z.literal('map_values'), params: OP_PARAMS.map_values }).strict(),
  z.object({ op: z.literal('normalize_phone'), params: OP_PARAMS.normalize_phone }).strict(),
]);
export type Step = z.infer<typeof StepSchema>;

export type ChainCheck =
  | { ok: true; type: ChainType }
  | { ok: false; stepIndex: number | null; message: string };

/**
 * Static type flow for a mapping's step chain.
 * Arity rules: 0 sources ⇒ first step must be `default`; ≥2 sources ⇒ first step must be `concat`;
 * `concat` is only valid as the first step of a multi-source mapping.
 */
export function chainType(sourceCount: number, steps: readonly Step[]): ChainCheck {
  if (sourceCount === 0 && steps[0]?.op !== 'default') {
    return { ok: false, stepIndex: steps.length ? 0 : null, message: 'A mapping with no source fields must start with `default`.' };
  }
  if (sourceCount >= 2 && steps[0]?.op !== 'concat') {
    return { ok: false, stepIndex: steps.length ? 0 : null, message: 'A mapping with several source fields must start with `concat`.' };
  }
  let type: ChainType = sourceCount >= 2 ? 'string[]' : 'string';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const spec = OP_SPECS[step.op];
    if (step.op === 'concat' && (i !== 0 || sourceCount < 2)) {
      return { ok: false, stepIndex: i, message: '`concat` must be the first step of a multi-source mapping.' };
    }
    if (spec.in === 'string' && type !== 'string') {
      return { ok: false, stepIndex: i, message: `\`${step.op}\` needs a string input but receives ${type}.` };
    }
    if (spec.in === 'string[]' && type !== 'string[]') {
      return { ok: false, stepIndex: i, message: `\`${step.op}\` needs several source values but receives ${type}.` };
    }
    if (spec.in === 'any' && type === 'string[]') {
      return { ok: false, stepIndex: i, message: `\`${step.op}\` cannot take several source values; start with \`concat\`.` };
    }
    type = spec.out === 'same' ? type : spec.out;
  }
  if (type === 'string[]') {
    return { ok: false, stepIndex: null, message: 'Several source values must be combined with `concat`.' };
  }
  return { ok: true, type };
}
