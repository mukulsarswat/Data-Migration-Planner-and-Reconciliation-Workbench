// Dataset schema contracts shared by server, agent tools and UI. Pure: no Node/DOM APIs.
import { z } from 'zod';

/** Value types produced by the transform DSL and declared by target fields. */
export const VALUE_TYPES = ['string', 'integer', 'boolean', 'date'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** A transformed cell value. Dates are 'YYYY-MM-DD' strings; money is integer cents. */
export type Value = string | number | boolean | null;

export const SourceFieldSchema = z.object({
  name: z.string().min(1),
  /** Legacy extracts are untyped text; every source field is a string. */
  type: z.literal('string'),
  description: z.string(),
  /** Personally identifiable: values are masked before they reach the LLM. */
  pii: z.boolean(),
});
export type SourceField = z.infer<typeof SourceFieldSchema>;

export const SourceSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Business key field in the legacy system (not guaranteed unique in dirty data). */
  keyField: z.string(),
  fields: z.array(SourceFieldSchema).min(1),
});
export type SourceSchema = z.infer<typeof SourceSchemaSchema>;

export const TargetFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(VALUE_TYPES),
  required: z.boolean(),
  unique: z.boolean(),
  maxLength: z.number().int().positive().optional(),
  /** ECMAScript regex source, anchored. Enforced by both the JS validator and the SQLite CHECK (REGEXP). */
  pattern: z.string().optional(),
  enum: z.array(z.string()).min(1).optional(),
  description: z.string(),
});
export type TargetField = z.infer<typeof TargetFieldSchema>;

export const TargetSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Unique business key; idempotent loads conflict on this column. */
  keyField: z.string(),
  fields: z.array(TargetFieldSchema).min(1),
});
export type TargetSchema = z.infer<typeof TargetSchemaSchema>;

/** One raw legacy row. `sourceKey` is a surrogate row id (r0001…), the legacy key stays inside `values`. */
export type SourceRecord = {
  sourceKey: string;
  values: Record<string, string>;
};

/** Documented bound for this assignment: one source, one target, at most this many records. */
export const MAX_SAMPLE_SIZE = 500;
