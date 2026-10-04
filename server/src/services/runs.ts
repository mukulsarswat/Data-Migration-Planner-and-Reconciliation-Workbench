// Dry run, execute, retry and rollback. Everything here is synchronous (better-sqlite3): no request can interleave
// with a run, and every mutating run takes the run lock (partial UNIQUE on runs.status='running') inside an
// IMMEDIATE transaction together with its gates.
import type { Db } from '../db/connection.ts';
import type { AppDeps } from '../app.ts';
import type { DryRunCounts, Evidence, ExecuteCounts, LoadOutcome, RecordResult } from '../../../shared/evidence.ts';
import { toTargetRow, businessColumns } from '../../../shared/targetRow.ts';
import { conflict, notFound, unprocessable } from '../http/errors.ts';
import { dryRun } from '../engine/dryRun.ts';
import { hashCanonical } from '../engine/hash.ts';
import { targetTableName } from '../db/targetDdl.ts';
import { appendEvent } from './events.ts';
import { assertExecutable, getVersion, getVersionById, type PlanVersion } from './plans.ts';

export const BATCH_SIZE = 50;

export type RunKind = 'dry_run' | 'execute' | 'rollback';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export type Run = {
  id: number;
  migrationId: number;
  planVersionId: number | null;
  version: number | null;
  planHash: string | null;
  kind: RunKind;
  attempt: number;
  parentRunId: number | null;
  status: RunStatus;
  counts: Record<string, unknown>;
  resultHash: string | null;
  options: Record<string, unknown>;
  actor: string;
  errorCode: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  retriedBy: number | null;
};

type Raw = {
  id: number;
  migration_id: number;
  plan_version_id: number | null;
  version: number | null;
  plan_hash: string | null;
  kind: RunKind;
  attempt: number;
  parent_run_id: number | null;
  status: RunStatus;
  counts: string;
  result_hash: string | null;
  options: string;
  actor: string;
  error_code: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  retried_by: number | null;
};

const SELECT = `SELECT r.*, v.version AS version, (SELECT c.id FROM runs c WHERE c.parent_run_id = r.id) AS retried_by
                FROM runs r LEFT JOIN plan_versions v ON v.id = r.plan_version_id`;

function toRun(r: Raw): Run {
  return {
    id: r.id,
    migrationId: r.migration_id,
    planVersionId: r.plan_version_id,
    version: r.version,
    planHash: r.plan_hash,
    kind: r.kind,
    attempt: r.attempt,
    parentRunId: r.parent_run_id,
    status: r.status,
    counts: JSON.parse(r.counts) as Record<string, unknown>,
    resultHash: r.result_hash,
    options: JSON.parse(r.options) as Record<string, unknown>,
    actor: r.actor,
    errorCode: r.error_code,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    retriedBy: r.retried_by,
  };
}

export function getRun(db: Db, migrationId: number, runId: number): Run {
  const row = db.prepare(`${SELECT} WHERE r.id = ? AND r.migration_id = ?`).get(runId, migrationId) as Raw | undefined;
  if (!row) throw notFound('RUN_NOT_FOUND', `Run #${runId} does not exist in this workspace`);
  return toRun(row);
}

export function listRuns(db: Db, migrationId: number, limit = 50, kinds?: readonly RunKind[]): Run[] {
  const filter = kinds?.length ? `AND r.kind IN (${kinds.map(() => '?').join(', ')})` : '';
  return (
    db.prepare(`${SELECT} WHERE r.migration_id = ? ${filter} ORDER BY r.id DESC LIMIT ?`).all(migrationId, ...(kinds ?? []), limit) as Raw[]
  ).map(toRun);
}

export type RunRecordRow = { sourceKey: string; outcome: string; errors: Evidence[]; transformed: Record<string, unknown> | null; raw: Record<string, string> };

