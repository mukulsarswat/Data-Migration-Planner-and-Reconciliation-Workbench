// Agent-wire submissions used by scripted-LLM tests (the shape the strict submit tool accepts).
import type { MigrationPlan } from '../../../shared/plan.ts';

/** Convert a stored plan (e.g. gold-plan.json) to the agent submission wire format. */
export function toSubmission(plan: MigrationPlan, extra: Record<string, unknown> = {}) {
  return {
    mappings: plan.mappings.map((m) => ({
      target: m.target,
      sources: m.sources,
      steps: m.steps.map((s) =>
        s.op === 'map_values' ? { op: s.op, params: { pairs: s.params.pairs, fallback: s.params.fallback ?? '' } } : s,
      ),
      confidence: m.confidence,
      rationale: m.rationale,
    })),
    ignored: plan.ignored,
    no_match_targets: [],
    risks: [{ severity: 'medium', field: 'signup_dt', description: 'Slash dates may be day-first for a few rows.' }],
    questions: [{ field: 'country', question: 'Are all legacy customers US accounts?' }],
    summary: 'Map legacy customers to accounts; quarantine malformed rows.',
    ...extra,
  };
}

export const DISCOVERY_CALLS = [
  ['t1', 'get_source_schema', {}],
  ['t2', 'get_target_schema', {}],
  ['t3', 'profile_source_fields', { fields: [] }],
  ['t4', 'get_field_gaps', {}],
  ['t5', 'list_supported_transforms', {}],
] as const;
