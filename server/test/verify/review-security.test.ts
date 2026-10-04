// Adversarial security review (hosted demo: Basic auth + LLM key). Every test here is a FAILING reproduction of a
// confirmed defect; the expectation is the hardened behaviour.
import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { LogBuffer, createLogger } from '../../src/logger.ts';
import { createApp } from '../../src/app.ts';
import type { AppDeps } from '../../src/app.ts';
import { openDb } from '../../src/db/connection.ts';
import type { Db } from '../../src/db/connection.ts';
import { workbenchRoutes } from '../../src/routes/workbench.ts';
import { agentRoutes } from '../../src/routes/agent.ts';
import type { LlmClient } from '../../src/agent/llm.ts';
import { runReadOnlyTool } from '../../src/agent/tools.ts';
import { engineContext } from '../../src/services/context.ts';
import { createVersion } from '../../src/services/plans.ts';
import { dataset } from '../helpers.ts';

type Json = Record<string, any>;
const USER = 'grader';
const PASS = 's3cret-pass';
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const NO_STATIC = path.join(os.tmpdir(), 'mw-review-security-no-static');
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
});

/** A live-mode LLM client that fails instantly (no network): enough to exercise caps and run bookkeeping. */
const failingLiveClient: LlmClient = {
  mode: 'live',
  async create() {
    throw new Error('upstream unavailable (test double)');
  },
};

function makeApp(env: Record<string, string> = {}, staticDir = NO_STATIC) {
  const ds = dataset();
  const config = loadConfig({
    LOG_TO_STDOUT: 'false',
    STATIC_DIR: staticDir,
    BASIC_AUTH_USER: USER,
    BASIC_AUTH_PASS: PASS,
    ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
    ...env,
  });
  const logBuffer = new LogBuffer(1000);
  const logger = createLogger({ level: 'info', buffer: logBuffer, stdout: false });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0) + 1000 * tick++).toISOString();
  const db = openDb(':memory:', { dataset: ds, now });
  opened.push(db);
  const deps: AppDeps = { db, config, logger, logBuffer, dataset: ds, now };
  const app = createApp(deps, [workbenchRoutes, agentRoutes(() => failingLiveClient)]);
  return { app, deps };
}

