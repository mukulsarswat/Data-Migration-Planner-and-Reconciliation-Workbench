// Docs-truthfulness review: every concrete README / AGENT_USAGE claim that is cheap to check, executed against the
// in-process app. Tests that FAIL here are documented defects (see the review report).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDataset } from '../../src/dataset/load.ts';
import { openDb, type Db } from '../../src/db/connection.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { LogBuffer, createLogger } from '../../src/logger.ts';
import { workbenchRoutes } from '../../src/routes/workbench.ts';

type Json = Record<string, any>;
const ROOT = path.resolve(import.meta.dirname, '../../..');

function makeApp(env: Record<string, string> = {}) {
  const dataset = loadDataset();
  const logBuffer = new LogBuffer(2000);
  const logger = createLogger({ level: 'silent', buffer: logBuffer, stdout: false });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0) + 1000 * tick++).toISOString();
  const db = openDb(':memory:', { dataset, now });
  const config = loadConfig({ LOG_TO_STDOUT: 'false', ALLOW_FAULT_INJECTION: 'true', ...env });
  const app = createApp({ db, config, logger, logBuffer, dataset, now }, [workbenchRoutes]);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await app.request(p, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  return { app, db, dataset, call };
}
const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('README reviewer walkthrough, heuristic path, step by step', () => {
  const h = makeApp();
  let v = 1;
  let failedRunId = 0;

  it('step 1: 7 gaps and 14 supported transforms', async () => {
    const { body } = await h.call('GET', '/api/migration');
    const g = body.gaps;
    expect(g.sourceWithoutTarget.length + g.requiredTargetWithoutSource.length + g.typeIncompatible.length).toBe(7);
    expect(g.requiredTargetWithoutSource.map((x: Json) => x.target)).toContain('country');
    expect(body.catalog.ops).toHaveLength(14);
  });

  it('step 3: the 4 clarifications carry the README labels; each answer is a new version v2..v5; blockers reach 0', async () => {
    expect((await h.call('POST', '/api/plans/heuristic', { actor: 'alice' })).status).toBe(201);
    const labels = [/Treat empty as 0/, /Default to 'US'/, /Quarantine the 5 rows/, /Keep US month\/day/];
    const v1 = await h.call('GET', '/api/plans/1');
    expect(v1.body.plan.clarifications).toHaveLength(4);
    for (const label of labels) {
      const cur = await h.call('GET', `/api/plans/${v}`);
      const c = cur.body.plan.clarifications.find((x: Json) => x.resolution === null && x.options.some((o: Json) => label.test(o.label)));
      expect(c, String(label)).toBeTruthy();
      const choice = c.options.findIndex((o: Json) => label.test(o.label));
      const ans = await h.call('POST', `/api/plans/${v}/clarifications/${c.id}`, { choice, actor: 'alice' });
      expect(ans.status).toBe(201);
      expect(ans.body.version).toBe(v + 1);
      v = ans.body.version;
    }
    expect(v).toBe(5);
    const latest = await h.call('GET', `/api/plans/${v}`);
    expect(latest.body.blockers).toBe(0);
    expect(latest.body.diff.from).toBe(4);
  });

  it('step 4: Source 200 · Transformed 180 · Accepted 164 · Rejected 36; identical hash; 3 conflicting keys', async () => {
    const a = await h.call('POST', '/api/runs/dry-run', { version: v });
    expect(a.body.counts).toMatchObject({ source: 200, transformed: 180, accepted: 164, rejected: 36 });
    expect(a.body.conflictPreflight).toHaveLength(3);
    const b = await h.call('POST', '/api/runs/dry-run', { version: v });
    expect(b.body.resultHash).toBe(a.body.resultHash);
    expect(b.body.deterministicMatch).toBe(true);
  });

  it('approval is bound to the plan hash', async () => {
    const ap = await h.call('POST', `/api/plans/${v}/approve`, { reviewer: 'alice' });
    expect(ap.status).toBe(200);
    expect(ap.body.approval.planHash).toBe(ap.body.planHash);
  });

  it('step 5: fail after 75 ⇒ "50 rows committed, the second batch rolled back"', async () => {
    const ex = await h.call('POST', '/api/runs/execute', { version: v, failAfter: 75 });
    expect(ex.body.status).toBe('failed');
    failedRunId = ex.body.id;
    expect(ex.body.counts.processed).toBe(50);
    // README: "50 rows committed". Committed TARGET rows are the inserted ones.
    expect(ex.body.counts.inserted).toBe(50);
  });

  it('step 5: retry skips the committed rows and inserts the rest', async () => {
    const r = await h.call('POST', `/api/runs/${failedRunId}/retry`, {});
    expect(r.body.status).toBe('succeeded');
    expect(count(h.db, 'SELECT COUNT(*) AS n FROM tgt_accounts')).toBe(166);
  });

  it('step 6: MATCHED, 161 loaded + 3 conflicts + 36 rejected = 200, money equal; rollback ⇒ ROLLED_BACK_CLEAN with 5 rows', async () => {
    const rec = (await h.call('GET', '/api/reconciliation')).body;
    expect(rec.verdict).toBe('MATCHED');
    expect(rec.totals).toMatchObject({ loadedActive: 161, conflicts: 3, rejected: 36, source: 200 });
    expect(rec.totals.loadedActive + rec.totals.conflicts + rec.totals.rejected).toBe(200);
    expect(rec.totals.expectedBalanceCents).toBe(rec.totals.actualBalanceCents);
    const rb = await h.call('POST', '/api/rollback', { actor: 'alice' });
    expect(rb.status).toBe(201);
    const after = (await h.call('GET', '/api/reconciliation')).body;
    expect(after.verdict).toBe('ROLLED_BACK_CLEAN');
    expect(after.preExistingIntact).toBe(true);
    expect(count(h.db, 'SELECT COUNT(*) AS n FROM tgt_accounts')).toBe(5);
  });
});

