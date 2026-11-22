import { z } from 'zod';
import { contentHashText } from './ids.js';
import { GitObjectIdSchema } from './context.js';
import { PUBLISHED_CLAIM_STATUSES, type Claim, type ClaimStatus, type StoredClaim } from './claims.js';

/** Default brief sections when project config does not override them. */
export const DEFAULT_BRIEF_SECTIONS = [
  'architecture',
  'security',
  'getting-started',
  'testing',
  'deployment',
  'data-model',
] as const;

export const BriefSectionSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'expected a lower-case section name');
export type BriefSection = z.infer<typeof BriefSectionSchema>;

/** Persisted approval / draft state for one repository's brief. */
export const BriefStateSchema = z
  .object({
    repoPath: z.string().min(1),
    commit: GitObjectIdSchema,
    /** Hash of the published claim set at `commit` (ids, statuses, verifier proofs). */
    claimsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** Set when a human approved exactly `claimsHash`; cleared when the claim set changes. */
    approvedHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable(),
    approvedBy: z.string().min(1).max(200).nullable(),
    approvedAt: z.string().min(1).nullable(),
    sampleCap: z.number().int().min(1).max(200),
    /** Paths sampled for the last draft (reported; may be empty when no model call ran). */
    samplePaths: z.array(z.string()).max(200),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BriefState = z.infer<typeof BriefStateSchema>;

/** Stable hash of the published claims that may appear in the brief. */
export function claimsHashOf(claims: readonly StoredClaim[]): string {
  const rows = claims
    .filter((c) => (PUBLISHED_CLAIM_STATUSES as readonly ClaimStatus[]).includes(c.status))
    .map((c) => ({
      id: c.claim.id,
      section: c.claim.section,
      status: c.status,
      commit: c.commit,
      kind: c.claim.kind,
      verifier: c.claim.verifier,
      evidence: c.claim.evidence,
      reason: c.reason ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return contentHashText(JSON.stringify(rows));
}

/** Short confirm token a human types to approve the brief (first 8 hex of the claims hash). */
export function briefConfirmToken(claimsHash: string): string {
  const hex = claimsHash.replace(/^sha256:/, '');
  return hex.slice(0, 8);
}

/** Model output schema id for draft-project-brief. */
export const BRIEF_SCHEMA_ID = 'project-brief';

/** One proposed claim from the model (validated with ClaimSchema before verify). */
export type BriefProposal = { claims: Claim[] };
