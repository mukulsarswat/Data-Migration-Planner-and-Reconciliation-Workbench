// Live adapter over the official SDK (beta namespace: server-side refusal fallbacks require it).
import Anthropic from '@anthropic-ai/sdk';
import type { AgentFailureCode, LlmClient } from './llm.ts';

export function anthropicClient(apiKey: string, opts: { fetch?: typeof fetch; baseURL?: string } = {}): LlmClient {
  const client = new Anthropic({ apiKey, maxRetries: 1, fetch: opts.fetch, baseURL: opts.baseURL });
  return {
    mode: 'live',
    async create(request, { signal, timeoutMs }) {
      const { data, request_id } = await client.beta.messages
        .create(request, { timeout: timeoutMs, maxRetries: 1, signal })
        .withResponse();
      return { message: data, requestId: request_id ?? null };
    },
  };
}

/** Map SDK errors (most specific first) to stable failure codes. */
export function classifyLlmError(err: unknown): { code: AgentFailureCode; message: string } {
  if (err instanceof Anthropic.APIUserAbortError) return { code: 'TIMEOUT', message: 'The agent run exceeded its time budget' };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { code: 'TIMEOUT', message: 'The model request timed out' };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { code: 'AUTH', message: 'The Anthropic API key was rejected' };
  }
  if (err instanceof Anthropic.RateLimitError) return { code: 'RATE_LIMITED', message: 'The model provider is rate limiting requests' };
  if (err instanceof Anthropic.BadRequestError) return { code: 'BAD_REQUEST', message: `The model request was rejected: ${err.message}` };
  if (err instanceof Anthropic.InternalServerError) return { code: 'UPSTREAM_UNAVAILABLE', message: 'The model provider is unavailable or overloaded' };
  if (err instanceof Anthropic.APIConnectionError) return { code: 'NETWORK', message: 'Could not reach the model provider' };
  if (err instanceof Anthropic.APIError) return { code: 'UPSTREAM_UNAVAILABLE', message: `Model provider error (${String(err.status)})` };
  if (err instanceof Error && err.name === 'AbortError') return { code: 'TIMEOUT', message: 'The agent run exceeded its time budget' };
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Unknown error' };
}
