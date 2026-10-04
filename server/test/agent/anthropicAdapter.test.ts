// Contract tests for the REAL Anthropic adapter: the SDK runs against a stubbed fetch (no network), so we verify the exact
// wire request (endpoint, beta header, body) and how provider failures are classified.
import { describe, expect, it } from 'vitest';
import { anthropicClient, classifyLlmError } from '../../src/agent/anthropicClient.ts';
import { buildRequest } from '../../src/agent/loop.ts';
import { lintStrictSchema } from '../../src/agent/strictLint.ts';
import { engineContext } from '../../src/services/context.ts';
import { dataset } from '../helpers.ts';

const ctx = engineContext(dataset());
const request = buildRequest({ model: 'claude-sonnet-5-5', effort: 'medium', maxIterations: 8, timeoutMs: 180_000 }, ctx, [
  { role: 'user', content: 'plan it' },
]);

const okMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  container: null,
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function stub(responses: (() => Response | Promise<Response>)[]) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_123', 'retry-after-ms': '0', ...headers } });
const apiError = (status: number, type: string) => json(status, { type: 'error', error: { type, message: `${type} happened` } });

const opts = (timeoutMs = 5_000) => ({ signal: new AbortController().signal, timeoutMs });

describe('Anthropic adapter (stubbed fetch)', () => {
  it('posts to the beta Messages endpoint with the fallback beta header and the documented body', async () => {
    const { calls, fetchImpl } = stub([json(200, okMessage)]);
    const { message, requestId } = await anthropicClient('test-key', { fetch: fetchImpl }).create(request, opts());
    expect(message.stop_reason).toBe('end_turn');
    expect(requestId).toBe('req_123');
    const call = calls[0]!;
    expect(call.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(call.headers['x-api-key']).toBe('test-key');
    expect(call.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(call.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
    });
    expect(call.body).not.toHaveProperty('betas'); // moved to the header by the SDK
    expect(JSON.stringify(call.body)).not.toContain('budget_tokens');
    expect(JSON.stringify(call.body)).not.toContain('"disabled"');
    const tools = call.body.tools as { name: string; strict?: boolean; input_schema: unknown }[];
    expect(tools).toHaveLength(9);
    for (const t of tools.filter((t) => t.strict)) expect(lintStrictSchema(t.input_schema)).toEqual([]);
  });

  it.each([
    [400, 'invalid_request_error', 'BAD_REQUEST', 1],
    [401, 'authentication_error', 'AUTH', 1],
    [429, 'rate_limit_error', 'RATE_LIMITED', 2],
    [529, 'overloaded_error', 'UPSTREAM_UNAVAILABLE', 2],
    [500, 'api_error', 'UPSTREAM_UNAVAILABLE', 2],
  ])('HTTP %i (%s) ⇒ %s after %i attempt(s)', async (status, type, code, attempts) => {
    const { calls, fetchImpl } = stub([apiError(status, type)]);
    const err = await anthropicClient('k', { fetch: fetchImpl }).create(request, opts()).catch((e: unknown) => e);
    expect(classifyLlmError(err).code).toBe(code);
    expect(calls).toHaveLength(attempts);
  });

  it('network failures ⇒ NETWORK', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await anthropicClient('k', { fetch: fetchImpl }).create(request, opts()).catch((e: unknown) => e);
    expect(classifyLlmError(err).code).toBe('NETWORK');
  });

  it('a hung request is cut off by the timeout ⇒ TIMEOUT', async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
    const t0 = Date.now();
    const err = await anthropicClient('k', { fetch: fetchImpl }).create(request, opts(100)).catch((e: unknown) => e);
    expect(classifyLlmError(err).code).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a run-level abort ⇒ TIMEOUT', async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
    const err = await anthropicClient('k', { fetch: fetchImpl })
      .create(request, { signal: AbortSignal.timeout(50), timeoutMs: 10_000 })
      .catch((e: unknown) => e);
    expect(classifyLlmError(err).code).toBe('TIMEOUT');
  });
});
