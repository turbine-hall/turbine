import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepo } from '@turbine-hall/turbine-adapter-git';
import type { Fact } from './docs/normalize.js';

/**
 * Deterministic project snapshot for assess/plan. Everything here is read from disk/git,
 * so it is reported as verified facts with a source. It is kept task-relevant: what the
 * project is built with, which scripts exist, and which existing files look related to
 * the request — not a dump of every dependency version.
 */
export type ProjectEvidence = {
  projectRoot: string;
  collectedAt: string;
  git?: { branch: string; head: string; dirty: boolean };
  packageManager?: string;
  packageName?: string;
  scripts: string[];
  stack: Array<{ name: string; version: string }>;
  testRunner?: string;
  typescript?: string;
  relatedFiles: string[];
  facts: Fact[];
};

const STACK: Array<[string, string]> = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'],
  ['express', 'Express'], ['@nestjs/core', 'NestJS'], ['fastify', 'Fastify'], ['hono', 'Hono'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['typeorm', 'TypeORM'], ['mongoose', 'Mongoose'], ['drizzle-orm', 'Drizzle'],
  ['tailwindcss', 'Tailwind CSS'], ['zod', 'Zod'], ['react-hook-form', 'React Hook Form'],
];
const TEST_RUNNERS = ['vitest', 'jest', 'mocha', '@playwright/test', 'cypress'];
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'add', 'update', 'make', 'user', 'users', 'can', 'should', 'when', 'will', 'new', 'all', 'not']);

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Existing tracked files whose path mentions DISTINCTIVE words from the request (cap 12).
 * Words are weighted by rarity across the repo (IDF), so common words like "section" or
 * "content" do not pull in unrelated files.
 */
function relatedFiles(projectRoot: string, requestText: string): string[] {
  const words = [...new Set(requestText.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
  if (!words.length) return [];
  const r = spawnSync('git', ['ls-files'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const files = r.stdout
    .split('\n')
    .filter((f) => f && !/(^|\/)(node_modules|dist|build|\.next|coverage|public)\//.test(f) && !/\.(lock|png|jpe?g|svg|ico|woff2?|gif|webp|mp4)$/.test(f));
  if (!files.length) return [];
  const lower = files.map((f) => f.toLowerCase());
  const idf = new Map<string, number>();
  for (const w of words) {
    const df = lower.filter((f) => f.includes(w)).length;
    // Ignore words that match nothing or are everywhere (>3% of files).
    if (df > 0 && df / files.length <= 0.03) idf.set(w, Math.log(files.length / df));
  }
  const scored = files
    .map((f, i) => ({ f, score: [...idf.entries()].filter(([w]) => lower[i]!.includes(w)).reduce((n, [, v]) => n + v, 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.length - b.f.length);
  const top = scored[0]?.score ?? 0;
  return scored.filter((x) => x.score >= top * 0.5).slice(0, 12).map((x) => x.f);
}

export function collectProjectEvidence(projectRoot: string, requestText = ''): ProjectEvidence {
  const facts: Fact[] = [];
  const ev: ProjectEvidence = {
    projectRoot,
    collectedAt: new Date().toISOString(),
    scripts: [],
    stack: [],
    relatedFiles: [],
    facts,
  };
  try {
    const git = inspectRepo(projectRoot);
    ev.git = { branch: git.branch, head: git.head, dirty: git.dirty };
    facts.push({ text: `Base branch is ${git.branch} at ${git.head.slice(0, 8)}${git.dirty ? ' (main checkout has uncommitted changes)' : ''}`, source: 'git' });
  } catch {
    facts.push({ text: 'Project is not a git repository', source: 'git' });
  }

  const pkg = readJson(join(projectRoot, 'package.json'));
  if (pkg) {
    const deps = { ...((pkg.dependencies as Record<string, string>) ?? {}), ...((pkg.devDependencies as Record<string, string>) ?? {}) };
    ev.packageName = typeof pkg.name === 'string' ? pkg.name : undefined;
    ev.scripts = Object.keys((pkg.scripts as Record<string, string>) ?? {});
    for (const [dep, name] of STACK) {
      if (deps[dep] && !ev.stack.some((s) => s.name === name)) ev.stack.push({ name, version: deps[dep]! });
    }
    ev.testRunner = TEST_RUNNERS.find((t) => deps[t]);
    ev.typescript = deps.typescript;
    if (ev.stack.length) facts.push({ text: `Built with ${ev.stack.map((s) => `${s.name} ${s.version}`).join(', ')}`, source: 'package.json' });
    const useful = ev.scripts.filter((s) => /^(lint|test|typecheck|type-check|build|e2e|check)/.test(s));
    if (useful.length) facts.push({ text: `Scripts available: ${useful.join(', ')}`, source: 'package.json' });
    if (ev.testRunner) facts.push({ text: `Test runner: ${ev.testRunner}`, source: 'package.json' });
    else facts.push({ text: 'No JavaScript test runner dependency found', source: 'package.json' });
    if (ev.typescript) facts.push({ text: `TypeScript ${ev.typescript}`, source: 'package.json' });
  }
  for (const [file, pm] of [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun']] as const) {
    if (existsSync(join(projectRoot, file))) {
      ev.packageManager = pm;
      facts.push({ text: `Package manager: ${pm}`, source: file });
      break;
    }
  }
  ev.relatedFiles = relatedFiles(projectRoot, requestText);
  if (ev.relatedFiles.length) {
    facts.push({ text: `Existing files that look related: ${ev.relatedFiles.slice(0, 6).join(', ')}${ev.relatedFiles.length > 6 ? ` (+${ev.relatedFiles.length - 6})` : ''}`, source: 'git ls-files' });
  }
  return ev;
}

/** Bullet facts derived deterministically (kept for callers that want plain strings). */
export function projectEvidenceFacts(evidence: ProjectEvidence): string[] {
  return evidence.facts.map((f) => f.text);
}

/**
 * Unknowns that are engineering discovery work, not human requirement blockers.
 * These must not force NEEDS_CLARIFICATION.
 */
export function isDeferredEngineeringUnknown(text: string): boolean {
  return /(latest.*(npm|registry|version)|@types|compatib|refactor|typecheck|build scripts? will pass|will force|exact .*version available|whether the upgrade|whether any @types|whether the existing)/i.test(
    text,
  );
}
