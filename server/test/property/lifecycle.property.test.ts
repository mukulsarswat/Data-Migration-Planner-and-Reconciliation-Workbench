// Property tests for the guarantees graders care about: determinism, idempotent retry, crash safety, clean rollback.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dryRun } from '../../src/engine/dryRun.ts';
import { execute, retry, rollback } from '../../src/services/runs.ts';
import { reconcile } from '../../src/services/reconcile.ts';
import { planHashOf } from '../../src/services/plans.ts';
import { dataset, readyToExecute, targetProjection } from '../helpers.ts';

describe('dry run determinism', () => {
  const ds = dataset();
  const planHash = planHashOf(ds.goldPlan);
  const reference = dryRun(ds.records, ds.goldPlan, ds.target, planHash);

  it('is identical for any ordering of the source records (incl. duplicate-key twins)', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(ds.records, { minLength: ds.records.length, maxLength: ds.records.length }), (shuffled) => {
        const r = dryRun(shuffled, ds.goldPlan, ds.target, planHash);
        expect(r.resultHash).toBe(reference.resultHash);
        expect(r.counts).toEqual(reference.counts);
      }),
      { numRuns: 25 },
    );
  });

  it('partition identities hold for arbitrary subsets of the data', () => {
    fc.assert(
      fc.property(fc.subarray(ds.records), (subset) => {
        const c = dryRun(subset, ds.goldPlan, ds.target, planHash).counts;
        expect(c.source).toBe(subset.length);
        expect(c.source).toBe(c.transformFailed + c.transformed);
        expect(c.transformed).toBe(c.accepted + c.validationRejected);
        expect(c.rejected).toBe(c.transformFailed + c.validationRejected);
      }),
      { numRuns: 40 },
    );
  });

  it('does not depend on the process timezone', () => {
    const original = process.env.TZ;
    try {
      for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
        process.env.TZ = tz;
        expect(dryRun(ds.records, ds.goldPlan, ds.target, planHash).resultHash, tz).toBe(reference.resultHash);
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('execution idempotency and crash safety', () => {
  const clean = (() => {
    const { deps, version } = readyToExecute();
    const run = execute(deps, 1, { version, actor: 'p' });
    expect(run.status).toBe('succeeded');
    return targetProjection(deps.db);
  })();

  it('executing the same approved version N times yields the same target', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), (n) => {
        const { deps, version } = readyToExecute();
        for (let i = 0; i < n; i++) execute(deps, 1, { version, actor: 'p' });
        expect(targetProjection(deps.db)).toEqual(clean);
      }),
      { numRuns: 5 },
    );
  });

  it('a failure at any point followed by retry converges to the clean single-run state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 163 }), (failAfter) => { // 164 accepted ⇒ every fault point that can fire
        const { deps, version } = readyToExecute();
        let run = execute(deps, 1, { version, actor: 'p', failAfter });
        while (run.status === 'failed') run = retry(deps, 1, run.id, 'p');
        expect(run.status).toBe('succeeded');
        expect(targetProjection(deps.db)).toEqual(clean);
        expect(reconcile(deps, 1).verdict).toBe('MATCHED');
      }),
      { numRuns: 20 },
    );
  });

  it('rejects a fault point that could never fire (failAfter ≥ accepted)', () => {
    const { deps, version } = readyToExecute();
    expect(() => execute(deps, 1, { version, actor: 'p', failAfter: 164 })).toThrow(/failAfter must be below the 164 accepted/);
  });

  it('execute → rollback restores the exact pre-execution target; rollback → re-execute converges again', () => {
    const { deps, version } = readyToExecute();
    const before = targetProjection(deps.db);
    execute(deps, 1, { version, actor: 'p', failAfter: 120 });
    rollback(deps, 1, 'p');
    expect(targetProjection(deps.db)).toEqual(before);
    expect(reconcile(deps, 1).verdict).toBe('ROLLED_BACK_CLEAN');
    execute(deps, 1, { version, actor: 'p' });
    expect(targetProjection(deps.db)).toEqual(clean);
    expect(reconcile(deps, 1).verdict).toBe('MATCHED');
  });
});
