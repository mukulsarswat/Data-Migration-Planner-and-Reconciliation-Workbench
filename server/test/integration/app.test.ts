import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../../src/config.ts';
import type { Config } from '../../src/config.ts';
import { LogBuffer, createLogger } from '../../src/logger.ts';
import type { LogEntry } from '../../src/logger.ts';
import { HttpError, conflict, notFound, tooManyRequests, unprocessable, badRequest } from '../../src/http/errors.ts';
import { createApp } from '../../src/app.ts';
import type { AppDeps, RouteRegistrar } from '../../src/app.ts';
import { openDb } from '../../src/db/connection.ts';
import { loadDataset } from '../../src/dataset/load.ts';
import { routeRegistrars } from '../../src/routes/index.ts';

const dataset = loadDataset();
const NOW = '2026-10-03T12:00:00.000Z';
const NO_STATIC = path.join(os.tmpdir(), 'mw-no-such-static-dir');
const pkgVersion = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as {
  version: string;
}).version;

const opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** Build an app on an in-memory DB with a quiet logger whose output lands only in the buffer. */
function makeApp(env: Record<string, string> = {}, registrars: readonly RouteRegistrar[] = []) {
  const config = loadConfig({ LOG_TO_STDOUT: 'false', STATIC_DIR: NO_STATIC, ...env });
  const logBuffer = new LogBuffer(1000);
  const logger = createLogger({ level: config.logLevel, buffer: logBuffer, stdout: config.logToStdout });
  const now = () => NOW;
  const db = openDb(':memory:', { dataset, now, logger });
  opened.push(db);
  const deps: AppDeps = { db, config, logger, logBuffer, dataset, now };
  return { app: createApp(deps, registrars), deps };
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
type Envelope = { error: { code: string; message: string; details: unknown; requestId: string } };

describe('loadConfig', () => {
  it('applies .env.example defaults', () => {
    const c = loadConfig({});
    expect(c).toEqual<Config>({
      port: 8787,
      dbPath: './data/workbench.db',
      staticDir: './dist',
      logLevel: 'info',
      logToStdout: true,
      anthropic: { apiKey: null, model: 'claude-sonnet-5-5', effort: 'medium', maxIterations: 8, timeoutMs: 180000 },
      basicAuth: null,
      caps: { perIpPerDay: 10, globalPerDay: 60 },
      allowFaultInjection: true,
    trustProxy: false,
      version: pkgVersion,
    });
  });

  it('treats empty strings as unset and parses typed values', () => {
    const c = loadConfig({
      PORT: '9000',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_EFFORT: 'high',
      AGENT_MAX_ITERATIONS: '4',
      LOG_TO_STDOUT: 'false',
      ALLOW_FAULT_INJECTION: '0',
      AGENT_RUNS_PER_IP_PER_DAY: '',
    });
    expect(c.port).toBe(9000);
    expect(c.anthropic.apiKey).toBeNull();
    expect(c.anthropic.effort).toBe('high');
    expect(c.anthropic.maxIterations).toBe(4);
    expect(c.logToStdout).toBe(false);
    expect(c.allowFaultInjection).toBe(false);
    expect(c.caps.perIpPerDay).toBe(10);
  });

  it('enables basic auth only when both user and pass are non-empty, and fails closed when half-configured', () => {
    expect(loadConfig({ BASIC_AUTH_USER: '', BASIC_AUTH_PASS: '' }).basicAuth).toBeNull();
    expect(() => loadConfig({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASS: '' })).toThrow(/BASIC_AUTH_USER and BASIC_AUTH_PASS/);
    expect(() => loadConfig({ BASIC_AUTH_USER: '', BASIC_AUTH_PASS: 'p' })).toThrow(/BASIC_AUTH_USER and BASIC_AUTH_PASS/);
    expect(loadConfig({ BASIC_AUTH_USER: 'u', BASIC_AUTH_PASS: 'p' }).basicAuth).toEqual({ user: 'u', pass: 'p' });
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }).anthropic.apiKey).toBe('sk-test');
  });

  it('rejects invalid values with the offending variable named', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ANTHROPIC_EFFORT: 'max' })).toThrow(/ANTHROPIC_EFFORT/);
    expect(() => loadConfig({ LOG_TO_STDOUT: 'maybe' })).toThrow(/LOG_TO_STDOUT/);
  });
});

