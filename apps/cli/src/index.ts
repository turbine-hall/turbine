#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, lstatSync, opendirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJiraAdapter } from '@turbine-hall/turbine-adapter-jira';
import { assertTransition, listFrameworks, loadRoles } from '@turbine-hall/turbine-core';
import { listModels } from '@turbine-hall/turbine-models';
import { loadSkills } from '@turbine-hall/turbine-skills';
import { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { err, okfTrustTier } from '@turbine-hall/turbine-contracts';
import { formatOutcome, understandOnInitWithBrief, understandProjectWithBrief } from './engine/context/understand.js';
import { lintProjectContext } from './engine/context/render.js';
import { lintTaskContexts } from './engine/context/task-render.js';
import { briefConfigOf, briefDiff } from './engine/context/brief.js';
import { approveBrief, attestClaim } from './engine/context/brief-approve.js';
import { renderClaimBullet } from './engine/context/brief-render.js';
import { validateBundle, lintKnowledgeBundle } from './engine/knowledge/validate.js';
import { exportKnowledgeBundle, lintKnowledgeHandEdits } from './engine/knowledge/publish.js';
import {
  knowledgePaths,
  readBoundedUtf8,
  MAX_BUNDLE_DEPTH,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_FILES,
} from './engine/knowledge/paths.js';
import { splitFrontmatter } from './engine/knowledge/frontmatter.js';
import { Engine } from './engine/engine.js';
import { initProject, openContext } from './engine/project.js';
import { ensureBoard } from './board/launch.js';
import { handleError, printResult } from './output.js';
import { callerCwd, factoryRoot, findProjectRoot, resolveProjectPath } from './paths.js';
import {
  CONFIRM_PRESENCE,
  HUMAN_PRESENCE,
  ask,
  askReviewer,
  assertHumanTerminal,
  assertMediatedConfirm,
  gitUserName,
  isAgentSession,
} from './human-gate.js';
import { repoToplevel } from './engine/context/git-read.js';
import { formatTokenCount, formatUsageQualifiers } from './engine/usage.js';
import {
  approvePolicy,
  pendingPolicyApproval,
  pendingPolicyResume,
  policyDiff,
  policyStatuses,
  resumePolicy,
  suspendPolicy,
} from './engine/lane-policy.js';
import { computeLaneMetrics, type LaneMetric } from './engine/lane-metrics.js';
import { nextLaneAudit, recordLaneAuditOutcome } from './engine/lane-audit.js';
import { fleetStatus, runFleet } from './engine/fleet.js';
import { DEFAULT_USD_PER_MILLION_TOKENS } from './engine/fleet-spend.js';
import { DEFAULT_FLEET_LEASE_MS } from './engine/fleet-lock.js';
import { importTasks, issuesFromGitHubFixture, issuesFromJiraFixture } from './engine/task-import.js';

function parseTokenArg(raw: string): number | 'unknown' {
  if (raw === 'unknown' || raw === '?') return 'unknown';
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw err('E_INVALID_CONFIG', `token count must be a non-negative integer or "unknown" (got ${raw})`);
  }
  return n;
}

function formatLaneMetric(name: string, value: LaneMetric): string {
  const rendered = value.value === 'unknown' ? 'unknown' : String(value.value);
  return `  ${name}: ${rendered} (numerator ${value.numerator}; denominator ${value.denominator}; unknown ${value.unknown}; period ${value.period.since}..${value.period.until})`;
}

const program = new Command();
program.name('turbine').description('Turbine Hall CLI').version('0.5.0');

function withEngine() {
  return new Engine(openContext());
}

program
  .command('init')
  .option('--project <path>', 'Project path')
  .option('--non-interactive', 'Non-interactive init')
  .action(async (opts) => {
    try {
      const result = initProject({
        projectPath: opts.project,
        nonInteractive: !!opts.nonInteractive,
      });
      // A repository that already has commits gets its project facts (and brief draft) right away.
      let context: string | undefined;
      const store = new WorkStore(result.paths.dbPath);
      try {
        context = await understandOnInitWithBrief(store, result.paths.root, {
          factoryRoot: factoryRoot(),
          config: result.config,
        });
      } catch (e) {
        process.stderr.write(`Warning: project facts were not built: ${(e as Error).message}\nRun: turbine understand\n`);
      } finally {
        store.close();
      }
      let boardUrl: string | undefined;
      try {
        const board = await ensureBoard(result.paths.root);
        boardUrl = board.url;
      } catch (e) {
        process.stderr.write(`Warning: task board did not start: ${(e as Error).message}\n`);
      }
      printResult(
        {
          message: 'Initialized Turbine Hall project',
          createdOrEnsured: result.created,
          config: result.paths.configPath,
          note: 'Re-running init is idempotent and does not overwrite edited project.yaml',
          ...(boardUrl ? { board: boardUrl } : {}),
          ...(context ? { context } : {}),
        },
        false,
      );
    } catch (e) {
      handleError(e);
    }
  });

program
  .command('board')
  .option('--project <path>', 'Project path')
  .description('Open the task board, starting it if this project does not have one yet')
  .action(async (opts) => {
    try {
      const projectRoot = resolveProjectPath(opts.project);
      const board = await ensureBoard(projectRoot);
      printResult({ url: board.url, started: board.started }, false);
    } catch (e) {
      handleError(e);
    }
  });

