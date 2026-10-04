import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDataset } from '../../src/dataset/load.ts';
import { openDb } from '../../src/db/connection.ts';
import type { Db } from '../../src/db/connection.ts';
import { targetTableDdl, targetTableName } from '../../src/db/targetDdl.ts';
import { bootRecover } from '../../src/db/boot.ts';
import { toTargetRow } from '../../../shared/targetRow.ts';
import type { TransformedRow } from '../../../shared/evidence.ts';

const dataset = loadDataset();
const NOW = '2026-10-03T12:00:00.000Z';
const now = () => NOW;

const count = (db: Db, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).pluck().get(...params) as number);

/** Insert minimal parent rows so FK-bound tables can be exercised. */
function insertPlanVersion(db: Db, version = 1): number {
  return Number(
    db
      .prepare(
        `INSERT INTO plan_versions (migration_id, version, author, actor, plan_json, plan_hash, created_at)
         VALUES (1, ?, 'user', 'tester', '{}', 'h', ?)`,
      )
      .run(version, NOW).lastInsertRowid,
  );
}
function insertRun(db: Db, status: string, kind = 'execute'): number {
  return Number(
    db
      .prepare(`INSERT INTO runs (migration_id, kind, status, started_at) VALUES (1, ?, ?, ?)`)
      .run(kind, status, NOW).lastInsertRowid,
  );
}
function insertAgentRun(db: Db, status: string): number {
  return Number(
    db
      .prepare(`INSERT INTO agent_runs (migration_id, status, mode, model, created_at) VALUES (1, ?, 'scripted', 'm', ?)`)
      .run(status, NOW).lastInsertRowid,
  );
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-db-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('targetTableDdl', () => {
  it('names the mock target table tgt_<name>', () => {
    expect(targetTableName(dataset.target)).toBe('tgt_accounts');
  });

  it('generates columns in schema order with lineage column and index', () => {
    const ddl = targetTableDdl(dataset.target);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS tgt_accounts \(\s*id INTEGER PRIMARY KEY,/);
    const cols = dataset.target.fields.map((f) => ddl.indexOf(`\n  ${f.name} `));
    expect(cols.every((i) => i > 0)).toBe(true);
    expect([...cols].sort((a, b) => a - b)).toEqual(cols);
    expect(ddl).toMatch(/_load_run_id INTEGER\s*\)/);
    expect(ddl).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON tgt_accounts \(_load_run_id\)/);
  });

  it('escapes single quotes in patterns and enum values', () => {
    const ddl = targetTableDdl({
      name: 't',
      description: '',
      keyField: 'k',
      fields: [
        { name: 'k', type: 'string', required: true, unique: true, pattern: "^it's$", enum: ["o'k"], description: '' },
      ],
    });
    expect(ddl).toContain(`k REGEXP '^it''s$'`);
    expect(ddl).toContain(`IN ('o''k')`);
  });
});

