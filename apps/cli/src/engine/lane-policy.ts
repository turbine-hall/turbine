import { existsSync, lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { isAlias, isMap, isSeq, parseDocument } from 'yaml';
import {
  LanePolicySchema,
  contentHashText,
  createId,
  err,
  policyDecisionSubject,
  type ApprovedLanePolicy,
  type Decision,
  type LanePolicy,
} from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { compileGlob } from './context/snapshot.js';
import { readBoundedUtf8 } from './knowledge/paths.js';

/** Budgets for reading `.turbine/policies/` (rule 2 / rule 17). */
export const MAX_POLICY_FILES = 50;
export const MAX_POLICY_BYTES = 64 * 1024;
/** Total directory entries (yaml and otherwise) before the walk stops. */
export const MAX_POLICY_DIR_ENTRIES = 200;
const MAX_POLICY_YAML_DEPTH = 8;
const MAX_DIFF_LINES = 2000;
export type ModelProfiles = Record<string, { provider: string; model: string; maxOutputTokens?: number }>;

/** Paths of Turbine's own gate machinery; approving a policy that does not deny them prints a warning. */
const GATE_MACHINERY_SAMPLES = ['.cursor/hooks.json', '.github/workflows/ci.yml', '.turbine/project.yaml', 'apps/cli/src/human-gate.ts'];

export type PolicyFile = {
  name: string;
  path: string;
  yaml?: string;
  hash?: string;
  policy?: LanePolicy;
  /** Why the file cannot be used (read, parse or validation failure). */
  error?: string;
};

/**
 * - `active` / `suspended`: the file matches the approved snapshot
 * - `pending`: the file differs from (or no longer exists for) the approved snapshot, so nothing passes with it
 * - `unapproved`: a valid file that no human has approved yet
 * - `invalid`: the file or the stored snapshot cannot be read or validated
 */
export type PolicyState = 'active' | 'suspended' | 'pending' | 'unapproved' | 'invalid';

export type PolicyStatus = {
  name: string;
  state: PolicyState;
  reason?: string;
  file?: PolicyFile;
  approved?: ApprovedLanePolicy;
};

export const policiesDir = (projectRoot: string) => join(projectRoot, '.turbine', 'policies');
export const policyConfirmToken = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 8);

function assertDepth(node: unknown, depth: number): void {
  if (depth > MAX_POLICY_YAML_DEPTH) throw new Error(`YAML nesting exceeds ${MAX_POLICY_YAML_DEPTH} levels`);
  if (isAlias(node)) throw new Error('YAML aliases are not allowed in a lane policy');
  if (isMap(node)) {
    for (const item of node.items) {
      if (isAlias(item.key)) throw new Error('YAML aliases are not allowed in a lane policy');
      assertDepth(item.value, depth + 1);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) assertDepth(item, depth + 1);
  }
}

/** Parse and validate one policy document. Throws a readable message on any problem. */
export function parsePolicyYaml(text: string, expectedName?: string): LanePolicy {
  const doc = parseDocument(text, { strict: true, uniqueKeys: true, schema: 'core', version: '1.2' });
  if (doc.errors.length) throw new Error(`invalid YAML (${doc.errors[0]!.message.split('\n')[0]})`);
  if (doc.warnings.some((w) => /unknown tag|unresolved tag/i.test(w.message))) throw new Error('YAML custom tags are not allowed');
  if (!isMap(doc.contents)) throw new Error('a lane policy must be a YAML mapping');
  assertDepth(doc.contents, 0);
  const parsed = LanePolicySchema.safeParse(doc.toJS({ mapAsMap: false, maxAliasCount: 0 }));
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  const policy = parsed.data;
  if (expectedName !== undefined && policy.name !== expectedName) {
    throw new Error(`name "${policy.name}" does not match the file name ${expectedName}.yaml`);
  }
  // deniedPaths are matched with the iterative glob matcher; syntax it cannot compile is refused, not ignored.
  for (const p of policy.deniedPaths) {
    if (!compileGlob(p, { dot: true })) throw new Error(`deniedPaths: unsupported pattern "${p}" (use *, ?, ** and {a,b})`);
  }
  return policy;
}

/**
 * Read `.turbine/policies/*.yaml` (top level only). Symlinks, non-files and oversized files are refused
 * per file. The walk stops at MAX_POLICY_FILES and says so.
 */
