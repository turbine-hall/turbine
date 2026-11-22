import type {
  Artifact,
  ArtifactDependencyEdge,
  Claim,
  ClaimStatus,
  Decision,
  EecInvalidationEvent,
  EngineeringEvidenceContract,
  EngineEvent,
  Evidence,
  RecoveryPlan,
  RepoSnapshot,
  RoleRun,
  StoredClaim,
  WorkPackage,
} from '@turbine-hall/turbine-contracts';
import {
  ArtifactDependencyEdgeSchema,
  ArtifactSchema,
  ClaimSchema,
  ClaimStatusSchema,
  MAX_CLAIM_BYTES,
  MAX_CLAIM_REASON_BYTES,
  assertClaimBudget,
  DecisionSchema,
  EecInvalidationEventSchema,
  EngineeringEvidenceContractSchema,
  EngineEventSchema,
  EvidenceSchema,
  GitObjectIdSchema,
  RecoveryPlanSchema,
  RepoSnapshotSchema,
  RoleRunSchema,
  StoredClaimSchema,
  assertNoUnsafeKeys,
  claimCommit,
  WorkPackageSchema,
  createId,
  err,
} from '@turbine-hall/turbine-contracts';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { SqliteDb } from './db.js';
import { openDatabase } from './db.js';

/**
 * The claim columns, with the payload measured in BYTES inside SQLite: a payload over the limit comes back as NULL, so an
 * oversized or damaged row is never read into memory by this process.
 */
// `octet_length` (SQLite 3.43+, bundled with Node 22.5 and later) reads the stored size without loading the value.
const MAX_CLAIM_SECTION_BYTES = 1024;
const MAX_CLAIM_ID_BYTES = 256;
const MAX_CLAIM_CREATED_AT_BYTES = 64;
/** Metadata columns are size-capped in SQL the same way as `data` and `reason`. */
const CLAIM_COLUMNS = `
  CASE WHEN octet_length(id) > ${MAX_CLAIM_ID_BYTES} THEN NULL ELSE id END AS id,
  CASE WHEN octet_length(repo_path) > ${MAX_CLAIM_BYTES} THEN NULL ELSE repo_path END AS repo_path,
  CASE WHEN octet_length(section) > ${MAX_CLAIM_SECTION_BYTES} THEN NULL ELSE section END AS section,
  CASE WHEN octet_length("commit") IN (40, 64) THEN "commit" ELSE NULL END AS "commit",
  CASE WHEN octet_length(data) > ${MAX_CLAIM_BYTES} THEN NULL ELSE data END AS data, status,
  CASE WHEN octet_length(reason) > ${MAX_CLAIM_REASON_BYTES} THEN NULL ELSE reason END AS reason,
  coalesce(octet_length(reason) > ${MAX_CLAIM_REASON_BYTES}, 0) AS reason_oversized,
  CASE WHEN octet_length(section) > ${MAX_CLAIM_SECTION_BYTES} OR octet_length(id) > ${MAX_CLAIM_ID_BYTES}
    OR octet_length("commit") NOT IN (40, 64) OR octet_length(created_at) > ${MAX_CLAIM_CREATED_AT_BYTES}
    OR octet_length(repo_path) > ${MAX_CLAIM_BYTES} THEN 1 ELSE 0 END AS meta_oversized,
  CASE WHEN octet_length(created_at) > ${MAX_CLAIM_CREATED_AT_BYTES} THEN NULL ELSE created_at END AS created_at`;

