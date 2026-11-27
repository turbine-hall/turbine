import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DecisionSchema,
  LANE_HARD_TRIGGER_NAMES,
  LANE_SOFT_TRIGGER_NAMES,
  LanePolicySchema,
} from '../../packages/contracts/dist/index.js';
import { HARD_TRIGGERS, SOFT_TRIGGERS } from '../../packages/core/dist/index.js';
import { isHumanOnlyCommand } from '../../apps/cli/src/engine/agent-guard.js';
import {
  MAX_POLICY_BYTES,
  MAX_POLICY_DIR_ENTRIES,
  MAX_POLICY_FILES,
  approvePolicy,
  parsePolicyYaml,
  pendingPolicyApproval,
  pendingPolicyResume,
  policyStatuses,
  readPolicyFiles,
  resumePolicy,
  suspendPolicy,
} from '../../apps/cli/src/engine/lane-policy.js';
import { cleanup } from './fixture.js';
import { ROUTINE_POLICY, approve, laneEvents, laneProject, toRequirementsGate, writePolicy } from './lane-fixture.js';

const dirs: string[] = [];
afterEach(() => cleanup(dirs));

const here = dirname(fileURLToPath(import.meta.url));
const factory = resolve(here, '../..');
const tsx = join(factory, 'node_modules', '.bin', 'tsx');
const cli = join(factory, 'apps', 'cli', 'src', 'index.ts');
const AGENT_MARKERS = ['TURBINE_AGENT', 'CLAUDECODE', 'CURSOR_AGENT'];
function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, INIT_CWD: dir, PWD: dir };
  for (const k of AGENT_MARKERS) delete base[k];
  return spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...base, ...env }, input: '' });
}

const EXAMPLE = `# .turbine/policies/routine-fixes.yaml
name: routine-fixes
maxRiskProfile: lightweight
labels: [bug, chore, docs, test]
deniedTriggers: [auth-permissions, payments, sensitive-data, data-migration, file-upload, untrusted-input, data-deletion, new-dependency]
maxChangedLines: 300
maxChangedFiles: 10
allowDependencyChanges: false
maxRepos: 1
deniedPaths:
  - "apps/cli/src/human-gate.ts"
  - ".cursor/**"
  - ".github/**"
  - "packages/storage-sqlite/src/migrations/**"
gates: [requirements, plan, codeReview, acceptance]
reviewers: [review-primary, review-secondary]
tools: [pr.create, pr.merge]
sampling: { rate: 0.1 }
revertWindowDays: 14
suspendWhen:
  revertRate: { above: 0.02, overLastMerges: 50 }
  auditProblems: { atLeast: 2, inLastAudits: 20 }
  reviewerDisagreement: { above: 0.3 }
`;

