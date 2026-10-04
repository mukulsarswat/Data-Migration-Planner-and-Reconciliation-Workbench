// Workspaces ("migrations"): exactly one is current. Starting a new one rolls back the current workspace's loaded
// rows (recorded as a normal rollback run) and never deletes history.
import type { Db } from '../db/connection.ts';
import type { AppDeps } from '../app.ts';
import { conflict, notFound } from '../http/errors.ts';
import { appendEvent } from './events.ts';
import { activeLedgerCount, rollback } from './runs.ts';

export type Workspace = { id: number; name: string; createdAt: string; isCurrent: boolean };

type Raw = { id: number; name: string; created_at: string; is_current: number };
const toWorkspace = (r: Raw): Workspace => ({ id: r.id, name: r.name, createdAt: r.created_at, isCurrent: r.is_current === 1 });

export function currentWorkspace(db: Db): Workspace {
  const row = db.prepare('SELECT * FROM migrations WHERE is_current = 1').get() as Raw | undefined;
  if (!row) throw notFound('NO_WORKSPACE', 'No current workspace');
  return toWorkspace(row);
}

export function listWorkspaces(db: Db): Workspace[] {
  return (db.prepare('SELECT * FROM migrations ORDER BY id DESC').all() as Raw[]).map(toWorkspace);
}

export function startNewWorkspace(deps: AppDeps, actor: string): { workspace: Workspace; rolledBack: number } {
  const { db } = deps;
  const previous = currentWorkspace(db);
  const activeAgent = db.prepare("SELECT id FROM agent_runs WHERE migration_id = ? AND status IN ('queued','running')").get(previous.id) as { id: number } | undefined;
  if (activeAgent) {
    throw conflict('AGENT_RUN_IN_PROGRESS', `Agent run #${activeAgent.id} is still running in this workspace; wait for it to finish before starting a new workspace`);
  }
  let rolledBack = 0;
  if (activeLedgerCount(db, previous.id) > 0) {
    rolledBack = rollback(deps, previous.id, actor, 'Starting a new workspace').counts.deleted;
  }
  const now = deps.now();
  const workspace = db.transaction(() => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n;
    db.prepare('UPDATE migrations SET is_current = 0 WHERE is_current = 1').run();
    const info = db
      .prepare('INSERT INTO migrations (name, is_current, created_at) VALUES (?, 1, ?)')
      .run(`Workspace ${n + 1}`, now);
    const id = Number(info.lastInsertRowid);
    appendEvent(db, { migrationId: id, type: 'workspace_created', actor, payload: { previousWorkspaceId: previous.id, rolledBack } }, now);
    return toWorkspace(db.prepare('SELECT * FROM migrations WHERE id = ?').get(id) as Raw);
  }).immediate();
  return { workspace, rolledBack };
}
