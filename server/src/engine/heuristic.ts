// Deterministic "heuristic draft" plan: the no-LLM path (agent failure, cap, missing key) and the e2e baseline.
// Best candidate per target + a fixed step recipe per target shape; questions come from the same triggers as agent plans.
import type { TargetField } from '../../../shared/schemas.ts';
import type { FieldMapping, MigrationPlan, Risk } from '../../../shared/plan.ts';
import { DEFAULT_ERROR_BUDGET_PCT } from '../../../shared/plan.ts';
import type { Step } from '../../../shared/dsl.ts';
import { bestCandidate, computeFieldGaps } from './gaps.ts';
import { computeClarifications } from './triggers.ts';
import type { AnalysisContext } from './triggers.ts';

const E164_PATTERN = /^\^\\\+/; // pattern source starting with ^\+
const NAME_PART = new Map<string, 'first' | 'last'>([
  ['firstname', 'first'],
  ['lastname', 'last'],
]);

export function buildHeuristicPlan(ctx: AnalysisContext): MigrationPlan {
  const gaps = computeFieldGaps(ctx.source, ctx.target, ctx.profiles);
  const mappings: FieldMapping[] = [];
  const weak: Risk[] = [];
  for (const t of ctx.target.fields) {
    const c = bestCandidate(t, ctx.source, ctx.profiles);
    if (!c) continue;
    const steps = gaps.typeIncompatible.find((g) => g.target === t.name)?.suggestedSteps ?? stringSteps(t, c.source);
    const confidence = c.score >= 0.9 ? 'high' : c.score >= 0.7 ? 'medium' : 'low';
    const rationale = `Best candidate ${c.source} (score ${c.score}): ${c.reasons.join('; ')}. Steps: ${steps.map((s) => s.op).join(' → ')}.`;
    mappings.push({ target: t.name, sources: [c.source], steps, origin: 'heuristic', confidence, rationale: rationale.slice(0, 600) });
    if (confidence === 'low') {
      weak.push({
        severity: 'medium',
        field: t.name,
        description: `Low-confidence match: ${t.name} ← ${c.source} (score ${c.score}); check the preview before approving.`,
      });
    }
  }

  const used = new Set(mappings.flatMap((m) => m.sources));
  const ignored = ctx.source.fields
    .filter((f) => !used.has(f.name))
    .map((f) => ({
      source: f.name,
      reason: (gaps.sourceWithoutTarget.find((g) => g.source === f.name)?.reason ?? `${f.name} is not used by any mapping.`).slice(0, 300),
    }));

  const clarifications = computeClarifications({ mappings, ignored }, ctx);
  const risks: Risk[] = [
    ...clarifications.map((c): Risk => ({ severity: c.impact === 'blocking' ? 'high' : 'medium', field: c.field, description: c.question })),
    ...weak,
  ];
  return { mappings, ignored, clarifications, risks, summary: summarize(ctx, mappings, ignored, clarifications), errorBudgetPct: DEFAULT_ERROR_BUDGET_PCT };
}

/**
 * Recipe for plain string targets: E.164 phone ⇒ normalize_phone; first/last name from a *name* field ⇒ split_full_name;
 * otherwise trim (+ null_if_empty when optional, + lowercase/uppercase when the pattern only allows that letter case).
 */
function stringSteps(t: TargetField, src: string): Step[] {
  const trim: Step = { op: 'trim', params: {} };
  if (t.pattern && E164_PATTERN.test(t.pattern)) {
    return [trim, { op: 'null_if_empty', params: {} }, { op: 'normalize_phone', params: { default_country: 'US' } }];
  }
  // Split only a combined full-name source: separate first/last columns are copied as-is.
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const part = NAME_PART.get(norm(t.name));
  if (part && !NAME_PART.has(norm(src)) && norm(src).includes('name')) return [trim, { op: 'split_full_name', params: { part } }];

  const steps: Step[] = [trim];
  if (!t.required) steps.push({ op: 'null_if_empty', params: {} });
  const letterCase = patternLetterCase(t.pattern);
  if (letterCase === 'lower') steps.push({ op: 'lowercase', params: {} });
  if (letterCase === 'upper') steps.push({ op: 'uppercase', params: {} });
  return steps;
}

/** 'lower' / 'upper' when every letter the pattern mentions (escapes like \d or \. removed) has that case, else null. */
function patternLetterCase(pattern: string | undefined): 'lower' | 'upper' | null {
  // A negated class ([^A-Z]) says which case is FORBIDDEN; don't infer a case conversion from it.
  if ((pattern ?? '').includes('[^')) return null;
  const letters = (pattern ?? '').replace(/\\./g, '').match(/[A-Za-z]/g) ?? [];
  if (letters.length === 0) return null;
  if (letters.every((l) => l >= 'a' && l <= 'z')) return 'lower';
  if (letters.every((l) => l >= 'A' && l <= 'Z')) return 'upper';
  return null;
}

function summarize(
  ctx: AnalysisContext,
  mappings: readonly FieldMapping[],
  ignored: readonly { source: string }[],
  clarifications: readonly { impact: string }[],
): string {
  const mapped = new Set(mappings.map((m) => m.target));
  const missing = ctx.target.fields.filter((f) => !mapped.has(f.name)).map((f) => f.name);
  const parts = [`Heuristic draft (no LLM): ${mappings.length} of ${ctx.target.fields.length} target fields are mapped from their best-scoring source field.`];
  const gaps = [
    ignored.length ? `ignored ${ignored.map((g) => g.source).join(', ')}` : '',
    missing.length ? `no source found for ${missing.join(', ')}` : '',
  ].filter((s) => s !== '');
  if (gaps.length) parts.push(`Gaps: ${gaps.join('; ')}.`);
  const blocking = clarifications.filter((c) => c.impact === 'blocking').length;
  parts.push(
    clarifications.length
      ? `${clarifications.length} clarification(s) need an answer before approval (${blocking} blocking).`
      : 'No clarifications were raised; review the mappings and run a dry run.',
  );
  return parts.join(' ').slice(0, 1200);
}