describe('.env.example vs config.ts', () => {
  it('.env.example names every variable config.ts reads', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'server/src/config.ts'), 'utf8');
    const schemaBlock = cfg.slice(cfg.indexOf('const EnvSchema'), cfg.indexOf('});', cfg.indexOf('const EnvSchema')));
    const read = [...schemaBlock.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const listed = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    expect(read.filter((k) => !listed.has(k))).toEqual([]);
  });
});

describe('"PII masked toward the LLM" / "tests prove [the r0167 injection note] never reaches the model"', () => {
  const tools = async () => {
    const { runReadOnlyTool } = await import('../../src/agent/tools.ts');
    const { engineContext } = await import('../../src/services/context.ts');
    const ctx = engineContext(loadDataset());
    return (input: Json) => runReadOnlyTool('preview_mapping', input, ctx).content;
  };

  it('preview_mapping masks raw values but echoes the same PII unmasked in failure messages', async () => {
    const preview = await tools();
    const out = preview({ target: 'is_vip', sources: ['email_addr'], steps: [{ op: 'to_boolean', params: { true_values: ['Y'], false_values: ['N'] } }] });
    expect(out).toContain('Y***@Example.Com'); // raw column is masked...
    expect(out).not.toContain('Yuki.Ivanova73@Example.Com'); // ...but the message carries the clear-text address
  });

  it('three read-only preview_mapping calls deliver the r0167 injection payload to the model verbatim', async () => {
    const preview = await tools();
    const known: string[] = [];
    let last = '';
    for (let call = 0; call < 3; call++) {
      const pairs = [{ from: 'A', to: 'active' }, ...known.map((from) => ({ from, to: 'active' }))];
      last = preview({ target: 'status', sources: ['notes'], steps: [{ op: 'null_if_empty', params: {} }, { op: 'map_values', params: { pairs, fallback: '' } }] });
      for (const f of JSON.parse(last).data.failures as Json[]) {
        const m = /^value '(.*)' has no mapping$/s.exec(f.message);
        if (m && !known.includes(m[1]!)) known.push(m[1]!); // the model learns clear-text values from the messages
      }
    }
    expect(last).not.toContain('INJECT-7f3a');
    expect(last).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  });
});

