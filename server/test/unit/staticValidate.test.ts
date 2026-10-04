import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceSchemaSchema, TargetSchemaSchema } from '../../../shared/schemas.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';
import type { Clarification, FieldMapping, MigrationPlan, PlanIssue } from '../../../shared/plan.ts';
import type { Step } from '../../../shared/dsl.ts';
import { validatePlanStatic } from '../../src/engine/staticValidate.ts';

const load = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../../src/dataset/${name}`, import.meta.url), 'utf8'));
const source = SourceSchemaSchema.parse(load('source-schema.json'));
const target = TargetSchemaSchema.parse(load('target-schema.json'));
/** A fresh, mutable copy of the gold plan for every test. */
const gold = (): MigrationPlan => MigrationPlanSchema.parse(load('gold-plan.json'));

const APPROVE = { forApproval: true, reviewer: 'alice' };

/** Apply a mutation to a fresh gold plan and validate it. */
function issuesAfter(mutate: (plan: MigrationPlan) => void, opts: Parameters<typeof validatePlanStatic>[3] = APPROVE): PlanIssue[] {
  const plan = gold();
  mutate(plan);
  return validatePlanStatic(plan, source, target, opts);
}

const mappingFor = (plan: MigrationPlan, field: string): FieldMapping => {
  const m = plan.mappings.find((x) => x.target === field);
  if (!m) throw new Error(`gold plan has no mapping for ${field}`);
  return m;
};

const mapping = (targetField: string, sources: string[], steps: Step[]): FieldMapping => ({
  target: targetField,
  sources,
  steps,
  origin: 'human',
  confidence: 'high',
  rationale: 'test',
});

const clarification = (resolution: Clarification['resolution']): Clarification => ({
  id: 'c1',
  question: 'Which country are legacy customers in?',
  impact: 'blocking',
  trigger: 'required_target_unmapped',
  field: 'country',
  options: [],
  resolution,
});

/** Expect exactly one issue with this code/severity/field and a message naming `named`. */
function expectSingle(issues: PlanIssue[], code: PlanIssue['code'], field: string | null, named: string[], severity: PlanIssue['severity'] = 'blocker') {
  expect(issues.map((i) => [i.severity, i.code, i.field])).toEqual([[severity, code, field]]);
  for (const s of named) expect(issues[0]?.message).toContain(s);
}

describe('validatePlanStatic', () => {
  it('passes the gold plan with zero issues (approval and draft modes)', () => {
    expect(validatePlanStatic(gold(), source, target, APPROVE)).toEqual([]);
    expect(validatePlanStatic(gold(), source, target)).toEqual([]);
  });

  it('UNKNOWN_TARGET: mapping to a field the target lacks', () => {
    const issues = issuesAfter((p) => p.mappings.push(mapping('nickname', ['full_name'], [{ op: 'trim', params: {} }])));
    expectSingle(issues, 'UNKNOWN_TARGET', 'nickname', ['"nickname"']);
  });

  describe('UNKNOWN_SOURCE', () => {
    it('mapping reads a source field that does not exist', () => {
      const issues = issuesAfter((p) => {
        const m = mappingFor(p, 'email');
        m.sources = ['email_addr', 'email_alt'];
        m.steps = [{ op: 'concat', params: { separator: '' } }, ...m.steps];
      });
      expectSingle(issues, 'UNKNOWN_SOURCE', 'email', ['"email_alt"', '"email"']);
    });

    it('ignored entry names a source field that does not exist', () => {
      const issues = issuesAfter((p) => p.ignored.push({ source: 'pager', reason: 'gone' }));
      expectSingle(issues, 'UNKNOWN_SOURCE', 'pager', ['"pager"']);
    });

    it('a misspelt source also leaves the real field unaccounted', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'email').sources = ['email_address'];
      });
      expect(issues.map((i) => [i.code, i.field])).toEqual([
        ['UNKNOWN_SOURCE', 'email'],
        ['SOURCE_NOT_ACCOUNTED', 'email_addr'],
      ]);
    });
  });

  it('DUPLICATE_TARGET_MAPPING: two mappings for the same target', () => {
    const issues = issuesAfter((p) => p.mappings.push(structuredClone(mappingFor(p, 'email'))));
    expectSingle(issues, 'DUPLICATE_TARGET_MAPPING', 'email', ['"email"']);
  });

  describe('TYPE_CHAIN', () => {
    it('concat with a single source', () => {
      const issues = issuesAfter((p) => {
        const m = mappingFor(p, 'external_ref');
        m.steps = [{ op: 'concat', params: { separator: ' ' } }, ...m.steps];
      });
      expectSingle(issues, 'TYPE_CHAIN', 'external_ref', ['"external_ref"', 'step 1', 'concat']);
    });

    it('0 sources without a leading default', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'country').steps = [{ op: 'uppercase', params: {} }];
      });
      expectSingle(issues, 'TYPE_CHAIN', 'country', ['"country"', 'default']);
    });

    it('0 sources with no steps at all (no step index)', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'country').steps = [];
      });
      expectSingle(issues, 'TYPE_CHAIN', 'country', ['"country"', 'default']);
      expect(issues[0]?.message).not.toContain('step 1');
    });

    it('several sources without concat', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'first_name').sources = ['full_name', 'email_addr'];
      });
      expectSingle(issues, 'TYPE_CHAIN', 'first_name', ['"first_name"', 'concat']);
    });

    it('a string op after a date-producing op reports the failing step', () => {
      const issues = issuesAfter((p) => {
        const m = mappingFor(p, 'created_on');
        m.steps = [...m.steps, { op: 'trim', params: {} }];
      });
      expectSingle(issues, 'TYPE_CHAIN', 'created_on', ['"created_on"', 'step 3', 'trim']);
    });
  });

  describe('TARGET_TYPE_MISMATCH', () => {
    it('parse_date into a string target', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'first_name').steps = [{ op: 'trim', params: {} }, { op: 'parse_date', params: { formats: ['yyyy-MM-dd'] } }];
      });
      expectSingle(issues, 'TARGET_TYPE_MISMATCH', 'first_name', ['"first_name"', 'date', 'string']);
    });

    it('a string chain into an integer target', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'balance_cents').steps = [{ op: 'trim', params: {} }];
      });
      expectSingle(issues, 'TARGET_TYPE_MISMATCH', 'balance_cents', ['"balance_cents"', 'integer']);
    });

    it("map_values to 'actve' (not in the target enum)", () => {
      const issues = issuesAfter((p) => {
        const step = mappingFor(p, 'status').steps.at(-1);
        if (step?.op !== 'map_values') throw new Error('expected map_values');
        step.params.pairs[0]!.to = 'actve';
      });
      expectSingle(issues, 'TARGET_TYPE_MISMATCH', 'status', ['"status"', '"actve"']);
    });

    it('map_values fallback outside the enum (a fallback inside it is fine)', () => {
      const withFallback = (fallback: string) =>
        issuesAfter((p) => {
          const step = mappingFor(p, 'status').steps.at(-1);
          if (step?.op !== 'map_values') throw new Error('expected map_values');
          step.params.fallback = fallback;
        });
      expectSingle(withFallback('unknown'), 'TARGET_TYPE_MISMATCH', 'status', ['"unknown"']);
      expect(withFallback('pending')).toEqual([]);
    });

    it('a final default that breaks the target pattern', () => {
      const issues = issuesAfter((p) => {
        mappingFor(p, 'country').steps = [{ op: 'default', params: { value: 'usa' } }];
      });
      expectSingle(issues, 'TARGET_TYPE_MISMATCH', 'country', ['"country"', '"usa"']);
    });

    it('a final default outside the target enum (an allowed value is fine)', () => {
      const withDefault = (value: string) =>
        issuesAfter((p) => {
          const m = mappingFor(p, 'status');
          m.steps = [...m.steps, { op: 'default', params: { value } }];
        });
      expectSingle(withDefault('archived'), 'TARGET_TYPE_MISMATCH', 'status', ['"archived"']);
      expect(withDefault('pending')).toEqual([]);
    });
  });

  it('REQUIRED_TARGET_UNMAPPED: removing the country mapping', () => {
    const issues = issuesAfter((p) => {
      p.mappings = p.mappings.filter((m) => m.target !== 'country');
    });
    expectSingle(issues, 'REQUIRED_TARGET_UNMAPPED', 'country', ['"country"']);
  });

  it('SOURCE_NOT_ACCOUNTED: dropping the fax ignore entry', () => {
    const issues = issuesAfter((p) => {
      p.ignored = p.ignored.filter((i) => i.source !== 'fax');
    });
    expectSingle(issues, 'SOURCE_NOT_ACCOUNTED', 'fax', ['"fax"']);
  });

  it('SOURCE_BOTH_MAPPED_AND_IGNORED is a warning, even for approval', () => {
    const issues = issuesAfter((p) => p.ignored.push({ source: 'email_addr', reason: 'dup' }));
    expectSingle(issues, 'SOURCE_BOTH_MAPPED_AND_IGNORED', 'email_addr', ['"email_addr"'], 'warning');
  });

  describe('UNRESOLVED_CLARIFICATION', () => {
    it('blocks approval', () => {
      const issues = issuesAfter((p) => p.clarifications.push(clarification(null)));
      expectSingle(issues, 'UNRESOLVED_CLARIFICATION', 'country', ['c1', 'Which country']);
    });

    it('is only a warning outside approval', () => {
      const issues = issuesAfter((p) => p.clarifications.push(clarification(null)), {});
      expectSingle(issues, 'UNRESOLVED_CLARIFICATION', 'country', ['c1'], 'warning');
    });

    it('answered or dismissed clarifications raise nothing', () => {
      expect(issuesAfter((p) => p.clarifications.push(clarification({ choice: 0, by: 'alice' })))).toEqual([]);
      expect(issuesAfter((p) => p.clarifications.push(clarification({ choice: 'dismissed', by: 'alice' })))).toEqual([]);
    });
  });

  describe('MISSING_REVIEWER', () => {
    it.each(['', '   ', undefined])('blocks approval when reviewer is %j', (reviewer) => {
      const issues = validatePlanStatic(gold(), source, target, { forApproval: true, reviewer });
      expectSingle(issues, 'MISSING_REVIEWER', null, ['reviewer']);
    });

    it('is not checked outside approval', () => {
      expect(validatePlanStatic(gold(), source, target, { reviewer: '' })).toEqual([]);
    });
  });

  it('sorts blockers first, then field (null first), then code — independent of plan order', () => {
    const mutate = (p: MigrationPlan) => {
      p.mappings = p.mappings.filter((m) => m.target !== 'country');
      p.ignored = [...p.ignored.filter((i) => i.source !== 'fax'), { source: 'email_addr', reason: 'dup' }];
      p.clarifications.push(clarification(null));
    };
    const expected = [
      ['blocker', 'MISSING_REVIEWER', null],
      ['blocker', 'REQUIRED_TARGET_UNMAPPED', 'country'],
      ['blocker', 'UNRESOLVED_CLARIFICATION', 'country'],
      ['blocker', 'SOURCE_NOT_ACCOUNTED', 'fax'],
      ['warning', 'SOURCE_BOTH_MAPPED_AND_IGNORED', 'email_addr'],
    ];
    const opts = { forApproval: true, reviewer: ' ' };
    const issues = issuesAfter(mutate, opts);
    expect(issues.map((i) => [i.severity, i.code, i.field])).toEqual(expected);

    const reversed = issuesAfter((p) => {
      mutate(p);
      p.mappings.reverse();
      p.ignored.reverse();
    }, opts);
    expect(reversed).toEqual(issues);
  });
});
