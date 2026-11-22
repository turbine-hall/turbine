import {
  BriefStateSchema,
  PUBLISHED_CLAIM_STATUSES,
  briefConfirmToken,
  claimsHashOf,
  err,
  parseClaimSafe,
  type BriefState,
  type Claim,
} from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { briefDiff } from './brief.js';
import { writeBriefFiles } from './brief-render.js';
import { contextPaths } from './render.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolveCommit } from './git-read.js';

/**
 * Human approval of the brief: hash-bound, like task gates.
 * Approves the *already verified* claim set; never publishes a rejected or unverified claim.
 */
export function approveBrief(input: {
  store: WorkStore;
  projectRoot: string;
  repoRoot: string;
  repoPath: string;
  sections: string[];
  reviewer: string;
  confirmToken: string;
  presence: string;
}): BriefState {
  if (input.presence !== 'tty-hash-confirmation') {
    throw err('E_UNTRUSTED_IDENTITY', 'Brief approval requires interactive terminal presence');
  }
  const { state, claims, confirmToken } = briefDiff(input.store, input.repoPath);
  if (!state || !confirmToken) throw err('E_NOT_FOUND', 'No brief to approve; run: turbine understand');
  if (input.confirmToken.trim() !== confirmToken) {
    throw err(
      'E_UNTRUSTED_IDENTITY',
      `Confirmation "${input.confirmToken}" does not match the brief under review (${confirmToken}). Re-read the claim diff and try again.`,
    );
  }
  const head = resolveCommit(input.repoRoot, 'HEAD');
  if (!head || head !== state.commit) {
    throw err('E_CONTEXT_UNAVAILABLE', `HEAD moved since the brief was drafted at ${state.commit.slice(0, 8)}; run: turbine understand`);
  }
  // Recompute hash from published claims only — approval cannot invent or revive rejected rows.
  const published = claims.filter((c) => (PUBLISHED_CLAIM_STATUSES as readonly string[]).includes(c.status));
  const hash = claimsHashOf(published);
  if (hash !== state.claimsHash) {
    throw err('E_CONTEXT_UNAVAILABLE', 'The published claim set changed; run: turbine understand');
  }
  const next: BriefState = BriefStateSchema.parse({
    ...state,
    approvedHash: hash,
    approvedBy: input.reviewer.trim(),
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  input.store.saveBriefState(next);
  const projectPath = contextPaths(input.projectRoot).project;
  const existing = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : undefined;
  writeBriefFiles(input.projectRoot, input.sections, published, next, existing);
  return next;
}

/**
 * Human attestation for a claim that cannot be proven mechanically (intent / rationale).
 * Stored as `attested` with who/when/commit in the reason. Never writes `verified`.
 */
export function attestClaim(input: {
  store: WorkStore;
  repoRoot: string;
  repoPath: string;
  raw: unknown;
  reviewer: string;
  presence: string;
}): Claim {
  if (input.presence !== 'tty-hash-confirmation') {
    throw err('E_UNTRUSTED_IDENTITY', 'Claim attestation requires interactive terminal presence');
  }
  const parsed = parseClaimSafe(input.raw);
  if (!parsed.ok) throw err('E_INVALID_CONFIG', `the claim is not valid: ${parsed.reason}`);
  const head = resolveCommit(input.repoRoot, 'HEAD');
  if (!head) throw err('E_CONTEXT_UNAVAILABLE', 'HEAD does not resolve to a commit');
  // Evidence commit must be HEAD so reverify can withdraw when cited files change.
  const claim: Claim = {
    ...parsed.claim,
    evidence: parsed.claim.evidence.map((e) => ({ ...e, commit: head })),
  };
  const reason = `Human-attested (by ${input.reviewer.trim()}, date ${new Date().toISOString().slice(0, 10)}, commit ${head.slice(0, 8)})`;
  const ok = input.store.saveClaim({ repoPath: input.repoPath, claim, status: 'attested', reason });
  if (!ok) throw err('E_SOURCE_CONFLICT', `could not attest claim ${claim.id}`);
  input.store.setClaimFrontier(input.repoPath, head);
  // Clear approval: claim set changed.
  const prev = input.store.getBriefState(input.repoPath);
  if (prev) {
    const published = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
    input.store.saveBriefState({
      ...prev,
      commit: head,
      claimsHash: claimsHashOf(published),
      approvedHash: null,
      approvedBy: null,
      approvedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }
  return claim;
}

export { briefConfirmToken };
