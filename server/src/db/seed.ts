// Idempotent first-boot seed: mock source rows, the first workspace, and the pre-existing target rows.
import { createHash } from 'node:crypto';
import type { Db } from './connection.ts';
import type { Dataset } from '../dataset/load.ts';
import { canonicalJson } from '../../../shared/canonical.ts';
import { businessColumns, toTargetRow } from '../../../shared/targetRow.ts';
import { targetTableName } from './targetDdl.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const isEmpty = (db: Db, table: string) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() === undefined;

export function seed(db: Db, dataset: Dataset, now: () => string): void {
  const table = targetTableName(dataset.target);
  db.transaction(() => {
    if (isEmpty(db, 'src_legacy_customers')) {
      const insert = db.prepare(
        'INSERT INTO src_legacy_customers (row_no, source_key, payload, row_hash) VALUES (?, ?, ?, ?)',
      );
      dataset.records.forEach((r, i) => {
        insert.run(i + 1, r.sourceKey, JSON.stringify(r.values), sha256(canonicalJson(r.values)));
      });
    }

    const event = db.prepare(
      `INSERT INTO events (migration_id, type, actor, payload, created_at) VALUES (?, ?, 'system', ?, ?)`,
    );
    if (isEmpty(db, 'migrations')) {
      const name = 'Workspace 1';
      const id = db
        .prepare('INSERT INTO migrations (name, is_current, created_at) VALUES (?, 1, ?)')
        .run(name, now()).lastInsertRowid;
      event.run(id, 'workspace_created', JSON.stringify({ name }), now());
    }

    // Pre-existing target rows (_load_run_id NULL) are seeded only into a pristine target: never after any load.
    if (isEmpty(db, table) && isEmpty(db, 'load_ledger')) {
      const cols = businessColumns(dataset.target);
      const insert = db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}, _load_run_id) VALUES (${cols.map(() => '?').join(', ')}, NULL)`,
      );
      for (const row of dataset.targetSeed) insert.run(...toTargetRow(dataset.target, row));
      const current = db.prepare('SELECT id FROM migrations WHERE is_current = 1').pluck().get() ?? null;
      event.run(current, 'target_seeded', JSON.stringify({ table, rows: dataset.targetSeed.length }), now());
    }
  }).immediate();
}