describe('LogBuffer + createLogger', () => {
  const entry = (level: number, requestId?: string): LogEntry => ({ level, time: 0, requestId });

  it('is a ring buffer (newest last) that filters by requestId, minLevel and limit', () => {
    const buf = new LogBuffer(3);
    for (let i = 0; i < 5; i++) buf.push({ ...entry(30, i % 2 ? 'odd' : 'even'), msg: `m${i}` });
    expect(buf.query({}).map((e) => e.msg)).toEqual(['m2', 'm3', 'm4']);
    expect(buf.query({ requestId: 'even' }).map((e) => e.msg)).toEqual(['m2', 'm4']);
    expect(buf.query({ limit: 1 }).map((e) => e.msg)).toEqual(['m4']);
    buf.push(entry(50));
    expect(buf.query({ minLevel: 40 })).toHaveLength(1);
  });

  it('defaults to a capacity of 1000', () => {
    const buf = new LogBuffer();
    for (let i = 0; i < 1005; i++) buf.push(entry(30));
    expect(buf.query({})).toHaveLength(1000);
  });

  it('writes structured entries to the buffer and redacts secrets', () => {
    const buf = new LogBuffer(10);
    const log = createLogger({ level: 'debug', buffer: buf, stdout: false });
    log.debug({ requestId: 'r1' }, 'hello');
    log.info({
      headers: { authorization: 'Basic c2VjcmV0', 'x-api-key': 'k-1' },
      apiKey: 'sk-ant-1',
      config: { anthropic: { apiKey: 'sk-ant-2' } },
      ANTHROPIC_API_KEY: 'sk-ant-3',
    });
    const [first, second] = buf.query({});
    expect(first).toMatchObject({ level: 20, msg: 'hello', requestId: 'r1', time: expect.any(Number) });
    const text = JSON.stringify(second);
    for (const secret of ['c2VjcmV0', 'k-1', 'sk-ant-1', 'sk-ant-2', 'sk-ant-3']) expect(text).not.toContain(secret);
    expect(second).toMatchObject({ apiKey: '[redacted]', headers: { authorization: '[redacted]' } });
  });
});

describe('http errors', () => {
  it('builds typed HttpErrors', () => {
    const e = conflict('RUN_IN_PROGRESS', 'busy', { runId: 1 });
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toBeInstanceOf(Error);
    expect([e.status, e.code, e.message, e.details]).toEqual([409, 'RUN_IN_PROGRESS', 'busy', { runId: 1 }]);
    expect(unprocessable('X', 'm').status).toBe(422);
    expect(notFound('X', 'm').status).toBe(404);
    expect(tooManyRequests('X', 'm').status).toBe(429);
    expect(badRequest('X', 'm').details).toBeNull();
  });
});

