import { ClaimSchema, PUBLISHED_CLAIM_STATUSES, claimCommit, parseClaimSafe } from '@turbine-hall/turbine-contracts';
import type { Claim, StoredClaim } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { resolveCommit, treeIdOf } from './git-read.js';
import { CommitReader, verifyClaim } from './verify.js';

/**
 * Publishing and re-verifying claims.
 *
 * The rule this file enforces: a claim is `verified` (and so can appear in a brief) only if its verifier proved it
 * against the git objects of the commit it names, in this process, immediately before it was stored. There is no
 * other path to the `verified` status: publication runs the verifier, and carrying a claim to a newer commit runs
 * it again (or proves the cited blobs did not change).
 */

export type PublishOutcome =
  | { published: true; claim: StoredClaim }
  | {
      published: false;
      reason: string;
      /** The verifier could not look (for example a file it needs was unreadable), as opposed to finding the claim false. */
      unconfirmed: boolean;
      /** Whether a `rejected` record was written. A claim that does not parse, or that would replace a published claim, is not. */
      recorded: boolean;
    };

/** Verify a claim at the commit it names and, only if the verifier proves it, store it as `verified`. */
export function publishClaim(store: WorkStore, repoRoot: string, repoPath: string, input: unknown): PublishOutcome {
  // A `__proto__` key is refused before the schema runs (zod would drop it and change what the claim says); nothing is written.
  const parsed = parseClaimSafe(input);
  if (!parsed.ok) return { published: false, reason: `the claim is not valid: ${parsed.reason}`, unconfirmed: false, recorded: false };
  const claim = parsed.claim;
  const commit = claimCommit(claim);
  let result: ReturnType<typeof verifyClaim>;
  try {
    result = verifyClaim(new CommitReader(repoRoot, commit), claim, 'pinned');
  } catch (e) {
    // A repository that cannot be read is not a false claim, and not a proven one either.
    const reason = e instanceof Error ? e.message : String(e);
    return reject(store, repoPath, claim, reason, true);
  }
  if (!result.ok) return reject(store, repoPath, claim, result.reason, result.unconfirmed === true);
  // The row is read in the same transaction that wrote it: another process may withdraw it the moment this one commits.
  const stored = store.transaction(() => {
    store.saveClaim({ repoPath, claim, status: 'verified', reason: result.reason });
    return store.getClaim(repoPath, claim.id)!;
  });
  return { published: true, claim: stored };
}

function reject(store: WorkStore, repoPath: string, claim: Claim, reason: string, unconfirmed: boolean): PublishOutcome {
  const recorded = store.transaction(() => store.saveClaim({ repoPath, claim, status: 'rejected', reason }));
  return { published: false, reason, unconfirmed, recorded };
}

export type ReverifyResult = {
  from: string;
  to: string;
  /** Claims carried to the new commit (their cited blobs did not change, or the verifier proved them again). */
  kept: string[];
  /** Claims removed from the brief, with the reason. */
  withdrawn: Array<{ id: string; section: string; reason: string }>;
  /** Sections that lost a claim: the brief must be rendered again for them. */
  sections: string[];
};

/** The claim, carried to the commit `reader` reads: every evidence item now names this commit and its blob there. */
function rebind(reader: CommitReader, claim: Claim): Claim {
  return ClaimSchema.parse({
    ...claim,
    evidence: claim.evidence.map((e) => {
      const entry = reader.entry(e.path);
      if (!entry) throw new Error(`${e.path} is not tracked at ${reader.commit}`);
      return { ...e, commit: reader.commit, blob: entry.id };
    }),
  });
}

/**
 * Carry every published claim of `prev` to `next`.
 *   - A claim whose cited files are all unchanged is kept and re-pinned to `next`.
 *   - A claim with a changed (or deleted) cited file is verified again against `next`. If it is no longer proven it is
 *     WITHDRAWN with the reason: it leaves the brief, it is not left in place with a flag.
 *   - An absence claim covers the whole tree, so it is verified again whenever the tree changed at all.
 *   - An attested claim has no verifier proof to repeat, so a change to a cited file withdraws it: a person must attest again.
 * All writes happen in one transaction, so a failure part-way (an unreadable repository) leaves the claims as they were.
 */
export function reverifyOnCommit(store: WorkStore, repoRoot: string, repoPath: string, prev: string, next: string): ReverifyResult {
  if (resolveCommit(repoRoot, prev) !== prev) throw new Error(`${prev} is not a commit of this repository (a full commit id is required)`);
  const reader = new CommitReader(repoRoot, next);
  const result: ReverifyResult = { from: prev, to: next, kept: [], withdrawn: [], sections: [] };
  if (prev === next) return result;
  const treeChanged = treeIdOf(repoRoot, prev) !== treeIdOf(repoRoot, next);

  store.transaction(() => {
    const claims = store.listClaims(repoPath, { statuses: PUBLISHED_CLAIM_STATUSES, commit: prev });
    // Compared by what the tree holds (object id and type), not by `git diff`: a mode-only change does not change the
    // blob, and a diff over thousands of cited paths would overflow the command line.
    const before = new CommitReader(repoRoot, prev);
    const changed = new Set<string>();
    for (const c of claims) {
      for (const e of c.claim.evidence) {
        const a = before.entry(e.path);
        const b = reader.entry(e.path);
        if (!a || !b || a.id !== b.id || a.type !== b.type) changed.add(e.path);
      }
    }
    const sections = new Set<string>();

    for (const stored of claims) {
      const { claim } = stored;
      const citedChanged = claim.evidence.some((e) => changed.has(e.path));
      const wholeTree = claim.kind === 'absence' && treeChanged;
      const withdraw = (reason: string) => {
        store.withdrawClaim(repoPath, claim.id, `at ${next}: ${reason}`);
        store.appendEvent({ type: 'claim.withdrawn', payload: { repoPath, id: claim.id, section: claim.section, from: prev, to: next, reason } });
        result.withdrawn.push({ id: claim.id, section: claim.section, reason });
        sections.add(claim.section);
      };
      if (!citedChanged && !wholeTree) {
        store.saveClaim({ repoPath, claim: rebind(reader, claim), status: stored.status, ...(stored.reason ? { reason: stored.reason } : {}) });
        result.kept.push(claim.id);
        continue;
      }
      if (stored.status === 'attested') {
        withdraw(wholeTree && !citedChanged ? 'the tree changed and an attested absence claim cannot be checked again' : 'a cited file changed since it was attested, so it must be attested again');
        continue;
      }
      const v = verifyClaim(reader, claim, 'rebind');
      if (!v.ok) {
        withdraw(v.reason);
        continue;
      }
      store.saveClaim({ repoPath, claim: rebind(reader, claim), status: 'verified', reason: v.reason });
      result.kept.push(claim.id);
    }
    result.sections = [...sections].sort();
  });
  return result;
}
