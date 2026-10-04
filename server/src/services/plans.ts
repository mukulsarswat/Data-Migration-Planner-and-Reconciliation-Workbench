// Plan versions (immutable, hashed), clarification answers (deterministic patches, no LLM call),
// approval decisions (one per version) and the execution gate `assertExecutable`.
import type { Db } from '../db/connection.ts';
import type { AppDeps } from '../app.ts';
import { MigrationPlanSchema, type FieldMapping, type MigrationPlan, type PlanIssue } from '../../../shared/plan.ts';
import { canonicalJson } from '../../../shared/canonical.ts';
import { conflict, notFound, unprocessable } from '../http/errors.ts';
import { hashCanonical } from '../engine/hash.ts';
import { validatePlanStatic } from '../engine/staticValidate.ts';
import { applyClarification, computeClarifications, mergeClarifications } from '../engine/triggers.ts';
import { appendEvent } from './events.ts';
import { engineContext } from './context.ts';

export type Author = 'agent' | 'heuristic' | 'user';

export type Approval = { decision: 'approved' | 'rejected'; reviewer: string; comment: string; planHash: string; createdAt: string };

export type PlanVersion = {
  id: number;
  migrationId: number;
  version: number;
  parentVersion: number | null;
  author: Author;
  actor: string;
  plan: MigrationPlan;
  planHash: string;
  agentRunId: number | null;
  changeNote: string;
  createdAt: string;
  approval: Approval | null;
};

type Raw = {
  id: number;
  migration_id: number;
  version: number;
  parent_version: number | null;
  author: Author;
  actor: string;
  plan_json: string;
  plan_hash: string;
  agent_run_id: number | null;
  change_note: string;
  created_at: string;
  a_decision: 'approved' | 'rejected' | null;
  a_reviewer: string | null;
  a_comment: string | null;
  a_hash: string | null;
  a_created: string | null;
};

const SELECT = `SELECT v.*, a.decision AS a_decision, a.reviewer AS a_reviewer, a.comment AS a_comment,
                       a.plan_hash AS a_hash, a.created_at AS a_created
                FROM plan_versions v LEFT JOIN approvals a ON a.plan_version_id = v.id`;

function toVersion(r: Raw): PlanVersion {
  return {
    id: r.id,
    migrationId: r.migration_id,
    version: r.version,
    parentVersion: r.parent_version,
    author: r.author,
    actor: r.actor,
    plan: MigrationPlanSchema.parse(JSON.parse(r.plan_json)),
    planHash: r.plan_hash,
    agentRunId: r.agent_run_id,
    changeNote: r.change_note,
    createdAt: r.created_at,
    approval: r.a_decision
      ? { decision: r.a_decision, reviewer: r.a_reviewer!, comment: r.a_comment ?? '', planHash: r.a_hash!, createdAt: r.a_created! }
      : null,
  };
}

export function planHashOf(plan: MigrationPlan): string {
  return hashCanonical(plan);
}

export function listVersions(db: Db, migrationId: number): PlanVersion[] {
  return (db.prepare(`${SELECT} WHERE v.migration_id = ? ORDER BY v.version DESC`).all(migrationId) as Raw[]).map(toVersion);
}

export function getVersion(db: Db, migrationId: number, version: number): PlanVersion {
  const row = db.prepare(`${SELECT} WHERE v.migration_id = ? AND v.version = ?`).get(migrationId, version) as Raw | undefined;
  if (!row) throw notFound('PLAN_VERSION_NOT_FOUND', `Plan version v${version} does not exist in this workspace`);
  return toVersion(row);
}

export function getVersionById(db: Db, id: number): PlanVersion {
  const row = db.prepare(`${SELECT} WHERE v.id = ?`).get(id) as Raw | undefined;
  if (!row) throw notFound('PLAN_VERSION_NOT_FOUND', `Plan version #${id} does not exist`);
  return toVersion(row);
}

export function latestVersion(db: Db, migrationId: number): PlanVersion | null {
  const row = db.prepare(`${SELECT} WHERE v.migration_id = ? ORDER BY v.version DESC LIMIT 1`).get(migrationId) as Raw | undefined;
  return row ? toVersion(row) : null;
}

/** Re-derive deterministic clarifications for a plan, keeping answered ones and agent questions. */
export function refreshClarifications(deps: AppDeps, plan: MigrationPlan): MigrationPlan {
  const computed = computeClarifications(plan, engineContext(deps.dataset));
  return { ...plan, clarifications: mergeClarifications(plan.clarifications, computed) };
}