program
  .command('understand')
  .option('--json', 'JSON output')
  .description('Build or refresh project facts and the verified-claims brief; render .turbine/context/')
  .action(async (opts) => {
    try {
      const ctx = openContext();
      try {
        const o = await understandProjectWithBrief(ctx.store, ctx.projectRoot, {
          factoryRoot: ctx.factoryRoot,
          config: ctx.config,
        });
        if (opts.json) {
          printResult(
            {
              status: o.status,
              snapshot: o.snapshot.hash,
              commit: o.snapshot.commit,
              dirty: o.dirty,
              written: o.written,
              repaired: o.repaired,
              diff: o.diff,
              brief: o.brief,
            },
            true,
          );
        } else process.stdout.write(`${formatOutcome(o).join('\n')}\n`);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

const contextCmd = program.command('context').description('Project brief (verified claims)');
contextCmd
  .command('show')
  .option('--json', 'JSON output')
  .description('Show the published brief claims and approval status')
  .action((opts) => {
    try {
      const ctx = openContext();
      try {
        const { state, claims, confirmToken } = briefDiff(ctx.store, ctx.projectRoot);
        if (opts.json) {
          printResult({ state, claims, confirmToken }, true);
          return;
        }
        if (!state) {
          process.stdout.write('No brief yet. Run: turbine understand\n');
          return;
        }
        const approved = state.approvedHash === state.claimsHash;
        process.stdout.write(
          `Brief at ${state.commit.slice(0, 8)} — ${approved ? 'approved' : 'draft, not approved'} (claims ${state.claimsHash.slice(0, 15)}…)\n`,
        );
        if (!approved && confirmToken) process.stdout.write(`Approve code: ${confirmToken}\n`);
        process.stdout.write(`Sample files (cap ${state.sampleCap}): ${state.samplePaths.join(', ') || '(none)'}\n\n`);
        for (const c of claims) {
          process.stdout.write(`${renderClaimBullet(c)}\n\n`);
        }
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

contextCmd
  .command('approve')
  .description('Human-only: approve the current verified claim set (hash-bound)')
  .action(async () => {
    try {
      assertHumanTerminal('turbine context approve');
      const ctx = openContext();
      try {
        const { state, claims, confirmToken } = briefDiff(ctx.store, ctx.projectRoot);
        if (!state || !confirmToken) throw err('E_NOT_FOUND', 'No brief to approve; run: turbine understand');
        process.stdout.write(`Review ${claims.length} published claim(s) at ${state.commit.slice(0, 8)}:\n\n`);
        for (const c of claims) process.stdout.write(`${renderClaimBullet(c)}\n\n`);
        process.stdout.write(`\nType the code ${confirmToken} to confirm you reviewed exactly this claim set.\n`);
        const token = await ask('Code: ');
        const reviewer = await askReviewer(ctx.projectRoot);
        const next = approveBrief({
          store: ctx.store,
          projectRoot: ctx.projectRoot,
          repoRoot: repoToplevel(ctx.projectRoot) ?? ctx.projectRoot,
          repoPath: ctx.projectRoot,
          sections: briefConfigOf(ctx.config).sections,
          reviewer,
          confirmToken: token,
          presence: HUMAN_PRESENCE,
        });
        printResult({ approved: true, by: next.approvedBy, at: next.approvedAt, claimsHash: next.claimsHash }, false);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

contextCmd
  .command('attest')
  .argument('<claim-json-or-file>', 'Claim JSON string, or path to a JSON file')
  .description('Human-only: attest a claim that cannot be verified mechanically')
  .action(async (arg: string) => {
    try {
      assertHumanTerminal('turbine context attest');
      const ctx = openContext();
      try {
        let rawText = arg;
        try {
          rawText = readFileSync(arg, 'utf8');
        } catch {
          // treat as inline JSON
        }
        const raw = JSON.parse(rawText) as unknown;
        const reviewer = await askReviewer(ctx.projectRoot);
        const claim = attestClaim({
          store: ctx.store,
          projectRoot: ctx.projectRoot,
          repoRoot: repoToplevel(ctx.projectRoot) ?? ctx.projectRoot,
          repoPath: ctx.projectRoot,
          sections: briefConfigOf(ctx.config).sections,
          raw,
          reviewer,
          presence: HUMAN_PRESENCE,
        });
        printResult({ attested: true, id: claim.id, section: claim.section }, false);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

const knowledgeCmd = program.command('knowledge').description('OKF v0.3 knowledge bundle (.turbine/knowledge/)');
knowledgeCmd
  .command('validate')
  .argument('[dir]', 'Bundle directory (default: .turbine/knowledge)')
  .option('--json', 'JSON output')
  .description('Validate OKF conformance and the Turbine profile')
  .action((dir: string | undefined, opts: { json?: boolean }) => {
    try {
      const cwd = callerCwd();
      const root = findProjectRoot(cwd);
      const target = dir
        ? (dir.startsWith('/') ? dir : join(cwd, dir))
        : root
          ? knowledgePaths(root).dir
          : undefined;
      if (!target) throw err('E_INVALID_CONFIG', `No .turbine project found from ${cwd}. Run: turbine init --project .`);
      const issues = validateBundle(target);
      if (opts.json) printResult(issues, true);
      else if (!issues.length) process.stdout.write('Knowledge bundle OK.\n');
      else {
        for (const i of issues) process.stdout.write(`${i.level}: ${i.file}: ${i.message}\n`);
      }
      if (issues.some((i) => i.level === 'error')) process.exitCode = 3;
    } catch (e) {
      handleError(e);
    }
  });

knowledgeCmd
  .command('export')
  .argument('<dir>', 'Destination directory for a validated copy')
  .option('--force', 'Replace a non-empty target')
  .description('Write a validated copy of the knowledge bundle for committing or sharing')
  .action((dir: string, opts: { force?: boolean }) => {
    try {
      const ctx = openContext();
      try {
        const cwd = callerCwd();
        const targetDir = dir.startsWith('/') ? dir : join(cwd, dir);
        const result = exportKnowledgeBundle({ projectRoot: ctx.projectRoot, targetDir, force: !!opts.force });
        printResult(result, false);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

knowledgeCmd
  .command('show')
  .argument('[concept]', 'Optional concept path relative to the bundle')
  .option('--json', 'JSON output')
  .description('List concepts and their trust tiers')
  .action((concept: string | undefined, opts: { json?: boolean }) => {
    try {
      const cwd = callerCwd();
      const root = findProjectRoot(cwd);
      if (!root) throw err('E_INVALID_CONFIG', `No .turbine project found from ${cwd}. Run: turbine init --project .`);
      const dir = knowledgePaths(root).dir;
      if (!existsSync(dir)) throw err('E_NOT_FOUND', 'No knowledge bundle; run: turbine understand');
      const rows: Array<{ path: string; type?: string; title?: string; trust: string }> = [];
      let visited = 0;
      let budgetHit: string | undefined;
      const walk = (abs: string, rel: string, depth: number) => {
        if (budgetHit) return;
        if (depth > MAX_BUNDLE_DEPTH) {
          budgetHit = `bundle exceeds max depth ${MAX_BUNDLE_DEPTH}`;
          return;
        }
        let dirHandle;
        try {
          dirHandle = opendirSync(abs);
        } catch (e) {
          budgetHit = `cannot read ${rel || '.'}: ${(e as Error).message}`;
          return;
        }
        try {
          for (let ent = dirHandle.readSync(); ent !== null; ent = dirHandle.readSync()) {
            if (budgetHit) return;
            // Count every scanned entry (including hidden) so the budget bounds enumeration work.
            visited += 1;
            if (visited > MAX_BUNDLE_FILES) {
              budgetHit = `bundle has more than ${MAX_BUNDLE_FILES} entries`;
              return;
            }
            const name = ent.name;
            if (name.startsWith('.')) continue;
            const child = join(abs, name);
            const childRel = rel ? `${rel}/${name}` : name;
            let st;
            try {
              st = lstatSync(child);
            } catch (e) {
              rows.push({ path: childRel, trust: `unreadable:${(e as Error).message}` });
              continue;
            }
            if (st.isDirectory()) walk(child, childRel, depth + 1);
            else if (st.isFile() && name.endsWith('.md') && name !== 'index.md' && name !== 'log.md' && name !== 'README.md') {
              if (concept && childRel !== concept && !childRel.endsWith(`/${concept}`)) continue;
              let text: string;
              try {
                const body = readBoundedUtf8(child, MAX_BUNDLE_FILE_BYTES);
                if (body === undefined) continue;
                text = body;
              } catch (e) {
                rows.push({ path: childRel, trust: `unreadable:${(e as Error).message}` });
                continue;
              }
              const split = splitFrontmatter(text);
              if (!split.ok || typeof split.data.type !== 'string') continue;
              rows.push({
                path: childRel,
                type: split.data.type,
                title: typeof split.data.title === 'string' ? split.data.title : undefined,
                trust: okfTrustTier({
                  generated: split.data.generated as { by?: string; at?: string } | undefined,
                  verified: split.data.verified,
                }),
              });
            }
          }
        } finally {
          dirHandle.closeSync();
        }
      };
      walk(dir, '', 0);
      if (budgetHit) throw err('E_CONTEXT_UNAVAILABLE', budgetHit);
      rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (opts.json) printResult(rows, true);
      else {
        process.stdout.write(`Knowledge bundle (${rows.length} concepts)\n`);
        for (const r of rows) process.stdout.write(`${r.trust.padEnd(18)} ${r.path}${r.title ? ` — ${r.title}` : ''}\n`);
      }
    } catch (e) {
      handleError(e);
    }
  });

program
  .command('lint')
  .option('--json', 'JSON output')
  .description('Check the generated project context (.turbine/context/) and task CONTEXT.md files have not been edited by hand')
  .action((opts) => {
    try {
      // Lint only reads files: it finds the project from the caller's directory and does not open the store
      // (openContext would create or migrate the database, which a read-only check must not do).
      const cwd = callerCwd();
      const root = findProjectRoot(cwd);
      if (!root) throw err('E_INVALID_CONFIG', `No .turbine project found from ${cwd}. Run: turbine init --project .`);
      const issues = [
        ...lintProjectContext(root),
        ...lintTaskContexts(root),
        ...lintKnowledgeBundle(root),
      ];
      try {
        issues.push(...lintKnowledgeHandEdits(root));
      } catch (e) {
        // A hand-edit check failure must not discard the other lint diagnostics.
        issues.push({
          level: 'error',
          file: 'knowledge/',
          message: `hand-edit check failed: ${(e as Error).message}`,
        });
      }
      if (opts.json) printResult(issues, true);
      else if (!issues.length) process.stdout.write('Project context OK.\n');
      else for (const i of issues) process.stdout.write(`${i.level.toUpperCase().padEnd(7)} ${i.file}: ${i.message}\n`);
      if (issues.some((i) => i.level === 'error')) process.exitCode = 3;
    } catch (e) {
      handleError(e);
    }
  });

program
  .command('doctor')
  .option('--json', 'JSON output')
  .action((opts) => {
    try {
      const engine = withEngine();
      printResult(engine.doctor(), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

const configCmd = program.command('config');
configCmd
  .command('show')
  .option('--json')
  .action((opts) => {
    try {
      const ctx = openContext();
      printResult(ctx.config, !!opts.json);
      ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
configCmd.command('set').argument('<key>').argument('<value>').action((key, value) => {
  try {
    const engine = withEngine();
    printResult(engine.setConfig(key, value), false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});

const frameworkCmd = program.command('framework');
frameworkCmd.command('list').action(() => {
  try {
    printResult(listFrameworks(factoryRoot()), false);
  } catch (e) {
    handleError(e);
  }
});
frameworkCmd.command('show').argument('<id>').action((id) => {
  try {
    const engine = withEngine();
    printResult(engine.frameworkShow(id), false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});
frameworkCmd.command('use').argument('<idVersion>').action((idVersion) => {
  try {
    const engine = withEngine();
    const [id, version] = String(idVersion).split('@');
    engine.setConfig('framework.id', id!);
    if (version) engine.setConfig('framework.version', version);
    printResult({ id, version: version ?? engine.ctx.config.framework.version }, false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});

const roleCmd = program.command('role');
roleCmd.command('list').action(() => {
  try {
    printResult(loadRoles(factoryRoot()).map((r) => ({ id: r.id, version: r.version })), false);
  } catch (e) {
    handleError(e);
  }
});
roleCmd.command('show').argument('<role-id>').action((id) => {
  try {
    const engine = withEngine();
    printResult(engine.roleShow(id), false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});

const skillCmd = program.command('skill');
skillCmd.command('list').action(() => {
  try {
    printResult(loadSkills(factoryRoot()).map((s) => ({ id: s.id, version: s.version })), false);
  } catch (e) {
    handleError(e);
  }
});
skillCmd.command('show').argument('<skill-id>').action((id) => {
  try {
    const engine = withEngine();
    printResult(engine.skillShow(id), false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});

const modelCmd = program.command('model');
modelCmd
  .command('add')
  .option('--provider <provider>', 'Provider', 'mock')
  .option('--id <id>', 'Model id', 'mock-default')
  .action((opts) => {
    try {
      const engine = withEngine();
      printResult(engine.addModel(opts.provider, opts.id), false);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
modelCmd.command('list').action(() => {
  try {
    openContext();
    printResult(listModels().map((m) => ({ id: m.id, provider: m.provider })), false);
  } catch (e) {
    handleError(e);
  }
});
modelCmd.command('test').argument('[id]', 'Model id', 'mock-default').action(async (id) => {
  try {
    const engine = withEngine();
    printResult(await engine.testModel(id), false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});

const toolCmd = program.command('tool');
toolCmd.command('list').action(() => {
  printResult(
    [
      { id: 'jira', capabilities: ['issue.read'] },
      { id: 'git', capabilities: ['repo.inspect', 'repo.read', 'git.diff', 'git.branch.create'] },
      { id: 'tests', capabilities: ['tests.run'] },
    ],
    false,
  );
});
toolCmd
  .command('connect')
  .argument('<name>')
  .option('--site-url <url>')
  .action((name, opts) => {
    try {
      const engine = withEngine();
      if (name !== 'jira') throw new Error(`Unknown tool: ${name}`);
      if (!opts.siteUrl) throw new Error('--site-url is required for jira');
      printResult(engine.connectJira(opts.siteUrl), false);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
toolCmd.command('test').argument('<name>').action(async (name) => {
  try {
    const engine = withEngine();
    if (name !== 'jira') throw new Error(`Unknown tool: ${name}`);
    const adapter = createJiraAdapter({
      siteUrl: engine.ctx.config.inputs.adapters.jira.siteUrl ?? '',
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
    });
    printResult(await adapter.healthCheck(), false);
    engine.ctx.store.close();
  } catch (e) {
    handleError(e);
  }
});

const task = program.command('task');

task
  .command('create')
  .requiredOption('--title <title>')
  .option('--file <path>')
  .option('--type <type>', 'feature')
  .option('--json')
  .action(async (opts) => {
    try {
      const engine = withEngine();
      const work = engine.createTask({ title: opts.title, file: opts.file, type: opts.type });
      await engine.waitForMirror();
      printResult(
        {
          id: work.id,
          state: work.currentState,
          title: work.title,
          packetDir: (work as { packetDir?: string }).packetDir,
          next: 'turbine task assess <id>  then open STATUS.md',
        },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('takeover')
  .argument('<ref>')
  .option('--fixture <path>')
  .option('--json')
  .action(async (ref, opts) => {
    try {
      const engine = withEngine();
      if (!String(ref).startsWith('jira:')) throw new Error('Only jira:KEY takeover supported');
      const key = String(ref).slice('jira:'.length);
      let fixtures: Record<string, any> | undefined;
      if (opts.fixture) {
        const issue = JSON.parse(readFileSync(opts.fixture, 'utf8'));
        fixtures = { [issue.key]: issue };
      }
      const work = await engine.takeoverJiraAsync(key, fixtures);
      printResult({ id: work.id, aliases: work.aliases, state: work.currentState }, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('import')
  .option('--github <owner/repo>', 'Import open issues from GitHub (requires --fixture in CI)')
  .option('--label <label>', 'Only GitHub issues carrying this label')
  .option('--jira <jql>', 'Import Jira issues matching JQL (requires --fixture in CI; JQL recorded for operators)')
  .option('--fixture <path>', 'JSON fixture of issues (required without live tokens)')
  .option('--json')
  .action(async (opts) => {
    try {
      const engine = withEngine();
      const hasGh = Boolean(opts.github);
      const hasJira = Boolean(opts.jira);
      if (hasGh === hasJira) {
        throw new Error('Specify exactly one of --github <owner/repo> or --jira <jql>');
      }
      if (!opts.fixture) {
        throw new Error('task import currently requires --fixture <path> (live tracker list is not enabled in this build)');
      }
      const fixture = JSON.parse(readFileSync(opts.fixture, 'utf8'));
      let issues;
      if (hasGh) {
        const parts = String(opts.github).split('/');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new Error('--github must be owner/repo');
        }
        issues = issuesFromGitHubFixture(parts[0], parts[1], fixture, opts.label);
      } else {
        // JQL is accepted for the CLI surface; fixtures supply the issue list for CI.
        void opts.jira;
        issues = issuesFromJiraFixture(fixture);
      }
      const report = importTasks(engine, issues);
      await engine.waitForMirror();
      printResult(report, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('list')
  .option('--state <state>')
  .option('--json')
  .action((opts) => {
    try {
      const engine = withEngine();
      printResult(
        engine.ctx.store.listWork(opts.state).map((w) => ({
          id: w.id,
          title: w.title,
          state: w.currentState,
          aliases: w.aliases,
        })),
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('status')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      const packetDir = `${engine.ctx.projectRoot}/.turbine/tasks/${work.id}`;
      const next = engine.next(work.id);
      printResult(
        {
          id: work.id,
          state: work.currentState,
          revision: work.currentRevision,
          risk: work.risk,
          selectedRoles: work.selectedRoles,
          packetDir,
          next,
          hint: 'Prefer: turbine task next <id>  then follow doNow / commands',
        },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('next')
  .argument('<id>')
  .option('--json')
  .description('Print the single next human/agent action with copy-paste commands')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const next = engine.next(id);
      if (opts.json) {
        printResult(next, true);
      } else {
        process.stdout.write(`\n## Next — ${next.state}\n`);
        process.stdout.write(`Who: ${next.who}\n`);
        process.stdout.write(`Do now: ${next.doNow}\n\n`);
        if (next.openFiles.length) {
          process.stdout.write('Open:\n');
          for (const f of next.openFiles) process.stdout.write(`  ${f}\n`);
          process.stdout.write('\n');
        }
        if (next.worktreePath) {
          process.stdout.write(`Worktree: ${next.worktreePath}\n`);
          process.stdout.write(`Branch:   ${next.branch}\n\n`);
        }
        process.stdout.write('Commands:\n');
        for (const c of next.commands) process.stdout.write(`  ${c}\n`);
        process.stdout.write('\nImportant:\n');
        for (const i of next.important) process.stdout.write(`  - ${i}\n`);
        process.stdout.write('\nAgent playbook:\n');
        for (const a of next.agentPlaybook) process.stdout.write(`  - ${a}\n`);
        process.stdout.write('\n');
      }
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('show')
  .argument('<id>')
  .argument('[part]')
  .option('--json')
  .action((id, part, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      if (!part) {
        printResult(work, !!opts.json);
      } else {
        const type = part === 'requirements' ? 'specification' : part;
        const art = engine.ctx.store.getLatestArtifact(work.id, type);
        if (!art) throw new Error(`No ${part} artifact`);
        const raw = engine.ctx.store.getArtifactContent(art.id);
        let content: unknown = raw;
        try {
          content = JSON.parse(raw);
        } catch {
          /* keep text */
        }
        printResult({ artifact: art, content }, !!opts.json);
      }
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('history')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.ctx.store.listEvents(engine.ctx.store.getWork(id).id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('assess')
  .argument('<id>')
  .option('--json')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      const result = await engine.assess(id);
      printResult(
        {
          id: result.work.id,
          state: result.work.currentState,
          unknowns: result.work.unknowns,
          packetDir: (result as { packetDir?: string }).packetDir,
          openFile: 'SPEC.md (start with STATUS.md)',
          next: 'Edit Decision in packet MD, then: turbine task sync <id>',
          roles: result.roles,
          assessment: opts.json ? result.assessment : undefined,
        },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('sync')
  .argument('<id>')
  .option('--actor <actor>', 'local-user')
  .option('--json')
  .description('Apply markdown Decision / edits from .turbine/tasks/<id>/')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      const result = await engine.syncFromMarkdown(id, opts.actor ?? 'local-user');
      const next = engine.next(result.work.id);
      printResult(
        {
          action: result.action,
          id: result.work.id,
          state: result.work.currentState,
          detail: result.detail,
          open: `STATUS.md in .turbine/tasks/${result.work.id}/`,
          next: {
            who: next.who,
            doNow: next.doNow,
            commands: next.commands,
            worktreePath: next.worktreePath,
            branch: next.branch,
          },
        },
        !!opts.json,
      );
      if (!opts.json) {
        process.stdout.write(`\n→ Next (${next.who}): ${next.doNow}\n`);
        process.stdout.write(`  (full guide: turbine task next ${result.work.id})\n`);
      }
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

const requirementsCmd = task.command('requirements');
requirementsCmd
  .command('edit')
  .argument('<id>')
  .option('--criteria <json>')
  .option('--clear-unknowns')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.editRequirements(id, {
        acceptanceCriteria: opts.criteria ? JSON.parse(opts.criteria) : undefined,
        unknowns: opts.clearUnknowns ? [] : undefined,
      });
      printResult(
        { id: work.id, state: work.currentState, acceptanceCriteria: work.acceptanceCriteria },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
requirementsCmd
  .command('approve')
  .argument('[args...]')
  .allowUnknownOption()
  .description('Removed — use: turbine task approve <id>')
  .action(() => {
    handleError(
      Object.assign(new Error('"task requirements approve" was removed. A human now approves with: turbine task approve <id> (interactive, in your own terminal).'), {
        code: 'E_UNTRUSTED_IDENTITY',
        exitCode: 3,
      }),
    );
  });
requirementsCmd
  .command('reject')
  .argument('[args...]')
  .allowUnknownOption()
  .description('Removed — use: turbine task reject <id>')
  .action(() => {
    handleError(
      Object.assign(new Error('"task requirements reject" was removed. A human now approves with: turbine task approve <id> (interactive, in your own terminal).'), {
        code: 'E_UNTRUSTED_IDENTITY',
        exitCode: 3,
      }),
    );
  });

const planCmd = task.command('plan');
planCmd
  .argument('[id]')
  .option('--json')
  .action(async (id, opts, cmd) => {
    // If a subcommand was used, commander still may hit this; guard missing id for subcommands
    if (!id) {
      cmd.help();
      return;
    }
    try {
      const engine = withEngine();
      const result = await engine.plan(id);
      const planArt = engine.ctx.store.getLatestArtifact(result.work.id, 'plan');
      printResult(
        {
          id: result.work.id,
          state: result.work.currentState,
          planHash: planArt?.contentHash ?? (result as { planHash?: string }).planHash,
          packetDir: (result as { packetDir?: string }).packetDir,
          openFile: 'SPEC.md → Plan',
          next: 'A human reads SPEC.md → Plan, then runs: turbine task approve <id>',
          plan: opts.json ? result.plan : undefined,
        },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
planCmd
  .command('approve')
  .argument('[args...]')
  .allowUnknownOption()
  .description('Removed — use: turbine task approve <id>')
  .action(() => {
    handleError(
      Object.assign(new Error('"task plan approve" was removed. A human now approves with: turbine task approve <id> (interactive, in your own terminal).'), {
        code: 'E_UNTRUSTED_IDENTITY',
        exitCode: 3,
      }),
    );
  });
planCmd
  .command('reject')
  .argument('[args...]')
  .allowUnknownOption()
  .description('Removed — use: turbine task reject <id>')
  .action(() => {
    handleError(
      Object.assign(new Error('"task plan reject" was removed. A human now approves with: turbine task approve <id> (interactive, in your own terminal).'), {
        code: 'E_UNTRUSTED_IDENTITY',
        exitCode: 3,
      }),
    );
  });

const contractCmd = task.command('contract');
contractCmd
  .command('show')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.contractShow(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
contractCmd
  .command('validate')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.contractValidate(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('impact')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.impact(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('recover')
  .argument('<id>')
  .option('--dry-run', 'Dry run')
  .option('--apply', 'Apply recovery')
  .option('--json')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      if (opts.apply) printResult(await engine.recoverApply(id), !!opts.json);
      else printResult(engine.recoverDryRun(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('explain')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.explain(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('roles')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      printResult({ selectedRoles: work.selectedRoles, risk: work.risk }, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('resume')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.explain(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('export')
  .argument('<id>')
  .option('--format <fmt>', 'json')
  .option('--redact')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      printResult(
        {
          work,
          eec: engine.ctx.store.getLatestEec(work.id),
          artifacts: engine.ctx.store.listArtifacts(work.id),
          decisions: engine.ctx.store.listDecisions(work.id),
          evidence: engine.ctx.store.listEvidence(work.id),
          events: engine.ctx.store.listEvents(work.id),
          usage: engine.usageSummary(work.id),
          roleRuns: engine.ctx.store.listRoleRuns(work.id),
          redacted: !!opts.redact,
        },
        true,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('execute')
  .argument('<id>')
  .option('--json')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      const result = await engine.execute(id);
      printResult(
        {
          id: result.work.id,
          state: result.work.currentState,
          packetDir: result.packetDir,
          openFile: result.openFile,
          worktreePath: result.result.worktreePath,
          branch: result.result.branch,
          baseCommit: result.result.baseCommit,
          next: 'Work ONLY in the worktree listed in STATUS.md. Commit, then: turbine task sync <id>',
          result: opts.json ? result.result : undefined,
        },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('run')
  .argument('<id>')
  .option('--json')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      if (work.currentState === 'IMPORTED') printResult(await engine.assess(id), !!opts.json);
      else if (work.currentState === 'REQUIREMENTS_APPROVED') printResult(await engine.plan(id), !!opts.json);
      else if (work.currentState === 'PLAN_APPROVED') printResult(await engine.execute(id), !!opts.json);
      else if (work.currentState === 'AI_REVIEW') printResult(await engine.aiReview(id), !!opts.json);
      else if (work.currentState === 'VERIFYING') printResult(await engine.verify(id), !!opts.json);
      else printResult(engine.explain(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('review')
  .argument('<id>')
  .option('--ai', 'Run the AI review (default)')
  .option('--json')
  .description('Run the AI review. Human code review: turbine task approve <id>')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      printResult(await engine.aiReview(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('verify')
  .argument('<id>')
  .option('--json')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      printResult(await engine.verify(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('accept')
  .argument('[args...]')
  .allowUnknownOption()
  .description('Removed — use: turbine task approve <id>')
  .action(() => {
    handleError(
      Object.assign(new Error('"task accept" was removed. A human now approves with: turbine task approve <id> (interactive, in your own terminal).'), {
        code: 'E_UNTRUSTED_IDENTITY',
        exitCode: 3,
      }),
    );
  });

task
  .command('changes-requested')
  .argument('<id>')
  .requiredOption('--reason <text>')
  .action((id, opts) => {
    try {
      assertHumanTerminal('turbine task changes-requested');
      const engine = withEngine();
      let work = engine.ctx.store.getWork(id);
      assertTransition(work.currentState, 'CHANGES_REQUESTED');
      work = {
        ...work,
        currentState: 'CHANGES_REQUESTED',
        updatedAt: new Date().toISOString(),
        currentRevision: work.currentRevision + 1,
      };
      engine.ctx.store.saveWork(work);
      printResult({ id: work.id, state: work.currentState, reason: opts.reason }, false);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('cancel')
  .argument('<id>')
  .requiredOption('--reason <text>')
  .action((id, opts) => {
    try {
      assertHumanTerminal('turbine task cancel');
      const engine = withEngine();
      let work = engine.ctx.store.getWork(id);
      assertTransition(work.currentState, 'CANCELLED');
      work = {
        ...work,
        currentState: 'CANCELLED',
        updatedAt: new Date().toISOString(),
        currentRevision: work.currentRevision + 1,
      };
      engine.ctx.store.saveWork(work);
      printResult({ id: work.id, state: work.currentState, reason: opts.reason }, false);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('runs')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.ctx.store.listRoleRuns(engine.ctx.store.getWork(id).id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('costs')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult({ budget: engine.ctx.store.getBudget(engine.ctx.store.getWork(id).id) }, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

const sourceCmd = task.command('source');
sourceCmd
  .command('refresh')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      printResult(
        {
          message: 'Source refresh inspected; no silent adoption',
          currentSnapshot: work.sourceRefs[0],
          changed: false,
        },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('analyze')
  .argument('<id>')
  .option('--json')
  .description('Read-only consistency check: requirements ↔ plan ↔ code ↔ evidence (CRITICAL blocks approval)')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const findings = engine.analyzeWork(id);
      if (opts.json) printResult(findings, true);
      else if (!findings.length) process.stdout.write('No problems found.\n');
      else for (const f of findings) process.stdout.write(`${f.severity.padEnd(8)} ${f.id.padEnd(4)} [${f.gate}] ${f.where ? `${f.where}: ` : ''}${f.message}\n`);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('lint')
  .argument('<id>')
  .option('--json')
  .option('--render', 'Regenerate the documents first')
  .description('Check the task documents are well-formed (errors block approval)')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      if (opts.render) engine.render(engine.ctx.store.getWork(id).id);
      const issues = engine.lintWork(id);
      if (opts.json) printResult(issues, true);
      else if (!issues.length) process.stdout.write('Documents OK.\n');
      else for (const i of issues) process.stdout.write(`${i.level.toUpperCase().padEnd(7)} ${i.file}: ${i.message}\n`);
      engine.ctx.store.close();
      if (issues.some((i) => i.level === 'error')) process.exitCode = 3;
    } catch (e) {
      handleError(e);
    }
  });

const usageCmd = task
  .command('usage')
  .description('Token and model usage for a task (Turbine role_runs + coding-agent records)');

usageCmd
  .command('add')
  .argument('<id>')
  .requiredOption('--source <name>', 'agent name (e.g. cursor) — records source=agent')
  .option('--model <id>', 'model id')
  .option('--provider <name>', 'model provider')
  .requiredOption('--input <n>', 'input tokens, or "unknown"')
  .requiredOption('--output <n>', 'output tokens, or "unknown"')
  .option('--method <m>', 'measured|reported|estimated', 'reported')
  .option('--note <text>')
  .option('--by <name>', 'who recorded this (defaults to git user.name or agent)')
  .option('--json')
  .description('Record coding-agent (or other) usage against a task. Append-only; no edit/delete.')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const method = String(opts.method);
      if (!['measured', 'reported', 'estimated'].includes(method)) {
        throw err('E_INVALID_CONFIG', 'method must be measured, reported, or estimated');
      }
      const agent = isAgentSession();
      const recordedBy =
        opts.by?.trim() ||
        (agent ? 'agent:session' : gitUserName(engine.ctx.projectRoot) || 'local-user');
      const record = engine.addUsage({
        idOrAlias: id,
        source: 'agent',
        agentName: String(opts.source),
        modelId: opts.model,
        modelProvider: opts.provider,
        inputTokens: parseTokenArg(String(opts.input)),
        outputTokens: parseTokenArg(String(opts.output)),
        method: method as 'measured' | 'reported' | 'estimated',
        note: opts.note,
        recordedBy,
        enteredBy: agent ? 'agent' : 'human',
      });
      printResult(
        { id: record.id, workId: record.workId, source: record.source, agentName: record.agentName },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

usageCmd
  .argument('<id>')
  .option('--json')
  .description('Show per-source and per-model totals (unknown never summed as 0)')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const summary = engine.usageSummary(id);
      if (opts.json) {
        printResult(summary, true);
      } else {
        const out = process.stdout;
        out.write(`Usage — ${summary.workId}\n`);
        out.write(
          `  Turbine: calls=${summary.bySource.turbine.calls} in=${formatTokenCount(summary.bySource.turbine.input)} out=${formatTokenCount(summary.bySource.turbine.output)} total=${formatTokenCount(summary.bySource.turbine.total)}${formatUsageQualifiers(summary.bySource.turbine)}\n`,
        );
        out.write(
          `  Agent:   calls=${summary.bySource.agent.calls} in=${formatTokenCount(summary.bySource.agent.input)} out=${formatTokenCount(summary.bySource.agent.output)} total=${formatTokenCount(summary.bySource.agent.total)}${formatUsageQualifiers(summary.bySource.agent)}\n`,
        );
        out.write(
          `  Grand:   calls=${summary.grand.calls} in=${formatTokenCount(summary.grand.input)} out=${formatTokenCount(summary.grand.output)} total=${formatTokenCount(summary.grand.total)}${formatUsageQualifiers(summary.grand)}\n`,
        );
        if (summary.byModel.length) {
          out.write('  By model:\n');
          for (const b of summary.byModel) {
            out.write(
              `    - ${b.source}/${b.modelId ?? b.agentName ?? '?'}: calls=${b.calls} in=${formatTokenCount(b.input)} out=${formatTokenCount(b.output)} total=${formatTokenCount(b.total)}${formatUsageQualifiers(b)}\n`,
            );
          }
        }
        if (summary.records.length) {
          out.write(`  Records (${summary.records.length}):\n`);
          for (const r of summary.records) {
            out.write(
              `    - ${r.id.slice(0, 16)}… ${r.source}${r.agentName ? `:${r.agentName}` : ''} model=${r.modelId ?? '—'} method=${r.method} enteredBy=${r.enteredBy} in=${formatTokenCount(r.tokens.input)} out=${formatTokenCount(r.tokens.output)}\n`,
            );
          }
        }
      }
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('risk')
  .argument('<id>')
  .requiredOption('--raise <profile>', 'standard | comprehensive')
  .requiredOption('--reason <text>', 'Why the task is riskier than detected')
  .option('--json')
  .description('Raise the risk profile (adds reviewers). Lowering is not possible.')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      if (!['lightweight', 'standard', 'comprehensive'].includes(opts.raise)) throw new Error('profile must be standard or comprehensive');
      const work = engine.raiseRisk(id, opts.raise, opts.reason);
      printResult({ id: work.id, profile: work.risk.profile, minimum: work.risk.minimum, roles: work.selectedRoles.map((r) => r.id) }, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

const repoCmd = task.command('repo').description('Repositories this task changes besides the project repo');
repoCmd
  .command('add')
  .argument('<id>')
  .requiredOption('--path <dir>', 'Path to the other repository (its main checkout)')
  .option('--name <name>', 'Short name, e.g. backend')
  .option('--check <cmd...>', 'Quality check(s) to run in its worktree, e.g. "npm run build"')
  .option('--setup <cmd...>', 'Setup command(s) before checks, e.g. "npm ci"')
  .option('--json')
  .description('Add a repository to the task (before the plan is approved)')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const { work, repo } = engine.addRepository(id, {
        path: opts.path,
        name: opts.name,
        checks: opts.check,
        setup: opts.setup,
      });
      printResult({ id: work.id, added: repo, repositories: work.repositories }, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });
repoCmd
  .command('list')
  .argument('<id>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.ctx.store.getWork(id);
      printResult(
        { declared: work.repositories ?? [], worktrees: engine.repoStates(work.id) },
        !!opts.json,
      );
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

async function decideCommand(
  id: string,
  action: 'approve' | 'reject',
  opts: { reason?: string; confirm?: string; by?: string } = {},
) {
  const mediated = Boolean(opts.confirm || opts.by);
  if (!mediated) assertHumanTerminal(`turbine task ${action}`);
  const mediatedIds = mediated
    ? assertMediatedConfirm(`turbine task ${action}`, opts.confirm, opts.by)
    : null;
  const engine = withEngine();
  try {
    const pending = engine.pendingApproval(id);
    const gateLabel: Record<string, string> = {
      requirements: 'Requirements',
      plan: 'Plan',
      'code-review': 'Code review',
      acceptance: 'Final acceptance',
    };
    const out = process.stdout;
    out.write(`\n${action === 'approve' ? 'APPROVE' : 'REJECT'} — ${gateLabel[pending.gate]}\n`);
    out.write(`  Task:      ${pending.work.title} (${pending.work.id})\n`);
    out.write(`  Read:      ${pending.openFile}\n`);
    out.write(
      `  Revision:  ${pending.gate === 'requirements' || pending.gate === 'plan' ? pending.subject : `commit ${pending.subject}`}\n`,
    );
    if (pending.gate === 'code-review' || pending.gate === 'acceptance') {
      const gate = engine.gateDecision(id);
      out.write(`  Evidence:  gate ${gate.decision}\n`);
      for (const b of gate.blocking) out.write(`             - ${b.id}: ${b.status} — ${b.reason}\n`);
    }
    if (pending.gate === 'acceptance') {
      out.write(`  Expected:  ${pending.notes?.expected || '(empty)'}\n`);
      out.write(`  Actual:    ${pending.notes?.actual || '(empty)'}\n`);
    }
    let confirmToken: string;
    let reviewer: string;
    let presence: string;
    if (mediatedIds) {
      confirmToken = mediatedIds.confirmToken;
      reviewer = mediatedIds.reviewer;
      presence = CONFIRM_PRESENCE;
      out.write(
        `\nMediated confirm ${confirmToken} by ${reviewer} (revision under review: ${pending.confirmToken}).\n`,
      );
    } else {
      out.write(`\nType the code ${pending.confirmToken} to confirm you reviewed exactly this revision.\n`);
      confirmToken = await ask('Code: ');
      reviewer = await askReviewer(engine.ctx.projectRoot);
      presence = HUMAN_PRESENCE;
    }
    let why = opts.reason;
    if (action === 'reject' && !why) {
      if (mediatedIds) {
        throw err('E_UNTRUSTED_IDENTITY', 'Non-interactive reject needs --reason <text>');
      }
      why = await ask('Reason: ');
    }
    const result = engine.decide(id, {
      action,
      reviewer,
      confirmToken,
      reason: why,
      presence,
    });
    await engine.waitForLanePr();
    out.write(
      mediatedIds
        ? '\nRecorded via --confirm/--by (local attestation; identity not cryptographically verified).\n'
        : '\nRecorded as a local attestation (identity not cryptographically verified).\n',
    );
    const work = (result as { work: { id: string; currentState: string } }).work;
    printResult({ id: work.id, state: work.currentState }, false);
    await engine.waitForMirror();
  } finally {
    engine.ctx.store.close();
  }
}

task
  .command('approve')
  .argument('<id>')
  .option('--confirm <token>', 'Non-interactive: short hash of the revision (from task next --json)')
  .option('--by <name>', 'Non-interactive: name of the human who approved in chat')
  .description('Approve the pending gate (interactive, or --confirm + --by after human review in chat)')
  .action(async (id, opts) => {
    try {
      await decideCommand(id, 'approve', { confirm: opts.confirm, by: opts.by });
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('reject')
  .argument('<id>')
  .option('--reason <text>')
  .option('--confirm <token>', 'Non-interactive: short hash of the revision (from task next --json)')
  .option('--by <name>', 'Non-interactive: name of the human who rejected in chat')
  .description('Reject / request changes on the pending gate (interactive, or --confirm + --by + --reason)')
  .action(async (id, opts) => {
    try {
      await decideCommand(id, 'reject', { reason: opts.reason, confirm: opts.confirm, by: opts.by });
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('waive')
  .argument('<id>')
  .requiredOption('--obligation <ids...>', 'Obligation id(s) to waive, e.g. obl_manual_sqa')
  .requiredOption('--reason <text>', 'Why the risk is acceptable')
  .requiredOption('--expires <date>', 'ISO date after which the waiver stops applying')
  .description('HUMAN ONLY: accept the risk of unmet obligations (recorded separately; gate stays FAIL)')
  .action(async (id, opts) => {
    try {
      assertHumanTerminal('turbine task waive');
      const engine = withEngine();
      const reviewer = await askReviewer(engine.ctx.projectRoot);
      const confirm = await ask(`Type WAIVE to waive ${opts.obligation.join(', ')}: `);
      if (confirm !== 'WAIVE') throw new Error('Waiver not confirmed');
      const decision = engine.waive(id, {
        obligationIds: opts.obligation,
        reason: opts.reason,
        expiresAt: opts.expires,
        reviewer,
        presence: HUMAN_PRESENCE,
      });
      printResult({ waiver: decision.id, obligations: decision.obligationIds, expiresAt: decision.expiresAt }, false);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('gate')
  .argument('<id>')
  .option('--json')
  .description('Show the derived gate decision (PASS / CONCERNS / FAIL) and what blocks it')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      printResult(engine.gateDecision(id), !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('mark-commit')
  .argument('<id>')
  .requiredOption('--commit <sha>')
  .option('--json')
  .action((id, opts) => {
    try {
      const engine = withEngine();
      const work = engine.markCommitChanged(id, opts.commit);
      printResult({ id: work.id, state: work.currentState }, !!opts.json);
      engine.ctx.store.close();
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('lane')
  .argument('<id>')
  .option('--retry', 'HUMAN ONLY: put a task that fell back to the human flow back in the autonomous lane')
  .option('--json')
  .description('Show whether the task is in the autonomous lane (and why it fell back); --retry is human-only')
  .action(async (id, opts) => {
    try {
      if (opts.retry) assertHumanTerminal('turbine task lane --retry');
      const engine = withEngine();
      try {
        if (!opts.retry) {
          printResult(engine.laneState(id), !!opts.json);
          return;
        }
        const pending = engine.pendingLaneRetry(id);
        process.stdout.write(`\nPUT BACK IN THE LANE — fell back at the ${pending.fallback.gate} gate (${pending.fallback.at.slice(0, 10)}):\n`);
        for (const r of pending.fallback.reasons) process.stdout.write(`  - ${r}\n`);
        process.stdout.write(`\nType the code ${pending.confirmToken} to confirm.\n`);
        const token = await ask('Code: ');
        const reviewer = await askReviewer(engine.ctx.projectRoot);
        const result = engine.laneRetry(id, { actor: reviewer, confirmToken: token, presence: HUMAN_PRESENCE });
        printResult({ id: result.work.id, inLane: true, next: `turbine task sync ${result.work.id}` }, false);
        await engine.waitForMirror();
      } finally {
        engine.ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

task
  .command('pr-refresh')
  .argument('<id>')
  .option('--json')
  .description('Poll the recorded PR: record a merge, or return an ejected task to CHANGES_REQUESTED (also runs on sync)')
  .action(async (id, opts) => {
    try {
      const engine = withEngine();
      try {
        const result = await engine.refreshLanePullRequest(id);
        printResult(
          {
            id: result.work.id,
            state: result.work.currentState,
            pr: result.record.number,
            result: result.kind,
            queueState: result.record.queueState,
            ...(result.reason ? { reason: result.reason } : {}),
            ...('fixRound' in result ? { fixRound: result.fixRound } : {}),
          },
          !!opts.json,
        );
      } finally {
        engine.ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

const fleetCmd = program.command('fleet').description('Drive many tasks under concurrency + spend budget (Part E)');
fleetCmd
  .command('run')
  .requiredOption('--max-concurrent <n>', 'Max tasks claimed at once', (v) => Number(v))
  .requiredOption('--budget <usd>', 'Stop starting tasks once known spend reaches this USD amount', (v) => Number(v))
  .option('--policy <name>', 'Lane policy to watch; if suspended mid-run, finish current steps then leave the lane')
  .option('--lease-ms <ms>', `Lock lease before reclaim (default ${DEFAULT_FLEET_LEASE_MS})`, (v) => Number(v))
  .option(
    '--usd-per-mtok <n>',
    `USD per million measured tokens for budget accounting (default ${DEFAULT_USD_PER_MILLION_TOKENS})`,
    (v) => Number(v),
  )
  .option('--json', 'Machine-readable JSON')
  .description('Pick ready tasks, claim with locks, run sync/next steps until idle, budget, or policy suspend')
  .action(async (opts) => {
    try {
      const engine = withEngine();
      try {
        const report = await runFleet(engine, {
          maxConcurrent: opts.maxConcurrent,
          budgetUsd: opts.budget,
          policyName: opts.policy,
          leaseMs: opts.leaseMs,
          usdPerMillionTokens: opts.usdPerMtok,
        });
        if (opts.json) {
          printResult(report, true);
          return;
        }
        process.stdout.write(`Fleet run ${report.runId} stopped: ${report.stoppedReason}\n`);
        process.stdout.write(
          `Started ${report.started}, finished ${report.finished}; known spend $${report.spend.knownUsd.toFixed(4)}` +
            ` (${report.spend.knownTokens} tokens` +
            `${report.spend.hasUnknown ? '; UNKNOWN usage present — not summed as 0' : ''})\n`,
        );
        for (const o of report.outcomes) {
          process.stdout.write(`  ${o.workId}: ${o.kind}${o.state ? ` → ${o.state}` : ''}${o.detail ? ` (${o.detail})` : ''}\n`);
        }
      } finally {
        engine.ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

fleetCmd
  .command('status')
  .option('--json')
  .description('Counts: running (live locks), waiting-on-human, failed, merged')
  .action((opts) => {
    try {
      const engine = withEngine();
      try {
        const report = fleetStatus(engine);
        if (opts.json) {
          printResult(report, true);
          return;
        }
        process.stdout.write(
          `running ${report.running}; waiting-on-human ${report.waitingOnHuman}; failed ${report.failed}; merged ${report.merged}\n`,
        );
      } finally {
        engine.ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

program
  .command('metrics')
  .option('--policy <name>', 'Policy name, or "human"')
  .option('--since <date>', 'Start of reporting period (ISO date/time)')
  .option('--json', 'Machine-readable JSON')
  .description('Lane safety and delivery metrics with explicit denominators and unknown counts')
  .action((opts) => {
    try {
      const ctx = openContext();
      try {
        const report = computeLaneMetrics(ctx.store, { policy: opts.policy, since: opts.since });
        if (opts.json) {
          printResult(report, true);
          return;
        }
        process.stdout.write(`Metrics period: ${report.period.since}..${report.period.until}\n`);
        for (const row of report.rows) {
          process.stdout.write(`\n${row.lane === 'human' ? 'Human lane' : `Policy ${row.policy}`} (${row.tasks} tasks)\n`);
          process.stdout.write(`${formatLaneMetric('merged PRs/week', row.mergedPrsPerWeek)}\n`);
          process.stdout.write(`${formatLaneMetric('merge rate', row.mergeRate)}\n`);
          process.stdout.write(`${formatLaneMetric('revert rate', row.revertRate)}\n`);
          process.stdout.write(`${formatLaneMetric('fix rounds/merged PR', row.fixRoundsPerMergedPr)}\n`);
          process.stdout.write(`${formatLaneMetric('cost/merged PR (USD)', row.costPerMergedPrUsd)}\n`);
          process.stdout.write(`${formatLaneMetric('reviewer disagreement rate', row.reviewerDisagreementRate)}\n`);
          process.stdout.write(`${formatLaneMetric('fallback share', row.fallbackShare)}\n`);
          const reasons = Object.entries(row.fallbackShare.reasons);
          process.stdout.write(`  fallback reasons: ${reasons.length ? reasons.map(([reason, count]) => `${reason} (${count})`).join('; ') : 'none recorded'}\n`);
        }
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

const auditCmd = program.command('audit').description('Human audit queue for sampled autonomous policy merges');
auditCmd
  .command('next')
  .option('--json')
  .description('Show the oldest queued audit')
  .action((opts) => {
    try {
      const ctx = openContext();
      try {
        const audit = nextLaneAudit(ctx.store);
        printResult(audit ?? { status: 'empty', message: 'No queued lane audits' }, !!opts.json);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

auditCmd
  .command('record')
  .argument('<id>')
  .option('--ok', 'Record that the sampled merge is satisfactory')
  .option('--problem <text>', 'Record a problem and its explanation')
  .description('HUMAN ONLY: record an audit outcome')
  .action(async (id, opts) => {
    try {
      assertHumanTerminal('turbine audit record');
      if (!!opts.ok === !!opts.problem) throw err('E_INVALID_CONFIG', 'Choose exactly one of --ok or --problem "<text>"');
      const ctx = openContext();
      try {
        const reviewer = await askReviewer(ctx.projectRoot);
        const result = recordLaneAuditOutcome(ctx.store, {
          id,
          outcome: opts.ok ? 'ok' : 'problem',
          note: opts.problem,
          reviewer,
        });
        printResult(
          {
            audit: result.audit.id,
            outcome: result.audit.outcome,
            policy: result.audit.policyId,
            autoSuspended: result.suspended,
            reasons: result.reasons,
          },
          false,
        );
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

const policyCmd = program.command('policy').description('Lane policies (.turbine/policies/*.yaml); no effect until a human approves the exact content');
policyCmd
  .command('list')
  .option('--json')
  .action((opts) => {
    try {
      const ctx = openContext();
      try {
        const { policies, errors } = policyStatuses(ctx.store, ctx.projectRoot);
        const rows = policies.map((p) => ({
          name: p.name,
          state: p.state,
          reason: p.reason,
          approvedBy: p.approved?.approvedBy,
          approvedAt: p.approved?.approvedAt,
          approvedHash: p.approved?.contentHash,
          fileHash: p.file?.hash,
        }));
        printResult({ policies: rows, ...(errors.length ? { errors } : {}) }, !!opts.json);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

policyCmd
  .command('show')
  .argument('<name>')
  .option('--json')
  .description('Show a policy, its state, and the diff between the approved and the file content')
  .action((name, opts) => {
    try {
      const ctx = openContext();
      try {
        const status = policyStatuses(ctx.store, ctx.projectRoot).policies.find((p) => p.name === name);
        if (!status) throw err('E_NOT_FOUND', `No policy named ${name}`);
        const diff =
          status.approved && status.file?.yaml !== undefined && status.file.hash !== status.approved.contentHash
            ? policyDiff(status.approved.yaml, status.file.yaml)
            : undefined;
        if (opts.json) {
          printResult({ name, state: status.state, reason: status.reason, approved: status.approved, file: status.file, diff }, true);
          return;
        }
        const out = process.stdout;
        out.write(`Policy ${name}: ${status.state}${status.reason ? ` — ${status.reason}` : ''}\n`);
        if (status.approved) out.write(`Approved by ${status.approved.approvedBy} on ${status.approved.approvedAt.slice(0, 10)} (${status.approved.contentHash})\n`);
        if (status.file?.hash) out.write(`File: ${status.file.path} (${status.file.hash})\n`);
        if (diff) {
          out.write('\nDiff (approved → file; the file has NO effect until approved):\n');
          for (const l of diff) out.write(`${l}\n`);
        } else if (status.file?.yaml !== undefined) {
          out.write(`\n${status.file.yaml}\n`);
        }
        if (status.state === 'unapproved' || status.state === 'pending') {
          out.write(`\nA human approves it in their own terminal: turbine policy approve ${name}\n`);
        }
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

policyCmd
  .command('approve')
  .argument('<name>')
  .description('HUMAN ONLY: approve the exact content of .turbine/policies/<name>.yaml (interactive)')
  .action(async (name) => {
    try {
      assertHumanTerminal('turbine policy approve');
      const ctx = openContext();
      try {
        const pending = pendingPolicyApproval(ctx.store, ctx.projectRoot, name, ctx.config.models.profiles);
        const out = process.stdout;
        out.write(`\nAPPROVE LANE POLICY — ${name}\n  File: ${pending.status.file!.path}\n  Hash: ${pending.hash}\n\n`);
        if (pending.diff) {
          out.write('Changes since the approved version:\n');
          for (const l of pending.diff) out.write(`${l}\n`);
        } else out.write(`${pending.yaml}\n`);
        for (const w of pending.warnings) out.write(`\nWARNING: ${w}\n`);
        out.write(`\nTasks that meet this policy will pass its gates without a human. Type the code ${pending.confirmToken} to confirm.\n`);
        const token = await ask('Code: ');
        const reviewer = await askReviewer(ctx.projectRoot);
        const result = approvePolicy(ctx.store, ctx.projectRoot, {
          name,
          confirmToken: token,
          reviewer,
          presence: HUMAN_PRESENCE,
          profiles: ctx.config.models.profiles,
        });
        out.write('\nRecorded as a local attestation (identity not cryptographically verified).\n');
        printResult({ policy: name, state: 'active', hash: result.policy.contentHash, decision: result.decision.id }, false);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

policyCmd
  .command('suspend')
  .argument('<name>')
  .requiredOption('--reason <text>', 'Why the policy is suspended')
  .option('--actor <actor>', 'Who is suspending (agents may suspend)')
  .description('Suspend a policy (anyone, agents included: it only removes autonomy)')
  .action((name, opts) => {
    try {
      const ctx = openContext();
      try {
        const actor = opts.actor ?? (isAgentSession() ? 'agent' : gitUserName(ctx.projectRoot) || 'local-user');
        const p = suspendPolicy(ctx.store, name, opts.reason, actor);
        printResult({ policy: p.name, state: p.status, reason: p.suspendedReason }, false);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

policyCmd
  .command('resume')
  .argument('<name>')
  .description('HUMAN ONLY: re-activate a suspended policy (interactive)')
  .action(async (name) => {
    try {
      assertHumanTerminal('turbine policy resume');
      const ctx = openContext();
      try {
        const pending = pendingPolicyResume(ctx.store, name);
        process.stdout.write(
          `\nRESUME LANE POLICY — ${name}\n  Suspended: ${pending.policy.suspendedReason ?? '(no reason recorded)'}\n  Approved hash: ${pending.policy.contentHash}\n\nType the code ${pending.confirmToken} to confirm.\n`,
        );
        const token = await ask('Code: ');
        const reviewer = await askReviewer(ctx.projectRoot);
        const result = resumePolicy(ctx.store, { name, confirmToken: token, reviewer, presence: HUMAN_PRESENCE });
        // Stored status is "active" after resume, but a drifted file is still pending until re-approved.
        const effective = policyStatuses(ctx.store, ctx.projectRoot).policies.find((p) => p.name === name);
        const out: Record<string, unknown> = {
          policy: name,
          state: effective?.state ?? result.policy.status,
          decision: result.decision.id,
        };
        if (effective?.reason) out.reason = effective.reason;
        if (effective?.state === 'pending') {
          out.next = `turbine policy approve ${name}`;
        }
        printResult(out, false);
      } finally {
        ctx.store.close();
      }
    } catch (e) {
      handleError(e);
    }
  });

program.parseAsync(process.argv).catch(handleError);
