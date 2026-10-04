// Append-only audit history (UPDATE/DELETE are blocked by triggers).
import type { Db } from '../db/connection.ts';

export type EventInput = {
  migrationId: number | null;
  type: string;
  actor: string;
  planVersionId?: number | null;
  runId?: number | null;
  agentRunId?: number | null;
  payload?: Record<string, unknown>;
};

export type EventRow = {
  id: number;
  migrationId: number | null;
  type: string;
  actor: string;
  planVersionId: number | null;
  runId: number | null;
  agentRunId: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function appendEvent(db: Db, e: EventInput, now: string): number {
  const info = db
    .prepare(
      `INSERT INTO events (migration_id, type, actor, plan_version_id, run_id, agent_run_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.migrationId, e.type, e.actor, e.planVersionId ?? null, e.runId ?? null, e.agentRunId ?? null, JSON.stringify(e.payload ?? {}), now);
  return Number(info.lastInsertRowid);
}

type RawEvent = {
  id: number;
  migration_id: number | null;
  type: string;
  actor: string;
  plan_version_id: number | null;
  run_id: number | null;
  agent_run_id: number | null;
  payload: string;
  created_at: string;
};

export function listEvents(db: Db, q: { migrationId?: number | null; limit?: number; beforeId?: number }): EventRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.migrationId != null) {
    where.push('migration_id = ?');
    args.push(q.migrationId);
  }
  if (q.beforeId != null) {
    where.push('id < ?');
    args.push(q.beforeId);
  }
  const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, Math.min(q.limit ?? 200, 500)) as RawEvent[];
  return rows.map((r) => ({
    id: r.id,
    migrationId: r.migration_id,
    type: r.type,
    actor: r.actor,
    planVersionId: r.plan_version_id,
    runId: r.run_id,
    agentRunId: r.agent_run_id,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}
