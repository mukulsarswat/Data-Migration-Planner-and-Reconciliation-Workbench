// HTTP app: request id → access log → basic auth → body limit → routes, one error envelope for everything,
// and the built web shell served as a SPA. Route modules plug in through RouteRegistrars.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/connection.ts';
import type { Dataset } from './dataset/load.ts';
import type { LogBuffer } from './logger.ts';
import { HttpError } from './http/errors.ts';

export type AppEnv = { Variables: { requestId: string } };
export type AppDeps = { db: Db; config: Config; logger: Logger; logBuffer: LogBuffer; dataset: Dataset; now: () => string };
export type RouteRegistrar = (app: Hono<AppEnv>, deps: AppDeps) => void;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 1024 * 1024;
/** Envelope code + message for framework-raised HTTPExceptions (basic auth, …). */
const HTTP_ERRORS: Record<number, [code: string, message: string]> = {
  400: ['BAD_REQUEST', 'Bad request'],
  401: ['UNAUTHORIZED', 'Authentication required'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not found'],
  413: ['PAYLOAD_TOO_LARGE', 'Request body is too large'],
};
const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const LEVEL_VALUES = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

function envelope(c: Context<AppEnv>, status: number, code: string, message: string, details: unknown = null) {
  return c.json(
    { error: { code, message, details, requestId: c.get('requestId') ?? null } },
    status as ContentfulStatusCode,
  );
}

const LogsQuery = z.object({
  requestId: z.string().min(1).max(64).optional(),
  minLevel: z
    .union([z.coerce.number().int().min(0), z.enum(LEVEL_NAMES)])
    .transform((v) => (typeof v === 'number' ? v : LEVEL_VALUES[v]))
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function createApp(deps: AppDeps, registrars: readonly RouteRegistrar[] = []): Hono<AppEnv> {
  const { db, config, logger, logBuffer, dataset } = deps;
  const app = new Hono<AppEnv>();

  // Request id: reuse a well-formed incoming one, otherwise mint one; echoed on every response.
  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId); // clones the response if it is already finalized (immutable headers)
  });

  // Hono's error handler only sees Error instances: normalise anything else thrown downstream so it still gets
  // the 500 envelope (with request id) and an error log line instead of escaping the app.
  app.use('*', async (_c, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error(`Non-Error value thrown: ${String(err)}`);
    }
  });

  // Security headers: strict CSP (the built SPA has no inline scripts; React style props need 'unsafe-inline' styles),
  // no framing (clickjacking), nosniff, no referrer.
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
    }),
  );

  // Access log (never includes headers, so credentials cannot leak into logs).
  app.use('*', async (c, next) => {
    const start = performance.now();
    await next();
    const status = c.res.status;
    const entry = {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Math.round((performance.now() - start) * 10) / 10,
    };
    if (status >= 500) logger.error(entry, 'request failed');
    else logger.info(entry, 'request');
  });

  // CSRF: browsers re-send cached Basic-auth credentials cross-site, so state-changing requests must come from our own
  // origin. Cross-site/same-site fetch metadata or a foreign Origin ⇒ 403. Non-browser clients (no such headers) pass.
  app.use('*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const site = c.req.header('sec-fetch-site');
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
    let foreignOrigin = false;
    if (origin) {
      try {
        foreignOrigin = new URL(origin).host !== host;
      } catch {
        foreignOrigin = true;
      }
    }
    if ((site && site !== 'same-origin' && site !== 'none') || foreignOrigin) {
      return envelope(c, 403, 'CSRF_REJECTED', 'Cross-site requests cannot change state; use the workbench UI on this origin');
    }
    return next();
  });

  if (config.basicAuth) {
    const auth = basicAuth({ username: config.basicAuth.user, password: config.basicAuth.pass, realm: 'Migration Workbench' });
    const isHealth = (c: Context) => c.req.path === '/api/health' && (c.req.method === 'GET' || c.req.method === 'HEAD');
    app.use('*', async (c, next) => (isHealth(c) ? next() : auth(c, next)));
  }

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB');
      },
    }),
  );

  app.get('/api/health', (c) => {
    let dbOk = true;
    let last: { status: string; created_at: string } | undefined;
    try {
      db.prepare('SELECT 1').get();
      last = db.prepare('SELECT status, created_at FROM agent_runs ORDER BY id DESC LIMIT 1').get() as typeof last;
    } catch (err) {
      dbOk = false;
      logger.error({ requestId: c.get('requestId'), err }, 'health: database check failed');
    }
    return c.json(
      {
        status: dbOk ? 'ok' : 'error',
        version: config.version,
        time: deps.now(),
        db: dbOk ? 'ok' : 'error',
        dataset: { source: dataset.source.name, target: dataset.target.name, records: dataset.records.length },
        llm: {
          configured: config.anthropic.apiKey !== null,
          model: config.anthropic.model,
          lastRunStatus: last?.status ?? null,
          lastRunAt: last?.created_at ?? null,
        },
      },
      dbOk ? 200 : 503,
    );
  });

  app.get('/api/logs', (c) => {
    const q = LogsQuery.parse(c.req.query());
    return c.json({ entries: logBuffer.query(q) });
  });

  for (const register of registrars) register(app, deps);

  // Built web shell: real files first, then index.html for client-side routes. /api never falls through to it.
  const staticRoot = path.resolve(config.staticDir);
  if (fs.existsSync(staticRoot)) {
    const files = serveStatic<AppEnv>({ root: staticRoot });
    const spa = serveStatic<AppEnv>({ root: staticRoot, path: 'index.html' });
    const skipApi = (h: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> => (c, next) =>
      isApiPath(c.req.path) ? next() : h(c, next);
    app.get('*', skipApi(files), skipApi(spa));
  }

  app.notFound((c) => envelope(c, 404, 'NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`));

  app.onError(async (err, c) => {
    if (err instanceof HttpError) return envelope(c, err.status, err.code, err.message, err.details);
    if (err instanceof z.core.$ZodError) return envelope(c, 422, 'VALIDATION_FAILED', 'Request validation failed', err.issues);
    // c.req.json() surfaces malformed bodies as a SyntaxError after reading the body text. Only call it BAD_JSON
    // when the cached body really fails to parse; any other SyntaxError is a server bug (500).
    if (err instanceof HTTPException && /malformed json/i.test(err.message)) {
      return envelope(c, 400, 'BAD_JSON', 'Request body is not valid JSON');
    }
    if (err instanceof SyntaxError && ('text' in c.req.bodyCache || 'json' in c.req.bodyCache || 'arrayBuffer' in c.req.bodyCache)) {
      const malformed = await c.req
        .text()
        .then((t) => {
          JSON.parse(t);
          return false;
        })
        .catch(() => true);
      if (malformed) return envelope(c, 400, 'BAD_JSON', 'Request body is not valid JSON');
    }
    if (err instanceof HTTPException) {
      // Framework errors (basic auth 401, …): our envelope, keeping the WWW-Authenticate challenge.
      const [code, message] = HTTP_ERRORS[err.status] ?? ['HTTP_ERROR', 'Request failed'];
      const res = envelope(c, err.status, code, err.message || message);
      const challenge = err.res?.headers.get('www-authenticate');
      if (challenge) res.headers.set('www-authenticate', challenge);
      return res;
    }
    logger.error({ requestId: c.get('requestId'), err }, 'unhandled error');
    return envelope(c, 500, 'INTERNAL', 'Internal server error');
  });

  return app;
}