describe('lane policy schema (FR-A1, FR-A2)', () => {
  it('accepts the published example policy', () => {
    const p = parsePolicyYaml(EXAMPLE, 'routine-fixes');
    expect(p.maxRiskProfile).toBe('lightweight');
    expect(p.maxRepos).toBe(1);
    expect(p.allowDependencyChanges).toBe(false);
  });

  it('applies the documented defaults', () => {
    const p = parsePolicyYaml('name: x\nmaxRiskProfile: standard\nmaxChangedLines: 1\nmaxChangedFiles: 1\ngates: [plan]\n', 'x');
    expect(p.allowDependencyChanges).toBe(false);
    expect(p.maxRepos).toBe(1);
    expect(p.sampling.rate).toBe(0.1);
  });

  it('schema rejects comprehensive and unknown triggers', () => {
    expect(() => parsePolicyYaml(EXAMPLE.replace('maxRiskProfile: lightweight', 'maxRiskProfile: comprehensive'))).toThrow(/maxRiskProfile/);
    expect(() => parsePolicyYaml(EXAMPLE.replace('deniedTriggers: [auth-permissions', 'deniedTriggers: [made-up, auth-permissions'))).toThrow(/unknown trigger "made-up"/);
  });

  it('rejects unknown top-level keys, absolute and .. path patterns, and unsupported globs', () => {
    expect(() => parsePolicyYaml(`${EXAMPLE}autoMerge: true\n`)).toThrow(/autoMerge|Unrecognized/i);
    expect(() => parsePolicyYaml(EXAMPLE.replace('"apps/cli/src/human-gate.ts"', '"/etc/passwd"'))).toThrow(/relative/);
    expect(() => parsePolicyYaml(EXAMPLE.replace('"apps/cli/src/human-gate.ts"', '"src/../../secret"'))).toThrow(/\.\./);
    expect(() => parsePolicyYaml(EXAMPLE.replace('"apps/cli/src/human-gate.ts"', '"C:/x"'))).toThrow(/relative/);
    expect(() => parsePolicyYaml(EXAMPLE.replace('"apps/cli/src/human-gate.ts"', '"src/[ab].ts"'))).toThrow(/unsupported pattern/);
    expect(() => parsePolicyYaml(EXAMPLE.replace('  reviewerDisagreement: { above: 0.3 }', '  reviewerDisagreement: { above: 0.3, extra: 1 }'))).toThrow();
  });

  it('parses with the YAML Document API: duplicate keys, aliases and a wrong name are refused', () => {
    expect(() => parsePolicyYaml(`${EXAMPLE}maxRepos: 2\n`)).toThrow(/invalid YAML/);
    expect(() => parsePolicyYaml('name: &n x\nmaxRiskProfile: standard\nmaxChangedLines: 1\nmaxChangedFiles: 1\ngates: [plan]\nlabels: [*n]\n')).toThrow(/alias/i);
    expect(() => parsePolicyYaml(EXAMPLE, 'other-name')).toThrow(/does not match the file name/);
    // a YAML comment is a comment, not part of a value
    expect(parsePolicyYaml('name: x # comment\nmaxRiskProfile: standard\nmaxChangedLines: 1\nmaxChangedFiles: 1\ngates: [plan]\n', 'x').name).toBe('x');
  });

  it('the trigger names match the ARSP trigger tables in core', () => {
    expect([...LANE_HARD_TRIGGER_NAMES].sort()).toEqual(Object.keys(HARD_TRIGGERS).sort());
    expect([...LANE_SOFT_TRIGGER_NAMES].sort()).toEqual(Object.keys(SOFT_TRIGGERS).sort());
    expect(LanePolicySchema.safeParse({ ...parsePolicyYaml(EXAMPLE), deniedTriggers: Object.keys(SOFT_TRIGGERS) }).success).toBe(true);
  });

  it('a policy Decision needs every policy field and can never approve a policy or waive', () => {
    const base = {
      id: 'dec_1', workId: 'work_1', gate: 'plan', action: 'approve', artifactIds: [], artifactHashes: [], workRevision: 1,
      actorId: 'policy:routine', actorType: 'policy', identityAssurance: 'local-attestation', decidedAt: new Date().toISOString(),
      policyId: 'routine', policyHash: 'sha256:x', policyApprovalDecisionId: 'dec_0', evaluationHash: 'sha256:y',
    };
    expect(DecisionSchema.safeParse(base).success).toBe(true);
    for (const k of ['policyId', 'policyHash', 'policyApprovalDecisionId', 'evaluationHash']) {
      expect(DecisionSchema.safeParse({ ...base, [k]: undefined }).success, k).toBe(false);
    }
    expect(DecisionSchema.safeParse({ ...base, gate: 'policy' }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...base, gate: 'exception' }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...base, gate: 'code-review' }).success).toBe(true);
    expect(DecisionSchema.safeParse({ ...base, actorType: 'human', gate: 'policy' }).success).toBe(true);
  });
});

