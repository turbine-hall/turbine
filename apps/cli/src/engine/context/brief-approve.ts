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
import { reverifyOnCommit } from './claims.js';
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
  const head = resolveCommit(input.repoRoot, 'HEAD');
  if (!head) throw err('E_CONTEXT_UNAVAILABLE', 'HEAD does not resolve to a commit');

  // Carry claims to HEAD before sealing. If anything is withdrawn, the confirm token no longer matches.
  const frontier = input.store.getClaimFrontier(input.repoPath);
  if (frontier && frontier !== head) {
    reverifyOnCommit(input.store, input.repoRoot, input.repoPath, frontier, head);
  }

  const { next, published } = input.store.transaction(() => {
    const { state, claims, confirmToken } = briefDiff(input.store, input.repoPath);
    if (!state || !confirmToken) throw err('E_NOT_FOUND', 'No brief to approve; run: turbine understand');
    if (input.confirmToken.trim() !== confirmToken) {
      throw err(
        'E_UNTRUSTED_IDENTITY',
        `Confirmation "${input.confirmToken}" does not match the brief under review (${confirmToken}). Re-read the claim diff and try again.`,
      );
    }
    const headNow = resolveCommit(input.repoRoot, 'HEAD');
    if (!headNow || headNow !== head || headNow !== state.commit) {
      throw err('E_CONTEXT_UNAVAILABLE', `HEAD moved since the brief was drafted at ${state.commit.slice(0, 8)}; run: turbine understand`);
    }
    // Recompute hash from published claims only — approval cannot invent or revive rejected rows.
    const publishedNow = claims.filter((c) => (PUBLISHED_CLAIM_STATUSES as readonly string[]).includes(c.status));
    if (publishedNow.some((c) => c.commit !== headNow)) {
      throw err('E_CONTEXT_UNAVAILABLE', 'Published claims are not all at HEAD; run: turbine understand');
    }
    const hash = claimsHashOf(publishedNow);
    if (hash !== state.claimsHash) {
      throw err('E_CONTEXT_UNAVAILABLE', 'The published claim set changed; run: turbine understand');
    }
    const saved: BriefState = BriefStateSchema.parse({
      ...state,
      commit: headNow,
      approvedHash: hash,
      approvedBy: input.reviewer.trim(),
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    input.store.saveBriefState(saved);
    return { next: saved, published: publishedNow };
  });

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
  projectRoot: string;
  repoRoot: string;
  repoPath: string;
  sections: string[];
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

  // Reverify before advancing the frontier so a cited-file change cannot leave a stale claim labelled current.
  const frontier = input.store.getClaimFrontier(input.repoPath);
  if (frontier && frontier !== head) {
    reverifyOnCommit(input.store, input.repoRoot, input.repoPath, frontier, head);
  }

  // Evidence commit must be HEAD so reverify can withdraw when cited files change.
  const claim: Claim = {
    ...parsed.claim,
    evidence: parsed.claim.evidence.map((e) => ({ ...e, commit: head })),
  };
  const reason = `Human-attested (by ${input.reviewer.trim()}, date ${new Date().toISOString().slice(0, 10)}, commit ${head.slice(0, 8)})`;

  const { saved, state } = input.store.transaction(() => {
    const headNow = resolveCommit(input.repoRoot, 'HEAD');
    if (!headNow || headNow !== head) {
      throw err('E_CONTEXT_UNAVAILABLE', 'HEAD moved while the claim was being attested; nothing was stored, try again');
    }
    const ok = input.store.saveClaim({ repoPath: input.repoPath, claim, status: 'attested', reason });
    if (!ok) throw err('E_SOURCE_CONFLICT', `could not attest claim ${claim.id}`);
    input.store.setClaimFrontier(input.repoPath, headNow);
    // Clear approval: claim set changed.
    const prev = input.store.getBriefState(input.repoPath);
    const published = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
    const nextState: BriefState | null = prev
      ? {
          ...prev,
          commit: headNow,
          claimsHash: claimsHashOf(published),
          approvedHash: null,
          approvedBy: null,
          approvedAt: null,
          updatedAt: new Date().toISOString(),
        }
      : null;
    if (nextState) input.store.saveBriefState(nextState);
    return { saved: claim, state: nextState, published };
  });

  // Render markers immediately so the next understand does not treat the attestation as a human removal.
  if (state) {
    const projectPath = contextPaths(input.projectRoot).project;
    const existing = existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : undefined;
    const published = input.store.listClaims(input.repoPath, { statuses: [...PUBLISHED_CLAIM_STATUSES] });
    writeBriefFiles(input.projectRoot, input.sections, published, state, existing);
  }

  return saved;
}

export { briefConfirmToken };
