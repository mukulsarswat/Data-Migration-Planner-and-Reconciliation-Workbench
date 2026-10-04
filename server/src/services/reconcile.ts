// Reconciliation from CURRENT state (not run counters): expected accepted rows of the executed plan version vs the
// active load ledger vs the target table. Per-key statuses use dbt-audit-helper vocabulary.
import type { AppDeps } from '../app.ts';
import { businessColumns, dbRowToPrimitives, toTargetRow } from '../../../shared/targetRow.ts';
import { compareCodeUnits } from '../../../shared/canonical.ts';
import { dryRun } from '../engine/dryRun.ts';
import { hashCanonical } from '../engine/hash.ts';
import { targetTableName } from '../db/targetDdl.ts';
import { getVersionById } from './plans.ts';

export type Verdict = 'NOT_EXECUTED' | 'MATCHED' | 'INCOMPLETE' | 'ROLLED_BACK_CLEAN' | 'MISMATCHED';
export type KeyStatus = 'perfect match' | 'missing from target' | 'values do not match' | 'extra in target' | 'conflict' | 'load rejected' | 'pending';

export type Reconciliation = {
  verdict: Verdict;
  version: number | null;
  totals: {
    source: number;
    accepted: number;
    rejected: number;
    conflicts: number;
    loadRejected: number;
    loadedActive: number;
    pending: number;
    targetTotal: number;
    preExisting: number;
    expectedBalanceCents: number;
    actualBalanceCents: number;
    pendingBalanceCents: number;
  };
  equations: { name: string; expression: string; holds: boolean }[];
  statusCounts: Partial<Record<KeyStatus, number>>;
  /** Non-matching keys (capped at 100), for drill-down. */
  exceptions: { sourceKey: string; externalRef: string | null; status: KeyStatus; detail: string }[];
  preExistingIntact: boolean;
  lastLoadRun: { id: number; kind: string; status: string } | null;
};

