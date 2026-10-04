// Adversarial verification of module D (platform): config, logger, errors, dataset loader, DB layer
// (target DDL, seed, boot recovery), Hono app, process entry, web shell and Docker packaging.
// Failing tests here are CONFIRMED defects against the module spec; see the report for details.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/config.ts';
import { LogBuffer, createLogger } from '../../src/logger.ts';
import type { LogEntry } from '../../src/logger.ts';
import { HttpError, badRequest, conflict } from '../../src/http/errors.ts';
import { createApp } from '../../src/app.ts';
import type { AppDeps, RouteRegistrar } from '../../src/app.ts';
import { openDb } from '../../src/db/connection.ts';
import type { Db } from '../../src/db/connection.ts';
import { targetTableDdl, targetTableName } from '../../src/db/targetDdl.ts';
import { bootRecover } from '../../src/db/boot.ts';
import { seed } from '../../src/db/seed.ts';
import { loadDataset } from '../../src/dataset/load.ts';
import type { Dataset } from '../../src/dataset/load.ts';
import { canonicalJson } from '../../../shared/canonical.ts';
import { toTargetRow } from '../../../shared/targetRow.ts';
import type { TargetSchema } from '../../../shared/schemas.ts';
import type { TransformedRow } from '../../../shared/evidence.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATASET_DIR = path.join(ROOT, 'server/src/dataset');
const DATASET_FILES = ['source-schema.json', 'target-schema.json', 'source-records.json', 'target-seed.json', 'gold-plan.json'];
const dataset = loadDataset();
const NOW = '2026-10-03T12:00:00.000Z';
const now = () => NOW;
const NO_STATIC = path.join(os.tmpdir(), 'mw-verify-no-static-dir');
const MIB = 1024 * 1024;

