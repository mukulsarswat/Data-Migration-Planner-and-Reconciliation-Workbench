// Boot recovery: nothing can still be running in a freshly started process, so any run left
// `running` (or an agent run `queued`/`running`) was cut off by a restart. Mark it and record why.
import type { Db } from './connection.ts';

const ERROR_CODE = 'INTERRUPTED';
const ERROR = 'Interrupted by server restart';

type Orphan = { id: number; migration_id: number };

export function bootRecover(db: Db, now: () => string): { runs: number; agentRuns: number } {
  return db.transaction(() => {
    const at = now();
    const event = db.prepare(
      `INSERT INTO events (migration_id, type, actor, run_id, agent_run_id, payload, created_at)
       VALUES (?, ?, 'system', ?, ?, ?, ?)`,
    );

    const runs = db.prepare(`SELECT id, migration_id, kind FROM runs WHERE status = 'running' ORDER BY id`).all() as Array<
      Orphan & { kind: string }
    >;
    const markRun = db.prepare(
      `UPDATE runs SET status = 'interrupted', error_code = ?, error = ?, finished_at = ? WHERE id = ?`,
    );
    for (const r of runs) {
      markRun.run(ERROR_CODE, ERROR, at, r.id);
      event.run(r.migration_id, 'run_interrupted', r.id, null, JSON.stringify({ kind: r.kind, reason: ERROR }), at);
    }

    const agentRuns = db
      .prepare(`SELECT id, migration_id FROM agent_runs WHERE status IN ('queued', 'running') ORDER BY id`)
      .all() as Orphan[];
    const markAgentRun = db.prepare(
      `UPDATE agent_runs SET status = 'interrupted', error_code = ?, error = ?, finished_at = ? WHERE id = ?`,
    );
    for (const a of agentRuns) {
      markAgentRun.run(ERROR_CODE, ERROR, at, a.id);
      event.run(a.migration_id, 'agent_run_interrupted', null, a.id, JSON.stringify({ reason: ERROR }), at);
    }

    return { runs: runs.length, agentRuns: agentRuns.length };
  }).immediate();
}