export function reconcile(deps: AppDeps, migrationId: number): Reconciliation {
  const { db, dataset } = deps;
  const target = dataset.target;
  const table = targetTableName(target);
  const keyField = target.keyField;
  const cols = businessColumns(target);

  const targetTotal = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const preRows = db.prepare(`SELECT * FROM ${table} WHERE _load_run_id IS NULL ORDER BY ${keyField}`).all() as Record<string, unknown>[];
  const preExisting = preRows.length;
  const seedHash = hashCanonical(
    dataset.targetSeed
      .map((r) => toTargetRow(target, r))
      .sort((a, b) => compareCodeUnits(String(a[cols.indexOf(keyField)]), String(b[cols.indexOf(keyField)]))),
  );
  const preExistingIntact = hashCanonical(preRows.map((r) => dbRowToPrimitives(target, r))) === seedHash;

  const lastLoad = db
    .prepare(`SELECT id, kind, status, plan_version_id FROM runs WHERE migration_id = ? AND kind IN ('execute','rollback') ORDER BY id DESC LIMIT 1`)
    .get(migrationId) as { id: number; kind: string; status: string; plan_version_id: number | null } | undefined;
  const lastExecute = db
    .prepare(`SELECT plan_version_id FROM runs WHERE migration_id = ? AND kind = 'execute' ORDER BY id DESC LIMIT 1`)
    .get(migrationId) as { plan_version_id: number } | undefined;

  const ledger = db
    .prepare('SELECT source_key, target_id, external_ref FROM load_ledger WHERE migration_id = ? AND rolled_back_at IS NULL')
    .all(migrationId) as { source_key: string; target_id: number; external_ref: string }[];
  const loadedActive = ledger.length;
  const sourceTotal = dataset.records.length;

  const base = {
    totals: {
      source: sourceTotal,
      accepted: 0,
      rejected: 0,
      conflicts: 0,
      loadRejected: 0,
      loadedActive,
      pending: 0,
      targetTotal,
      preExisting,
      expectedBalanceCents: 0,
      actualBalanceCents: 0,
      pendingBalanceCents: 0,
    },
    preExistingIntact,
    lastLoadRun: lastLoad ? { id: lastLoad.id, kind: lastLoad.kind, status: lastLoad.status } : null,
  };

  if (!lastExecute) {
    return { ...base, verdict: 'NOT_EXECUTED', version: null, equations: [], statusCounts: {}, exceptions: [] };
  }

  const version = getVersionById(db, lastExecute.plan_version_id);
  const expected = dryRun(dataset.records, version.plan, target, version.planHash);
  const accepted = expected.results.filter((r) => r.outcome === 'accepted');
  const byLedger = new Map(ledger.map((l) => [l.source_key, l]));
  // Load the (bounded) target once: O(n) maps instead of a correlated query per key.
  const targetRows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const targetById = new Map(targetRows.map((r) => [Number(r.id), r]));
  const targetByKey = new Map(targetRows.map((r) => [String(r[keyField]), r]));
  const ownedTargetIds = new Set(ledger.map((l) => l.target_id));
  // Keys the database rejected during a load of this version (only those rows are read).
  const loadRejectedKeys = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT rr.source_key FROM run_records rr JOIN runs r ON r.id = rr.run_id
           WHERE r.migration_id = ? AND r.kind = 'execute' AND r.plan_version_id = ? AND rr.outcome = 'load_rejected'`,
        )
        .all(migrationId, version.id) as { source_key: string }[]
    ).map((r) => r.source_key),
  );
  // Aggregate check column: the target's money column (first integer field).
  const sumField = target.fields.find((f) => f.type === 'integer')?.name ?? null;
  const sameRow = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  const statusCounts: Partial<Record<KeyStatus, number>> = {};
  const exceptions: Reconciliation['exceptions'] = [];
  const note = (sourceKey: string, externalRef: string | null, status: KeyStatus, detail: string) => {
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status !== 'perfect match' && exceptions.length < 100) exceptions.push({ sourceKey, externalRef, status, detail });
  };

  let conflicts = 0;
  let loadRejected = 0;
  let pending = 0;
  let mismatched = 0;
  let missing = 0;
  let expectedBalance = 0;
  let actualBalance = 0;
  let pendingBalance = 0;
  const acceptedKeys = new Set<string>();
  for (const r of accepted) {
    acceptedKeys.add(r.sourceKey);
    const externalRef = String(r.row![keyField]);
    const l = byLedger.get(r.sourceKey);
    if (l) {
      const expectedRow = toTargetRow(target, r.row!);
      if (sumField) expectedBalance += Number(r.row![sumField] ?? 0);
      const actual = targetById.get(l.target_id);
      if (!actual) {
        missing++;
        note(r.sourceKey, externalRef, 'missing from target', `Ledger row points to target #${l.target_id}, which does not exist`);
        continue;
      }
      if (sumField) actualBalance += Number(actual[sumField] ?? 0);
      if (sameRow(dbRowToPrimitives(target, actual), expectedRow)) note(r.sourceKey, externalRef, 'perfect match', '');
      else {
        mismatched++;
        note(r.sourceKey, externalRef, 'values do not match', 'Target row differs from the transformed source row');
      }
    } else if (targetByKey.has(externalRef) && !ownedTargetIds.has(Number(targetByKey.get(externalRef)!.id))) {
      conflicts++;
      note(r.sourceKey, externalRef, 'conflict', `${keyField} already existed in the target before this workspace loaded it`);
    } else if (loadRejectedKeys.has(r.sourceKey)) {
      loadRejected++;
      note(r.sourceKey, externalRef, 'load rejected', 'The database rejected this row during the load');
    } else {
      pending++;
      if (sumField) pendingBalance += Number(r.row![sumField] ?? 0);
      note(r.sourceKey, externalRef, 'pending', 'Accepted but not loaded yet (execution incomplete or rolled back)');
    }
  }
  let extra = 0;
  for (const l of ledger) {
    if (!acceptedKeys.has(l.source_key)) {
      extra++;
      note(l.source_key, l.external_ref, 'extra in target', 'Loaded row is not an accepted record of the executed plan version');
    }
  }

  const totals = {
    ...base.totals,
    accepted: expected.counts.accepted,
    rejected: expected.counts.rejected,
    conflicts,
    loadRejected,
    pending: pending + missing,
    expectedBalanceCents: expectedBalance + pendingBalance,
    actualBalanceCents: actualBalance,
    pendingBalanceCents: pendingBalance,
  };
  const equations = [
    { name: 'Source partition', expression: `${sourceTotal} source = ${totals.accepted} accepted + ${totals.rejected} rejected`, holds: sourceTotal === totals.accepted + totals.rejected },
    {
      name: 'Load partition',
      expression: `${totals.accepted} accepted = ${loadedActive - extra} loaded + ${conflicts} conflicts + ${loadRejected} load-rejected + ${totals.pending} pending`,
      holds: totals.accepted === loadedActive - extra + conflicts + loadRejected + totals.pending,
    },
    { name: 'Target total', expression: `${targetTotal} target rows = ${preExisting} pre-existing + ${loadedActive} loaded`, holds: targetTotal === preExisting + loadedActive },
    {
      // Source-side money (every loadable accepted row) vs money actually in the target for this workspace:
      // fails while rows are pending, which is exactly what an aggregate check must reveal.
      name: 'Balance sum',
      expression: `${expectedBalance + pendingBalance} expected cents = ${actualBalance} loaded cents${pendingBalance ? ` (${pendingBalance} pending)` : ''}`,
      holds: expectedBalance + pendingBalance === actualBalance,
    },
  ];

  let verdict: Verdict;
  const strayLoaded = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE _load_run_id IS NOT NULL`).get() as { n: number }).n;
  if (lastLoad?.kind === 'rollback' && loadedActive === 0) {
    verdict = strayLoaded === 0 && preExistingIntact && targetTotal === preExisting ? 'ROLLED_BACK_CLEAN' : 'MISMATCHED';
  } else if (mismatched > 0 || extra > 0 || missing > 0 || !preExistingIntact || !equations[2]!.holds || expectedBalance !== actualBalance) {
    verdict = 'MISMATCHED'; // loaded rows themselves disagree (values, extras, money of loaded rows)
  } else if (pending > 0) {
    verdict = 'INCOMPLETE'; // everything loaded is correct; the rest is still pending (Balance sum fails until retried)
  } else if (!equations[3]!.holds) {
    verdict = 'MISMATCHED';
  } else {
    verdict = 'MATCHED';
  }
  return { ...base, totals, verdict, version: version.version, equations, statusCounts, exceptions };
}
