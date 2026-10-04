// End-to-end lifecycle through the HTTP API (no LLM): the executable specification of the core requirements.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDataset } from '../../src/dataset/load.ts';
import { openDb, type Db } from '../../src/db/connection.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { LogBuffer, createLogger } from '../../src/logger.ts';
import { workbenchRoutes } from '../../src/routes/workbench.ts';

type Json = Record<string, any>;

function makeApp() {
  const dataset = loadDataset();
  const logBuffer = new LogBuffer(2000);
  const logger = createLogger({ level: 'silent', buffer: logBuffer, stdout: false });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0) + 1000 * tick++).toISOString();
  const db = openDb(':memory:', { dataset, now });
  const config = loadConfig({ LOG_TO_STDOUT: 'false', ALLOW_FAULT_INJECTION: 'true' });
  const app = createApp({ db, config, logger, logBuffer, dataset, now }, [workbenchRoutes]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  return { app, db, dataset, call };
}

const targetRows = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM tgt_accounts').get() as { n: number }).n;
const duplicateRefs = (db: Db) =>
  (db.prepare('SELECT COUNT(*) AS n FROM (SELECT external_ref FROM tgt_accounts GROUP BY external_ref HAVING COUNT(*) > 1)').get() as { n: number }).n;

describe('migration lifecycle via the HTTP API', () => {
  const h = makeApp();
  let approvedVersion = 0;

  it('serves inputs, profiles, gaps and the transform catalog', async () => {
    const { status, body } = await h.call('GET', '/api/migration');
    expect(status).toBe(200);
    expect(body.source.name).toBe('legacy_customers');
    expect(body.target.name).toBe('accounts');
    expect(body.limits).toEqual({ records: 200, maxSampleSize: 500 });
    expect(body.gaps.requiredTargetWithoutSource.map((g: Json) => g.target)).toEqual(['country']);
    expect(body.catalog.ops.length).toBe(14);
  });

  it('creates a heuristic draft that cannot be approved until clarifications are answered', async () => {
    const created = await h.call('POST', '/api/plans/heuristic', { actor: 'alice' });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);
    const v1 = await h.call('GET', '/api/plans/1');
    expect(v1.body.plan.clarifications.some((c: Json) => c.trigger === 'required_target_unmapped' && c.field === 'country')).toBe(true);
    const approve = await h.call('POST', '/api/plans/1/approve', { reviewer: 'alice' });
    expect(approve.status).toBe(422);
    expect(approve.body.error.code).toBe('PLAN_NOT_APPROVABLE');
  });

  it('answers every clarification with deterministic patches (no LLM) and produces new versions', async () => {
    let version = 1;
    for (let guard = 0; guard < 10; guard++) {
      const v = await h.call('GET', `/api/plans/${version}`);
      const open = v.body.plan.clarifications.find((c: Json) => c.resolution === null);
      if (!open) break;
      const answer = await h.call('POST', `/api/plans/${version}/clarifications/${open.id}`, { choice: 0, actor: 'alice' });
      expect(answer.status).toBe(201);
      expect(answer.body.version).toBe(version + 1);
      version = answer.body.version;
    }
    const latest = await h.call('GET', `/api/plans/${version}`);
    expect(latest.body.plan.mappings.find((m: Json) => m.target === 'country').steps[0]).toEqual({ op: 'default', params: { value: 'US' } });
    expect(latest.body.approvalIssues).toEqual([]);
    expect(latest.body.diff.from).toBe(version - 1);
    approvedVersion = version;
  });

  it('refuses execution before approval and before a dry run', async () => {
    const exec = await h.call('POST', '/api/runs/execute', { version: approvedVersion });
    expect(exec.status).toBe(409);
    expect(exec.body.error.code).toBe('NOT_APPROVED');
    const approve = await h.call('POST', `/api/plans/${approvedVersion}/approve`, { reviewer: 'alice', comment: 'looks right' });
    expect(approve.status).toBe(200);
    expect(approve.body.approval.decision).toBe('approved');
    const again = await h.call('POST', `/api/plans/${approvedVersion}/reject`, { reviewer: 'bob' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
    const noDry = await h.call('POST', '/api/runs/execute', { version: approvedVersion });
    expect(noDry.status).toBe(409);
    expect(noDry.body.error.code).toBe('DRY_RUN_REQUIRED');
  });

  it('dry run partitions records, keeps evidence, and is deterministic across reruns', async () => {
    const first = await h.call('POST', '/api/runs/dry-run', { version: approvedVersion });
    expect(first.status).toBe(201);
    const c = first.body.counts;
    expect(c.source).toBe(200);
    expect(c.source).toBe(c.transformFailed + c.transformed);
    expect(c.transformed).toBe(c.accepted + c.validationRejected);
    expect(c.rejected).toBe(c.transformFailed + c.validationRejected);
    expect(c.byCode.DUPLICATE_TARGET_KEY).toBe(4);
    expect(first.body.conflictPreflight).toEqual(['C-90001', 'C-90002', 'C-90003']);
    expect(first.body.deterministicMatch).toBeNull();
    const second = await h.call('POST', '/api/runs/dry-run', { version: approvedVersion });
    expect(second.body.resultHash).toBe(first.body.resultHash);
    expect(second.body.deterministicMatch).toBe(true);
    const rejected = await h.call('GET', `/api/runs/${first.body.run.id}/records?outcome=transform_failed&limit=200`);
    expect(rejected.body.total).toBe(c.transformFailed);
    const ev = rejected.body.items[0].errors[0];
    expect(ev).toMatchObject({ stage: 'transform' });
    expect(Object.keys(ev.rawValues).length).toBeGreaterThan(0);
  });

  it('a simulated failure leaves a partial, INCOMPLETE load; retry finishes it without duplicates', async () => {
    const before = targetRows(h.db);
    const failed = await h.call('POST', '/api/runs/execute', { version: approvedVersion, failAfter: 75 });
    expect(failed.status).toBe(201);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.errorCode).toBe('FAULT_INJECTED');
    expect(failed.body.counts.processed).toBe(50); // batch 2 rolled back atomically
    expect(targetRows(h.db)).toBe(before + failed.body.counts.inserted);
    const rec1 = await h.call('GET', '/api/reconciliation');
    expect(rec1.body.verdict).toBe('INCOMPLETE');

    const retried = await h.call('POST', `/api/runs/${failed.body.id}/retry`, {});
    expect(retried.status).toBe(201);
    expect(retried.body.status).toBe('succeeded');
    expect(retried.body.attempt).toBe(2);
    expect(retried.body.counts.skippedExisting).toBe(failed.body.counts.inserted);
    expect(retried.body.counts.conflict).toBe(3);
    expect(duplicateRefs(h.db)).toBe(0);
    const rec2 = await h.call('GET', '/api/reconciliation');
    expect(rec2.body.verdict).toBe('MATCHED');
    expect(rec2.body.equations.every((e: Json) => e.holds)).toBe(true);
    expect(rec2.body.totals.targetTotal).toBe(5 + rec2.body.totals.loadedActive);

    const twice = await h.call('POST', `/api/runs/${failed.body.id}/retry`, {});
    expect(twice.status).toBe(409);
  });

  it('re-executing the same approved version inserts nothing new', async () => {
    const rows = targetRows(h.db);
    const again = await h.call('POST', '/api/runs/execute', { version: approvedVersion });
    expect(again.body.status).toBe('succeeded');
    expect(again.body.counts.inserted).toBe(0);
    expect(targetRows(h.db)).toBe(rows);
  });

  it('rollback removes only this workspace’s rows and reconciles as ROLLED_BACK_CLEAN', async () => {
    const rb = await h.call('POST', '/api/rollback', { actor: 'alice', reason: 'test' });
    expect(rb.status).toBe(201);
    expect(targetRows(h.db)).toBe(5);
    const rec = await h.call('GET', '/api/reconciliation');
    expect(rec.body.verdict).toBe('ROLLED_BACK_CLEAN');
    expect(rec.body.preExistingIntact).toBe(true);
    const nothing = await h.call('POST', '/api/rollback', {});
    expect(nothing.status).toBe(409);
    expect(nothing.body.error.code).toBe('NOTHING_TO_ROLL_BACK');
    const reexec = await h.call('POST', '/api/runs/execute', { version: approvedVersion });
    expect(reexec.body.status).toBe('succeeded');
    expect((await h.call('GET', '/api/reconciliation')).body.verdict).toBe('MATCHED');
  });

  it('a different version cannot execute while rows from another version are loaded', async () => {
    const v = await h.call('GET', `/api/plans/${approvedVersion}`);
    const plan = { ...v.body.plan, errorBudgetPct: 40 };
    const edited = await h.call('POST', '/api/plans', { parentVersion: approvedVersion, plan, changeNote: 'raise budget', actor: 'bob' });
    expect(edited.status).toBe(201);
    const nv = edited.body.version;
    expect((await h.call('POST', '/api/runs/execute', { version: nv })).body.error.code).toBe('NOT_APPROVED');
    await h.call('POST', `/api/plans/${nv}/approve`, { reviewer: 'bob' });
    await h.call('POST', '/api/runs/dry-run', { version: nv });
    const blocked = await h.call('POST', '/api/runs/execute', { version: nv });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ROLLBACK_REQUIRED');
  });

  it('preserves approval, execution, retry and rollback history', async () => {
    const { body } = await h.call('GET', '/api/events?limit=500');
    const types = new Set(body.items.map((e: Json) => e.type));
    for (const t of [
      'plan_version_created',
      'clarification_answered',
      'plan_approved',
      'dry_run_completed',
      'execution_started',
      'execution_failed',
      'execution_retried',
      'execution_completed',
      'rollback_completed',
    ]) {
      expect(types, t).toContain(t);
    }
  });

  it('a new workspace rolls back loaded rows but keeps all history', async () => {
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    const res = await h.call('POST', '/api/workspaces', { actor: 'carol' });
    expect(res.status).toBe(201);
    expect(res.body.rolledBack).toBeGreaterThan(0);
    expect(targetRows(h.db)).toBe(5);
    const after = (h.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    expect(after).toBeGreaterThan(before);
    const plans = await h.call('GET', '/api/plans');
    expect(plans.body.items).toEqual([]);
    const all = await h.call('GET', '/api/events?scope=all&limit=500');
    expect(all.body.items.length).toBe(after);
  });
});

describe('gold plan reference numbers (documented in README)', () => {
  let h: ReturnType<typeof makeApp>;
  beforeAll(() => {
    h = makeApp();
  });

  it('produces the documented dry-run partition and load outcome', async () => {
    const { createVersion, decide } = await import('../../src/services/plans.ts');
    const deps = { db: h.db, dataset: h.dataset, now: () => '2026-10-03T12:00:00.000Z' } as never;
    const v = createVersion(deps, { migrationId: 1, plan: h.dataset.goldPlan, author: 'user', actor: 'test', parentVersion: null, changeNote: 'gold' });
    const dr = await h.call('POST', '/api/runs/dry-run', { version: v.version });
    expect(dr.body.counts).toMatchObject({ source: 200, accepted: 164, rejected: 36 });
    decide({ ...(deps as object), dataset: h.dataset } as never, 1, v.version, 'approved', 'test', '');
    const ex = await h.call('POST', '/api/runs/execute', { version: v.version });
    expect(ex.body.counts).toMatchObject({ accepted: 164, inserted: 161, conflict: 3, skippedExisting: 0, pending: 0 });
    expect(targetRows(h.db)).toBe(166);
  });
});