describe('openDb', () => {
  it('applies pragmas (WAL for files) and registers a deterministic REGEXP', () => {
    const db = openDb(path.join(tmpDir, 'nested', 'w.db'), { dataset, now });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.prepare(`SELECT 'C-12345' REGEXP '^C-[0-9]{5}$'`).pluck().get()).toBe(1);
    expect(db.prepare(`SELECT 'nope' REGEXP '^C-[0-9]{5}$'`).pluck().get()).toBe(0);
    expect(db.prepare(`SELECT NULL REGEXP '^C'`).pluck().get()).toBeNull();
    db.close();
  });

  it('seeds idempotently: reopening the same file does not duplicate anything', () => {
    const file = path.join(tmpDir, 'w.db');
    openDb(file, { dataset, now }).close();
    const db = openDb(file, { dataset, now });
    expect(count(db, 'SELECT COUNT(*) FROM src_legacy_customers')).toBe(200);
    expect(count(db, 'SELECT COUNT(*) FROM tgt_accounts')).toBe(5);
    expect(count(db, 'SELECT COUNT(*) FROM tgt_accounts WHERE _load_run_id IS NOT NULL')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) FROM migrations')).toBe(1);
    expect(db.prepare('SELECT name, is_current, created_at FROM migrations').get()).toEqual({
      name: 'Workspace 1',
      is_current: 1,
      created_at: NOW,
    });
    expect(count(db, `SELECT COUNT(*) FROM events WHERE type = 'workspace_created'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) FROM events WHERE type = 'target_seeded'`)).toBe(1);
    db.close();
  });

  it('stores source rows in order with a canonical sha256 row hash', () => {
    const db = openDb(':memory:', { dataset, now });
    const first = db.prepare('SELECT * FROM src_legacy_customers WHERE row_no = 1').get() as Record<string, unknown>;
    expect(first.source_key).toBe('r0001');
    expect(JSON.parse(first.payload as string)).toEqual(dataset.records[0]!.values);
    expect(first.row_hash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it('does not re-seed the target once the load ledger has rows', () => {
    const file = path.join(tmpDir, 'w.db');
    const db = openDb(file, { dataset, now });
    const pv = insertPlanVersion(db);
    const run = insertRun(db, 'succeeded');
    db.prepare(
      `INSERT INTO load_ledger (migration_id, plan_version_id, source_key, target_id, external_ref, run_id, row_hash, inserted_at, rolled_back_at)
       VALUES (1, ?, 'r0001', 99, 'C-10041', ?, 'h', ?, ?)`,
    ).run(pv, run, NOW, NOW);
    db.prepare('DELETE FROM tgt_accounts').run();
    db.close();
    const reopened = openDb(file, { dataset, now });
    expect(count(reopened, 'SELECT COUNT(*) FROM tgt_accounts')).toBe(0);
    reopened.close();
  });
});

describe('append-only tables', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:', { dataset, now });
  });
  afterEach(() => db.close());

  it('events reject UPDATE and DELETE', () => {
    expect(() => db.prepare(`UPDATE events SET type = 'x'`).run()).toThrow('events are append-only');
    expect(() => db.prepare('DELETE FROM events').run()).toThrow('events are append-only');
  });

  it('plan_versions reject UPDATE and DELETE', () => {
    insertPlanVersion(db);
    expect(() => db.prepare(`UPDATE plan_versions SET change_note = 'x'`).run()).toThrow('plan versions are immutable');
    expect(() => db.prepare('DELETE FROM plan_versions').run()).toThrow('plan versions are immutable');
  });

  it('approvals reject UPDATE and DELETE and allow one decision per plan version', () => {
    const pv = insertPlanVersion(db);
    const insert = db.prepare(
      `INSERT INTO approvals (plan_version_id, plan_hash, decision, reviewer, created_at) VALUES (?, 'h', ?, 'rev', ?)`,
    );
    insert.run(pv, 'approved', NOW);
    expect(() => db.prepare(`UPDATE approvals SET decision = 'rejected'`).run()).toThrow(
      'approval decisions are immutable',
    );
    expect(() => db.prepare('DELETE FROM approvals').run()).toThrow('approval decisions are immutable');
    expect(() => insert.run(pv, 'rejected', NOW)).toThrow(/UNIQUE constraint failed: approvals.plan_version_id/);
  });
});

describe('partial unique indexes', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:', { dataset, now });
  });
  afterEach(() => db.close());

  it('ux_runs_one_running: one running run per migration', () => {
    insertRun(db, 'running');
    expect(() => insertRun(db, 'running', 'rollback')).toThrow(/UNIQUE constraint failed: runs.migration_id/);
    expect(() => insertRun(db, 'succeeded')).not.toThrow();
    expect(() => insertRun(db, 'failed')).not.toThrow();
  });

  it('ux_ledger_active: one active ledger row per (migration, source_key)', () => {
    const pv = insertPlanVersion(db);
    const run = insertRun(db, 'succeeded');
    const insert = db.prepare(
      `INSERT INTO load_ledger (migration_id, plan_version_id, source_key, target_id, external_ref, run_id, row_hash, inserted_at)
       VALUES (1, ?, 'r0001', ?, 'C-10041', ?, 'h', ?)`,
    );
    const first = insert.run(pv, 100, run, NOW).lastInsertRowid;
    expect(() => insert.run(pv, 101, run, NOW)).toThrow(/UNIQUE constraint failed/);
    db.prepare('UPDATE load_ledger SET rolled_back_at = ? WHERE id = ?').run(NOW, first);
    expect(() => insert.run(pv, 102, run, NOW)).not.toThrow();
  });
});