export function listRunRecords(
  db: Db,
  runId: number,
  q: { outcome?: string; offset?: number; limit?: number },
): { total: number; items: RunRecordRow[] } {
  const where = q.outcome ? 'WHERE rr.run_id = ? AND rr.outcome = ?' : 'WHERE rr.run_id = ?';
  const args: unknown[] = q.outcome ? [runId, q.outcome] : [runId];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM run_records rr ${where}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT rr.source_key, rr.outcome, rr.errors, rr.transformed, s.payload
       FROM run_records rr JOIN src_legacy_customers s ON s.source_key = rr.source_key
       ${where} ORDER BY rr.source_key LIMIT ? OFFSET ?`,
    )
    .all(...args, Math.min(q.limit ?? 50, 200), q.offset ?? 0) as { source_key: string; outcome: string; errors: string; transformed: string | null; payload: string }[];
  return {
    total,
    items: rows.map((r) => ({
      sourceKey: r.source_key,
      outcome: r.outcome,
      errors: JSON.parse(r.errors) as Evidence[],
      transformed: r.transformed ? (JSON.parse(r.transformed) as Record<string, unknown>) : null,
      raw: JSON.parse(r.payload) as Record<string, string>,
    })),
  };
}

export function activeLedgerCount(db: Db, migrationId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM load_ledger WHERE migration_id = ? AND rolled_back_at IS NULL').get(migrationId) as { n: number }).n;
}

function latestSucceededDryRun(db: Db, migrationId: number, planHash: string): Run | null {
  const row = db
    .prepare(`${SELECT} WHERE r.migration_id = ? AND r.kind = 'dry_run' AND r.status = 'succeeded' AND r.plan_hash = ? ORDER BY r.id DESC LIMIT 1`)
    .get(migrationId, planHash) as Raw | undefined;
  return row ? toRun(row) : null;
}

/** Accepted keys that already exist in the target and are not owned by this workspace's active ledger. */
export function conflictPreflight(deps: AppDeps, migrationId: number, results: readonly RecordResult[]): string[] {
  const table = targetTableName(deps.dataset.target);
  const keyField = deps.dataset.target.keyField;
  const keys = results.filter((r) => r.outcome === 'accepted').map((r) => String(r.row![keyField]));
  if (!keys.length) return [];
  const rows = deps.db
    .prepare(
      `SELECT t.${keyField} AS k FROM ${table} t
       WHERE t.${keyField} IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM load_ledger l WHERE l.target_id = t.id AND l.migration_id = ? AND l.rolled_back_at IS NULL)
       ORDER BY t.${keyField}`,
    )
    .all(JSON.stringify(keys), migrationId) as { k: string }[];
  return rows.map((r) => r.k);
}

function insertRunRecords(db: Db, runId: number, rows: readonly { sourceKey: string; outcome: string; errors: Evidence[]; transformed: unknown }[]) {
  const stmt = db.prepare('INSERT INTO run_records (run_id, source_key, outcome, errors, transformed) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) stmt.run(runId, r.sourceKey, r.outcome, JSON.stringify(r.errors), r.transformed == null ? null : JSON.stringify(r.transformed));
}

export type DryRunResponse = {
  run: Run;
  counts: DryRunCounts;
  resultHash: string;
  previousResultHash: string | null;
  deterministicMatch: boolean | null;
  conflictPreflight: string[];
  rejectRatePct: number;
  errorBudgetPct: number;
  withinErrorBudget: boolean;
};

export function runDryRun(deps: AppDeps, migrationId: number, version: number, actor: string): DryRunResponse {
  const { db, dataset } = deps;
  const v = getVersion(db, migrationId, version);
  const result = dryRun(dataset.records, v.plan, dataset.target, v.planHash);
  const previous = latestSucceededDryRun(db, migrationId, v.planHash);
  const preflight = conflictPreflight(deps, migrationId, result.results);
  const rejectRatePct = pct(result.counts.rejected, result.counts.source);
  const now = deps.now();
  const runId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO runs (migration_id, plan_version_id, plan_hash, kind, status, counts, result_hash, actor, started_at, finished_at)
         VALUES (?, ?, ?, 'dry_run', 'succeeded', ?, ?, ?, ?, ?)`,
      )
      .run(migrationId, v.id, v.planHash, JSON.stringify({ ...result.counts, conflictPreflight: preflight.length }), result.resultHash, actor, now, now);
    const id = Number(info.lastInsertRowid);
    insertRunRecords(
      db,
      id,
      result.results.map((r) => ({ sourceKey: r.sourceKey, outcome: r.outcome, errors: r.errors, transformed: r.row })),
    );
    appendEvent(
      db,
      {
        migrationId,
        type: 'dry_run_completed',
        actor,
        planVersionId: v.id,
        runId: id,
        payload: {
          version,
          source: result.counts.source,
          transformed: result.counts.transformed,
          accepted: result.counts.accepted,
          rejected: result.counts.rejected,
          resultHash: result.resultHash,
          deterministicMatch: previous ? previous.resultHash === result.resultHash : null,
        },
      },
      now,
    );
    return id;
  }).immediate();
  return {
    run: getRun(db, migrationId, runId),
    counts: result.counts,
    resultHash: result.resultHash,
    previousResultHash: previous?.resultHash ?? null,
    deterministicMatch: previous ? previous.resultHash === result.resultHash : null,
    conflictPreflight: preflight,
    rejectRatePct,
    errorBudgetPct: v.plan.errorBudgetPct,
    withinErrorBudget: rejectRatePct <= v.plan.errorBudgetPct,
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

class FaultInjected extends Error {}

export type ExecuteOptions = { version: number; actor: string; failAfter?: number | null; parentRunId?: number | null };

/** Gated, idempotent load of the approved plan's accepted records into the mock target. */
export function execute(deps: AppDeps, migrationId: number, opts: ExecuteOptions): Run {
  const { db, dataset } = deps;
  const failAfter = opts.failAfter ?? null;
  if (failAfter !== null && !deps.config.allowFaultInjection) throw unprocessable('FAULT_INJECTION_DISABLED', 'Fault injection is disabled on this deployment');
  if (failAfter !== null && (!Number.isInteger(failAfter) || failAfter < 1)) throw unprocessable('BAD_FAIL_AFTER', 'failAfter must be a positive integer');

  // --- Gates + run lock (one IMMEDIATE transaction) ---
  let version!: PlanVersion;
  let dryRunHash!: string;
  const now = deps.now();
  const runId = db.transaction(() => {
    version = assertExecutable(db, migrationId, opts.version);
    const dr = latestSucceededDryRun(db, migrationId, version.planHash);
    if (!dr) throw conflict('DRY_RUN_REQUIRED', `Run a dry run of v${opts.version} before executing it`);
    dryRunHash = dr.resultHash!;
    const drCounts = dr.counts as unknown as DryRunCounts;
    if (failAfter !== null && failAfter >= drCounts.accepted) {
      throw unprocessable('BAD_FAIL_AFTER', `failAfter must be below the ${drCounts.accepted} accepted records, or the simulated failure never happens`);
    }
    const rate = pct(drCounts.rejected, drCounts.source);
    if (rate > version.plan.errorBudgetPct) {
      throw conflict(
        'ERROR_BUDGET_EXCEEDED',
        `Dry-run reject rate ${rate}% exceeds the error budget of ${version.plan.errorBudgetPct}%: fix mappings or raise the budget in a new version`,
        { rejectRatePct: rate, errorBudgetPct: version.plan.errorBudgetPct },
      );
    }
    const foreign = db
      .prepare('SELECT DISTINCT plan_version_id AS id FROM load_ledger WHERE migration_id = ? AND rolled_back_at IS NULL AND plan_version_id <> ?')
      .all(migrationId, version.id) as { id: number }[];
    if (foreign.length) {
      const versions = foreign.map((f) => `v${getVersionById(db, f.id).version}`).join(', ');
      throw conflict('ROLLBACK_REQUIRED', `Rows loaded by ${versions} are still active; roll back before executing v${opts.version}`);
    }
    let attempt = 1;
    if (opts.parentRunId != null) {
      const parent = getRun(db, migrationId, opts.parentRunId);
      attempt = parent.attempt + 1;
    }
    try {
      const info = db
        .prepare(
          `INSERT INTO runs (migration_id, plan_version_id, plan_hash, kind, attempt, parent_run_id, status, options, actor, started_at)
           VALUES (?, ?, ?, 'execute', ?, ?, 'running', ?, ?, ?)`,
        )
        .run(migrationId, version.id, version.planHash, attempt, opts.parentRunId ?? null, JSON.stringify({ failAfter }), opts.actor, now);
      const id = Number(info.lastInsertRowid);
      appendEvent(
        db,
        {
          migrationId,
          type: opts.parentRunId != null ? 'execution_retried' : 'execution_started',
          actor: opts.actor,
          planVersionId: version.id,
          runId: id,
          payload: { version: opts.version, attempt, parentRunId: opts.parentRunId ?? null, failAfter },
        },
        now,
      );
      return id;
    } catch (err) {
      if (isUniqueViolation(err, 'runs.migration_id')) throw conflict('RUN_IN_PROGRESS', 'Another execution or rollback is in progress');
      if (isUniqueViolation(err, 'runs.parent_run_id')) throw conflict('ALREADY_RETRIED', `Run #${opts.parentRunId} was already retried; retry the latest attempt instead`);
      throw err;
    }
  }).immediate();

  // --- Load (synchronous batches; each batch commits atomically) ---
  const counts: ExecuteCounts = { accepted: 0, processed: 0, inserted: 0, skippedExisting: 0, conflict: 0, loadRejected: 0, pending: 0 };
  try {
    const result = dryRun(dataset.records, version.plan, dataset.target, version.planHash);
    if (result.resultHash !== dryRunHash) {
      throw new HashDrift(`Transform output hash ${result.resultHash.slice(0, 12)} differs from the dry run ${dryRunHash.slice(0, 12)}`);
    }
    const accepted = result.results.filter((r) => r.outcome === 'accepted');
    counts.accepted = accepted.length;
    const table = targetTableName(dataset.target);
    const cols = businessColumns(dataset.target);
    const keyField = dataset.target.keyField;
    const findLedger = db.prepare('SELECT target_id FROM load_ledger WHERE migration_id = ? AND source_key = ? AND rolled_back_at IS NULL');
    const targetExists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
    const insertTarget = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}, _load_run_id) VALUES (${cols.map(() => '?').join(', ')}, ?)
       ON CONFLICT(${keyField}) DO NOTHING RETURNING id`,
    );
    const insertLedger = db.prepare(
      `INSERT INTO load_ledger (migration_id, plan_version_id, source_key, target_id, external_ref, run_id, row_hash, inserted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let start = 0; start < accepted.length; start += BATCH_SIZE) {
      const batch = accepted.slice(start, start + BATCH_SIZE);
      const batchCounts = { ...counts };
      db.transaction(() => {
        const records: { sourceKey: string; outcome: LoadOutcome; errors: Evidence[]; transformed: unknown }[] = [];
        for (const r of batch) {
          if (failAfter !== null && batchCounts.processed >= failAfter) {
            throw new FaultInjected(`Simulated failure after ${failAfter} records`);
          }
          const values = toTargetRow(dataset.target, r.row!);
          const key = String(r.row![keyField]);
          const owned = findLedger.get(migrationId, r.sourceKey) as { target_id: number } | undefined;
          let outcome: LoadOutcome;
          const errors: Evidence[] = [];
          if (owned) {
            if (targetExists.get(owned.target_id)) outcome = 'skipped_existing';
            else {
              outcome = 'load_rejected';
              errors.push(loadEvidence(r, keyField, 'LOAD_CONSTRAINT', `Ledger points to target row #${owned.target_id}, which no longer exists`));
            }
          } else {
            try {
              const inserted = db.transaction(() => insertTarget.get(...values, runId) as { id: number } | undefined)();
              if (inserted) {
                insertLedger.run(migrationId, version.id, r.sourceKey, inserted.id, key, runId, hashCanonical(values), now);
                outcome = 'inserted';
              } else {
                outcome = 'conflict';
                errors.push(loadEvidence(r, keyField, 'TARGET_CONFLICT', `${keyField} '${key}' already exists in the target and was not loaded by this workspace`));
              }
            } catch (err) {
              if (!isConstraintError(err)) throw err;
              outcome = 'load_rejected';
              errors.push(loadEvidence(r, keyField, 'LOAD_CONSTRAINT', `Database rejected the row: ${(err as Error).message}`));
            }
          }
          batchCounts.processed++;
          bump(batchCounts, outcome);
          records.push({ sourceKey: r.sourceKey, outcome, errors, transformed: r.row });
        }
        insertRunRecords(db, runId, records);
      })();
      Object.assign(counts, batchCounts); // only committed batches count
    }
    counts.pending = counts.accepted - counts.processed;
    finishRun(deps, migrationId, runId, 'succeeded', counts, null, null, version, opts.actor);
  } catch (err) {
    counts.pending = counts.accepted - counts.processed;
    const code = err instanceof FaultInjected ? 'FAULT_INJECTED' : err instanceof HashDrift ? 'HASH_DRIFT' : 'LOAD_ERROR';
    if (code === 'LOAD_ERROR') deps.logger.error({ err, runId }, 'execution failed');
    finishRun(deps, migrationId, runId, 'failed', counts, code, (err as Error).message, version, opts.actor);
  }
  return getRun(db, migrationId, runId);
}

