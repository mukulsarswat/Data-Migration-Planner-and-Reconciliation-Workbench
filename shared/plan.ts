// Migration plan contract. Stored plans are immutable, versioned and hashed (see shared/canonical.ts).
import { z } from 'zod';
import { StepSchema } from './dsl.ts';

export const ORIGINS = ['agent', 'heuristic', 'human'] as const;
export const CONFIDENCE = ['high', 'medium', 'low'] as const;

export const FieldMappingSchema = z
  .object({
    /** Target field name. */
    target: z.string().min(1),
    /** Source field names (0 = constant via `default`, ≥2 = must start with `concat`). */
    sources: z.array(z.string().min(1)),
    steps: z.array(StepSchema),
    origin: z.enum(ORIGINS),
    confidence: z.enum(CONFIDENCE),
    rationale: z.string().max(600),
  })
  .strict();
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const IgnoredFieldSchema = z
  .object({ source: z.string().min(1), reason: z.string().max(300) })
  .strict();
export type IgnoredField = z.infer<typeof IgnoredFieldSchema>;

/** A deterministic plan edit attached to a clarification option. Applying it never calls the LLM. */
export const PlanPatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_mapping'), mapping: FieldMappingSchema }).strict(),
  z.object({ kind: z.literal('ignore_source'), source: z.string(), reason: z.string() }).strict(),
  z.object({ kind: z.literal('no_change') }).strict(),
]);
export type PlanPatch = z.infer<typeof PlanPatchSchema>;

export const TRIGGERS = [
  'required_target_unmapped',
  'unmapped_enum_values',
  'ambiguous_date_format',
  'empty_required_values',
  'lossy_cast',
  'low_margin_candidate',
  'agent_question',
] as const;
export type TriggerKind = (typeof TRIGGERS)[number];

export const ClarificationSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().max(400),
    /** blocking: approval impossible until answered (it changes what is loaded). advisory: may be dismissed. */
    impact: z.enum(['blocking', 'advisory']),
    trigger: z.enum(TRIGGERS),
    field: z.string().nullable(),
    options: z.array(z.object({ label: z.string().max(160), patch: PlanPatchSchema }).strict()),
    resolution: z
      .object({
        choice: z.union([z.number().int().min(0), z.literal('dismissed')]),
        by: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Clarification = z.infer<typeof ClarificationSchema>;

export const RiskSchema = z
  .object({
    severity: z.enum(['high', 'medium', 'low']),
    field: z.string().nullable(),
    description: z.string().max(400),
  })
  .strict();
export type Risk = z.infer<typeof RiskSchema>;

export const DEFAULT_ERROR_BUDGET_PCT = 30;
export const MAX_ERROR_BUDGET_PCT = 50;

export const MigrationPlanSchema = z
  .object({
    mappings: z.array(FieldMappingSchema),
    ignored: z.array(IgnoredFieldSchema),
    clarifications: z.array(ClarificationSchema),
    risks: z.array(RiskSchema),
    summary: z.string().max(1200),
    /** Server/human-owned execution gate: max dry-run reject rate (rejected/source, %). Never set by the agent. */
    errorBudgetPct: z.number().int().min(0).max(MAX_ERROR_BUDGET_PCT),
  })
  .strict();
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

/** Field-level gap analysis ("incompatible or missing fields"), computed deterministically on the server. */
export const FieldGapsSchema = z
  .object({
    sourceWithoutTarget: z.array(z.object({ source: z.string(), reason: z.string() }).strict()),
    requiredTargetWithoutSource: z.array(z.object({ target: z.string(), reason: z.string() }).strict()),
    typeIncompatible: z.array(
      z
        .object({
          source: z.string(),
          target: z.string(),
          sourceType: z.string(),
          targetType: z.string(),
          note: z.string(),
          suggestedSteps: z.array(StepSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type FieldGaps = z.infer<typeof FieldGapsSchema>;

/** Static-validation issue (blocks approval when severity = 'blocker'). */
export type PlanIssue = {
  severity: 'blocker' | 'warning';
  code:
    | 'UNKNOWN_TARGET'
    | 'UNKNOWN_SOURCE'
    | 'DUPLICATE_TARGET_MAPPING'
    | 'TYPE_CHAIN'
    | 'TARGET_TYPE_MISMATCH'
    | 'REQUIRED_TARGET_UNMAPPED'
    | 'SOURCE_NOT_ACCOUNTED'
    | 'SOURCE_BOTH_MAPPED_AND_IGNORED'
    | 'UNRESOLVED_CLARIFICATION'
    | 'MISSING_REVIEWER';
  field: string | null;
  message: string;
};