describe('createApp', () => {
  it('ships an empty route registrar list for the integrator', () => {
    expect(Array.isArray(routeRegistrars)).toBe(true);
  });

  it('GET /api/health reports status, db, dataset and LLM state', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      version: pkgVersion,
      time: NOW,
      db: 'ok',
      dataset: { source: 'legacy_customers', target: 'accounts', records: 200 },
      llm: { configured: false, model: 'claude-sonnet-5-5', lastRunStatus: null, lastRunAt: null },
    });
  });

  it('GET /api/health reflects the latest agent run and a configured key', async () => {
    const { app, deps } = makeApp({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL: 'claude-opus-5-5' });
    const ins = deps.db.prepare(
      `INSERT INTO agent_runs (migration_id, status, mode, model, created_at) VALUES (1, ?, 'live', 'm', ?)`,
    );
    ins.run('failed', '2026-10-03T10:00:00.000Z');
    ins.run('succeeded', '2026-10-03T11:00:00.000Z');
    const body = (await (await app.request('/api/health')).json()) as { llm: unknown };
    expect(body.llm).toEqual({
      configured: true,
      model: 'claude-opus-5-5',
      lastRunStatus: 'succeeded',
      lastRunAt: '2026-10-03T11:00:00.000Z',
    });
  });

  it('GET /api/health is 503 with db "error" when the database is unavailable', async () => {
    const { app, deps } = makeApp();
    deps.db.close();
    const res = await app.request('/api/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'error', db: 'error', llm: { lastRunStatus: null } });
  });

  it('basic auth guards everything except GET /api/health', async () => {
    const { app } = makeApp({ BASIC_AUTH_USER: 'grader', BASIC_AUTH_PASS: 's3cret-pass' });
    expect((await app.request('/api/health')).status).toBe(200);

    const denied = await app.request('/api/logs');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/^Basic/);
    const env = (await denied.json()) as Envelope;
    expect(env.error).toMatchObject({ code: 'UNAUTHORIZED', requestId: denied.headers.get('x-request-id') });

    expect((await app.request('/api/logs', { headers: { authorization: basic('grader', 'wrong') } })).status).toBe(401);
    expect((await app.request('/', { headers: {} })).status).toBe(401);
    expect((await app.request('/api/logs', { headers: { authorization: basic('grader', 's3cret-pass') } })).status).toBe(
      200,
    );
  });

  it('never writes the Authorization header value to the logs', async () => {
    const { app, deps } = makeApp({ BASIC_AUTH_USER: 'grader', BASIC_AUTH_PASS: 's3cret-pass' });
    const auth = basic('grader', 's3cret-pass');
    await app.request('/api/logs', { headers: { authorization: auth } });
    await app.request('/api/logs', { headers: { authorization: basic('grader', 'wrong-pass') } });
    const text = JSON.stringify(deps.logBuffer.query({}));
    expect(text).not.toContain(auth.slice(6));
    expect(text).not.toContain('s3cret-pass');
    expect(text).not.toContain('wrong-pass');
  });

  it('echoes a valid incoming x-request-id and replaces an invalid one', async () => {
    const { app } = makeApp();
    const reused = await app.request('/api/health', { headers: { 'x-request-id': 'abc_DEF-123' } });
    expect(reused.headers.get('x-request-id')).toBe('abc_DEF-123');
    const replaced = await app.request('/api/health', { headers: { 'x-request-id': 'bad id; drop table' } });
    expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const fresh = await app.request('/api/health');
    expect(fresh.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown /api routes return the 404 envelope with the request id', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/nope', { headers: { 'x-request-id': 'req-404' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: expect.stringContaining('/api/nope'), details: null, requestId: 'req-404' },
    });
  });

  describe('error envelopes from registrar routes', () => {
    const testRoutes: RouteRegistrar = (app, deps) => {
      app.get('/api/test/conflict', () => {
        throw conflict('RUN_IN_PROGRESS', 'A run is already in progress', { runId: 7 });
      });
      app.get('/api/test/zod', () => {
        z.object({ reviewer: z.string() }).parse({});
        return new Response('unreachable');
      });
      app.get('/api/test/boom', () => {
        throw new Error('secret internal detail');
      });
      app.post('/api/test/echo', async (c) => c.json({ got: await c.req.json(), now: deps.now() }));
    };

    it('HttpError ⇒ its status, code, message and details', async () => {
      const { app } = makeApp({}, [testRoutes]);
      const res = await app.request('/api/test/conflict', { headers: { 'x-request-id': 'r-409' } });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: { code: 'RUN_IN_PROGRESS', message: 'A run is already in progress', details: { runId: 7 }, requestId: 'r-409' },
      });
    });

    it('ZodError ⇒ 422 VALIDATION_FAILED with issues as details', async () => {
      const { app } = makeApp({}, [testRoutes]);
      const res = await app.request('/api/test/zod');
      expect(res.status).toBe(422);
      const env = (await res.json()) as Envelope;
      expect(env.error.code).toBe('VALIDATION_FAILED');
      expect(env.error.details).toEqual([expect.objectContaining({ path: ['reviewer'] })]);
      expect(env.error.requestId).toBe(res.headers.get('x-request-id'));
    });

    it('unexpected Error ⇒ 500 INTERNAL without leaking message or stack; logged with stack', async () => {
      const { app, deps } = makeApp({}, [testRoutes]);
      const res = await app.request('/api/test/boom', { headers: { 'x-request-id': 'r-500' } });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('secret internal detail');
      expect(text).not.toMatch(/at .*\.ts/);
      expect(JSON.parse(text)).toEqual({
        error: { code: 'INTERNAL', message: expect.any(String), details: null, requestId: 'r-500' },
      });
      const logged = deps.logBuffer.query({ requestId: 'r-500', minLevel: 50 });
      expect(JSON.stringify(logged)).toContain('secret internal detail');
      expect(JSON.stringify(logged)).toMatch(/stack/);
    });

    it('malformed JSON body ⇒ 400 BAD_JSON; valid JSON reaches the route', async () => {
      const { app } = makeApp({}, [testRoutes]);
      const bad = await app.request('/api/test/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":',
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as Envelope).error.code).toBe('BAD_JSON');
      const ok = await app.request('/api/test/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });
      expect(await ok.json()).toEqual({ got: { a: 1 }, now: NOW });
    });

    it('bodies over 1 MB ⇒ 413 PAYLOAD_TOO_LARGE', async () => {
      const { app } = makeApp({}, [testRoutes]);
      const res = await app.request('/api/test/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024) }),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as Envelope).error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  it('access logs reach the buffer and /api/logs filters them by requestId', async () => {
    const { app } = makeApp();
    await app.request('/api/health', { headers: { 'x-request-id': 'trace-me' } });
    await app.request('/api/nope', { headers: { 'x-request-id': 'other' } });
    const res = await app.request('/api/logs?requestId=trace-me');
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: LogEntry[] };
    expect(entries).toEqual([
      expect.objectContaining({
        level: 30,
        requestId: 'trace-me',
        method: 'GET',
        path: '/api/health',
        status: 200,
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('/api/logs supports minLevel (number or label) and limit, and validates its query', async () => {
    const { app, deps } = makeApp();
    deps.logger.warn({ requestId: 'w' }, 'careful');
    deps.logger.error({ requestId: 'e' }, 'broken');
    const byNumber = (await (await app.request('/api/logs?minLevel=40')).json()) as { entries: LogEntry[] };
    expect(byNumber.entries.map((e) => e.msg)).toEqual(['careful', 'broken']);
    const byLabel = (await (await app.request('/api/logs?minLevel=error&limit=5')).json()) as { entries: LogEntry[] };
    expect(byLabel.entries.map((e) => e.msg)).toEqual(['broken']);
    const limited = (await (await app.request('/api/logs?limit=1')).json()) as { entries: LogEntry[] };
    expect(limited.entries).toHaveLength(1);
    const invalid = await app.request('/api/logs?limit=-3');
    expect(invalid.status).toBe(422);
  });

  describe('static web shell', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-static-'));
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
      return () => fs.rmSync(dir, { recursive: true, force: true });
    });

    it('serves files, falls back to index.html for client routes, and keeps /api 404s as JSON', async () => {
      const { app } = makeApp({ STATIC_DIR: dir });
      const asset = await app.request('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe('console.log(1)');
      const root = await app.request('/');
      expect(await root.text()).toContain('id="root"');
      const spa = await app.request('/some/client/route');
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain('id="root"');
      const api = await app.request('/api/missing');
      expect(api.status).toBe(404);
      expect(((await api.json()) as Envelope).error.code).toBe('NOT_FOUND');
    });
  });
});
