// Report-only performance check at the documented maximum sample size (500 records). `npm run bench`
import { loadDataset, type Dataset } from '../server/src/dataset/load.ts';
import { openDb } from '../server/src/db/connection.ts';
import { loadConfig } from '../server/src/config.ts';
import { LogBuffer, createLogger } from '../server/src/logger.ts';
import { dryRun } from '../server/src/engine/dryRun.ts';
import { createVersion, decide, planHashOf } from '../server/src/services/plans.ts';
import { execute, rollback, runDryRun } from '../server/src/services/runs.ts';
import { reconcile } from '../server/src/services/reconcile.ts';
import { MAX_SAMPLE_SIZE } from '../shared/schemas.ts';

const base = loadDataset();
// Scale the 200 fixture rows to the 500-row maximum with fresh keys (same defect mix).
const records = Array.from({ length: MAX_SAMPLE_SIZE }, (_, i) => {
  const src = base.records[i % base.records.length]!;
  const n = String(i + 1).padStart(4, '0');
  const custId = i < base.records.length ? src.values.cust_id! : `C-${String(30000 + i).padStart(5, '0')}`;
  return { sourceKey: `r${n}`, values: { ...src.values, cust_id: custId } };
});
const dataset: Dataset = { ...base, records };

const time = (label: string, budgetMs: number, fn: () => void, runs = 15) => {
  for (let i = 0; i < 3; i++) fn(); // warm-up: measure steady state, not JIT/GC start-up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(runs / 2)]!;
  const p95 = samples[Math.floor(runs * 0.95)]!;
  console.log(`${label.padEnd(34)} p50 ${p50.toFixed(1).padStart(6)} ms  p95 ${p95.toFixed(1).padStart(6)} ms  budget ${budgetMs} ms  ${p95 <= budgetMs ? 'OK' : 'OVER'}`);
};

const hash = planHashOf(base.goldPlan);
time(`dry run (pure, ${records.length} rows)`, 50, () => void dryRun(records, base.goldPlan, base.target, hash));

const logBuffer = new LogBuffer(100);
const logger = createLogger({ level: 'silent', buffer: logBuffer, stdout: false });
const now = () => new Date().toISOString();
const db = openDb(':memory:', { dataset, now });
const deps = { db, config: loadConfig({ LOG_TO_STDOUT: 'false' }), logger, logBuffer, dataset, now };
const v = createVersion(deps, { migrationId: 1, plan: base.goldPlan, author: 'user', actor: 'bench', parentVersion: null, changeNote: 'bench' });
decide(deps, 1, v.version, 'approved', 'bench', '');
time(`dry run + persist evidence (${records.length})`, 100, () => void runDryRun(deps, 1, v.version, 'bench'), 5);
time(`execute + rollback (${records.length} rows)`, 200, () => {
  execute(deps, 1, { version: v.version, actor: 'bench' });
  rollback(deps, 1, 'bench');
}, 5);
execute(deps, 1, { version: v.version, actor: 'bench' });
time('reconcile', 100, () => void reconcile(deps, 1), 5);
console.log(`rss ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);
