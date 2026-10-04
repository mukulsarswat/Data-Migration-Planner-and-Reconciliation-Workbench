// Scripted LLM for tests and offline demos: replays canned assistant turns and records every request it received.
import type { LlmClient, LlmContentBlock, LlmMessage, LlmRequest } from './llm.ts';

export type ScriptStep = LlmMessage | ((req: LlmRequest) => LlmMessage) | Error;

export function scriptedClient(steps: readonly ScriptStep[]): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    mode: 'scripted',
    requests,
    async create(request, { signal }) {
      requests.push(structuredClone(request));
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const step = steps[i++];
      if (step === undefined) throw new Error(`scripted client exhausted after ${steps.length} responses`);
      if (step instanceof Error) throw step;
      const message = typeof step === 'function' ? step(request) : step;
      return { message, requestId: `req_scripted_${i}` };
    },
  };
}

/** Build an assistant message for scripts. */
export function assistant(
  content: LlmContentBlock[] | unknown[],
  opts: { stop?: LlmMessage['stop_reason']; inputTokens?: number; outputTokens?: number; cacheRead?: number; model?: string } = {},
): LlmMessage {
  return {
    id: `msg_${Math.abs(hashish(JSON.stringify(content)))}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-sonnet-5-5',
    content: content as LlmContentBlock[],
    stop_reason: opts.stop ?? ((content as { type: string }[]).some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: opts.inputTokens ?? 1200,
      output_tokens: opts.outputTokens ?? 300,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as LlmMessage;
}

export function toolUse(id: string, name: string, input: unknown) {
  return { type: 'tool_use', id, name, input };
}

function hashish(s: string): number {
  let h = 0;
  for (let k = 0; k < s.length; k++) h = (Math.imul(31, h) + s.charCodeAt(k)) | 0;
  return h;
}