export function createVersion(
  deps: AppDeps,
  input: {
    migrationId: number;
    plan: MigrationPlan;
    author: Author;
    actor: string;
    parentVersion: number | null;
    agentRunId?: number | null;
    changeNote: string;
  },
): PlanVersion {
  const { db } = deps;
  const plan = MigrationPlanSchema.parse(input.plan);
  const planHash = planHashOf(plan);
  const now = deps.now();
  const id = db.transaction(() => {
    const next = ((db.prepare('SELECT MAX(version) AS v FROM plan_versions WHERE migration_id = ?').get(input.migrationId) as { v: number | null }).v ?? 0) + 1;
    const info = db
      .prepare(
        `INSERT INTO plan_versions (migration_id, version, parent_version, author, actor, plan_json, plan_hash, agent_run_id, change_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.migrationId, next, input.parentVersion, input.author, input.actor, canonicalJson(plan), planHash, input.agentRunId ?? null, input.changeNote, now);
    const vid = Number(info.lastInsertRowid);
    appendEvent(
      db,
      {
        migrationId: input.migrationId,
        type: 'plan_version_created',
        actor: input.actor,
        planVersionId: vid,
        agentRunId: input.agentRunId ?? null,
        payload: { version: next, parentVersion: input.parentVersion, author: input.author, planHash, changeNote: input.changeNote },
      },
      now,
    );
    return vid;
  }).immediate();
  return getVersionById(db, id);
}

/** Edits and answers must build on the latest version, otherwise a concurrent reviewer's newer work would be dropped. */
function assertLatest(db: Db, migrationId: number, version: number): void {
  const latest = latestVersion(db, migrationId);
  if (latest && latest.version !== version) {
    throw conflict('STALE_VERSION', `v${version} is not the latest version (v${latest.version} is); review v${latest.version} instead`, { latest: latest.version });
  }
}

/**
 * A human edit of mappings, ignored fields or the error budget. Clarification answers can NOT be changed here (they come
 * only from answerClarification, which applies the option's patch); unchanged mappings keep the parent's provenance.
 */
export function createEditedVersion(
  deps: AppDeps,
  migrationId: number,
  parentVersion: number,
  edited: MigrationPlan,
  actor: string,
  changeNote: string,
): PlanVersion {
  const parent = getVersion(deps.db, migrationId, parentVersion);
  assertLatest(deps.db, migrationId, parentVersion);
  const before = new Map(parent.plan.mappings.map((m) => [m.target, m]));
  const mappings = edited.mappings.map((m): FieldMapping => {
    const prev = before.get(m.target);
    if (prev && canonicalJson(stripMeta(prev)) === canonicalJson(stripMeta(m))) return prev;
    return { ...m, origin: 'human', confidence: 'high' };
  });
  const plan = refreshClarifications(deps, { ...edited, mappings, clarifications: parent.plan.clarifications });
  if (canonicalJson(plan) === canonicalJson(parent.plan)) {
    throw unprocessable('NO_CHANGES', 'The edited plan is identical to its parent version');
  }
  return createVersion(deps, { migrationId, plan, author: 'user', actor, parentVersion, changeNote: changeNote || 'Edited by reviewer' });
}

function stripMeta(m: FieldMapping) {
  return { target: m.target, sources: m.sources, steps: m.steps };
}

export function answerClarification(
  deps: AppDeps,
  migrationId: number,
  version: number,
  clarificationId: string,
  choice: number | 'dismissed',
  actor: string,
): PlanVersion {
  const parent = getVersion(deps.db, migrationId, version);
  assertLatest(deps.db, migrationId, version);
  let next: MigrationPlan;
  try {
    next = applyClarification(parent.plan, clarificationId, choice, actor);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'BAD_CHOICE';
    if (code === 'UNKNOWN_CLARIFICATION') throw notFound(code, `Clarification '${clarificationId}' is not part of v${version}`);
    throw unprocessable(code, `Cannot apply answer: ${code}`);
  }
  const question = parent.plan.clarifications.find((c) => c.id === clarificationId);
  const label = choice === 'dismissed' ? 'dismissed' : (question?.options[choice]?.label ?? `option ${choice}`);
  const created = createVersion(deps, {
    migrationId,
    plan: refreshClarifications(deps, next),
    author: 'user',
    actor,
    parentVersion: version,
    changeNote: `Answered "${question?.question ?? clarificationId}": ${label}`,
  });
  appendEvent(
    deps.db,
    { migrationId, type: 'clarification_answered', actor, planVersionId: created.id, payload: { clarificationId, choice, fromVersion: version, toVersion: created.version } },
    deps.now(),
  );
  return created;
}

export type PlanDiff = {
  from: number | null;
  to: number;
  changedTargets: { target: string; change: 'added' | 'removed' | 'modified'; before: FieldMapping | null; after: FieldMapping | null }[];
  ignoredAdded: string[];
  ignoredRemoved: string[];
  clarificationsResolved: string[];
  errorBudgetChanged: { before: number; after: number } | null;
};

export function diffPlans(fromVersion: number | null, before: MigrationPlan | null, toVersion: number, after: MigrationPlan): PlanDiff {
  const b = new Map((before?.mappings ?? []).map((m) => [m.target, m]));
  const a = new Map(after.mappings.map((m) => [m.target, m]));
  const targets = [...new Set([...b.keys(), ...a.keys()])].sort();
  const changedTargets: PlanDiff['changedTargets'] = [];
  for (const t of targets) {
    const x = b.get(t) ?? null;
    const y = a.get(t) ?? null;
    if (x && y && canonicalJson(x) === canonicalJson(y)) continue;
    changedTargets.push({ target: t, change: !x ? 'added' : !y ? 'removed' : 'modified', before: x, after: y });
  }
  const ib = new Set((before?.ignored ?? []).map((i) => i.source));
  const ia = new Set(after.ignored.map((i) => i.source));
  const resolvedBefore = new Set((before?.clarifications ?? []).filter((c) => c.resolution).map((c) => c.id));
  return {
    from: fromVersion,
    to: toVersion,
    changedTargets,
    ignoredAdded: [...ia].filter((s) => !ib.has(s)).sort(),
    ignoredRemoved: [...ib].filter((s) => !ia.has(s)).sort(),
    clarificationsResolved: after.clarifications.filter((c) => c.resolution && !resolvedBefore.has(c.id)).map((c) => c.id),
    errorBudgetChanged: before && before.errorBudgetPct !== after.errorBudgetPct ? { before: before.errorBudgetPct, after: after.errorBudgetPct } : null,
  };
}

export function staticIssues(deps: AppDeps, plan: MigrationPlan, opts?: { forApproval?: boolean; reviewer?: string }): PlanIssue[] {
  return validatePlanStatic(plan, deps.dataset.source, deps.dataset.target, opts);
}

export function decide(
  deps: AppDeps,
  migrationId: number,
  version: number,
  decision: 'approved' | 'rejected',
  reviewer: string,
  comment: string,
): PlanVersion {
  const { db } = deps;
  const v = getVersion(db, migrationId, version);
  if (v.approval) {
    throw conflict('ALREADY_DECIDED', `v${version} was already ${v.approval.decision} by ${v.approval.reviewer}; create a new version to change the decision`);
  }
  if (planHashOf(v.plan) !== v.planHash) throw conflict('HASH_MISMATCH', `Stored plan v${version} does not match its hash`);
  if (decision === 'approved') {
    const blockers = staticIssues(deps, v.plan, { forApproval: true, reviewer }).filter((i) => i.severity === 'blocker');
    if (blockers.length) {
      throw unprocessable('PLAN_NOT_APPROVABLE', `v${version} has ${blockers.length} blocking issue(s); fix them in a new version`, { issues: blockers });
    }
  } else if (!reviewer.trim()) {
    throw unprocessable('MISSING_REVIEWER', 'A reviewer name is required');
  }
  const now = deps.now();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO approvals (plan_version_id, plan_hash, decision, reviewer, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(v.id, v.planHash, decision, reviewer.trim(), comment, now);
    appendEvent(
      db,
      { migrationId, type: decision === 'approved' ? 'plan_approved' : 'plan_rejected', actor: reviewer.trim(), planVersionId: v.id, payload: { version, planHash: v.planHash, comment } },
      now,
    );
  }).immediate();
  return getVersion(db, migrationId, version);
}

/** Execution gate: approved, hash recomputed from the stored plan == version hash == approval hash. */
export function assertExecutable(db: Db, migrationId: number, version: number): PlanVersion {
  const v = getVersion(db, migrationId, version);
  if (!v.approval) throw conflict('NOT_APPROVED', `v${version} has not been approved; approve it before execution`);
  if (v.approval.decision !== 'approved') throw conflict('PLAN_REJECTED', `v${version} was rejected by ${v.approval.reviewer}`);
  const recomputed = planHashOf(v.plan);
  if (recomputed !== v.planHash || v.approval.planHash !== v.planHash) {
    throw conflict('HASH_MISMATCH', `v${version} content no longer matches the approved hash`);
  }
  return v;
}
