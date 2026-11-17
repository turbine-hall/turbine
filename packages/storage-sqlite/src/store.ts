import type {
  Artifact,
  ArtifactDependencyEdge,
  Decision,
  EecInvalidationEvent,
  EngineeringEvidenceContract,
  EngineEvent,
  Evidence,
  RecoveryPlan,
  RoleRun,
  WorkPackage,
} from '@turbine-hall/turbine-contracts';
import {
  ArtifactDependencyEdgeSchema,
  ArtifactSchema,
  DecisionSchema,
  EecInvalidationEventSchema,
  EngineeringEvidenceContractSchema,
  EngineEventSchema,
  EvidenceSchema,
  RecoveryPlanSchema,
  RoleRunSchema,
  WorkPackageSchema,
  createId,
  err,
} from '@turbine-hall/turbine-contracts';
import type { SqliteDb } from './db.js';
import { openDatabase } from './db.js';

function now(): string {
  return new Date().toISOString();
}

export class WorkStore {
  readonly db: SqliteDb;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  nextSequence(workId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM events WHERE work_id = ?`)
      .get(workId) as { seq: number };
    return row.seq + 1;
  }

  appendEvent(input: {
    workId?: string;
    type: string;
    payload: Record<string, unknown>;
    correlationId?: string;
  }): EngineEvent {
    const event: EngineEvent = {
      id: createId('evt'),
      workId: input.workId,
      type: input.type,
      sequence: input.workId ? this.nextSequence(input.workId) : 0,
      payload: input.payload,
      createdAt: now(),
      correlationId: input.correlationId,
    };
    EngineEventSchema.parse(event);
    this.db
      .prepare(
        `INSERT INTO events(id, work_id, type, sequence, payload, created_at, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.workId ?? null,
        event.type,
        event.sequence,
        JSON.stringify(event.payload),
        event.createdAt,
        event.correlationId ?? null,
      );
    return event;
  }

  listEvents(workId: string): EngineEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE work_id = ? ORDER BY sequence ASC`)
      .all(workId) as Array<{
      id: string;
      work_id: string;
      type: string;
      sequence: number;
      payload: string;
      created_at: string;
      correlation_id: string | null;
    }>;
    return rows.map((r) =>
      EngineEventSchema.parse({
        id: r.id,
        workId: r.work_id,
        type: r.type,
        sequence: r.sequence,
        payload: JSON.parse(r.payload),
        createdAt: r.created_at,
        correlationId: r.correlation_id ?? undefined,
      }),
    );
  }

  saveWork(work: WorkPackage): void {
    const parsed = WorkPackageSchema.parse(work);
    this.db
      .prepare(
        `INSERT INTO work_items(id, data, current_state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data, current_state=excluded.current_state, updated_at=excluded.updated_at`,
      )
      .run(parsed.id, JSON.stringify(parsed), parsed.currentState, parsed.updatedAt);
    this.db.prepare(`DELETE FROM work_aliases WHERE work_id = ?`).run(parsed.id);
    const insertAlias = this.db.prepare(`INSERT INTO work_aliases(alias, work_id) VALUES (?, ?)`);
    for (const alias of parsed.aliases) {
      insertAlias.run(alias, parsed.id);
    }
  }

  getWork(idOrAlias: string): WorkPackage {
    const byId = this.db.prepare(`SELECT data FROM work_items WHERE id = ?`).get(idOrAlias) as
      | { data: string }
      | undefined;
    if (byId) return WorkPackageSchema.parse(JSON.parse(byId.data));

    const alias = this.db
      .prepare(`SELECT work_id FROM work_aliases WHERE alias = ?`)
      .get(idOrAlias) as { work_id: string } | undefined;
    if (!alias) throw err('E_NOT_FOUND', `Work item not found: ${idOrAlias}`);

    const byAlias = this.db
      .prepare(`SELECT data FROM work_items WHERE id = ?`)
      .get(alias.work_id) as { data: string } | undefined;
    if (!byAlias) throw err('E_NOT_FOUND', `Work item not found: ${idOrAlias}`);
    return WorkPackageSchema.parse(JSON.parse(byAlias.data));
  }

  tryGetWork(idOrAlias: string): WorkPackage | null {
    try {
      return this.getWork(idOrAlias);
    } catch {
      return null;
    }
  }

  listWork(state?: string): WorkPackage[] {
    const rows = state
      ? (this.db
          .prepare(`SELECT data FROM work_items WHERE current_state = ? ORDER BY updated_at DESC`)
          .all(state) as { data: string }[])
      : (this.db
          .prepare(`SELECT data FROM work_items ORDER BY updated_at DESC`)
          .all() as { data: string }[]);
    return rows.map((r) => WorkPackageSchema.parse(JSON.parse(r.data)));
  }

  saveSourceSnapshot(input: {
    hash: string;
    workId: string;
    provider: string;
    content: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO source_snapshots(hash, work_id, provider, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.hash, input.workId, input.provider, input.content, now());
  }

  getSourceSnapshot(hash: string): { hash: string; content: string; provider: string } | null {
    const row = this.db
      .prepare(`SELECT hash, content, provider FROM source_snapshots WHERE hash = ?`)
      .get(hash) as { hash: string; content: string; provider: string } | undefined;
    return row ?? null;
  }

  saveArtifact(artifact: Artifact, content: string): void {
    const parsed = ArtifactSchema.parse(artifact);
    this.db
      .prepare(
        `INSERT INTO artifacts(id, work_id, type, revision, content_hash, data, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.workId,
        parsed.type,
        parsed.revision,
        parsed.contentHash,
        JSON.stringify(parsed),
        content,
        parsed.createdAt,
      );
  }

