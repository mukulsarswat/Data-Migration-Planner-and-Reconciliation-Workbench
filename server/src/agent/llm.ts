// LLM port. The loop only depends on this interface, so tests drive it with scripted responses and the real adapter is
// exercised separately with a stubbed fetch (no network in tests).
import type Anthropic from '@anthropic-ai/sdk';

export type LlmRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type LlmMessage = Anthropic.Beta.Messages.BetaMessage;
export type LlmMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type LlmTool = Anthropic.Beta.Messages.BetaTool;
export type LlmContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type LlmToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type LlmCallOptions = { signal: AbortSignal; timeoutMs: number };

export interface LlmClient {
  readonly mode: 'live' | 'scripted';
  create(request: LlmRequest, opts: LlmCallOptions): Promise<{ message: LlmMessage; requestId: string | null }>;
}

/** Stable failure codes surfaced to the UI (each maps to a clear failure state + heuristic fallback CTA). */
export type AgentFailureCode =
  | 'LLM_NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NETWORK'
  | 'REFUSAL'
  | 'TRUNCATED'
  | 'NO_PLAN'
  | 'INVALID_PLAN'
  | 'ITERATION_LIMIT'
  | 'INTERNAL';