describe('loading .turbine/policies (FR-A1)', () => {
  it('loads only policies dir; rejects bad paths/unknown keys', () => {
    const { dir, engine } = laneProject(dirs, { approved: false });
    writePolicy(dir, 'bad-key', ROUTINE_POLICY.replace('name: routine', 'name: bad-key') + 'unknownKey: 1\n');
    writePolicy(dir, 'bad-path', ROUTINE_POLICY.replace('name: routine', 'name: bad-path').replace('".turbine/**"', '"../outside/**"'));
    const policies = join(dir, '.turbine', 'policies');
    writeFileSync(join(policies, 'legacy.yml'), ROUTINE_POLICY);
    mkdirSync(join(policies, 'nested'));
    writeFileSync(join(policies, 'nested', 'deep.yaml'), ROUTINE_POLICY);
    writeFileSync(join(dir, 'elsewhere.yaml'), ROUTINE_POLICY.replace('name: routine', 'name: linked'));
    symlinkSync(join(dir, 'elsewhere.yaml'), join(policies, 'linked.yaml'));
    writeFileSync(join(policies, 'huge.yaml'), `name: huge\n#${'x'.repeat(MAX_POLICY_BYTES)}\n`);

    const { files, errors } = readPolicyFiles(dir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual(['bad-key', 'bad-path', 'huge', 'linked', 'routine']);
    expect(byName.routine!.policy).toBeDefined();
    expect(byName['bad-key']!.error).toMatch(/unknownKey|Unrecognized/i);
    expect(byName['bad-path']!.error).toMatch(/\.\./);
    expect(byName.linked!.error).toMatch(/symlinks are refused/);
    expect(byName.huge!.error).toMatch(/larger than/);
    expect(errors.join('\n')).toMatch(/legacy\.yml: ignored/);
    const states = Object.fromEntries(policyStatuses(engine.ctx.store, dir).policies.map((p) => [p.name, p.state]));
    expect(states).toMatchObject({ routine: 'unapproved', 'bad-key': 'invalid', 'bad-path': 'invalid', linked: 'invalid' });
    expect(() => pendingPolicyApproval(engine.ctx.store, dir, 'bad-key', engine.ctx.config.models.profiles)).toThrow(/invalid/);
    engine.ctx.store.close();
  });

  it('stops after the directory entry budget, including non-yaml files', () => {
    const { dir, engine } = laneProject(dirs, { approved: false });
    const policies = join(dir, '.turbine', 'policies');
    for (let i = 0; i < MAX_POLICY_DIR_ENTRIES; i++) {
      writeFileSync(join(policies, `noise-${String(i).padStart(4, '0')}.txt`), 'x');
    }
    writePolicy(dir, 'late', ROUTINE_POLICY.replace('name: routine', 'name: late'));
    const { files, errors } = readPolicyFiles(dir);
    expect(errors.join('\n')).toMatch(new RegExp(`more than ${MAX_POLICY_DIR_ENTRIES} entries`));
    // Bound walk may omit later entries entirely; it must not silently load past the budget.
    expect(files.length).toBeLessThanOrEqual(MAX_POLICY_FILES);
    engine.ctx.store.close();
  });
});

describe('approval and drift (FR-A3, FR-A4)', () => {
  it('pending policy passes nothing', async () => {
    const { dir, engine } = laneProject(dirs, { approved: false });
    // Unapproved: the gate waits for a human and no decision of any kind is recorded.
    const work = await toRequirementsGate(engine);
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id)).toHaveLength(0);

    // Approved, then edited: the edit makes it pending, and the approved copy no longer passes anything.
    approve(engine, 'routine');
    writePolicy(dir, 'routine', ROUTINE_POLICY.replace('maxChangedLines: 40', 'maxChangedLines: 4000'));
    const status = policyStatuses(engine.ctx.store, dir).policies.find((p) => p.name === 'routine')!;
    expect(status.state).toBe('pending');
    const res2 = await engine.syncFromMarkdown(work.id);
    expect(res2.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id)).toHaveLength(0);
    expect(laneEvents(engine, work.id).at(-1)!.payload.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/policy routine is pending/)]));

    // `policy show` prints the approved → file diff
    const show = run(dir, ['policy', 'show', 'routine']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('- maxChangedLines: 40');
    expect(show.stdout).toContain('+ maxChangedLines: 4000');
    engine.ctx.store.close();
  });

  it('approval is bound to the typed short hash and recorded as a human policy Decision', () => {
    const { dir, engine } = laneProject(dirs, { approved: false });
    expect(() =>
      approvePolicy(engine.ctx.store, dir, {
        name: 'routine',
        confirmToken: 'deadbeef',
        reviewer: 'Ana',
        presence: 'test',
        profiles: engine.ctx.config.models.profiles,
      }),
    ).toThrow(/does not match/);
    expect(engine.ctx.store.getLanePolicy('routine')).toBeNull();
    const { decision, policy, warnings } = approve(engine, 'routine');
    expect(decision).toMatchObject({ gate: 'policy', actorType: 'human', actorId: 'Ana', workId: 'policy:routine', presence: 'test' });
    expect(policy).toMatchObject({ status: 'active', approvedDecisionId: decision.id, approvedBy: 'Ana' });
    expect(warnings).toEqual([]);
    engine.ctx.store.close();
  });

  it('approval warns when the policy does not deny Turbine gate machinery', () => {
    const { dir, engine } = laneProject(dirs, { approved: false });
    writePolicy(dir, 'loose', 'name: loose\nmaxRiskProfile: lightweight\nmaxChangedLines: 1\nmaxChangedFiles: 1\ngates: [plan]\n');
    const { warnings } = approve(engine, 'loose');
    expect(warnings.join('\n')).toMatch(/\.cursor\/hooks\.json/);
    engine.ctx.store.close();
  });

  it('approve is human-only, suspend is not', () => {
    const { dir, engine } = laneProject(dirs, { approved: false });
    engine.ctx.store.close();
    for (const args of [['policy', 'approve', 'routine'], ['policy', 'resume', 'routine'], ['task', 'lane', 'work_x', '--retry']]) {
      const agent = run(dir, args, { CURSOR_AGENT: '1' });
      expect(agent.status, args.join(' ')).not.toBe(0);
      expect(agent.stderr + agent.stdout).toMatch(/cannot run inside an AI agent session/);
      const piped = run(dir, args);
      expect(piped.status, args.join(' ')).not.toBe(0);
      expect(piped.stderr + piped.stdout).toMatch(/needs a TTY/);
    }
    // Nothing was approved by those attempts.
    const list = run(dir, ['policy', 'list', '--json']);
    expect(JSON.parse(list.stdout).policies[0]).toMatchObject({ name: 'routine', state: 'unapproved' });

    // Suspend works from an agent session (it only removes autonomy).
    const engine2 = laneProject(dirs).engine;
    const dir2 = engine2.ctx.projectRoot;
    engine2.ctx.store.close();
    const suspended = run(dir2, ['policy', 'suspend', 'routine', '--reason', 'flaky merges'], { CURSOR_AGENT: '1' });
    expect(suspended.status, suspended.stderr).toBe(0);
    const after = JSON.parse(run(dir2, ['policy', 'list', '--json']).stdout).policies[0];
    expect(after).toMatchObject({ name: 'routine', state: 'suspended', reason: 'flaky merges' });

    // The Cursor hook blocks the human-only policy commands and lets the others through.
    for (const c of ['turbine policy approve routine', 'pnpm turbine policy resume routine', 'turbine task lane work_1 --retry']) {
      expect(isHumanOnlyCommand(c), c).toBe(true);
    }
    for (const c of ['turbine policy suspend routine --reason x', 'turbine policy list', 'turbine policy show routine', 'turbine task lane work_1']) {
      expect(isHumanOnlyCommand(c), c).toBe(false);
    }
  });
});