describe('routes/agent.ts: "POST 202 + polling; per-IP and global daily caps" (no other test exercises these routes)', () => {
  const build = async (env: Record<string, string>, client: unknown) => {
    const { agentRoutes } = await import('../../src/routes/agent.ts');
    const dataset = loadDataset();
    const logBuffer = new LogBuffer(500);
    const logger = createLogger({ level: 'silent', buffer: logBuffer, stdout: false });
    const now = () => '2026-10-03T12:00:00.000Z';
    const db = openDb(':memory:', { dataset, now });
    const config = loadConfig({ LOG_TO_STDOUT: 'false', ...env });
    const app = createApp({ db, config, logger, logBuffer, dataset, now }, [workbenchRoutes, agentRoutes(() => client as never)]);
    const post = async (ip: string) => {
      const res = await app.request('/api/agent-runs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}' });
      return { status: res.status, body: (await res.json()) as Json };
    };
    const settle = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const r = (await (await app.request(`/api/agent-runs/${id}`)).json()) as Json;
        if (r.run.status !== 'queued' && r.run.status !== 'running') return r;
        await new Promise((res) => setTimeout(res, 5));
      }
      throw new Error('agent run did not settle');
    };
    return { app, db, post, settle };
  };

  it('a scripted agent run answers 202, persists its trace and creates an agent-authored plan version', async () => {
    const { scriptedClient, assistant, toolUse } = await import('../../src/agent/scriptedClient.ts');
    const { toSubmission } = await import('../agent/fixtures.ts');
    const client = scriptedClient([assistant([toolUse('s1', 'submit_migration_plan', toSubmission(loadDataset().goldPlan))])]);
    const h = await build({}, client);
    const started = await h.post('10.0.0.1');
    expect(started.status).toBe(202);
    const done = await h.settle(started.body.id);
    expect(done.run.status).toBe('succeeded');
    expect(done.run.resultVersion).toBe(1);
    expect(done.steps.length).toBeGreaterThan(0);
    const plans = (await (await h.app.request('/api/plans')).json()) as Json;
    expect(plans.items[0].author).toBe('agent');
  });

  it('the per-IP daily cap cannot be bypassed by changing the client-supplied X-Forwarded-For header', async () => {
    const failing = { mode: 'live', create: async () => Promise.reject(Object.assign(new Error('boom'), { status: 500 })) };
    const h = await build({ AGENT_RUNS_PER_IP_PER_DAY: '1', AGENT_RUNS_GLOBAL_PER_DAY: '60' }, failing);
    const first = await h.post('203.0.113.7');
    expect(first.status).toBe(202);
    await h.settle(first.body.id);
    // Same caller, forged header (a proxy that appends keeps the forged value first, which clientIp() trusts).
    const second = await h.post('198.51.100.99, 203.0.113.7');
    expect(second.status).toBe(429);
  });
});

describe('README "Docker: docker run -p 8787:8787 -v mw-data:/data --env-file .env" after "cp .env.example .env"', () => {
  it('keeps the SQLite file on the /data volume', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    const envLine = /^ENV (.+)$/m.exec(runtime)![1]!;
    const imageEnv = Object.fromEntries(envLine.split(/\s+/).map((kv) => kv.split('=') as [string, string]));
    const envFile = Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, '.env.example'), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    // `docker run --env-file` values override the image's ENV; the process runs with WORKDIR /app.
    const cfg = loadConfig({ ...imageEnv, ...envFile });
    expect(path.posix.resolve('/app', cfg.dbPath)).toBe('/data/workbench.db');
  });
});

describe('reconcile money check ("money check equal to the cent") compares only rows that were loaded', () => {
  it('an INCOMPLETE load (114 accepted rows missing) still reports the balance equation as holding', async () => {
    const { readyToExecute } = await import('../helpers.ts');
    const { execute } = await import('../../src/services/runs.ts');
    const { reconcile } = await import('../../src/services/reconcile.ts');
    const { deps, version } = readyToExecute();
    execute(deps, 1, { version, actor: 't', failAfter: 75 });
    const rec = reconcile(deps, 1);
    expect(rec.verdict).toBe('INCOMPLETE');
    const balance = rec.equations.find((e) => e.name === 'Balance sum')!;
    // An aggregate source-vs-target money check must fail while accepted rows are missing from the target.
    expect(balance.holds).toBe(false);
  });
});

