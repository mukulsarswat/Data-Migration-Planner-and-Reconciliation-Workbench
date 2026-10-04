// The visible AI-workflow log: every model turn (thinking summary, text, stop reason, tokens) and every read-only tool
// call the agent made, in order. All model-produced text is rendered as plain text and badged "AI-generated".
import type { ReactNode } from 'react';
import type { AgentRun, AgentStep } from '../api.ts';
import { useNav } from '../nav.tsx';
import { Badge, Skeleton, cx } from './ui.tsx';
import { seconds } from './proposalShared.tsx';

// The server writes this placeholder when a model turn had no text (it only called tools); it is not model output.
const TOOL_ONLY_PREFIX = 'model turn → ';

export function TraceTimeline({ run, steps, live }: { run: AgentRun; steps: AgentStep[]; live: boolean }) {
  return (
    <section aria-labelledby={`trace-${run.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`trace-${run.id}`} className="text-sm font-semibold text-slate-900">
          Trace
        </h4>
        <span className="text-xs text-slate-500">
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
        {live && (
          <span className="inline-flex items-center gap-1 text-xs text-sky-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" aria-hidden />
            live
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">Model turns and the read-only tool calls they made, in order. Model text is shown verbatim.</p>

      {steps.length === 0 ? (
        <div className="mt-3">
          {live ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Waiting for the first model turn…</p>
              <Skeleton lines={2} />
            </div>
          ) : (
            <p className="text-xs text-slate-500">No steps were recorded for this run.</p>
          )}
        </div>
      ) : (
        <ol className="mt-3 space-y-2 border-l-2 border-slate-200 pl-4">
          {steps.map((s) => (
            <TraceStep key={s.seq} step={s} runModel={run.model} />
          ))}
          {live && (
            <li className="relative text-xs text-slate-500">
              <Dot className="bg-sky-400 animate-pulse" />
              Waiting for the next step…
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cx('absolute top-1.5 -left-[1.4rem] h-2.5 w-2.5 rounded-full ring-2 ring-white', className)} />;
}

function TraceStep({ step, runModel }: { step: AgentStep; runModel: string }) {
  if (step.kind === 'llm') return <LlmStep step={step} runModel={runModel} />;
  if (step.kind === 'tool') return <ToolStep step={step} />;
  return (
    <li className="relative">
      <Dot className={step.isError ? 'bg-rose-500' : 'bg-amber-400'} />
      <div className={cx('rounded-md border px-3 py-2', step.isError ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50')}>
        <StepHeader seq={step.seq} label="System" durationMs={null}>
          {step.isError && <Badge tone="red">error</Badge>}
        </StepHeader>
        {step.summary && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-800">{step.summary}</p>}
      </div>
    </li>
  );
}

function LlmStep({ step, runModel }: { step: AgentStep; runModel: string }) {
  const nav = useNav();
  const toolOnly = step.summary?.startsWith(TOOL_ONLY_PREFIX) ?? false;
  const fallbackModel = step.model && !step.model.startsWith(runModel) ? step.model : null;
  const t = step.tokens;
  return (
    <li className="relative">
      <Dot className="bg-violet-500" />
      <div className="rounded-md border border-violet-200 bg-white px-3 py-2">
        <StepHeader seq={step.seq} label="Model turn" durationMs={step.durationMs}>
          {step.stopReason && (
            <Badge tone={step.stopReason === 'refusal' || step.stopReason === 'max_tokens' ? 'red' : 'neutral'} title="Stop reason">
              {step.stopReason}
            </Badge>
          )}
          {fallbackModel && (
            <Badge tone="amber" title="The response came from a different model than requested">
              served by {fallbackModel}
            </Badge>
          )}
          <span className="text-xs tabular-nums text-slate-500" title="Input / output / cache-read tokens">
            {fmtTokens(t.input)} in · {fmtTokens(t.output)} out · {fmtTokens(t.cacheRead)} cached
          </span>
          {step.requestId && (
            <button
              className="font-mono text-xs text-indigo-700 underline"
              title="Show the server log lines for this model request"
              onClick={() => nav.showLogs(step.requestId!)}
            >
              {step.requestId.length > 14 ? `${step.requestId.slice(0, 14)}…` : step.requestId}
            </button>
          )}
        </StepHeader>

        {step.thinking && (
          <details className="mt-2 rounded bg-violet-50/60 px-2 py-1">
            <summary className="cursor-pointer text-xs font-medium text-violet-800">
              Thinking summary <AiBadge />
            </summary>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">{step.thinking}</p>
          </details>
        )}

        {step.summary &&
          (toolOnly ? (
            <p className="mt-1 text-xs text-slate-500">Called {step.summary.slice(TOOL_ONLY_PREFIX.length)}</p>
          ) : (
            <div className="mt-2">
              <AiBadge />
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{step.summary}</p>
            </div>
          ))}
      </div>
    </li>
  );
}

function ToolStep({ step }: { step: AgentStep }) {
  return (
    <li className="relative">
      <Dot className={step.isError ? 'bg-rose-500' : 'bg-sky-500'} />
      <div className={cx('rounded-md border px-3 py-2', step.isError ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-slate-50')}>
        <StepHeader
          seq={step.seq}
          label={
            <>
              Tool <code className="font-mono text-sky-800">{step.toolName ?? 'unknown'}</code>
            </>
          }
          durationMs={step.durationMs}
        >
          {step.isError ? <Badge tone="red">error</Badge> : <Badge tone="green">ok</Badge>}
        </StepHeader>
        {step.summary && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">{step.summary}</p>}
        {step.input !== null && step.input !== undefined && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-slate-500">
              Arguments <AiBadge />
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-white p-2 font-mono text-xs text-slate-700 ring-1 ring-slate-200">
              {JSON.stringify(step.input, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

function StepHeader({ seq, label, durationMs, children }: { seq: number; label: ReactNode; durationMs: number | null; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-xs text-slate-400">#{seq}</span>
      <span className="text-xs font-semibold text-slate-800">{label}</span>
      {children}
      {durationMs !== null && <span className="ml-auto text-xs tabular-nums text-slate-500">{seconds(durationMs)}</span>}
    </div>
  );
}

function AiBadge() {
  return (
    <Badge tone="violet" title="Produced by the language model; shown verbatim as plain text">
      AI-generated
    </Badge>
  );
}

const fmtTokens = (n: number | null) => (n === null ? '—' : n.toLocaleString());
