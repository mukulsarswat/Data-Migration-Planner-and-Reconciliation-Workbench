// Workbench HTTP API: inputs, plans/versions/approvals, runs, reconciliation, history. Every body is zod-validated
// (ZodError ⇒ 422 envelope); gate violations surface as 409 with actionable messages.
import { z } from 'zod';
import type { RouteRegistrar } from '../app.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';
import { DATE_FORMATS, OP_SPECS, OP_PARAMS } from '../../../shared/dsl.ts';
import { MAX_SAMPLE_SIZE } from '../../../shared/schemas.ts';
import { targetTableName } from '../db/targetDdl.ts';
import { buildHeuristicPlan } from '../engine/heuristic.ts';
import { runMapping } from '../engine/transforms.ts';
import { engineContext } from '../services/context.ts';
import { listEvents } from '../services/events.ts';
import {
  answerClarification,
  createEditedVersion,
  createVersion,
  decide,
  diffPlans,
  getVersion,
  latestVersion,
  listVersions,
  staticIssues,
  type PlanVersion,
} from '../services/plans.ts';
import { reconcile } from '../services/reconcile.ts';
import { activeLedgerCount, execute, getRun, listRunRecords, listRuns, retry, rollback, runDryRun } from '../services/runs.ts';
import { currentWorkspace, listWorkspaces, startNewWorkspace } from '../services/workspace.ts';
import type { AppDeps } from '../app.ts';
import type { MigrationPlan } from '../../../shared/plan.ts';

const Actor = z.string().trim().min(1).max(60).default('reviewer');
const Paging = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const VersionParam = z.coerce.number().int().min(1);
const RunParam = z.coerce.number().int().min(1);

/** Pass rate of every mapping over the full bounded dataset (cheap: ≤ 500 × ~10 mappings). */
function passRates(deps: AppDeps, plan: MigrationPlan) {
  const records = deps.dataset.records;
  return Object.fromEntries(
    plan.mappings.map((m) => {
      let ok = 0;
      const failures: { sourceKey: string; raw: Record<string, string | null>; message: string }[] = [];
      const samples: { sourceKey: string; raw: Record<string, string | null>; value: unknown }[] = [];
      for (const r of records) {
        const res = runMapping(r.values, m);
        const raw = Object.fromEntries(m.sources.map((s) => [s, r.values[s] ?? null]));
        if (res.ok) {
          ok++;
          if (samples.length < 3) samples.push({ sourceKey: r.sourceKey, raw, value: res.value });
        } else if (failures.length < 5) failures.push({ sourceKey: r.sourceKey, raw, message: res.message });
      }
      return [m.target, { passRatePct: Math.round((ok / records.length) * 1000) / 10, ok, total: records.length, samples, failures }];
    }),
  );
}

function versionSummary(deps: AppDeps, v: PlanVersion) {
  const issues = staticIssues(deps, v.plan, { forApproval: true, reviewer: 'x' });
  return {
    version: v.version,
    parentVersion: v.parentVersion,
    author: v.author,
    actor: v.actor,
    planHash: v.planHash,
    changeNote: v.changeNote,
    createdAt: v.createdAt,
    agentRunId: v.agentRunId,
    approval: v.approval,
    blockers: issues.filter((i) => i.severity === 'blocker').length,
    unresolvedClarifications: v.plan.clarifications.filter((c) => !c.resolution).length,
  };
}

