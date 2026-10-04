// Test helpers: an in-memory workbench wired exactly like production (minus HTTP listener and stdout logs).
import { loadDataset, type Dataset } from '../src/dataset/load.ts';
import { openDb, type Db } from '../src/db/connection.ts';
import { loadConfig } from '../src/config.ts';
import { LogBuffer, createLogger } from '../src/logger.ts';
import type { AppDeps } from '../src/app.ts';
import { createVersion, decide } from '../src/services/plans.ts';
import { runDryRun } from '../src/services/runs.ts';

let cachedDataset: Dataset | null = null;
export function dataset(): Dataset {
  return (cachedDataset ??= loadDataset());
}

export function makeDeps(env: Record<string, string> = {}): AppDeps {
  const ds = dataset();
  const logBuffer = new LogBuffer(500);
  const logger = createLogger({ level: 'info', buffer: logBuffer, stdout: false });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0) + 1000 * tick++).toISOString();
  const db = openDb(':memory:', { dataset: ds, now });
  const config = loadConfig({ LOG_TO_STDOUT: 'false', ALLOW_FAULT_INJECTION: 'true', ...env });
  return { db, config, logger, logBuffer, dataset: ds, now };
}

/** Workspace 1 with the gold plan as v1, approved and dry-run: ready to execute. */
export function readyToExecute(env: Record<string, string> = {}): { deps: AppDeps; version: number } {
  const deps = makeDeps(env);
  const v = createVersion(deps, { migrationId: 1, plan: deps.dataset.goldPlan, author: 'user', actor: 'test', parentVersion: null, changeNote: 'gold' });
  decide(deps, 1, v.version, 'approved', 'test', '');
  runDryRun(deps, 1, v.version, 'test');
  return { deps, version: v.version };
}

/** Business-column projection of the target, ordered by key (ignores surrogate ids and lineage). */
export function targetProjection(db: Db): unknown[] {
  return db
    .prepare(
      'SELECT external_ref, first_name, last_name, email, phone_e164, status, created_on, balance_cents, is_vip, country FROM tgt_accounts ORDER BY external_ref',
    )
    .all();
}
