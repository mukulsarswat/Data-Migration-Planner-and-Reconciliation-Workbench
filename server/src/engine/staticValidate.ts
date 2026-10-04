// Static (data-free) plan validation: the approve gate's structural checks (tasks/plan.md "Static validation").
// Refs exist, arity and op-chain types flow into the target type, required targets covered,
// every source mapped or ignored, clarifications answered, reviewer named.
import type { SourceSchema, TargetField, TargetSchema } from '../../../shared/schemas.ts';
import type { FieldMapping, MigrationPlan, PlanIssue } from '../../../shared/plan.ts';
import { chainType } from '../../../shared/dsl.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';

/**
 * Issue `field` is the mapping's target for mapping problems, the source name for source-accounting problems,
 * the clarification's field for clarifications, and null for MISSING_REVIEWER.
 * `forApproval` turns unresolved clarifications into blockers and requires a non-blank reviewer.
 */
export function validatePlanStatic(
  plan: MigrationPlan,
  source: SourceSchema,
  target: TargetSchema,
  opts: { forApproval?: boolean; reviewer?: string } = {},
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: PlanIssue['severity'], code: PlanIssue['code'], field: string | null, message: string) =>
    issues.push({ severity, code, field, message });
  const targetFields = new Map(target.fields.map((f) => [f.name, f]));
  const sourceNames = new Set(source.fields.map((f) => f.name));

  // Mappings: references, duplicates, chain typing.
  const mappingCount = new Map<string, number>();
  for (const m of plan.mappings) {
    mappingCount.set(m.target, (mappingCount.get(m.target) ?? 0) + 1);
    const tf = targetFields.get(m.target);
    if (!tf) add('blocker', 'UNKNOWN_TARGET', m.target, `Mapping targets "${m.target}", which is not a field of ${target.name}.`);
    for (const s of m.sources) {
      if (!sourceNames.has(s)) {
        add('blocker', 'UNKNOWN_SOURCE', m.target, `Mapping for "${m.target}" reads "${s}", which is not a field of ${source.name}.`);
      }
    }
    const chain = chainType(m.sources.length, m.steps);
    if (!chain.ok) {
      const at = chain.stepIndex === null ? '' : ` at step ${chain.stepIndex + 1} (\`${m.steps[chain.stepIndex]?.op}\`)`;
      add('blocker', 'TYPE_CHAIN', m.target, `Mapping for "${m.target}" is invalid${at}: ${chain.message}`);
      continue;
    }
    if (!tf) continue;
    if (chain.type !== tf.type) {
      add('blocker', 'TARGET_TYPE_MISMATCH', m.target, `Mapping for "${m.target}" produces ${chain.type} but the target field is ${tf.type}.`);
      continue;
    }
    const problem = finalConstantProblem(m, tf);
    if (problem) add('blocker', 'TARGET_TYPE_MISMATCH', m.target, problem);
  }
  for (const [name, count] of mappingCount) {
    if (count > 1) add('blocker', 'DUPLICATE_TARGET_MAPPING', name, `"${name}" has ${count} mappings; keep exactly one.`);
  }
  for (const f of target.fields) {
    if (f.required && !mappingCount.has(f.name)) {
      add('blocker', 'REQUIRED_TARGET_UNMAPPED', f.name, `Required target field "${f.name}" has no mapping; map a source or supply a constant with \`default\`.`);
    }
  }

  // Source accounting: every source field is mapped or explicitly ignored.
  const used = new Set(plan.mappings.flatMap((m) => m.sources));
  const ignored = new Set(plan.ignored.map((i) => i.source));
  for (const i of plan.ignored) {
    if (!sourceNames.has(i.source)) add('blocker', 'UNKNOWN_SOURCE', i.source, `Ignored field "${i.source}" is not a field of ${source.name}.`);
  }
  for (const { name } of source.fields) {
    if (!used.has(name) && !ignored.has(name)) {
      add('blocker', 'SOURCE_NOT_ACCOUNTED', name, `Source field "${name}" is neither mapped nor ignored; map it or ignore it with a reason.`);
    } else if (used.has(name) && ignored.has(name)) {
      add('warning', 'SOURCE_BOTH_MAPPED_AND_IGNORED', name, `Source field "${name}" is both mapped and listed as ignored.`);
    }
  }

  // Human gates.
  for (const c of plan.clarifications) {
    if (c.resolution === null) {
      add(opts.forApproval ? 'blocker' : 'warning', 'UNRESOLVED_CLARIFICATION', c.field, `Clarification ${c.id} is unanswered: ${c.question}`);
    }
  }
  if (opts.forApproval && !opts.reviewer?.trim()) add('blocker', 'MISSING_REVIEWER', null, 'Approval needs a named reviewer.');

  return issues.sort(compareIssues);
}

/** Ops that keep a constant recognisable: we can still compute what it becomes. */
const PRESERVING = new Set(['copy', 'trim', 'lowercase', 'uppercase', 'null_if_empty', 'default']);

function applyPreserving(op: string, v: string): string {
  if (op === 'trim') return v.trim();
  if (op === 'lowercase') return v.toLowerCase();
  if (op === 'uppercase') return v.toUpperCase();
  return v;
}

/**
 * Constants a mapping can emit that the target can never accept: the outputs of its last map_values (pairs' `to`
 * values and a non-null fallback) and every default value, carried forward through value-preserving string ops
 * (copy/trim/case/null_if_empty/default). Any other later op makes the value unknowable, so it is not checked.
 */
function finalConstantProblem(m: FieldMapping, tf: TargetField): string | null {
  const constants: { value: string; via: 'map' | 'default' }[] = [];
  m.steps.forEach((step, i) => {
    if (step.op !== 'map_values' && step.op !== 'default') return;
    const rest = m.steps.slice(i + 1);
    if (!rest.every((s) => PRESERVING.has(s.op))) return;
    if (step.op === 'map_values' && rest.some((s) => s.op === 'map_values')) return;
    const seeds =
      step.op === 'map_values'
        ? [...step.params.pairs.map((p) => p.to), ...(step.params.fallback !== null ? [step.params.fallback] : [])]
        : [step.params.value];
    for (const seed of seeds) {
      const value = rest.reduce((v, s) => applyPreserving(s.op, v), seed);
      constants.push({ value, via: step.op === 'map_values' ? 'map' : 'default' });
    }
  });
  const enumBad = tf.enum ? [...new Set(constants.filter((c) => !tf.enum!.includes(c.value)).map((c) => c.value))] : [];
  if (enumBad.length) {
    const shown = enumBad.map((v) => JSON.stringify(v)).join(', ');
    return `Mapping for "${m.target}" can produce ${shown}, not one of ${tf.enum!.join(', ')}.`;
  }
  if (tf.pattern !== undefined) {
    const re = new RegExp(tf.pattern);
    const bad = constants.find((c) => !re.test(c.value));
    if (bad) {
      return bad.via === 'default'
        ? `Mapping for "${m.target}" defaults to ${JSON.stringify(bad.value)}, which does not match ${tf.pattern}.`
        : `Mapping for "${m.target}" can produce ${JSON.stringify(bad.value)}, which does not match ${tf.pattern}.`;
    }
  }
  return null;
}

/** Blockers first, then field (null first), then code; message breaks remaining ties. */
function compareIssues(a: PlanIssue, b: PlanIssue): number {
  const rank = (i: PlanIssue) => (i.severity === 'blocker' ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    compareCodeUnits(a.field ?? '', b.field ?? '') ||
    compareCodeUnits(a.code, b.code) ||
    compareCodeUnits(a.message, b.message)
  );
}