describe('documented gates that no existing test exercises (sanity: do they work at all?)', () => {
  it('ERROR_BUDGET_EXCEEDED blocks execution when the dry-run reject rate exceeds the plan budget', async () => {
    const h = makeApp();
    const plan = { ...h.dataset.goldPlan, errorBudgetPct: 10 };
    const { createVersion, decide } = await import('../../src/services/plans.ts');
    const deps = { db: h.db, dataset: h.dataset, now: () => '2026-10-03T12:00:00.000Z' } as never;
    const v = createVersion(deps, { migrationId: 1, plan, author: 'user', actor: 't', parentVersion: null, changeNote: 'x' });
    decide(deps, 1, v.version, 'approved', 't', '');
    await h.call('POST', '/api/runs/dry-run', { version: v.version });
    const ex = await h.call('POST', '/api/runs/execute', { version: v.version });
    expect(ex.status).toBe(409);
    expect(ex.body.error.code).toBe('ERROR_BUDGET_EXCEEDED');
  });

  it('"Restarts mark any in-flight runs interrupted, so they can be retried"', async () => {
    const { readyToExecute } = await import('../helpers.ts');
    const { bootRecover } = await import('../../src/db/boot.ts');
    const { getVersion } = await import('../../src/services/plans.ts');
    const { retry } = await import('../../src/services/runs.ts');
    const { deps, version } = readyToExecute();
    const v = getVersion(deps.db, 1, version);
    const id = Number(
      deps.db
        .prepare(`INSERT INTO runs (migration_id, plan_version_id, plan_hash, kind, status, options, actor, started_at) VALUES (1, ?, ?, 'execute', 'running', '{}', 't', ?)`)
        .run(v.id, v.planHash, deps.now()).lastInsertRowid,
    );
    bootRecover(deps.db, deps.now);
    const r = retry(deps, 1, id, 't');
    expect(r.status).toBe('succeeded');
    expect(r.counts.inserted).toBe(161);
  });
});

describe('more untested gates (sanity)', () => {
  it('PLAN_REJECTED, FAULT_INJECTION_DISABLED and LLM_NOT_CONFIGURED surface as documented', async () => {
    const { createVersion, decide } = await import('../../src/services/plans.ts');
    const { agentRoutes } = await import('../../src/routes/agent.ts');
    const h = makeApp({ ALLOW_FAULT_INJECTION: 'false' });
    const deps = { db: h.db, dataset: h.dataset, now: () => '2026-10-03T12:00:00.000Z' } as never;
    const v1 = createVersion(deps, { migrationId: 1, plan: h.dataset.goldPlan, author: 'user', actor: 't', parentVersion: null, changeNote: 'x' });
    decide(deps, 1, v1.version, 'rejected', 'bob', 'no');
    expect((await h.call('POST', '/api/runs/execute', { version: v1.version })).body.error.code).toBe('PLAN_REJECTED');
    const v2 = createVersion(deps, { migrationId: 1, plan: { ...h.dataset.goldPlan, summary: 'v2' }, author: 'user', actor: 't', parentVersion: 1, changeNote: 'y' });
    decide(deps, 1, v2.version, 'approved', 'bob', '');
    await h.call('POST', '/api/runs/dry-run', { version: v2.version });
    const fi = await h.call('POST', '/api/runs/execute', { version: v2.version, failAfter: 10 });
    expect([fi.status, fi.body.error.code]).toEqual([422, 'FAULT_INJECTION_DISABLED']);

    const dataset = loadDataset();
    const logBuffer = new LogBuffer(10);
    const logger = createLogger({ level: 'silent', buffer: logBuffer, stdout: false });
    const db = openDb(':memory:', { dataset, now: () => '2026-10-03T12:00:00.000Z' });
    const app = createApp({ db, config: loadConfig({ LOG_TO_STDOUT: 'false' }), logger, logBuffer, dataset, now: () => '2026-10-03T12:00:00.000Z' }, [agentRoutes()]);
    const res = await app.request('/api/agent-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe('LLM_NOT_CONFIGURED');
  });
});