  listArtifacts(workId: string, type?: string): Artifact[] {
    const rows = type
      ? (this.db
          .prepare(
            `SELECT data FROM artifacts WHERE work_id = ? AND type = ? ORDER BY revision ASC`,
          )
          .all(workId, type) as { data: string }[])
      : (this.db
          .prepare(`SELECT data FROM artifacts WHERE work_id = ? ORDER BY created_at ASC`)
          .all(workId) as { data: string }[]);
    return rows.map((r) => ArtifactSchema.parse(JSON.parse(r.data)));
  }

  getLatestArtifact(workId: string, type: string): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT data FROM artifacts WHERE work_id = ? AND type = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(workId, type) as { data: string } | undefined;
    return row ? ArtifactSchema.parse(JSON.parse(row.data)) : null;
  }

  getArtifactContent(artifactId: string): string {
    const row = this.db
      .prepare(`SELECT content FROM artifacts WHERE id = ?`)
      .get(artifactId) as { content: string } | undefined;
    if (!row) throw err('E_NOT_FOUND', `Artifact not found: ${artifactId}`);
    return row.content;
  }

  getArtifactByHash(workId: string, contentHash: string): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT data FROM artifacts WHERE work_id = ? AND content_hash = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(workId, contentHash) as { data: string } | undefined;
    return row ? ArtifactSchema.parse(JSON.parse(row.data)) : null;
  }

  saveDecision(decision: Decision): void {
    const parsed = DecisionSchema.parse(decision);
    this.db
      .prepare(
        `INSERT INTO approvals(id, work_id, data, invalidated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data, invalidated_at=excluded.invalidated_at`,
      )
      .run(parsed.id, parsed.workId, JSON.stringify(parsed), parsed.invalidatedAt ?? null);
  }

  listDecisions(workId: string): Decision[] {
    const rows = this.db
      .prepare(`SELECT data FROM approvals WHERE work_id = ?`)
      .all(workId) as { data: string }[];
    return rows.map((r) => DecisionSchema.parse(JSON.parse(r.data)));
  }

  saveEvidence(evidence: Evidence): void {
    const parsed = EvidenceSchema.parse(evidence);
    this.db
      .prepare(
        `INSERT INTO evidence(id, work_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(parsed.id, parsed.workId, JSON.stringify(parsed));
  }

  listEvidence(workId: string): Evidence[] {
    const rows = this.db
      .prepare(`SELECT data FROM evidence WHERE work_id = ?`)
      .all(workId) as { data: string }[];
    return rows.map((r) => EvidenceSchema.parse(JSON.parse(r.data)));
  }

  saveRoleRun(run: RoleRun): void {
    const parsed = RoleRunSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO role_runs(id, work_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(parsed.id, parsed.workId, JSON.stringify(parsed));
  }

  listRoleRuns(workId: string): RoleRun[] {
    const rows = this.db
      .prepare(`SELECT data FROM role_runs WHERE work_id = ?`)
      .all(workId) as { data: string }[];
    return rows.map((r) => RoleRunSchema.parse(JSON.parse(r.data)));
  }

  saveEec(eec: EngineeringEvidenceContract): void {
    const parsed = EngineeringEvidenceContractSchema.parse(eec);
    this.db
      .prepare(
        `INSERT INTO eec_contracts(id, work_id, revision, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(work_id, revision) DO UPDATE SET data=excluded.data`,
      )
      .run(parsed.id, parsed.workId, parsed.revision, JSON.stringify(parsed));
  }

  getLatestEec(workId: string): EngineeringEvidenceContract | null {
    const row = this.db
      .prepare(
        `SELECT data FROM eec_contracts WHERE work_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(workId) as { data: string } | undefined;
    return row ? EngineeringEvidenceContractSchema.parse(JSON.parse(row.data)) : null;
  }

  listEec(workId: string): EngineeringEvidenceContract[] {
    const rows = this.db
      .prepare(`SELECT data FROM eec_contracts WHERE work_id = ? ORDER BY revision ASC`)
      .all(workId) as { data: string }[];
    return rows.map((r) => EngineeringEvidenceContractSchema.parse(JSON.parse(r.data)));
  }

  saveEdge(edge: ArtifactDependencyEdge): void {
    const parsed = ArtifactDependencyEdgeSchema.parse(edge);
    this.db
      .prepare(
        `INSERT INTO artifact_dependency_edges(id, work_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(parsed.id, parsed.workId, JSON.stringify(parsed));
  }

  listEdges(workId: string): ArtifactDependencyEdge[] {
    const rows = this.db
      .prepare(`SELECT data FROM artifact_dependency_edges WHERE work_id = ?`)
      .all(workId) as { data: string }[];
    return rows.map((r) => ArtifactDependencyEdgeSchema.parse(JSON.parse(r.data)));
  }

  saveInvalidation(event: EecInvalidationEvent): EecInvalidationEvent | null {
    const parsed = EecInvalidationEventSchema.parse(event);
    const existing = this.db
      .prepare(`SELECT data FROM eec_invalidation_events WHERE idempotency_key = ?`)
      .get(parsed.idempotencyKey) as { data: string } | undefined;
    if (existing) return null;
    this.db
      .prepare(
        `INSERT INTO eec_invalidation_events(id, work_id, idempotency_key, data) VALUES (?, ?, ?, ?)`,
      )
      .run(parsed.id, parsed.workId, parsed.idempotencyKey, JSON.stringify(parsed));
    return parsed;
  }

  listInvalidations(workId: string): EecInvalidationEvent[] {
    const rows = this.db
      .prepare(`SELECT data FROM eec_invalidation_events WHERE work_id = ?`)
      .all(workId) as { data: string }[];
    return rows.map((r) => EecInvalidationEventSchema.parse(JSON.parse(r.data)));
  }

  saveRecoveryPlan(plan: RecoveryPlan): void {
    const parsed = RecoveryPlanSchema.parse(plan);
    this.db
      .prepare(
        `INSERT INTO recovery_plans(id, work_id, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(parsed.id, parsed.workId, JSON.stringify(parsed));
  }

  getLatestRecoveryPlan(workId: string): RecoveryPlan | null {
    const rows = this.db
      .prepare(`SELECT data FROM recovery_plans WHERE work_id = ?`)
      .all(workId) as { data: string }[];
    if (rows.length === 0) return null;
    const plans = rows.map((r) => RecoveryPlanSchema.parse(JSON.parse(r.data)));
    return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  getBudget(workId: string): { modelCalls: number; estimatedCost: number } {
    const row = this.db
      .prepare(`SELECT model_calls, estimated_cost FROM budget_counters WHERE work_id = ?`)
      .get(workId) as { model_calls: number; estimated_cost: number } | undefined;
    return row
      ? { modelCalls: row.model_calls, estimatedCost: row.estimated_cost }
      : { modelCalls: 0, estimatedCost: 0 };
  }

  incrementBudget(workId: string, modelCalls = 1, estimatedCost = 0): void {
    this.db
      .prepare(
        `INSERT INTO budget_counters(work_id, model_calls, estimated_cost)
         VALUES (?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET
           model_calls = model_calls + excluded.model_calls,
           estimated_cost = estimated_cost + excluded.estimated_cost`,
      )
      .run(workId, modelCalls, estimatedCost);
  }
}
