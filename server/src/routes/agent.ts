// Agent endpoints. POST answers 202 immediately; the UI polls the run (status + step trace).
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppDeps, AppEnv, RouteRegistrar } from '../app.ts';
import type { LlmClient } from '../agent/llm.ts';
import { anthropicClient } from '../agent/anthropicClient.ts';
import { getAgentRun, listAgentRuns, startAgentRun } from '../services/agentRuns.ts';
import { currentWorkspace } from '../services/workspace.ts';

export type LlmClientFactory = (deps: AppDeps) => LlmClient | null;

export const liveClientFactory: LlmClientFactory = (deps) =>
  deps.config.anthropic.apiKey ? anthropicClient(deps.config.anthropic.apiKey) : null;

/** Client IP for per-IP caps. X-Forwarded-For is client-controlled except for the hop our own proxy appended (the
 *  right-most one), so it is only consulted when TRUST_PROXY is set; otherwise the socket address is used. */
function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const hops = c.req.header('x-forwarded-for')?.split(',').map((h) => h.trim()).filter(Boolean) ?? [];
    const last = hops.at(-1);
    if (last) return last.slice(0, 64);
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

export function agentRoutes(factory: LlmClientFactory = liveClientFactory): RouteRegistrar {
  return (app, deps) => {
    let client: LlmClient | null | undefined;
    const getClient = () => (client === undefined ? (client = factory(deps)) : client);

    app.post('/api/agent-runs', async (c) => {
      const body = z
        .object({
          actor: z.string().trim().min(1).max(60).default('reviewer'),
          basedOnVersion: z.number().int().min(1).nullable().default(null),
          reviewerNotes: z.string().max(1000).nullable().default(null),
        })
        .parse(await c.req.json().catch(() => ({})));
      const ws = currentWorkspace(deps.db).id;
      const { run } = startAgentRun(deps, ws, getClient(), { ...body, clientIp: clientIp(c, deps.config.trustProxy) });
      return c.json(run, 202);
    });

    app.get('/api/agent-runs', (c) => c.json({ items: listAgentRuns(deps, currentWorkspace(deps.db).id) }));

    app.get('/api/agent-runs/:id', (c) => {
      const id = z.coerce.number().int().min(1).parse(c.req.param('id'));
      return c.json(getAgentRun(deps, currentWorkspace(deps.db).id, id));
    });
  };
}