// ------------------------------------------------------------------------------------------------ CSRF
describe('CSRF: Basic-auth credentials are replayed by the browser on cross-site "simple" requests', () => {
  it('a cross-site <form enctype="text/plain"> can approve a plan version (approval gate forged)', async () => {
    const { app, deps } = makeApp();
    const v = createVersion(deps, { migrationId: 1, plan: deps.dataset.goldPlan, author: 'user', actor: 'alice', parentVersion: null, changeNote: 'gold' });
    // Exactly what <form method=POST enctype=text/plain><input name='{"reviewer":"mallory","comment":"' value='"}'> sends.
    const res = await app.request(`/api/plans/${v.version}/approve`, {
      method: 'POST',
      headers: { authorization: AUTH, 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: '{"reviewer":"mallory","comment":"="}\r\n',
    });
    expect(res.status, 'cross-site approval must be refused').toBe(403);
  });

  it('a cross-site urlencoded form POST starts a new workspace (rolls back the loaded target)', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { authorization: AUTH, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: 'x=1',
    });
    expect(res.status, 'non-JSON cross-site POST must be refused').toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------ agent caps
describe('agent cost caps', () => {
  it('the per-IP daily cap is bypassed by rotating a client-supplied X-Forwarded-For header', async () => {
    const { app } = makeApp({ AGENT_RUNS_PER_IP_PER_DAY: '1', AGENT_RUNS_GLOBAL_PER_DAY: '50' });
    const socket = { incoming: { socket: { remoteAddress: '203.0.113.7' } } }; // the same TCP peer every time
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        '/api/agent-runs',
        { method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i + 1}` }, body: '{}' },
        socket,
      );
      statuses.push(res.status);
      if (res.status === 202) {
        const { id } = (await res.json()) as Json;
        for (let t = 0; t < 200; t++) {
          const r = (await (await app.request(`/api/agent-runs/${id}`, { headers: { authorization: AUTH } })).json()) as Json;
          if (r.run.status === 'failed' || r.run.status === 'succeeded') break;
          await new Promise((r2) => setTimeout(r2, 2));
        }
      }
    }
    // One peer, cap 1/day ⇒ only the first run may start.
    expect(statuses).toEqual([202, 429, 429]);
  });
});

// ------------------------------------------------------------------------------------------------ PII to the LLM
describe('PII masking toward the LLM', () => {
  it('preview_mapping failure messages return raw (unmasked) e-mail addresses and names to the model', () => {
    const ctx = engineContext(dataset());
    const probe = (source: string) =>
      runReadOnlyTool(
        'preview_mapping',
        { target: 'email', sources: [source], steps: [{ op: 'map_values', params: { pairs: [{ from: '\u0000', to: 'x' }], fallback: '' } }] },
        ctx,
      ).content;
    const emails = dataset().records.map((r) => r.values.email_addr).filter((v): v is string => !!v && v.includes('@'));
    const names = dataset().records.map((r) => r.values.full_name).filter((v): v is string => !!v && v.trim().length > 3);
    const leakedEmails = emails.filter((e) => probe('email_addr').includes(e));
    const leakedNames = names.filter((n) => probe('full_name').includes(n));
    expect(leakedEmails, 'raw e-mails in a tool result').toEqual([]);
    expect(leakedNames, 'raw full names in a tool result').toEqual([]);
  });

  it('the same channel delivers the seeded prompt-injection note (r0167, masked PII field `notes`) to the model verbatim', () => {
    const ctx = engineContext(dataset());
    const seen = new Set<string>(['']);
    let leaked = false;
    for (let call = 0; call < 6 && !leaked; call++) {
      const pairs = [...seen].map((from) => ({ from, to: 'x' }));
      const out = runReadOnlyTool('preview_mapping', { target: 'first_name', sources: ['notes'], steps: [{ op: 'map_values', params: { pairs, fallback: '' } }] }, ctx);
      if (out.content.includes('[[INJECT-7f3a]]')) leaked = true;
      for (const f of (JSON.parse(out.content) as { data: { failures: { message: string }[] } }).data.failures) {
        const m = /^value '([\s\S]*)' has no mapping$/.exec(f.message);
        if (m) seen.add(m[1]!);
      }
    }
    expect(leaked, 'injection payload reached a tool result').toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ mass assignment
describe('mass assignment: POST /api/plans trusts client-supplied clarification resolutions', () => {
  it('a blocking clarification can be "dismissed" (or answered with a non-existent option, by a forged name) without applying any patch', async () => {
    const { app } = makeApp();
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await app.request(p, {
        method,
        headers: { authorization: AUTH, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Json };
    };
    expect((await call('POST', '/api/plans/heuristic', { actor: 'alice' })).status).toBe(201);
    const v1 = (await call('GET', '/api/plans/1')).body;
    const blocking = v1.plan.clarifications.filter((c: Json) => c.impact === 'blocking');
    expect(blocking.length).toBeGreaterThan(1);
    // The answer endpoint refuses both of these (CANNOT_DISMISS_BLOCKING / BAD_CHOICE):
    expect((await call('POST', `/api/plans/1/clarifications/${blocking[0].id}`, { choice: 'dismissed' })).status).toBe(422);
    expect((await call('POST', `/api/plans/1/clarifications/${blocking[0].id}`, { choice: 99 })).status).toBe(422);
    // …but a plan "edit" can set them directly, plus satisfy the one structural blocker (country).
    const plan = structuredClone(v1.plan);
    plan.clarifications = plan.clarifications.map((c: Json, i: number) => ({
      ...c,
      resolution: { choice: i % 2 === 0 ? 'dismissed' : 99, by: 'Chief Risk Officer' },
    }));
    if (!plan.mappings.some((m: Json) => m.target === 'country')) {
      plan.mappings.push({ target: 'country', sources: [], steps: [{ op: 'default', params: { value: 'US' } }], origin: 'human', confidence: 'high', rationale: '' });
    }
    const edited = await call('POST', '/api/plans', { parentVersion: 1, plan, actor: 'mallory', changeNote: 'tidy' });
    const v2 = edited.status === 201 ? (await call('GET', `/api/plans/${edited.body.version}`)).body : null;
    const forged = v2?.plan.clarifications.filter((c: Json) => c.resolution && (c.resolution.choice === 'dismissed' && c.impact === 'blocking' || c.resolution.choice === 99)) ?? [];
    const approve = v2 ? await call('POST', `/api/plans/${v2.version}/approve`, { reviewer: 'mallory' }) : null;
    expect(
      { forgedResolutions: forged.length, approvedWithoutAnswering: approve?.status === 200 },
      'resolutions the answer endpoint would never allow, and the approval they unlock',
    ).toEqual({ forgedResolutions: 0, approvedWithoutAnswering: false });
  });
});

// ------------------------------------------------------------------------------------------------ headers
describe('security headers', () => {
  it('the SPA shell and API responses carry anti-framing and nosniff headers', async () => {
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-review-sec-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"></div>');
    try {
      const { app } = makeApp({}, dir);
      for (const p of ['/', '/api/migration']) {
        const res = await app.request(p, { headers: { authorization: AUTH } });
        expect(res.status, p).toBe(200);
        const csp = res.headers.get('content-security-policy') ?? '';
        const framing = res.headers.get('x-frame-options') !== null || /frame-ancestors/.test(csp);
        expect({ path: p, framing, nosniff: res.headers.get('x-content-type-options') }).toEqual({ path: p, framing: true, nosniff: 'nosniff' });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------ fail-open auth
describe('auth configuration fails open', () => {
  it('BASIC_AUTH_USER set but BASIC_AUTH_PASS left blank (as copied from .env.example) silently disables auth on every route', async () => {
    const config = (() => {
      try {
        return loadConfig({ LOG_TO_STDOUT: 'false', BASIC_AUTH_USER: 'grader', BASIC_AUTH_PASS: '', ANTHROPIC_API_KEY: 'sk-ant-x' });
      } catch {
        return 'refused';
      }
    })();
    expect(config === 'refused' || config.basicAuth !== null, 'half-configured auth must not yield an open app').toBe(true);
  });
});