class HashDrift extends Error {}

function bump(c: ExecuteCounts, o: LoadOutcome) {
  if (o === 'inserted') c.inserted++;
  else if (o === 'skipped_existing') c.skippedExisting++;
  else if (o === 'conflict') c.conflict++;
  else c.loadRejected++;
}

function loadEvidence(r: RecordResult, keyField: string, code: 'TARGET_CONFLICT' | 'LOAD_CONSTRAINT', message: string): Evidence {
  return { sourceKey: r.sourceKey, stage: 'load', targetField: keyField, sourceFields: [], rawValues: {}, stepIndex: null, op: null, code, message };
}

function finishRun(
  deps: AppDeps,
  migrationId: number,
  runId: number,
  status: 'succeeded' | 'failed',
  counts: ExecuteCounts,
  errorCode: string | null,
  error: string | null,
  version: PlanVersion,
  actor: string,
) {
  const now = deps.now();
  deps.db.transaction(() => {
    deps.db
      .prepare('UPDATE runs SET status = ?, counts = ?, error_code = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(counts), errorCode, error, now, runId);
    appendEvent(
      deps.db,
      {
        migrationId,
        type: status === 'succeeded' ? 'execution_completed' : 'execution_failed',
        actor,
        planVersionId: version.id,
        runId,
        payload: { version: version.version, ...counts, errorCode, error },
      },
      now,
    );
  }).immediate();
}

/** Retry a failed/interrupted execution: a child run of the same version with the same gates. */
export function retry(deps: AppDeps, migrationId: number, runId: number, actor: string): Run {
  const parent = getRun(deps.db, migrationId, runId);
  if (parent.kind !== 'execute') throw conflict('NOT_RETRYABLE', `Run #${runId} is a ${parent.kind}, only executions can be retried`);
  if (parent.status !== 'failed' && parent.status !== 'interrupted') {
    throw conflict('NOT_RETRYABLE', `Run #${runId} is ${parent.status}; only failed or interrupted executions can be retried`);
  }
  if (parent.retriedBy != null) throw conflict('ALREADY_RETRIED', `Run #${runId} was already retried by run #${parent.retriedBy}`);
  const rolledBackAfter = deps.db
    .prepare("SELECT id FROM runs WHERE migration_id = ? AND kind = 'rollback' AND status = 'succeeded' AND id > ? LIMIT 1")
    .get(migrationId, runId) as { id: number } | undefined;
  if (rolledBackAfter) {
    throw conflict('PARENT_ROLLED_BACK', `Run #${runId}'s rows were rolled back by run #${rolledBackAfter.id}; start a new execution instead of retrying`);
  }
  return execute(deps, migrationId, { version: parent.version!, actor, parentRunId: runId, failAfter: null });
}

export type RollbackResult = { run: Run; counts: { deleted: number } };

/** Compensating delete of every target row this workspace inserted (ledger-scoped), in one transaction. */
export function rollback(deps: AppDeps, migrationId: number, actor: string, reason = ''): RollbackResult {
  const { db, dataset } = deps;
  const table = targetTableName(dataset.target);
  const now = deps.now();
  const runId = db.transaction(() => {
    const active = activeLedgerCount(db, migrationId);
    if (active === 0) throw conflict('NOTHING_TO_ROLL_BACK', 'This workspace has no loaded rows to roll back');
    let id: number;
    try {
      id = Number(
        db
          .prepare(`INSERT INTO runs (migration_id, kind, status, actor, options, started_at) VALUES (?, 'rollback', 'running', ?, ?, ?)`)
          .run(migrationId, actor, JSON.stringify({ reason }), now).lastInsertRowid,
      );
    } catch (err) {
      if (isUniqueViolation(err, 'runs.migration_id')) throw conflict('RUN_IN_PROGRESS', 'Another execution or rollback is in progress');
      throw err;
    }
    const deleted = db
      .prepare(`DELETE FROM ${table} WHERE id IN (SELECT target_id FROM load_ledger WHERE migration_id = ? AND rolled_back_at IS NULL)`)
      .run(migrationId).changes;
    db.prepare('UPDATE load_ledger SET rolled_back_at = ?, rollback_run_id = ? WHERE migration_id = ? AND rolled_back_at IS NULL').run(now, id, migrationId);
    db.prepare(`UPDATE runs SET status = 'succeeded', counts = ?, finished_at = ? WHERE id = ?`).run(JSON.stringify({ deleted, ledgerRows: active }), now, id);
    appendEvent(db, { migrationId, type: 'rollback_completed', actor, runId: id, payload: { deleted, ledgerRows: active, reason } }, now);
    return id;
  }).immediate();
  const run = getRun(db, migrationId, runId);
  return { run, counts: { deleted: Number((run.counts as { deleted: number }).deleted) } };
}

function isUniqueViolation(err: unknown, column: string): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE' && (e.message ?? '').includes(column);
}

function isConstraintError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code.startsWith('SQLITE_CONSTRAINT');
}