type ClaimRow = {
  id: string | null;
  repo_path: string | null;
  section: string | null;
  commit: string | null;
  data: string | null;
  status: string;
  reason: string | null;
  reason_oversized: number;
  meta_oversized: number;
  created_at: string | null;
};

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

  /**
   * BEGIN IMMEDIATE takes SQLite's write lock up front: reads inside `fn` (for example a claim check) and
   * the writes that follow cannot be interleaved with another process's writes.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
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

  /**
   * Store a repository snapshot. The schema re-checks the hash, so only a snapshot whose
   * content matches its hash can be stored. Saving a hash again moves it to "latest" for the repo.
   */
  saveSnapshot(snapshot: RepoSnapshot, repoPath: string): void {
    const parsed = RepoSnapshotSchema.parse(snapshot);
    // REPLACE deletes the old (repo_path, hash) row and inserts a new one in a single statement, so a
    // re-saved snapshot gets a fresh rowid and becomes the latest for THIS repository only; another
    // repository that holds the same hash keeps its own row.
    this.db
      .prepare(`INSERT OR REPLACE INTO repo_snapshots(hash, repo_path, "commit", data, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(parsed.hash, repoPath, parsed.commit, JSON.stringify(parsed), now());
  }

  getSnapshot(hash: string): RepoSnapshot | null {
    const row = this.db
      .prepare(`SELECT hash, data FROM repo_snapshots WHERE hash = ? ORDER BY rowid DESC LIMIT 1`)
      .get(hash) as { hash: string; data: string } | undefined;
    return row ? this.parseSnapshotRow(row) : null;
  }

  /** The snapshot most recently saved for this repository path AT this commit: a snapshot of another commit does not hide it. */
  getLatestSnapshotAt(repoPath: string, commit: string): RepoSnapshot | null {
    const row = this.db
      .prepare(`SELECT hash, data FROM repo_snapshots WHERE repo_path = ? AND "commit" = ? ORDER BY rowid DESC LIMIT 1`)
      .get(repoPath, commit) as { hash: string; data: string } | undefined;
    return row ? this.parseSnapshotRow(row) : null;
  }

  /** The snapshot most recently saved for this repository path. */
  getLatestSnapshotFor(repoPath: string): RepoSnapshot | null {
    const row = this.db
      .prepare(`SELECT hash, data FROM repo_snapshots WHERE repo_path = ? ORDER BY rowid DESC LIMIT 1`)
      .get(repoPath) as { hash: string; data: string } | undefined;
    return row ? this.parseSnapshotRow(row) : null;
  }

  /** The schema proves the JSON is a valid snapshot; this proves it is the one the row is filed under. */
  private parseSnapshotRow(row: { hash: string; data: string }): RepoSnapshot {
    const raw: unknown = JSON.parse(row.data);
    assertNoUnsafeKeys(raw);
    const parsed = RepoSnapshotSchema.parse(raw);
    if (parsed.hash !== row.hash) {
      throw new Error(`snapshot stored under ${row.hash} actually has hash ${parsed.hash} (the row was replaced or corrupted)`);
    }
    return parsed;
  }

  /**
   * Store a claim under a status. This method only records: it does not decide whether a claim is true.
   * `verified` must only ever be passed by code that has just run the claim's verifier against `claimCommit(claim)`
   * (see publishClaim / reverifyOnCommit in the engine); the claim table is the brief's only source, so nothing else
   * may write that status. A `rejected` record never replaces a claim that is already published: the published
   * claim stays and false is returned. Otherwise the record is stored (replacing an older record of the same id).
   */
  saveClaim(input: { repoPath: string; claim: Claim; status: ClaimStatus; reason?: string }): boolean {
    // A row under an empty path could be written but never read back (the stored-claim schema needs a path).
    if (typeof input.repoPath !== 'string' || input.repoPath === '') throw new Error('a claim is stored under a non-empty repository path');
    if (Buffer.byteLength(input.repoPath, 'utf8') > MAX_CLAIM_BYTES) throw new Error(`a claim repository path is over ${MAX_CLAIM_BYTES} bytes`);
    assertClaimBudget(input.claim);
    assertNoUnsafeKeys(input.claim);
    const claim = ClaimSchema.parse(input.claim);
    const status = ClaimStatusSchema.parse(input.status);
    const reason = input.reason?.trim() || undefined;
    if (reason !== undefined) {
      if (reason.includes('\0')) throw new Error('a claim reason must not contain a NUL byte');
      if (Buffer.byteLength(reason, 'utf8') > MAX_CLAIM_REASON_BYTES) throw new Error(`a claim reason is over ${MAX_CLAIM_REASON_BYTES} bytes`);
    }
    if ((status === 'rejected' || status === 'withdrawn') && !reason) throw new Error(`a ${status} claim must record why`);
    // One statement, so the "never replace a published claim with a rejection" rule cannot race another writer.
    const written = this.db
      .prepare(
        `INSERT INTO claims(id, repo_path, section, "commit", data, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_path, id) DO UPDATE SET section = excluded.section, "commit" = excluded."commit", data = excluded.data,
           status = excluded.status, reason = excluded.reason, created_at = excluded.created_at
         WHERE NOT (claims.status IN ('verified', 'attested') AND excluded.status = 'rejected')`,
      )
      .run(claim.id, input.repoPath, claim.section, claimCommit(claim), JSON.stringify(claim), status, reason ?? null, now());
    return Number(written.changes) === 1;
  }

  /** Withdraw a published claim (or any claim not already withdrawn). The claim stays on record with the reason. */
  withdrawClaim(repoPath: string, id: string, reason: string): boolean {
    if (!reason.trim()) throw new Error('a withdrawn claim must record why');
    const clipped = reason.trim();
    if (clipped.includes('\0')) throw new Error('a claim reason must not contain a NUL byte');
    if (Buffer.byteLength(clipped, 'utf8') > MAX_CLAIM_REASON_BYTES) throw new Error(`a claim reason is over ${MAX_CLAIM_REASON_BYTES} bytes`);
    const r = this.db
      .prepare(`UPDATE claims SET status = 'withdrawn', reason = ? WHERE repo_path = ? AND id = ? AND status <> 'withdrawn'`)
      .run(clipped, repoPath, id);
    return Number(r.changes) === 1;
  }

  /** The commit this repository's claims have been carried to, or null before any claim was published or carried. */
  getClaimFrontier(repoPath: string): string | null {
    const row = this.db
      .prepare(
        `SELECT CASE WHEN octet_length("commit") IN (40, 64) THEN "commit" ELSE NULL END AS "commit" FROM claim_frontier WHERE repo_path = ?`,
      )
      .get(repoPath) as { commit: string | null } | undefined;
    if (!row) return null;
    if (row.commit === null) throw new Error(`claim frontier for ${repoPath} is stored with a commit id that is not a full object id`);
    return GitObjectIdSchema.parse(row.commit);
  }

  /**
   * The distinct commits at which this repository has published claims. Metadata only: the claim payloads are not read.
   * Used by the engine to refuse a transition that would move the frontier past an unchecked published claim.
   * `exceptId` omits one claim (the one being replaced) so a sole claim can move forward without hiding a sibling.
   */
  listPublishedClaimCommits(repoPath: string, opts: { exceptId?: string } = {}): string[] {
    const rows = (
      opts.exceptId === undefined
        ? this.db.prepare(
            `SELECT DISTINCT CASE WHEN octet_length("commit") IN (40, 64) THEN "commit" ELSE NULL END AS "commit"
             FROM claims WHERE repo_path = ? AND status IN ('verified', 'attested') ORDER BY 1`,
          ).all(repoPath)
        : this.db.prepare(
            `SELECT DISTINCT CASE WHEN octet_length("commit") IN (40, 64) THEN "commit" ELSE NULL END AS "commit"
             FROM claims WHERE repo_path = ? AND status IN ('verified', 'attested') AND id <> ? ORDER BY 1`,
          ).all(repoPath, opts.exceptId)
    ) as Array<{ commit: string | null }>;
    return rows.map((r) => {
      if (r.commit === null) throw new Error(`a published claim in ${repoPath} is stored with a commit id that is not a full object id`);
      return GitObjectIdSchema.parse(r.commit);
    });
  }

  /** Record the commit the claims are carried to. Like `saveClaim`, a trusted write: only publishClaim / reverifyOnCommit move it. */
  setClaimFrontier(repoPath: string, commit: string): void {
    if (typeof repoPath !== 'string' || repoPath === '') throw new Error('a claim frontier is stored under a non-empty repository path');
    const id = GitObjectIdSchema.parse(commit);
    this.db
      .prepare(
        `INSERT INTO claim_frontier(repo_path, "commit", updated_at) VALUES (?, ?, ?)
         ON CONFLICT(repo_path) DO UPDATE SET "commit" = excluded."commit", updated_at = excluded.updated_at`,
      )
      .run(repoPath, id, now());
  }

  getClaim(repoPath: string, id: string): StoredClaim | null {
    const row = this.db.prepare(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE repo_path = ? AND id = ?`).get(repoPath, id) as ClaimRow | undefined;
    return row ? this.parseClaimRow(row) : null;
  }

  /** Claims of one repository, in the order each claim id was first stored (re-saving an id does not move it). `statuses` / `section` / `commit` narrow the list. */
  /**
   * Claims of one repository. Optional `limit` / `afterId` page by claim id so a transition can process a bounded batch
   * without loading every payload at once. `afterId` is exclusive; the next page starts after that id (lexicographic).
   */
  listClaims(
    repoPath: string,
    filter: { statuses?: readonly ClaimStatus[]; section?: string; commit?: string; limit?: number; afterId?: string } = {},
  ): StoredClaim[] {
    const where = ['repo_path = ?'];
    const args: string[] = [repoPath];
    if (filter.section !== undefined) {
      where.push('section = ?');
      args.push(filter.section);
    }
    if (filter.commit !== undefined) {
      where.push('"commit" = ?');
      args.push(filter.commit);
    }
    if (filter.statuses) {
      // An empty list matches nothing; it must not fall back to "every status".
      if (!filter.statuses.length) return [];
      const statuses = [...new Set(filter.statuses.map((s) => ClaimStatusSchema.parse(s)))];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      args.push(...statuses);
    }
    if (filter.afterId !== undefined) {
      where.push('id > ?');
      args.push(filter.afterId);
    }
    let sql = `SELECT ${CLAIM_COLUMNS} FROM claims WHERE ${where.join(' AND ')} ORDER BY id ASC`;
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1) throw new Error('listClaims limit must be a positive integer');
      sql += ` LIMIT ${filter.limit}`;
    }
    const rows = this.db.prepare(sql).all(...args) as ClaimRow[];
    return rows.map((r) => this.parseClaimRow(r));
  }

  /** The schema proves the JSON is a valid claim; this proves it is the one the row is filed under. */
  private parseClaimRow(row: ClaimRow): StoredClaim {
    // The size was measured in bytes by SQLite, and an oversized payload was not returned at all.
    if (row.data === null) throw new Error(`claim ${row.id} is stored with more than ${MAX_CLAIM_BYTES} bytes of data`);
    // An over-budget reason is an invalid row, not a missing reason.
    if (row.meta_oversized || row.id === null || row.repo_path === null || row.section === null || row.commit === null || row.created_at === null) {
      throw new Error(`claim ${row.id ?? '(unknown)'} is stored with metadata over its size limit`);
    }
    if (row.reason_oversized) throw new Error(`claim ${row.id} is stored with a reason of more than ${MAX_CLAIM_REASON_BYTES} bytes`);
    const raw: unknown = JSON.parse(row.data);
    // The budget walk is iterative and stops at a fixed depth; the unsafe-key walk below recurses, so it only sees what fits.
    assertClaimBudget(raw);
    assertNoUnsafeKeys(raw);
    const stored = StoredClaimSchema.parse({
      repoPath: row.repo_path,
      claim: raw,
      section: row.section,
      commit: row.commit,
      status: row.status,
      ...(row.reason === null ? {} : { reason: row.reason }),
      createdAt: row.created_at,
    });
    if (stored.claim.id !== row.id) throw new Error(`claim stored under ${row.id} actually has id ${stored.claim.id} (the row was replaced or corrupted)`);
    return stored;
  }

  /**
   * Claim a work item for a long-running stage. Exactly one caller holds a claim at a time. A claim is
   * taken over ONLY when its owning process no longer exists: elapsed time alone never frees a claim,
   * because a slow live planner must not be displaced. Returns the token to release with.
   */
  claimWork(workId: string, purpose: string): string {
    // Owner = pid | process start time | unique id. The start time tells a live owner from a reused pid.
    const token = `${process.pid}|${processStart(process.pid) ?? ''}|${randomUUID()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = this.db
        .prepare(`INSERT OR IGNORE INTO work_claims(work_id, owner, purpose, claimed_at) VALUES (?, ?, ?, ?)`)
        .run(workId, token, purpose, now());
      if (Number(inserted.changes) === 1) return token;
      const row = this.db.prepare(`SELECT owner, purpose, claimed_at FROM work_claims WHERE work_id = ?`).get(workId) as
        | { owner: string; purpose: string; claimed_at: string }
        | undefined;
      if (!row) continue; // released between the two statements: try again
      if (claimOwnerIsDead(row.owner)) {
        const taken = this.db
          .prepare(`UPDATE work_claims SET owner = ?, purpose = ?, claimed_at = ? WHERE work_id = ? AND owner = ?`)
          .run(token, purpose, now(), workId, row.owner);
        if (Number(taken.changes) === 1) return token;
        continue;
      }
      throw err('E_CONCURRENT', `${row.purpose} is already in progress for ${workId} (started ${row.claimed_at}). Wait for it to finish, then retry.`);
    }
    throw err('E_CONCURRENT', `Could not claim ${workId} for ${purpose}; another process is changing it. Retry.`);
  }

  holdsClaim(workId: string, token: string): boolean {
    const row = this.db.prepare(`SELECT owner FROM work_claims WHERE work_id = ?`).get(workId) as { owner: string } | undefined;
    return row?.owner === token;
  }

  releaseClaim(workId: string, token: string): void {
    this.db.prepare(`DELETE FROM work_claims WHERE work_id = ? AND owner = ?`).run(workId, token);
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

/**
 * When a process started, as the OS reports it (`ps -o lstart=`). Undefined where that cannot be read, in
 * which case a claim cannot be told apart from a reused pid and is treated as held while its pid lives.
 */
function processStart(pid: number): string | undefined {
  // Render the start time in UTC with the C locale: the same process must read the same string whatever the
  // time zone or language of the process that asks (lstart is formatted in local time otherwise).
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
  });
  if (r.status !== 0) return undefined;
  const text = r.stdout.trim();
  return text === '' ? undefined : text;
}

/**
 * True only when the claim's owner is confirmed gone: its pid no longer exists, or the pid now belongs to a
 * different process (its start time differs). Age alone never qualifies.
 */
function claimOwnerIsDead(owner: string): boolean {
  const parts = owner.split('|');
  // Owners written before the start time was recorded look like "pid:uuid".
  const pid = parts.length > 1 ? Number(parts[0]) : Number(owner.split(':')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true; // not a token we issued: nobody can be defending it
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const recorded = parts.length > 2 ? parts[1] : undefined;
  if (recorded) {
    const now = processStart(pid);
    if (now !== undefined && now !== recorded) return true; // the pid was reused by another process
  }
  return false;
}
