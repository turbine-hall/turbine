import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  ProjectConfigSchema,
  type ProjectConfig,
  err,
} from '@turbine-hall/turbine-contracts';
import { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { callerCwd, factoryRoot, findProjectRoot, projectPaths, resolveProjectPath } from '../paths.js';
import { installCursorGuard } from './agent-guard.js';
import { GLOSSARY } from './docs/glossary.js';

export type EngineContext = {
  factoryRoot: string;
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof projectPaths>;
  store: WorkStore;
};

export function defaultConfig(projectRoot: string, name?: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    schemaVersion: 1,
    project: {
      name: name ?? basename(projectRoot),
      root: '.',
      nonProductionOnly: true,
    },
    framework: {
      id: 'turbine',
      version: '0.5.0',
      policyProfile: 'standard',
    },
    inputs: {
      default: 'file',
      adapters: {
        jira: { enabled: false, siteUrl: null, credentialRef: null },
      },
    },
    models: {
      defaultProfile: 'analysis',
      profiles: {
        analysis: { provider: 'mock', model: 'mock-default', maxOutputTokens: 4000 },
        implementation: { provider: 'mock', model: 'mock-default', maxOutputTokens: 8000 },
      },
    },
    budgets: {
      perTask: {
        currency: 'USD',
        maxEstimatedCost: 5,
        maxModelCalls: 15,
        maxExecutionAttempts: 2,
      },
    },
    tools: {
      allow: ['issue.read', 'repo.inspect', 'repo.read', 'git.diff', 'tests.run'],
      denied: ['issue.edit', 'issue.transition', 'pr.merge', 'production.deploy'],
    },
    execution: {
      mode: 'manual-supervised',
      requireIsolatedWorktree: true,
      allowNetwork: false,
    },
    quality: { checks: [] },
    humanGates: {
      requirements: true,
      plan: true,
      codeReview: true,
      sqaAcceptance: true,
    },
  });
}

export function initProject(input: {
  projectPath?: string;
  nonInteractive?: boolean;
}): { paths: ReturnType<typeof projectPaths>; created: string[]; config: ProjectConfig } {
  const projectRoot = resolveProjectPath(input.projectPath);
  const paths = projectPaths(projectRoot);
  const created: string[] = [];

  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });

  if (!existsSync(paths.configPath)) {
    const config = defaultConfig(projectRoot);
    writeFileSync(paths.configPath, stringifyYaml(config), 'utf8');
    created.push(paths.configPath);
  }

  if (!existsSync(paths.lockPath)) {
    writeFileSync(
      paths.lockPath,
      JSON.stringify(
        {
          framework: { id: 'turbine', version: '0.5.0', hash: 'sha256:turbine-0.5.0-baseline' },
          roles: {},
          skills: {},
        },
        null,
        2,
      ),
      'utf8',
    );
    created.push(paths.lockPath);
  }

  if (!existsSync(paths.gitignorePath)) {
    writeFileSync(
      paths.gitignorePath,
      ['state/', '*.db', '*.db-*', 'worktrees/', 'context/', '.env', 'secrets/'].join('\n') + '\n',
      'utf8',
    );
    created.push(paths.gitignorePath);
  }

  const howToPath = join(paths.sfDir, 'HOW_TO_DRIVE.md');
  const howToBody = [
    '# How to drive Turbine Hall',
    '',
    'Do not invent the next step. Ask the CLI:',
    '',
    '```bash',
    'turbine task next <work-id>',
    '```',
    '',
    'Then follow `Do now` / `Commands`. Agents run `sync` to advance AI/tool stages:',
    '',
    '```bash',
    'turbine task sync <work-id>',
    'turbine task next <work-id>',
    '```',
    '',
    '## Human decisions (humans only)',
    '',
    'Approvals are never made by editing markdown. A human runs, in their own terminal:',
    '',
    '```bash',
    'turbine task approve <work-id>   # shows what you are approving; you type its short code',
    'turbine task reject <work-id>',
    'turbine task gate <work-id>      # PASS / CONCERNS / FAIL and what blocks it',
    '```',
    '',
    'AI agents must not run approve / reject / waive / cancel. `.cursor/hooks.json` blocks them in Cursor.',
    '',
    '## Before your first task: configure checks',
    '',
    'Verification runs these commands in the task worktree. With none configured, verification is blocked.',
    '',
    '```yaml',
    '# .turbine/project.yaml',
    'quality:',
    '  setup:',
    '    - npm ci',
    '  checks:',
    '    - npm run lint',
    '    - npm run typecheck',
    '    - npm test',
    '    - npm run build',
    '```',
    '',
    '## Tasks that change more than one repository',
    '',
    '```bash',
    'turbine task repo add <work-id> --path ../backend --name backend --setup "npm ci" --check "npm run build"',
    '```',
    '',
    'Add repos before the plan is approved. Each gets its own worktree on `turbine/<work-id>`.',
    '',
    '## Mental model',
    '',
    '- Packet: `.turbine/tasks/<id>/` (STATUS + stage MD files)',
    '- Worktree: `.turbine/worktrees/<id>/` on branch `turbine/<id>` — code goes HERE',
    '- Main checkout (staging/main): stays old until you merge a PR and `git pull`',
    '- ACCEPTED ≠ merged/deployed',
    '',
    'Full agent playbook: see factory repo `docs/AGENT_DRIVER.md`.',
    '',
  ].join('\n');
  if (!existsSync(howToPath)) {
    writeFileSync(howToPath, howToBody, 'utf8');
    created.push(howToPath);
  } else {
    // Keep guide fresh on re-init without clobbering user edits if they customized heavily
    writeFileSync(howToPath, howToBody, 'utf8');
  }

  const glossaryPath = join(paths.sfDir, 'GLOSSARY.md');
  writeFileSync(glossaryPath, GLOSSARY, 'utf8');
  created.push(glossaryPath);

  // Block AI agents (Cursor) from running human-only commands in this project.
  try {
    created.push(...installCursorGuard(projectRoot));
  } catch (e) {
    process.stderr.write(`Warning: ${(e as Error).message}\n`);
  }

  // Ensure DB migrations run
  const store = new WorkStore(paths.dbPath);
  store.close();
  if (!created.includes(paths.dbPath) && existsSync(paths.dbPath)) {
    // db may already exist on re-init
  } else {
    created.push(paths.dbPath);
  }

  const config = loadConfig(paths.configPath);
  return { paths, created, config };
}

export function loadConfig(configPath: string): ProjectConfig {
  if (!existsSync(configPath)) {
    throw err('E_INVALID_CONFIG', `Missing project config at ${configPath}. Run: turbine init`);
  }
  const raw = parseYaml(readFileSync(configPath, 'utf8'));
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw err('E_INVALID_CONFIG', 'Invalid project.yaml', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export function saveConfig(configPath: string, config: ProjectConfig): void {
  writeFileSync(configPath, stringifyYaml(ProjectConfigSchema.parse(config)), 'utf8');
}

export function openContext(cwd = callerCwd()): EngineContext {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) {
    throw err(
      'E_INVALID_CONFIG',
      `No .turbine project found from ${cwd}. Run: turbine init --project .`,
    );
  }
  const paths = projectPaths(projectRoot);
  const config = loadConfig(paths.configPath);
  const store = new WorkStore(paths.dbPath);
  return {
    factoryRoot: factoryRoot(),
    projectRoot,
    config,
    paths,
    store,
  };
}