export function readPolicyFiles(projectRoot: string): { files: PolicyFile[]; errors: string[] } {
  const dir = policiesDir(projectRoot);
  const files: PolicyFile[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { files, errors };
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    errors.push(`${dir} is not a directory (symlinks are refused)`);
    return { files, errors };
  }
  // Bound enumeration of every entry (not only .yaml) so a large dir cannot bypass the budget.
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    for (;;) {
      const ent = handle.readSync();
      if (ent === null) break;
      if (names.length >= MAX_POLICY_DIR_ENTRIES) {
        errors.push(`policies directory has more than ${MAX_POLICY_DIR_ENTRIES} entries; stopped reading`);
        break;
      }
      names.push(ent.name);
    }
  } finally {
    handle.closeSync();
  }
  names.sort();
  let seen = 0;
  for (const entry of names) {
    if (!entry.endsWith('.yaml')) {
      if (entry.endsWith('.yml')) errors.push(`${entry}: ignored — lane policies must use the .yaml extension`);
      continue;
    }
    if (++seen > MAX_POLICY_FILES) {
      errors.push(`more than ${MAX_POLICY_FILES} policy files; stopped reading at ${entry}`);
      break;
    }
    const name = entry.slice(0, -'.yaml'.length);
    const path = join(dir, entry);
    const file: PolicyFile = { name, path };
    files.push(file);
    try {
      const lst = lstatSync(path);
      if (lst.isSymbolicLink() || !lst.isFile()) throw new Error('not a regular file (symlinks are refused)');
      const text = readBoundedUtf8(path, MAX_POLICY_BYTES);
      if (text === undefined) throw new Error('file disappeared while reading');
      file.yaml = text;
      file.hash = contentHashText(text);
      file.policy = parsePolicyYaml(text, name);
    } catch (e) {
      const message = (e as Error).message;
      file.error = message.startsWith('file-too-large') ? `larger than ${MAX_POLICY_BYTES} bytes` : message;
    }
  }
  return { files, errors };
}

/** Merge files on disk with approved snapshots in the store. Store read failures are reported per policy. */
export function policyStatuses(store: WorkStore, projectRoot: string): { policies: PolicyStatus[]; errors: string[] } {
  const { files, errors } = readPolicyFiles(projectRoot);
  const stored = store.listLanePolicies();
  const names = [...new Set([...files.map((f) => f.name), ...stored.map((s) => s.name)])].sort();
  const policies = names.map((name): PolicyStatus => {
    const file = files.find((f) => f.name === name);
    const row = stored.find((s) => s.name === name);
    if (row?.error) return { name, state: 'invalid', reason: `stored snapshot unreadable: ${row.error}`, file };
    const approved = row?.policy;
    if (file?.error) return { name, state: 'invalid', reason: file.error, file, approved };
    if (!approved) return { name, state: 'unapproved', reason: 'no human has approved this policy', file };
    if (!file) return { name, state: 'pending', reason: 'the approved policy file was removed', approved };
    if (file.hash !== approved.contentHash) {
      return { name, state: 'pending', reason: 'the file changed since it was approved; approve the new content', file, approved };
    }
    return approved.status === 'suspended'
      ? { name, state: 'suspended', reason: approved.suspendedReason ?? 'suspended', file, approved }
      : { name, state: 'active', file, approved };
  });
  return { policies, errors };
}

/** The approved snapshots that may pass gates right now (file matches the approved hash, status active). */
export function activePolicies(store: WorkStore, projectRoot: string): ApprovedLanePolicy[] {
  return policyStatuses(store, projectRoot)
    .policies.filter((p) => p.state === 'active')
    .map((p) => p.approved!);
}