const tempDirs: string[] = [];
const opened: Db[] = [];
const tmpDir = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
});
afterAll(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const count = (db: Db, sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
type Envelope = { error: { code: string; message: string; details: unknown; requestId: string } };

function memDb(): Db {
  const db = openDb(':memory:', { dataset, now });
  opened.push(db);
  return db;
}

function makeApp(env: Record<string, string> = {}, registrars: readonly RouteRegistrar[] = []) {
  const config = loadConfig({ LOG_TO_STDOUT: 'false', STATIC_DIR: NO_STATIC, ...env });
  const logBuffer = new LogBuffer(1000);
  const logger = createLogger({ level: config.logLevel, buffer: logBuffer, stdout: false });
  const db = openDb(':memory:', { dataset, now, logger });
  opened.push(db);
  const deps: AppDeps = { db, config, logger, logBuffer, dataset, now };
  return { app: createApp(deps, registrars), deps };
}

/** Copy the shipped fixtures to a temp dir, overriding some files with the given JSON values. */
function datasetDir(overrides: Record<string, unknown>): string {
  const dir = tmpDir('mw-verify-ds-');
  for (const f of DATASET_FILES) fs.copyFileSync(path.join(DATASET_DIR, f), path.join(dir, f));
  for (const [f, v] of Object.entries(overrides)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  return dir;
}

// ---------------------------------------------------------------------------------------------
describe('config', () => {
  it('reads process.env when called without arguments', () => {
    const before = process.env.PORT;
    process.env.PORT = '9123';
    try {
      expect(loadConfig().port).toBe(9123);
    } finally {
      if (before === undefined) delete process.env.PORT;
      else process.env.PORT = before;
    }
  });

  it('accepts LOG_LEVEL=silent and a silent logger writes nothing (and does not throw)', () => {
    expect(loadConfig({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
    const buf = new LogBuffer(10);
    const log = createLogger({ level: 'silent', buffer: buf, stdout: false });
    log.fatal('nothing to see');
    expect(buf.query({})).toEqual([]);
  });

  it('basic auth requires both values (half-configured fails closed); an API key that is only unset stays null', () => {
    expect(() => loadConfig({ BASIC_AUTH_USER: 'u' })).toThrow();
    expect(() => loadConfig({ BASIC_AUTH_PASS: 'p' })).toThrow();
    expect(loadConfig({ ANTHROPIC_API_KEY: undefined }).anthropic.apiKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('logger', () => {
  const secretsOf = (obj: Record<string, unknown>) => {
    const buf = new LogBuffer(10);
    createLogger({ level: 'info', buffer: buf, stdout: false }).info(obj, 'probe');
    return JSON.stringify(buf.query({}));
  };

  it('redacts a top-level x-api-key field (like the other secret fields)', () => {
    const text = secretsOf({ 'x-api-key': 'sk-top-level-key' });
    expect(text).not.toContain('sk-top-level-key');
  });

  it('redacts secrets inside a request-shaped object (req.headers.authorization / x-api-key)', () => {
    const text = secretsOf({
      req: { headers: { authorization: 'Bearer tok-1', 'x-api-key': 'k-2' } },
      env: { ANTHROPIC_API_KEY: 'sk-env' },
    });
    for (const s of ['tok-1', 'k-2', 'sk-env']) expect(text).not.toContain(s);
    expect(text).toContain('[redacted]');
  });

  it('does not mutate the logged object while redacting', () => {
    const obj = { headers: { authorization: 'Basic abc' } };
    secretsOf(obj);
    expect(obj.headers.authorization).toBe('Basic abc');
  });

  it('filters the buffer by the logger level', () => {
    const buf = new LogBuffer(10);
    const log = createLogger({ level: 'warn', buffer: buf, stdout: false });
    log.info('dropped');
    log.warn('kept');
    expect(buf.query({}).map((e) => e.msg)).toEqual(['kept']);
  });

  it('LogBuffer(1) keeps only the newest entry; combined filters apply before limit', () => {
    const one = new LogBuffer(1);
    one.push({ level: 30, time: 1, msg: 'a' });
    one.push({ level: 30, time: 2, msg: 'b' });
    expect(one.query({}).map((e) => e.msg)).toEqual(['b']);

    const buf = new LogBuffer(10);
    const e = (level: number, requestId: string, msg: string): LogEntry => ({ level, time: 0, requestId, msg });
    buf.push(e(50, 'x', 'x1'));
    buf.push(e(30, 'x', 'x2'));
    buf.push(e(50, 'y', 'y1'));
    buf.push(e(60, 'x', 'x3'));
    buf.push(e(30, 'x', 'x4'));
    expect(buf.query({ requestId: 'x', minLevel: 50, limit: 1 }).map((r) => r.msg)).toEqual(['x3']);
    expect(buf.query({ requestId: 'x', minLevel: 50 }).map((r) => r.msg)).toEqual(['x1', 'x3']);
    expect(buf.query({ limit: 0 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('http errors', () => {
  it('HttpError is a named Error; an explicitly undefined details becomes null', () => {
    const e = badRequest('BAD', 'nope', undefined);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('HttpError');
    expect([e.status, e.code, e.message, e.details]).toEqual([400, 'BAD', 'nope', null]);
    expect(new HttpError(418, 'TEAPOT', 'short and stout').details).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('loadDataset (adversarial fixtures)', () => {
  it('throws on non-adjacent duplicate sourceKeys', () => {
    const records = [
      { sourceKey: 'r0001', values: {} },
      { sourceKey: 'r0002', values: {} },
      { sourceKey: 'r0001', values: {} },
    ];
    expect(() => loadDataset(datasetDir({ 'source-records.json': records }))).toThrow(/r0001/);
  });

  it('throws when source-records.json is not an array', () => {
    expect(() => loadDataset(datasetDir({ 'source-records.json': { sourceKey: 'r1', values: {} } }))).toThrow();
  });

  it('zod-validates the target schema (unknown field type ⇒ throws)', () => {
    const target = JSON.parse(fs.readFileSync(path.join(DATASET_DIR, 'target-schema.json'), 'utf8')) as TargetSchema;
    const bad = { ...target, fields: [{ ...target.fields[0]!, type: 'decimal' }, ...target.fields.slice(1)] };
    expect(() => loadDataset(datasetDir({ 'target-schema.json': bad }))).toThrow(/target-schema/);
  });

  it('zod-validates the gold plan (errorBudgetPct above the max ⇒ throws)', () => {
    const gold = JSON.parse(fs.readFileSync(path.join(DATASET_DIR, 'gold-plan.json'), 'utf8')) as Record<string, unknown>;
    expect(() => loadDataset(datasetDir({ 'gold-plan.json': { ...gold, errorBudgetPct: 51 } }))).toThrow(/gold-plan/);
  });

  it('is deterministic: two loads are deeply equal; shipped sourceKeys are unique', () => {
    expect(loadDataset()).toEqual(loadDataset());
    expect(new Set(dataset.records.map((r) => r.sourceKey)).size).toBe(dataset.records.length);
  });
});

// ---------------------------------------------------------------------------------------------
describe('targetDdl: generated table shape', () => {
  it('PRAGMA table_info matches the schema: id, business columns in order, _load_run_id; types and NOT NULL', () => {
    const db = memDb();
    const info = db.prepare(`PRAGMA table_info(${targetTableName(dataset.target)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const sqlType = { string: 'TEXT', date: 'TEXT', integer: 'INTEGER', boolean: 'INTEGER' } as const;
    expect(info.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ['id', 'INTEGER', 0, 1],
      ...dataset.target.fields.map((f) => [f.name, sqlType[f.type], f.required ? 1 : 0, 0]),
      ['_load_run_id', 'INTEGER', 0, 0],
    ]);
  });

  it('has UNIQUE exactly on unique fields and a (non-unique) index on _load_run_id', () => {
    const db = memDb();
    const indexes = db.prepare(`PRAGMA index_list(tgt_accounts)`).all() as Array<{ name: string; unique: number }>;
    const cols = (name: string) =>
      (db.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>).map((c) => c.name);
    const unique = indexes.filter((i) => i.unique === 1).flatMap((i) => cols(i.name));
    expect(unique.sort()).toEqual(dataset.target.fields.filter((f) => f.unique).map((f) => f.name).sort());
    const lineage = indexes.filter((i) => i.unique === 0 && cols(i.name).join() === '_load_run_id');
    expect(lineage).toHaveLength(1);
  });

  it('wraps CHECKs of nullable columns only in "col IS NULL OR (...)"', () => {
    const ddl = targetTableDdl(dataset.target);
    for (const f of dataset.target.fields) {
      expect(ddl.includes(`CHECK (${f.name} IS NULL OR (`)).toBe(!f.required);
    }
  });

  it('enum/pattern literals cannot inject SQL; the literal value round-trips', () => {
    const evil = "a'); DROP TABLE events; --";
    const schema: TargetSchema = {
      name: 'inj',
      description: '',
      keyField: 'k',
      fields: [
        { name: 'k', type: 'string', required: true, unique: true, enum: [evil], pattern: "^a'\\)", description: '' },
      ],
    };
    const db = memDb();
    db.exec(targetTableDdl(schema));
    db.prepare('INSERT INTO tgt_inj (k) VALUES (?)').run(evil);
    expect(db.prepare('SELECT k FROM tgt_inj').pluck().get()).toBe(evil);
    expect(count(db, 'SELECT COUNT(*) FROM events')).toBeGreaterThan(0);
  });

  it('refuses identifiers that would inject SQL (field or table name)', () => {
    const field = { name: 'x TEXT); DROP TABLE events; --', type: 'string', required: true, unique: false, description: '' } as const;
    expect(() => targetTableDdl({ name: 'ok', description: '', keyField: 'x', fields: [field] })).toThrow();
    expect(() => targetTableName({ name: 'a; DROP TABLE events', description: '', keyField: 'k', fields: [] as never })).toThrow();
  });
});

describe('targetDdl: CHECK constraints reject every invalid value', () => {
  const cols = dataset.target.fields.map((f) => f.name);
  const valid: TransformedRow = {
    external_ref: 'C-54321',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone_e164: '+15551234567',
    status: 'active',
    created_on: '2019-03-14',
    balance_cents: -4500,
    is_vip: true,
    country: 'US',
  };
  const insertInto = (db: Db, row: TransformedRow) =>
    db
      .prepare(`INSERT INTO tgt_accounts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...toTargetRow(dataset.target, row));

  // SQLite treats a NULL CHECK result as a pass. date() returns NULL for month 13, day 32, month 00, day 00,
  // so `date(col) = col` is NULL and the whole CHECK passes: these impossible dates get stored.
  it.each(['2019-13-01', '2019-00-10', '2019-01-32', '2019-01-00', '2019-99-99'])(
    'rejects the impossible date %s in a DATE column',
    (d) => {
      const db = memDb();
      expect(() => insertInto(db, { ...valid, created_on: d })).toThrow(/CHECK constraint failed/);
    },
  );

  it.each([
    ['day overflow on a non-leap year', { created_on: '2019-02-29' }],
    ['a trailing newline after a valid date', { created_on: '2019-03-14\n' }],
    ['a trailing newline after a valid key', { external_ref: 'C-12345\n' }],
    ['an empty string in a nullable pattern column ("" is not NULL)', { email: '' }],
    ['enum values are case-sensitive', { status: 'Active' }],
    ['boolean -1', { is_vip: -1 }],
    ['51 code points (emoji) in a 50-char column', { first_name: '😀'.repeat(51) }],
  ])('rejects %s', (_label, patch) => {
    const db = memDb();
    expect(() => insertInto(db, { ...valid, ...patch })).toThrow(/CHECK constraint failed/);
  });

  it.each([
    ['a leap day', { created_on: '2020-02-29' }],
    ['50 code points (emoji) in a 50-char column, like SQLite length() and the JS validator', { first_name: '😀'.repeat(50) }],
    ['NULL in both nullable pattern columns', { email: null, phone_e164: null }],
  ])('accepts %s', (_label, patch) => {
    const db = memDb();
    expect(() => insertInto(db, { ...valid, ...patch })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
describe('openDb', () => {
  it('sets synchronous=NORMAL for files and :memory:; skips WAL for :memory:', () => {
    const file = path.join(tmpDir('mw-verify-db-'), 'a', 'b', 'c', 'w.db');
    const fdb = openDb(file, { dataset, now });
    opened.push(fdb);
    expect(fdb.pragma('synchronous', { simple: true })).toBe(1);
    expect(fdb.pragma('journal_mode', { simple: true })).toBe('wal');
    const mdb = memDb();
    expect(mdb.pragma('synchronous', { simple: true })).toBe(1);
    expect(mdb.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(mdb.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('enforces foreign keys', () => {
    const db = memDb();
    expect(() =>
      db
        .prepare(`INSERT INTO agent_runs (migration_id, status, mode, model, created_at) VALUES (999, 'queued', 'live', 'm', ?)`)
        .run(NOW),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('regexp(pattern, value): direct calls, NULL handling, unicode, and an invalid pattern does not poison the connection', () => {
    const db = memDb();
    const q = (sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p);
    expect(q(`SELECT regexp('^a', 'abc')`)).toBe(1);
    expect(q(`SELECT regexp('^a', NULL)`)).toBeNull();
    expect(q(`SELECT 'é' REGEXP '^.$'`)).toBe(1);
    expect(q(`SELECT ? REGEXP ?`, "it's", "^it's$")).toBe(1);
    expect(() => q(`SELECT 'a' REGEXP '('`)).toThrow();
    expect(q('SELECT 1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('seed', () => {
  it('stores every source record: row_no = index+1, payload = JSON of values, row_hash = sha256(canonicalJson(values))', () => {
    const db = memDb();
    const rows = db.prepare('SELECT row_no, source_key, payload, row_hash FROM src_legacy_customers ORDER BY row_no').all() as Array<{
      row_no: number;
      source_key: string;
      payload: string;
      row_hash: string;
    }>;
    expect(rows).toHaveLength(dataset.records.length);
    rows.forEach((row, i) => {
      const rec = dataset.records[i]!;
      expect(row.row_no).toBe(i + 1);
      expect(row.source_key).toBe(rec.sourceKey);
      expect(JSON.parse(row.payload)).toEqual(rec.values);
      expect(row.row_hash).toBe(sha256(canonicalJson(rec.values)));
    });
  });

  it('stores the target seed exactly as toTargetRow binds it, with _load_run_id NULL', () => {
    const db = memDb();
    const cols = dataset.target.fields.map((f) => f.name);
    const rows = db.prepare(`SELECT ${cols.join(', ')}, _load_run_id FROM tgt_accounts ORDER BY id`).raw().all();
    expect(rows).toEqual(dataset.targetSeed.map((r) => [...toTargetRow(dataset.target, r), null]));
  });

  it('records workspace_created and target_seeded events against the first workspace, as system', () => {
    const db = memDb();
    const events = db.prepare('SELECT migration_id, type, actor, payload, created_at FROM events ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    expect(events.map((e) => [e.migration_id, e.type, e.actor, e.created_at])).toEqual([
      [1, 'workspace_created', 'system', NOW],
      [1, 'target_seeded', 'system', NOW],
    ]);
    expect(JSON.parse(events[0]!.payload as string)).toEqual({ name: 'Workspace 1' });
  });

  it('is one transaction: a bad target-seed row rolls back the source rows and workspace too', () => {
    const bad: Dataset = { ...dataset, targetSeed: [...dataset.targetSeed, { ...dataset.targetSeed[0]!, external_ref: 'C-99999', status: 'bogus' }] };
    const file = path.join(tmpDir('mw-verify-seed-'), 'w.db');
    expect(() => openDb(file, { dataset: bad, now })).toThrow(/CHECK constraint failed/);
    const raw = new Database(file);
    try {
      expect(count(raw, 'SELECT COUNT(*) FROM src_legacy_customers')).toBe(0);
      expect(count(raw, 'SELECT COUNT(*) FROM migrations')).toBe(0);
      expect(count(raw, 'SELECT COUNT(*) FROM events')).toBe(0);
      expect(count(raw, 'SELECT COUNT(*) FROM tgt_accounts')).toBe(0);
    } finally {
      raw.close();
    }
  });

  it('never adds a workspace when one exists (even if a later workspace is current)', () => {
    const file = path.join(tmpDir('mw-verify-seed-'), 'w.db');
    const db = openDb(file, { dataset, now });
    db.prepare('UPDATE migrations SET is_current = 0').run();
    db.prepare(`INSERT INTO migrations (name, is_current, created_at) VALUES ('Workspace 2', 1, ?)`).run(NOW);
    db.close();
    const again = openDb(file, { dataset, now });
    opened.push(again);
    expect(again.prepare('SELECT name, is_current FROM migrations ORDER BY id').all()).toEqual([
      { name: 'Workspace 1', is_current: 0 },
      { name: 'Workspace 2', is_current: 1 },
    ]);
    expect(count(again, `SELECT COUNT(*) FROM events WHERE type = 'workspace_created'`)).toBe(1);
  });

  it('re-seeds the pre-existing target rows only while both the target and the load ledger are empty', () => {
    const file = path.join(tmpDir('mw-verify-seed-'), 'w.db');
    const db = openDb(file, { dataset, now });
    db.prepare('DELETE FROM tgt_accounts').run();
    db.close();
    const again = openDb(file, { dataset, now });
    opened.push(again);
    expect(count(again, 'SELECT COUNT(*) FROM tgt_accounts WHERE _load_run_id IS NULL')).toBe(5);
    expect(count(again, `SELECT COUNT(*) FROM events WHERE type = 'target_seeded'`)).toBe(2);
  });

  it('calling seed() again directly is a no-op', () => {
    const db = memDb();
    const before = count(db, 'SELECT COUNT(*) FROM events');
    seed(db, dataset, now);
    seed(db, dataset, now);
    expect(count(db, 'SELECT COUNT(*) FROM src_legacy_customers')).toBe(200);
    expect(count(db, 'SELECT COUNT(*) FROM tgt_accounts')).toBe(5);
    expect(count(db, 'SELECT COUNT(*) FROM events')).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
describe('bootRecover', () => {
  it('recovers running runs of every kind across workspaces, one event each with the right ids', () => {
    const db = memDb();
    db.prepare(`INSERT INTO migrations (name, is_current, created_at) VALUES ('Workspace 2', 0, ?)`).run(NOW);
    const run = db.prepare(`INSERT INTO runs (migration_id, kind, status, started_at) VALUES (?, ?, ?, ?)`);
    const r1 = Number(run.run(1, 'dry_run', 'running', NOW).lastInsertRowid);
    const r2 = Number(run.run(2, 'rollback', 'running', NOW).lastInsertRowid);
    run.run(1, 'execute', 'interrupted', NOW);
    run.run(2, 'execute', 'failed', NOW);
    const agent = db.prepare(`INSERT INTO agent_runs (migration_id, status, mode, model, created_at) VALUES (?, ?, 'live', 'm', ?)`);
    const a1 = Number(agent.run(2, 'queued', NOW).lastInsertRowid);
    agent.run(1, 'succeeded', NOW);

    const later = '2026-10-04T00:00:00.000Z';
    expect(bootRecover(db, () => later)).toEqual({ runs: 2, agentRuns: 1 });
    const ev = db
      .prepare(`SELECT migration_id, type, actor, run_id, agent_run_id, payload, created_at FROM events WHERE type LIKE '%interrupted' ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    expect(ev.map((e) => [e.migration_id, e.type, e.actor, e.run_id, e.agent_run_id, e.created_at])).toEqual([
      [1, 'run_interrupted', 'system', r1, null, later],
      [2, 'run_interrupted', 'system', r2, null, later],
      [2, 'agent_run_interrupted', 'system', null, a1, later],
    ]);
    for (const e of ev) expect(() => JSON.parse(e.payload as string)).not.toThrow();
    expect(db.prepare(`SELECT status FROM runs ORDER BY id`).pluck().all()).toEqual([
      'interrupted',
      'interrupted',
      'interrupted',
      'failed',
    ]);
    expect(db.prepare(`SELECT status FROM agent_runs ORDER BY id`).pluck().all()).toEqual(['interrupted', 'succeeded']);
    // A recovered workspace can take a new running run again (the run lock is released).
    expect(() => run.run(1, 'execute', 'running', later)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
describe('createApp: request id', () => {
  it('accepts exactly 64 allowed characters and replaces 65, empty, unicode and punctuation', async () => {
    const { app } = makeApp();
    const id64 = 'a'.repeat(64);
    expect((await app.request('/api/health', { headers: { 'x-request-id': id64 } })).headers.get('x-request-id')).toBe(id64);
    for (const bad of ['a'.repeat(65), '', 'réq', 'a.b', 'a/b', 'a,b']) {
      const got = (await app.request('/api/health', { headers: { 'x-request-id': bad } })).headers.get('x-request-id');
      expect(got).not.toBe(bad);
      expect(got).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe('createApp: error envelopes', () => {
  const routes: RouteRegistrar = (app) => {
    app.get('/api/v/conflict-no-details', () => {
      throw conflict('GATE', 'gate closed');
    });
    app.get('/api/v/boom', () => {
      throw new Error('kaboom');
    });
    app.get('/api/v/throw-string', () => {
      throw 'plain string failure';
    });
    app.get('/api/v/bad-regex', () => {
      new RegExp('(');
      return new Response('unreachable');
    });
    // A valid JSON body is read, then server-side data fails to parse: a server bug, not a client error.
    app.post('/api/v/parse-stored', async (c) => {
      await c.req.json();
      JSON.parse('{"corrupt": stored plan_json');
      return c.json({ ok: true });
    });
    app.post('/api/v/text', async (c) => c.json({ n: (await c.req.text()).length }));
  };

  it('every error response carries the same request id in the header and the envelope', async () => {
    const { app } = makeApp({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASS: 'p' }, [routes]);
    const auth = { authorization: basic('u', 'p') };
    const cases: Array<[string, RequestInit, number]> = [
      ['/api/logs', {}, 401],
      ['/api/nope', { headers: auth }, 404],
      ['/api/v/conflict-no-details', { headers: auth }, 409],
      ['/api/logs?limit=0', { headers: auth }, 422],
      ['/api/v/boom', { headers: auth }, 500],
      ['/api/v/text', { method: 'POST', headers: { ...auth, 'content-length': String(MIB + 1) }, body: 'x'.repeat(MIB + 1) }, 413],
    ];
    for (const [url, init, status] of cases) {
      const res = await app.request(url, init);
      expect(res.status, url).toBe(status);
      expect(res.headers.get('content-type'), url).toMatch(/^application\/json/);
      const env = (await res.json()) as Envelope;
      expect(Object.keys(env.error).sort(), url).toEqual(['code', 'details', 'message', 'requestId']);
      expect(env.error.requestId, url).toBe(res.headers.get('x-request-id'));
    }
  });

  it('HttpError without details serialises details: null (key present)', async () => {
    const { app } = makeApp({}, [routes]);
    const env = (await (await app.request('/api/v/conflict-no-details')).json()) as Envelope;
    expect(env.error).toMatchObject({ code: 'GATE', message: 'gate closed', details: null });
  });

  it('a 500 is access-logged at error level with {requestId, method, path, status, durationMs}', async () => {
    const { app, deps } = makeApp({}, [routes]);
    await app.request('/api/v/boom', { headers: { 'x-request-id': 'v-500' } });
    const access = deps.logBuffer.query({ requestId: 'v-500' }).filter((e) => e.status !== undefined);
    expect(access).toEqual([
      expect.objectContaining({ level: 50, requestId: 'v-500', method: 'GET', path: '/api/v/boom', status: 500, durationMs: expect.any(Number) }),
    ]);
  });

  it('a 503 health is access-logged at error level', async () => {
    const { app, deps } = makeApp();
    deps.db.close();
    expect((await app.request('/api/health', { headers: { 'x-request-id': 'v-503' } })).status).toBe(503);
    const access = deps.logBuffer.query({ requestId: 'v-503' }).filter((e) => e.status === 503);
    expect(access).toEqual([expect.objectContaining({ level: 50 })]);
  });

  it('a SyntaxError in a route that never read the body ⇒ 500 INTERNAL', async () => {
    const { app } = makeApp({}, [routes]);
    const res = await app.request('/api/v/bad-regex');
    expect(res.status).toBe(500);
    expect(((await res.json()) as Envelope).error.code).toBe('INTERNAL');
  });

  // Spec: only a malformed JSON *body* is 400 BAD_JSON; "anything else ⇒ 500 INTERNAL (log with stack)".
  it('a SyntaxError raised after a VALID JSON body was read ⇒ 500 INTERNAL (logged), not 400 BAD_JSON', async () => {
    const { app, deps } = makeApp({}, [routes]);
    const res = await app.request('/api/v/parse-stored', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'v-syntax' },
      body: '{"valid":true}',
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as Envelope).error.code).toBe('INTERNAL');
    expect(deps.logBuffer.query({ requestId: 'v-syntax', minLevel: 50 }).some((e) => e.msg === 'unhandled error')).toBe(true);
  });

  // Spec: "anything else ⇒ 500 INTERNAL ... Every error envelope includes requestId". Hono's onError only sees
  // `instanceof Error`, so a thrown non-Error escapes the app (no envelope, no access log).
  it('a thrown non-Error value ⇒ 500 INTERNAL envelope with the request id', async () => {
    const { app, deps } = makeApp({}, [routes]);
    let res: Response | undefined;
    let escaped: unknown;
    try {
      res = await app.request('/api/v/throw-string', { headers: { 'x-request-id': 'v-nonerror' } });
    } catch (err) {
      escaped = err;
    }
    expect(escaped).toBeUndefined();
    expect(res?.status).toBe(500);
    expect(((await res!.json()) as Envelope).error).toMatchObject({ code: 'INTERNAL', requestId: 'v-nonerror' });
    expect(deps.logBuffer.query({ requestId: 'v-nonerror', minLevel: 50 }).length).toBeGreaterThan(0);
  });

  it('body limit is exactly 1 MiB, with and without a content-length header', async () => {
    const { app } = makeApp({}, [routes]);
    const post = (n: number, withLength: boolean) =>
      app.request('/api/v/text', {
        method: 'POST',
        headers: withLength ? { 'content-length': String(n) } : {},
        body: 'x'.repeat(n),
      });
    for (const withLength of [true, false]) {
      const ok = await post(MIB, withLength);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ n: MIB });
      expect((await post(MIB + 1, withLength)).status).toBe(413);
    }
  });
});

describe('createApp: basic auth', () => {
  const env = { BASIC_AUTH_USER: 'grader', BASIC_AUTH_PASS: 'pässwörd-✓:colon' };

  it('GET /api/health never requires auth, even with wrong or malformed credentials', async () => {
    const { app } = makeApp(env);
    for (const authorization of [basic('grader', 'wrong'), 'Basic !!!', 'Bearer x']) {
      expect((await app.request('/api/health', { headers: { authorization } })).status).toBe(200);
    }
  });

  it('only GET/HEAD /api/health is exempt: other methods, other paths and unknown routes are 401', async () => {
    const { app } = makeApp(env);
    expect((await app.request('/api/health', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/health/', {})).status).toBe(401);
    expect((await app.request('/api/logs', { method: 'HEAD' })).status).toBe(401);
    expect((await app.request('/api/does-not-exist')).status).toBe(401);
    expect((await app.request('/api/%68ealth')).status).toBe(200); // decodes to the health route itself
  });

  it('accepts a UTF-8 password containing a colon', async () => {
    const { app } = makeApp(env);
    const res = await app.request('/api/logs', { headers: { authorization: basic(env.BASIC_AUTH_USER, env.BASIC_AUTH_PASS) } });
    expect(res.status).toBe(200);
  });

  it('guards the static web shell too', async () => {
    const dir = tmpDir('mw-verify-static-');
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root">shell</div>');
    const { app } = makeApp({ ...env, STATIC_DIR: dir });
    expect((await app.request('/')).status).toBe(401);
    expect((await app.request('/index.html')).status).toBe(401);
    const ok = await app.request('/', { headers: { authorization: basic(env.BASIC_AUTH_USER, env.BASIC_AUTH_PASS) } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('shell');
  });
});

describe('createApp: /api/logs and /api/health', () => {
  it('validates the query: limit 1..1000, minLevel number ≥0 or a level name', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/logs?limit=1000')).status).toBe(200);
    for (const q of ['limit=1001', 'limit=1.5', 'minLevel=abc', 'minLevel=-1']) {
      const res = await app.request(`/api/logs?${q}`);
      expect(res.status, q).toBe(422);
      expect(((await res.json()) as Envelope).error.code).toBe('VALIDATION_FAILED');
    }
    const none = (await (await app.request('/api/logs?requestId=never-seen')).json()) as { entries: unknown[] };
    expect(none.entries).toEqual([]);
  });

  it('health reports the latest agent run by insertion order and uses deps.now for time', async () => {
    const { app, deps } = makeApp();
    const ins = deps.db.prepare(`INSERT INTO agent_runs (migration_id, status, mode, model, created_at) VALUES (1, ?, 'scripted', 'm', ?)`);
    ins.run('succeeded', '2026-10-03T11:00:00.000Z');
    ins.run('running', '2026-10-03T09:00:00.000Z');
    const body = (await (await app.request('/api/health')).json()) as { time: string; llm: { lastRunStatus: string } };
    expect(body.time).toBe(NOW);
    expect(body.llm.lastRunStatus).toBe('running');
  });
});

describe('createApp: static web shell', () => {
  let dir: string;
  let parent: string;
  beforeAll(() => {
    parent = tmpDir('mw-verify-root-');
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT');
    dir = path.join(parent, 'static');
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root">spa</div>');
    fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'export {}');
  });

  it('never serves files outside the static root (encoded traversal)', async () => {
    const { app } = makeApp({ STATIC_DIR: dir });
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/../secret.txt']) {
      const res = await app.request(p);
      expect(await res.text(), p).not.toContain('TOP-SECRET');
    }
  });

  it('/api, /api/ and unknown /api paths stay JSON 404s; the request id is set on static responses', async () => {
    const { app } = makeApp({ STATIC_DIR: dir });
    for (const p of ['/api', '/api/', '/api/assets/a.js']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
      expect(((await res.json()) as Envelope).error.code).toBe('NOT_FOUND');
    }
    const asset = await app.request('/assets/a.js', { headers: { 'x-request-id': 'static-1' } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('x-request-id')).toBe('static-1');
  });

  it('registrars run in order with the shared deps, before the static fallback', async () => {
    const calls: string[] = [];
    const a: RouteRegistrar = (app, deps) => {
      calls.push(`a:${deps.now()}`);
      app.get('/api/v/a', (c) => c.text('a'));
    };
    const b: RouteRegistrar = (app) => {
      calls.push('b');
      app.get('/client/route', (c) => c.text('registrar wins'));
    };
    const { app } = makeApp({ STATIC_DIR: dir }, [a, b]);
    expect(calls).toEqual([`a:${NOW}`, 'b']);
    expect(await (await app.request('/api/v/a')).text()).toBe('a');
    expect(await (await app.request('/client/route')).text()).toBe('registrar wins');
  });
});

// ---------------------------------------------------------------------------------------------
describe('process entry (real node, native type stripping)', () => {
  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
  const waitExit = (child: ChildProcess, ms: number) =>
    new Promise<number | null>((resolve, reject) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      const t = setTimeout(() => reject(new Error(`no exit within ${ms}ms`)), ms);
      child.once('exit', (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  });

  it('serves the SPA, logs listening with the port, and on SIGINT exits 0 after closing the DB (WAL checkpointed)', async () => {
    const tmp = tmpDir('mw-verify-boot-');
    const staticDir = path.join(tmp, 'dist');
    fs.mkdirSync(staticDir);
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<div id="root">boot-spa-marker</div>');
    const dbPath = path.join(tmp, 'deep', 'dir', 'w.db');
    const port = await freePort();
    const child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, PORT: String(port), DB_PATH: dbPath, STATIC_DIR: staticDir, LOG_TO_STDOUT: 'true', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));

    const base = `http://127.0.0.1:${port}`;
    const deadline = performance.now() + 15_000;
    let healthy = false;
    while (!healthy && performance.now() < deadline && child.exitCode === null) {
      healthy = await fetch(`${base}/api/health`).then((r) => r.status === 200, () => false);
      if (!healthy) await new Promise((r) => setTimeout(r, 100));
    }
    expect(healthy, out).toBe(true);
    const spa = await fetch(`${base}/some/client/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('boot-spa-marker');
    expect(spa.headers.get('x-request-id')).toBeTruthy();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true); // WAL mode on the real file

    child.kill('SIGINT');
    expect(await waitExit(child, 5_000)).toBe(0);
    expect(fs.existsSync(`${dbPath}-wal`), 'db.close() checkpoints and removes the WAL').toBe(false);
    const listening = out
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as LogEntry)
      .find((e) => e.msg === 'listening');
    expect(listening, out).toMatchObject({ port });
  });

  it('fails fast with a non-zero exit on invalid configuration', async () => {
    const child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, PORT: 'not-a-port', DB_PATH: path.join(tmpDir('mw-verify-bad-'), 'w.db'), TZ: 'UTC' },
      stdio: 'ignore',
    });
    children.push(child);
    const code = await waitExit(child, 10_000);
    expect(code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('packaging and static contracts', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('Dockerfile: node:26-slim deps → build → runtime with the specified ENV, volume dir, port, healthcheck and CMD', () => {
    const df = read('Dockerfile').replace(/\\\n\s*/g, ' ');
    const from = [...df.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)].map((m) => m[1]);
    expect(from[0]).toBe('node:26-slim');
    expect(from.at(-1)).toBe('node:26-slim');
    expect(df).toMatch(/^RUN npm ci --ignore-scripts\s*$/m); // prebuilt better-sqlite3 binaries; no node-gyp toolchain in slim
    expect(df).toMatch(/^RUN npm run build/m);
    expect(df).toMatch(/^RUN npm ci --omit=dev/m);
    const runtime = df.slice(df.lastIndexOf('FROM '));
    for (const env of ['NODE_ENV=production', 'TZ=UTC', 'PORT=8787', 'DB_PATH=/data/workbench.db', 'STATIC_DIR=/app/dist']) {
      expect(runtime).toMatch(new RegExp(`^ENV .*\\b${env.replace(/[/.]/g, '\\$&')}(\\s|$)`, 'm'));
    }
    expect(runtime).toMatch(/^COPY --from=\S+ \/app\/dist /m);
    expect(runtime).toMatch(/^COPY shared /m);
    expect(runtime).toMatch(/^COPY server\/src /m);
    expect(runtime).toMatch(/^RUN mkdir (-p )?\/data/m);
    expect(runtime).toMatch(/^EXPOSE 8787/m);
    expect(runtime).toContain(
      `CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`,
    );
    expect(runtime).toMatch(/^CMD \["node", ?"server\/src\/index\.ts"\]\s*$/m);
    expect(df).not.toMatch(/^USER /m); // runs as root for Railway volumes
  });

  it('.dockerignore excludes the specified paths', () => {
    const entries = read('.dockerignore').split('\n').map((l) => l.trim());
    for (const e of ['node_modules', 'dist', 'data', '.env*', '.git', 'test-results', 'playwright-report', 'docs', 'tasks', 'e2e']) {
      expect(entries).toContain(e);
    }
  });

  it('runtime import graph from server/src/index.ts only needs shared/, server/src/ and production dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    const seen = new Set<string>();
    const bare = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = path.relative(ROOT, file);
      expect(rel.startsWith('shared/') || rel.startsWith('server/src/'), rel).toBe(true);
      const src = fs.readFileSync(file, 'utf8');
      const specs = [
        ...[...src.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]!),
        ...[...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
        ...[...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!),
      ];
      for (const s of specs) {
        if (s.startsWith('.')) visit(path.resolve(path.dirname(file), s));
        else if (!s.startsWith('node:')) bare.add(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!);
      }
    };
    visit(path.join(ROOT, 'server/src/index.ts'));
    for (const name of bare) expect(Object.keys(pkg.dependencies), name).toContain(name);
  });

  it('DB/dataset code is deterministic: no Date.now, new Date(string), Math.random or localeCompare', () => {
    for (const f of ['server/src/db/connection.ts', 'server/src/db/targetDdl.ts', 'server/src/db/seed.ts', 'server/src/db/boot.ts', 'server/src/dataset/load.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|localeCompare/);
    }
  });

  // (App.tsx is a placeholder the UI module replaces, so it is not checked here.)
  it('web shell: index.html root + module script + title, tailwind import, StrictMode entry', () => {
    const html = read('web/index.html');
    expect(html).toMatch(/<div id="root"><\/div>/);
    expect(html).toMatch(/<script type="module" src="\/src\/main\.tsx"><\/script>/);
    expect(html).toMatch(/<title>Migration Workbench<\/title>/);
    expect(read('web/src/index.css')).toContain('@import "tailwindcss";');
    const main = read('web/src/main.tsx');
    expect(main).toContain('<StrictMode>');
    expect(main).toMatch(/<App \/>/);
  });
});
