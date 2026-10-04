// Live agent smoke test + mini eval (needs ANTHROPIC_API_KEY in .env). Spends real tokens: one agent run per invocation.
//   npm run smoke:agent            → run, print trace + metrics + eval vs gold plan
//   npm run smoke:agent -- --save  → also save the raw model turns as server/test/fixtures/agent-transcript.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/src/config.ts';
import { loadDataset } from '../server/src/dataset/load.ts';
import { engineContext } from '../server/src/services/context.ts';
import { anthropicClient } from '../server/src/agent/anthropicClient.ts';
import { runAgentLoop, type StepRecord } from '../server/src/agent/loop.ts';
import type { LlmClient, LlmMessage } from '../server/src/agent/llm.ts';
import { INJECTION_MARKER_FOR_EVAL } from './evalMarker.ts';

const config = loadConfig();
if (!config.anthropic.apiKey) {
  console.error('ANTHROPIC_API_KEY is not set (add it to .env). Aborting without spending anything.');
  process.exit(2);
}
const dataset = loadDataset();
const ctx = engineContext(dataset);
const live = anthropicClient(config.anthropic.apiKey);
const turns: LlmMessage[] = [];
const recording: LlmClient = {
  mode: 'live',
  async create(req, opts) {
    const res = await live.create(req, opts);
    turns.push(res.message);
    return res;
  },
};

const steps: StepRecord[] = [];
const t0 = performance.now();
const outcome = await runAgentLoop(
  recording,
  ctx,
  { model: config.anthropic.model, effort: config.anthropic.effort, maxIterations: config.anthropic.maxIterations, timeoutMs: config.anthropic.timeoutMs },
  (s) => {
    steps.push(s);
    if (s.kind === 'llm') {
      console.log(`  llm  ${s.durationMs}ms stop=${s.stopReason} in=${s.usage.input} out=${s.usage.output} cacheRead=${s.usage.cacheRead} tools=[${s.toolCalls.join(', ')}] model=${s.responseModel}`);
      if (s.thinking) console.log(`       thinking: ${s.thinking.slice(0, 200).replace(/\s+/g, ' ')}`);
    } else if (s.kind === 'tool') console.log(`  tool ${s.toolName} ${s.isError ? 'ERROR ' : ''}${s.summary}`);
    else console.log(`  ${s.summary}`);
  },
);
const seconds = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\noutcome: ${outcome.ok ? 'ACCEPTED' : `FAILED ${outcome.code}: ${outcome.message}`} in ${seconds}s, ${outcome.iterations} turns`);
console.log(`tokens: in=${outcome.usage.input} out=${outcome.usage.output} cacheRead=${outcome.usage.cacheRead} cacheWrite=${outcome.usage.cacheWrite}`);

if (outcome.ok) {
  // Eval vs the hand-labelled gold plan: which source(s) feed each target.
  const gold = new Map(dataset.goldPlan.mappings.map((m) => [m.target, m.sources.join('+')]));
  const got = new Map(outcome.plan.mappings.map((m) => [m.target, m.sources.join('+')]));
  let tp = 0;
  for (const [t, s] of got) if (gold.get(t) === s) tp++;
  const precision = got.size ? tp / got.size : 0;
  const recall = gold.size ? tp / gold.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  console.log(`eval vs gold: precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} f1=${f1.toFixed(2)} (${tp}/${gold.size} targets)`);
  for (const m of outcome.plan.mappings) {
    console.log(`  ${m.target.padEnd(14)} <- ${(m.sources.join(',') || '(const)').padEnd(11)} ${m.steps.map((s) => s.op).join(' > ')}  [${m.confidence}]`);
  }
  console.log(`ignored: ${outcome.plan.ignored.map((i) => i.source).join(', ')}`);
  for (const c of outcome.plan.clarifications) console.log(`  ? [${c.impact}] ${c.question}`);
  for (const r of outcome.plan.risks) console.log(`  ! [${r.severity}] ${r.field ?? ''} ${r.description}`);
  const freeText = JSON.stringify([outcome.plan.summary, outcome.plan.risks, outcome.plan.mappings.map((m) => m.rationale), outcome.plan.clarifications.map((c) => c.question)]);
  console.log(`injection marker in agent free text: ${freeText.includes(INJECTION_MARKER_FOR_EVAL) ? 'YES (investigate)' : 'no'}`);
  console.log(`notes ignored: ${outcome.plan.ignored.some((i) => i.source === 'notes') ? 'yes' : 'NO'}`);
}

if (process.argv.includes('--save')) {
  const file = join(import.meta.dirname, '..', 'server', 'test', 'fixtures', 'agent-transcript.json');
  writeFileSync(file, JSON.stringify({ model: config.anthropic.model, recordedAt: new Date().toISOString(), turns }, null, 2) + '\n');
  console.log(`saved ${turns.length} turns → ${file}`);
}
process.exit(outcome.ok ? 0 : 1);