/** Line diff (approved → file) for `policy show`. Bounded; larger inputs say so instead of diffing. */
export function policyDiff(before: string, after: string): string[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return [`(policy longer than ${MAX_DIFF_LINES} lines; diff not shown)`];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

/** Gate-machinery paths the policy does not deny (approval warns about each). */
export function undeniedMachinery(policy: LanePolicy): string[] {
  const matchers = policy.deniedPaths.map((p) => compileGlob(p, { dot: true })!);
  return GATE_MACHINERY_SAMPLES.filter((path) => !matchers.some((m) => deniedBy(m, path)));
}

/** Resolve the two autonomous reviewers and refuse missing or identical provider+model identities. */
export function resolvePolicyReviewers(
  policy: LanePolicy,
  profiles: ModelProfiles,
): [
  { name: string; provider: string; model: string; maxOutputTokens: number },
  { name: string; provider: string; model: string; maxOutputTokens: number },
] | undefined {
  if (!policy.gates.includes('codeReview')) return undefined;
  if (!policy.reviewers || policy.reviewers.length !== 2) {
    throw err('E_INVALID_CONFIG', `Policy ${policy.name}: codeReview requires exactly two reviewer profiles`);
  }
  const resolved = policy.reviewers.map((name) => {
    const profile = profiles[name];
    if (!profile) throw err('E_INVALID_CONFIG', `Policy ${policy.name}: reviewer profile "${name}" is not configured`);
    return { name, provider: profile.provider, model: profile.model, maxOutputTokens: profile.maxOutputTokens ?? 4000 };
  }) as [
    { name: string; provider: string; model: string; maxOutputTokens: number },
    { name: string; provider: string; model: string; maxOutputTokens: number },
  ];
  if (resolved[0].provider === resolved[1].provider && resolved[0].model === resolved[1].model) {
    throw err(
      'E_INVALID_CONFIG',
      `Policy ${policy.name}: reviewers ${resolved[0].name} and ${resolved[1].name} resolve to the same model ${resolved[0].provider}/${resolved[0].model}`,
    );
  }
  return resolved;
}

/** A file is denied when the pattern matches it or any directory above it. */
export function deniedBy(matcher: (path: string) => boolean, path: string): boolean {
  const segs = path.split('/');
  for (let n = segs.length; n > 0; n--) if (matcher(segs.slice(0, n).join('/'))) return true;
  return false;
}

/** What `policy approve <name>` would approve: the file's exact content. */
export function pendingPolicyApproval(store: WorkStore, projectRoot: string, name: string, profiles: ModelProfiles) {
  const status = policyStatuses(store, projectRoot).policies.find((p) => p.name === name);
  if (!status?.file) throw err('E_NOT_FOUND', `No policy file .turbine/policies/${name}.yaml`);
  if (status.file.error || !status.file.policy || !status.file.hash || status.file.yaml === undefined) {
    throw err('E_INVALID_CONFIG', `Policy ${name} is invalid: ${status.file.error ?? 'unreadable'}`);
  }
  if (status.state === 'invalid') throw err('E_INVALID_CONFIG', `Policy ${name}: ${status.reason}`);
  resolvePolicyReviewers(status.file.policy, profiles);
  return {
    status,
    policy: status.file.policy,
    yaml: status.file.yaml,
    hash: status.file.hash,
    confirmToken: policyConfirmToken(status.file.hash),
    warnings: undeniedMachinery(status.file.policy).map((p) => `deniedPaths does not cover ${p} (Turbine's gate machinery)`),
    diff: status.approved ? policyDiff(status.approved.yaml, status.file.yaml) : undefined,
  };
}

function humanPolicyDecision(name: string, hash: string, reviewer: string, presence: string, rationale: string): Decision {
  return {
    id: createId('dec'),
    workId: policyDecisionSubject(name),
    gate: 'policy',
    action: 'approve',
    artifactIds: [],
    artifactHashes: [hash],
    workRevision: 0,
    actorId: reviewer,
    actorType: 'human',
    identityAssurance: 'local-attestation',
    rationale,
    decidedAt: new Date().toISOString(),
    presence,
  };
}

/** Human-only (callers establish presence): approve the exact content of `.turbine/policies/<name>.yaml`. */
export function approvePolicy(
  store: WorkStore,
  projectRoot: string,
  input: { name: string; confirmToken: string; reviewer: string; presence: string; profiles: ModelProfiles },
): { policy: ApprovedLanePolicy; decision: Decision; warnings: string[] } {
  const pending = pendingPolicyApproval(store, projectRoot, input.name, input.profiles);
  if (input.confirmToken.trim() !== pending.confirmToken) {
    throw err('E_STALE_REVISION', `Confirmation "${input.confirmToken}" does not match policy ${input.name} (${pending.confirmToken}). Re-read it and try again.`);
  }
  const reviewer = input.reviewer.trim();
  if (!reviewer) throw err('E_UNTRUSTED_IDENTITY', 'Reviewer name is required');
  const decision = humanPolicyDecision(input.name, pending.hash, reviewer, input.presence, 'Lane policy approved (local attestation)');
  const policy = store.transaction(() => {
    // The file is read again under the write lock: an edit after the human read it is not what they approved.
    const again = readPolicyFiles(projectRoot).files.find((f) => f.name === input.name);
    if (again?.hash !== pending.hash) {
      throw err('E_STALE_REVISION', `Policy ${input.name} changed while it was being approved; nothing was saved. Re-read it and approve again.`);
    }
    if (!again.policy) throw err('E_INVALID_CONFIG', `Policy ${input.name} became unreadable while it was being approved`);
    resolvePolicyReviewers(again.policy, input.profiles);
    const snapshot: ApprovedLanePolicy = {
      name: input.name,
      contentHash: pending.hash,
      yaml: pending.yaml,
      policy: pending.policy,
      approvedDecisionId: decision.id,
      approvedBy: reviewer,
      approvedAt: decision.decidedAt,
      status: 'active',
      updatedAt: decision.decidedAt,
    };
    store.saveDecision(decision);
    store.saveLanePolicy(snapshot);
    store.appendEvent({
      workId: policyDecisionSubject(input.name),
      type: 'policy.approved',
      payload: { decisionId: decision.id, hash: pending.hash, by: reviewer, warnings: pending.warnings },
    });
    return snapshot;
  });
  return { policy, decision, warnings: pending.warnings };
}

/** Anyone (agents included) may suspend: it only removes autonomy. */
export function suspendPolicy(store: WorkStore, name: string, reason: string, actor: string): ApprovedLanePolicy {
  if (!reason.trim()) throw err('E_INVALID_CONFIG', 'A suspension needs a reason (--reason)');
  return store.transaction(() => {
    const current = store.getLanePolicy(name);
    if (!current) throw err('E_NOT_FOUND', `Policy ${name} has never been approved, so there is nothing to suspend`);
    const next: ApprovedLanePolicy = { ...current, status: 'suspended', suspendedReason: reason.trim(), updatedAt: new Date().toISOString() };
    store.saveLanePolicy(next);
    store.appendEvent({ workId: policyDecisionSubject(name), type: 'policy.suspended', payload: { reason: reason.trim(), by: actor } });
    return next;
  });
}

/** What `policy resume <name>` would re-activate: the approved snapshot (typed token = its short hash). */
export function pendingPolicyResume(store: WorkStore, name: string) {
  const current = store.getLanePolicy(name);
  if (!current) throw err('E_NOT_FOUND', `Policy ${name} has never been approved`);
  if (current.status !== 'suspended') throw err('E_INVALID_TRANSITION', `Policy ${name} is not suspended`);
  return { policy: current, confirmToken: policyConfirmToken(current.contentHash) };
}

/** Human-only (callers establish presence): re-activate a suspended policy's approved snapshot. */
export function resumePolicy(
  store: WorkStore,
  input: { name: string; confirmToken: string; reviewer: string; presence: string },
): { policy: ApprovedLanePolicy; decision: Decision } {
  const reviewer = input.reviewer.trim();
  if (!reviewer) throw err('E_UNTRUSTED_IDENTITY', 'Reviewer name is required');
  return store.transaction(() => {
    const pending = pendingPolicyResume(store, input.name);
    if (input.confirmToken.trim() !== pending.confirmToken) {
      throw err('E_STALE_REVISION', `Confirmation "${input.confirmToken}" does not match policy ${input.name} (${pending.confirmToken}).`);
    }
    const decision = humanPolicyDecision(input.name, pending.policy.contentHash, reviewer, input.presence, 'Lane policy resumed (local attestation)');
    const next: ApprovedLanePolicy = { ...pending.policy, status: 'active', suspendedReason: undefined, updatedAt: decision.decidedAt };
    store.saveDecision(decision);
    store.saveLanePolicy(next);
    store.appendEvent({ workId: policyDecisionSubject(input.name), type: 'policy.resumed', payload: { decisionId: decision.id, by: reviewer } });
    return { policy: next, decision };
  });
}
