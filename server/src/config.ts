// Process configuration: environment variables parsed once with zod. Defaults mirror .env.example.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export type Config = {
  port: number;
  dbPath: string;
  staticDir: string;
  logLevel: string;
  logToStdout: boolean;
  anthropic: {
    apiKey: string | null;
    model: string;
    effort: 'low' | 'medium' | 'high';
    maxIterations: number;
    timeoutMs: number;
  };
  /** HTTP Basic auth for every route except GET /api/health; null = open. */
  basicAuth: { user: string; pass: string } | null;
  /** Agent-run caps per UTC day. */
  caps: { perIpPerDay: number; globalPerDay: number };
  allowFaultInjection: boolean;
  /** Behind a reverse proxy (Railway): take the client IP from the right-most X-Forwarded-For hop the proxy appended. */
  trustProxy: boolean;
  version: string;
};

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const int = (def: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: int(8787, 0, 65535),
  DB_PATH: z.string().default('./data/workbench.db'),
  STATIC_DIR: z.string().default('./dist'),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_TO_STDOUT: bool(true),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AGENT_MAX_ITERATIONS: int(8, 1),
  AGENT_TIMEOUT_MS: int(180_000, 1),
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASS: z.string().optional(),
  AGENT_RUNS_PER_IP_PER_DAY: int(10, 0),
  AGENT_RUNS_GLOBAL_PER_DAY: int(60, 0),
  ALLOW_FAULT_INJECTION: bool(true),
});

function packageVersion(): string {
  const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
  return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

/** Fail closed: a half-configured login must not silently leave every route (incl. paid LLM runs) public. */
function basicAuthOf(user: string | undefined, pass: string | undefined): Config['basicAuth'] {
  if (user && pass) return { user, pass };
  if (user || pass) throw new Error('Invalid configuration: set both BASIC_AUTH_USER and BASIC_AUTH_PASS (or neither)');
  return null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // `KEY=` in an env file means "unset": drop empty strings so defaults (and nulls) apply.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    dbPath: e.DB_PATH,
    staticDir: e.STATIC_DIR,
    logLevel: e.LOG_LEVEL,
    logToStdout: e.LOG_TO_STDOUT,
    anthropic: {
      apiKey: e.ANTHROPIC_API_KEY ?? null,
      model: e.ANTHROPIC_MODEL,
      effort: e.ANTHROPIC_EFFORT,
      maxIterations: e.AGENT_MAX_ITERATIONS,
      timeoutMs: e.AGENT_TIMEOUT_MS,
    },
    basicAuth: basicAuthOf(e.BASIC_AUTH_USER, e.BASIC_AUTH_PASS),
    caps: { perIpPerDay: e.AGENT_RUNS_PER_IP_PER_DAY, globalPerDay: e.AGENT_RUNS_GLOBAL_PER_DAY },
    allowFaultInjection: e.ALLOW_FAULT_INJECTION,
    trustProxy: e.TRUST_PROXY,
    version: packageVersion(),
  };
}