describe('suspend and resume (FR-A9)', () => {
  it('suspend anyone / resume human-only', async () => {
    const { dir, engine } = laneProject(dirs);
    expect(() => suspendPolicy(engine.ctx.store, 'routine', '  ', 'agent')).toThrow(/reason/);
    suspendPolicy(engine.ctx.store, 'routine', 'revert spike', 'agent');
    const work = await toRequirementsGate(engine);
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(laneEvents(engine, work.id).at(-1)!.payload.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/routine is suspended: revert spike/)]));

    const pending = pendingPolicyResume(engine.ctx.store, 'routine');
    expect(() => resumePolicy(engine.ctx.store, { name: 'routine', confirmToken: 'nope', reviewer: 'Ana', presence: 'test' })).toThrow(/does not match/);
    const resumed = resumePolicy(engine.ctx.store, { name: 'routine', confirmToken: pending.confirmToken, reviewer: 'Ana', presence: 'test' });
    expect(resumed.policy.status).toBe('active');
    expect(resumed.decision).toMatchObject({ gate: 'policy', actorType: 'human' });
    expect(policyStatuses(engine.ctx.store, dir).policies[0]!.state).toBe('active');

    // Suspend → edit YAML → resume: stored status is active, but effective state stays pending until re-approve.
    suspendPolicy(engine.ctx.store, 'routine', 'edit incoming', 'agent');
    writePolicy(dir, 'routine', ROUTINE_POLICY.replace('maxChangedLines: 40', 'maxChangedLines: 99'));
    const again = pendingPolicyResume(engine.ctx.store, 'routine');
    resumePolicy(engine.ctx.store, { name: 'routine', confirmToken: again.confirmToken, reviewer: 'Ana', presence: 'test' });
    const effective = policyStatuses(engine.ctx.store, dir).policies.find((p) => p.name === 'routine')!;
    expect(effective.state).toBe('pending');
    expect(engine.ctx.store.getLanePolicy('routine')!.status).toBe('active');
    engine.ctx.store.close();
  });
});

describe('fail closed on store records (FR-A5, AC5)', () => {
  it('an unreadable stored policy sends the task to a human with the reason shown', async () => {
    const { dir, engine } = laneProject(dirs);
    engine.ctx.store.db.prepare(`UPDATE lane_policies SET data = '{not json' WHERE name = 'routine'`).run();
    expect(policyStatuses(engine.ctx.store, dir).policies[0]).toMatchObject({ state: 'invalid' });
    const work = await toRequirementsGate(engine);
    const res = await engine.syncFromMarkdown(work.id);
    expect(res.work.currentState).toBe('REQUIREMENTS_REVIEW');
    expect(engine.ctx.store.listDecisions(work.id)).toHaveLength(0);
    const reasons = laneEvents(engine, work.id).at(-1)!.payload.reasons as string[];
    expect(reasons.join('\n')).toMatch(/stored snapshot unreadable/);
    engine.ctx.store.close();
  });
});