describe('bootRecover', () => {
  it('marks running runs and queued/running agent runs interrupted on reopen, with events', () => {
    const file = path.join(tmpDir, 'w.db');
    const db = openDb(file, { dataset, now });
    const running = insertRun(db, 'running');
    const done = insertRun(db, 'succeeded');
    const queued = insertAgentRun(db, 'queued');
    const active = insertAgentRun(db, 'running');
    const failed = insertAgentRun(db, 'failed');
    db.close();

    const later = '2026-10-03T13:00:00.000Z';
    const reopened = openDb(file, { dataset, now: () => later });
    const run = reopened.prepare('SELECT status, error_code, error, finished_at FROM runs WHERE id = ?');
    expect(run.get(running)).toEqual({
      status: 'interrupted',
      error_code: 'INTERRUPTED',
      error: 'Interrupted by server restart',
      finished_at: later,
    });
    expect((run.get(done) as { status: string }).status).toBe('succeeded');
    const agent = reopened.prepare('SELECT status, error_code, error, finished_at FROM agent_runs WHERE id = ?');
    for (const id of [queued, active]) {
      expect(agent.get(id)).toEqual({
        status: 'interrupted',
        error_code: 'INTERRUPTED',
        error: 'Interrupted by server restart',
        finished_at: later,
      });
    }
    expect((agent.get(failed) as { status: string }).status).toBe('failed');
    expect(
      reopened.prepare(`SELECT run_id, migration_id, actor, created_at FROM events WHERE type = 'run_interrupted'`).all(),
    ).toEqual([{ run_id: running, migration_id: 1, actor: 'system', created_at: later }]);
    expect(
      reopened
        .prepare(`SELECT agent_run_id FROM events WHERE type = 'agent_run_interrupted' ORDER BY agent_run_id`)
        .pluck()
        .all(),
    ).toEqual([queued, active]);
    // Nothing left to recover on a second pass.
    expect(bootRecover(reopened, () => later)).toEqual({ runs: 0, agentRuns: 0 });
    reopened.close();
  });
});

describe('tgt_accounts constraints (generated from target-schema.json)', () => {
  let db: Db;
  const cols = dataset.target.fields.map((f) => f.name);
  const valid: TransformedRow = {
    external_ref: 'C-12345',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    phone_e164: '+15551234567',
    status: 'active',
    created_on: '2019-03-14',
    balance_cents: 123450,
    is_vip: false,
    country: 'US',
  };
  const insert = (row: TransformedRow) =>
    db
      .prepare(`INSERT INTO tgt_accounts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...toTargetRow(dataset.target, row));

  beforeEach(() => {
    db = openDb(':memory:', { dataset, now });
  });
  afterEach(() => db.close());

  it('accepts every target-seed row (seeded at boot) and a valid row', () => {
    expect(count(db, 'SELECT COUNT(*) FROM tgt_accounts')).toBe(dataset.targetSeed.length);
    expect(db.prepare('SELECT is_vip FROM tgt_accounts ORDER BY id').pluck().all()).toEqual(
      dataset.targetSeed.map((r) => (r.is_vip ? 1 : 0)),
    );
    expect(() => insert(valid)).not.toThrow();
  });

  it('REGEXP CHECKs let NULL through on nullable columns', () => {
    expect(() => insert({ ...valid, email: null, phone_e164: null })).not.toThrow();
  });

  it.each([
    ['bad external_ref pattern', { external_ref: 'c-12345' }],
    ['external_ref too long', { external_ref: 'C-123456' }],
    ['status not in enum', { status: 'actve' }],
    ['boolean outside 0/1', { is_vip: 2 }],
    ['non-existent calendar date', { created_on: '2019-02-30' }],
    ['date in another format', { created_on: '03/14/2019' }],
    ['country pattern/length', { country: 'usa' }],
    ['first_name over maxLength', { first_name: 'x'.repeat(51) }],
    ['email not lower case', { email: 'Jane@Example.com' }],
    ['phone not E.164', { phone_e164: '555-1234' }],
    ['integer column given a real', { balance_cents: 12.5 }],
    // (TEXT affinity coerces numbers to text before CHECKs run, so only the INTEGER direction is testable.)
    ['integer column given text', { balance_cents: 'abc' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => insert({ ...valid, ...patch })).toThrow(/CHECK constraint failed/);
  });

  it('rejects NULL in a required column', () => {
    expect(() => insert({ ...valid, first_name: null })).toThrow(/NOT NULL constraint failed: tgt_accounts.first_name/);
  });

  it('enforces UNIQUE on the business key', () => {
    insert(valid);
    expect(() => insert({ ...valid, first_name: 'Other' })).toThrow(/UNIQUE constraint failed: tgt_accounts.external_ref/);
  });
});