export const workbenchRoutes: RouteRegistrar = (app, deps) => {
  const { db, dataset } = deps;
  const ws = () => currentWorkspace(db).id;

  // ---------- Inputs & status ----------
  app.get('/api/migration', (c) => {
    const ctx = engineContext(dataset);
    const workspace = currentWorkspace(db);
    const latest = latestVersion(db, workspace.id);
    const runs = listRuns(db, workspace.id, 1);
    return c.json({
      workspace,
      workspaces: listWorkspaces(db),
      source: dataset.source,
      target: dataset.target,
      catalog: {
        ops: Object.entries(OP_SPECS).map(([name, spec]) => ({ name, ...spec, params: Object.keys((OP_PARAMS as Record<string, { shape?: object }>)[name]?.shape ?? {}) })),
        dateFormats: DATE_FORMATS,
      },
      profiles: ctx.profiles,
      gaps: ctx.gaps,
      limits: { records: dataset.records.length, maxSampleSize: MAX_SAMPLE_SIZE },
      status: {
        latestVersion: latest ? versionSummary(deps, latest) : null,
        activeLoadedRows: activeLedgerCount(db, workspace.id),
        lastRun: runs[0] ?? null,
        llm: { configured: deps.config.anthropic.apiKey !== null, model: deps.config.anthropic.model },
        faultInjection: deps.config.allowFaultInjection,
      },
    });
  });

  app.post('/api/workspaces', async (c) => {
    const body = z.object({ actor: Actor }).parse(await c.req.json().catch(() => ({})));
    return c.json(startNewWorkspace(deps, body.actor), 201);
  });

  app.get('/api/source/records', (c) => {
    const q = Paging.extend({ q: z.string().max(80).optional() }).parse(c.req.query());
    let items = dataset.records;
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((r) => r.sourceKey.includes(needle) || Object.values(r.values).some((v) => v.toLowerCase().includes(needle)));
    }
    return c.json({ total: items.length, items: items.slice(q.offset, q.offset + q.limit) });
  });

  app.get('/api/target/accounts', (c) => {
    const q = Paging.parse(c.req.query());
    const table = targetTableName(dataset.target);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const items = db
      .prepare(
        `SELECT t.*, l.source_key AS loaded_from, l.migration_id AS loaded_by_workspace
         FROM ${table} t LEFT JOIN load_ledger l ON l.target_id = t.id AND l.rolled_back_at IS NULL
         ORDER BY t.${dataset.target.keyField} LIMIT ? OFFSET ?`,
      )
      .all(q.limit, q.offset);
    return c.json({ total, items });
  });

  // ---------- Plans, versions, clarifications, approvals ----------
  app.get('/api/plans', (c) => c.json({ items: listVersions(db, ws()).map((v) => versionSummary(deps, v)) }));

  app.get('/api/plans/:v', (c) => {
    const version = VersionParam.parse(c.req.param('v'));
    const v = getVersion(db, ws(), version);
    const parent = v.parentVersion ? getVersion(db, ws(), v.parentVersion) : null;
    return c.json({
      ...versionSummary(deps, v),
      plan: v.plan,
      issues: staticIssues(deps, v.plan),
      approvalIssues: staticIssues(deps, v.plan, { forApproval: true, reviewer: 'x' }).filter((i) => i.code !== 'MISSING_REVIEWER'),
      diff: diffPlans(parent?.version ?? null, parent?.plan ?? null, v.version, v.plan),
      passRates: passRates(deps, v.plan),
    });
  });

  app.post('/api/plans/heuristic', async (c) => {
    const body = z.object({ actor: Actor }).parse(await c.req.json().catch(() => ({})));
    const plan = buildHeuristicPlan(engineContext(dataset));
    const latest = latestVersion(db, ws());
    const v = createVersion(deps, {
      migrationId: ws(),
      plan,
      author: 'heuristic',
      actor: body.actor,
      parentVersion: latest?.version ?? null,
      changeNote: 'Deterministic heuristic draft (no LLM): name/synonym matching, profiling and type-driven recipes',
    });
    return c.json(versionSummary(deps, v), 201);
  });

  app.post('/api/plans', async (c) => {
    const body = z
      .object({ parentVersion: z.number().int().min(1), plan: MigrationPlanSchema, changeNote: z.string().max(300).default(''), actor: Actor })
      .parse(await c.req.json());
    const v = createEditedVersion(deps, ws(), body.parentVersion, body.plan, body.actor, body.changeNote);
    return c.json(versionSummary(deps, v), 201);
  });

  app.post('/api/plans/:v/clarifications/:id', async (c) => {
    const version = VersionParam.parse(c.req.param('v'));
    const body = z
      .object({ choice: z.union([z.number().int().min(0), z.literal('dismissed')]), actor: Actor })
      .parse(await c.req.json());
    const v = answerClarification(deps, ws(), version, c.req.param('id'), body.choice, body.actor);
    return c.json(versionSummary(deps, v), 201);
  });

  const Decision = z.object({ reviewer: z.string().trim().max(60).default(''), comment: z.string().max(500).default('') });
  app.post('/api/plans/:v/approve', async (c) => {
    const version = VersionParam.parse(c.req.param('v'));
    const body = Decision.parse(await c.req.json().catch(() => ({})));
    return c.json(versionSummary(deps, decide(deps, ws(), version, 'approved', body.reviewer, body.comment)));
  });
  app.post('/api/plans/:v/reject', async (c) => {
    const version = VersionParam.parse(c.req.param('v'));
    const body = Decision.parse(await c.req.json().catch(() => ({})));
    return c.json(versionSummary(deps, decide(deps, ws(), version, 'rejected', body.reviewer, body.comment)));
  });

  // ---------- Runs ----------
  app.post('/api/runs/dry-run', async (c) => {
    const body = z.object({ version: z.number().int().min(1), actor: Actor }).parse(await c.req.json());
    return c.json(runDryRun(deps, ws(), body.version, body.actor), 201);
  });

  app.post('/api/runs/execute', async (c) => {
    const body = z
      .object({ version: z.number().int().min(1), failAfter: z.number().int().min(1).max(10_000).nullable().default(null), actor: Actor })
      .parse(await c.req.json());
    return c.json(execute(deps, ws(), { version: body.version, actor: body.actor, failAfter: body.failAfter }), 201);
  });

  app.post('/api/runs/:id/retry', async (c) => {
    const id = RunParam.parse(c.req.param('id'));
    const body = z.object({ actor: Actor }).parse(await c.req.json().catch(() => ({})));
    return c.json(retry(deps, ws(), id, body.actor), 201);
  });

  app.post('/api/rollback', async (c) => {
    const body = z.object({ actor: Actor, reason: z.string().max(300).default('') }).parse(await c.req.json().catch(() => ({})));
    return c.json(rollback(deps, ws(), body.actor, body.reason), 201);
  });

  app.get('/api/runs', (c) => {
    const q = z
      .object({
        kind: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',') : []))
          .pipe(z.array(z.enum(['dry_run', 'execute', 'rollback']))),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(c.req.query());
    return c.json({ items: listRuns(db, ws(), q.limit, q.kind) });
  });
  app.get('/api/runs/:id', (c) => c.json(getRun(db, ws(), RunParam.parse(c.req.param('id')))));
  app.get('/api/runs/:id/records', (c) => {
    const id = RunParam.parse(c.req.param('id'));
    getRun(db, ws(), id); // 404 if not in this workspace
    const q = Paging.extend({ outcome: z.string().max(40).optional() }).parse(c.req.query());
    return c.json(listRunRecords(db, id, q));
  });

  app.get('/api/reconciliation', (c) => c.json(reconcile(deps, ws())));

  // ---------- History ----------
  app.get('/api/events', (c) => {
    const q = z
      .object({ scope: z.enum(['current', 'all']).default('current'), limit: z.coerce.number().int().min(1).max(500).default(200), beforeId: z.coerce.number().int().optional() })
      .parse(c.req.query());
    return c.json({ items: listEvents(db, { migrationId: q.scope === 'current' ? ws() : null, limit: q.limit, beforeId: q.beforeId }) });
  });
};
