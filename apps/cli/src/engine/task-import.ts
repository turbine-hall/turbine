import { createId, err, TurbineError, type WorkPackage } from '@turbine-hall/turbine-contracts';
import type { Engine } from './engine.js';

export type ImportIssue = {
  /** Stable tracker key used for alias / skip detection (e.g. `github:o/r#1` or `jira:KEY`). */
  alias: string;
  title: string;
  body: string;
  labels?: string[];
  provider: 'github' | 'jira';
  externalId: string;
  url?: string;
};

export type ImportSkip = {
  alias: string;
  reason: string;
  existingWorkId?: string;
};

export type ImportCreated = {
  alias: string;
  workId: string;
};

export type ImportReport = {
  created: ImportCreated[];
  skipped: ImportSkip[];
};

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Neutralize GitHub issue URLs in import body text so `createTask` does not attach
 * another issue's `github:owner/repo#n` alias to this task.
 */
export function scrubForeignGitHubIssueUrls(body: string, keepExternalId?: string): string {
  return body.replace(
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/gi,
    (full, owner: string, repo: string, num: string) => {
      const key = `${owner}/${repo}#${num}`;
      if (keepExternalId && key.toLowerCase() === keepExternalId.toLowerCase()) return full;
      return `github-issue ${owner}/${repo}#${num}`;
    },
  );
}

/**
 * Bulk-create tasks from tracker issues. Skips issues that already have a task and
 * records a non-silent reason for every skip (AGENTS.md rule 9).
 */
export function importTasks(engine: Engine, issues: ImportIssue[]): ImportReport {
  if (!Array.isArray(issues)) {
    throw err('E_INVALID_CONFIG', 'importTasks requires an issues array');
  }
  const created: ImportCreated[] = [];
  const skipped: ImportSkip[] = [];
  const seen = new Set<string>();

  for (const issue of issues) {
    if (!issue || typeof issue.alias !== 'string' || !issue.alias.trim()) {
      throw err('E_INVALID_CONFIG', 'import issue is missing alias');
    }
    if (!issue.title?.trim()) {
      throw err('E_INVALID_CONFIG', `import issue ${issue.alias} is missing title`);
    }
    if (seen.has(issue.alias)) {
      skipped.push({ alias: issue.alias, reason: 'duplicate alias in this import batch' });
      engine.ctx.store.appendEvent({
        type: 'task.import.skipped',
        payload: { alias: issue.alias, reason: 'duplicate alias in this import batch', at: nowIso() },
      });
      continue;
    }
    seen.add(issue.alias);

    // Fail closed on corrupt prior state (AGENTS.md rule 12): only E_NOT_FOUND means "absent".
    let existing: WorkPackage | null = null;
    try {
      existing = engine.ctx.store.getWork(issue.alias);
    } catch (e) {
      if (!(e instanceof TurbineError) || e.code !== 'E_NOT_FOUND') {
        throw err(
          'E_UNSAFE_EXECUTION',
          `import: unreadable prior work for ${issue.alias}: ${(e as Error).message.split('\n')[0]}`,
        );
      }
    }
    if (existing) {
      skipped.push({
        alias: issue.alias,
        reason: `already has task ${existing.id}`,
        existingWorkId: existing.id,
      });
      engine.ctx.store.appendEvent({
        workId: existing.id,
        type: 'task.import.skipped',
        payload: { alias: issue.alias, reason: `already has task ${existing.id}`, at: nowIso() },
      });
      continue;
    }

    const keepId = issue.provider === 'github' ? issue.externalId : undefined;
    const safeTitle = scrubForeignGitHubIssueUrls(issue.title, keepId);
    const body = scrubForeignGitHubIssueUrls(issue.body ?? '', keepId);
    // Include this issue's own URL (scrubbed) so createTask can record the matching github alias in one save.
    const rawOwnUrl =
      issue.provider === 'github' && issue.url
        ? issue.url
        : issue.provider === 'github'
          ? `https://github.com/${issue.externalId.replace('#', '/issues/')}`
          : '';
    const ownUrl = rawOwnUrl
      ? `\n\nSource: ${scrubForeignGitHubIssueUrls(rawOwnUrl, keepId)}\n`
      : '';
    const text = `# ${safeTitle}\n\n${body}${ownUrl}`;
    const seedAliases = [issue.alias];
    if (issue.provider === 'jira') seedAliases.push(issue.externalId);
    const work = engine.createTask({
      title: safeTitle,
      type: 'feature',
      text,
      labels: issue.labels,
      aliases: seedAliases,
    });

    // Keep only this issue's tracker identity (drop any residual foreign ghLinks).
    const aliases = [...new Set(seedAliases)];
    const withAlias: WorkPackage = {
      ...work,
      aliases,
      sourceRefs: [
        {
          provider: issue.provider,
          externalId: issue.externalId,
          url: issue.url,
          snapshotHash: work.sourceRefs[0]!.snapshotHash,
          ...(issue.labels?.length ? { labels: [...new Set(issue.labels)] } : {}),
        },
      ],
      updatedAt: nowIso(),
    };
    engine.ctx.store.saveWork(withAlias);
    engine.ctx.store.appendEvent({
      workId: work.id,
      type: 'task.import.created',
      payload: {
        alias: issue.alias,
        provider: issue.provider,
        externalId: issue.externalId,
        at: nowIso(),
        importId: createId('import'),
      },
    });
    created.push({ alias: issue.alias, workId: work.id });
  }

  return { created, skipped };
}

/** Parse a GitHub fixture list: `{ owner, repo, issues: [{ number, title, body?, labels? }] }`. */
export function issuesFromGitHubFixture(
  owner: string,
  repo: string,
  fixture: { issues?: Array<{ number: number; title: string; body?: string; labels?: string[]; url?: string }> },
  label?: string,
): ImportIssue[] {
  if (!owner || owner.includes('..') || owner.includes('/') || owner.includes('\\')) {
    throw err('E_INVALID_CONFIG', `invalid GitHub owner: ${owner}`);
  }
  if (!repo || repo.includes('..') || repo.includes('/') || repo.includes('\\')) {
    throw err('E_INVALID_CONFIG', `invalid GitHub repo: ${repo}`);
  }
  const issues = fixture?.issues;
  if (!Array.isArray(issues)) {
    throw err('E_INVALID_CONFIG', 'GitHub import fixture must include an issues array');
  }
  const out: ImportIssue[] = [];
  for (const issue of issues) {
    if (!issue || !Number.isInteger(issue.number) || issue.number < 1) {
      throw err('E_INVALID_CONFIG', 'GitHub fixture issue needs a positive integer number');
    }
    if (issue.labels != null && !Array.isArray(issue.labels)) {
      throw err('E_INVALID_CONFIG', `GitHub fixture #${issue.number} labels must be a string array`);
    }
    if (Array.isArray(issue.labels) && issue.labels.some((l) => typeof l !== 'string')) {
      throw err('E_INVALID_CONFIG', `GitHub fixture #${issue.number} labels must be strings`);
    }
    const labels = issue.labels ?? [];
    if (label && !labels.includes(label)) continue;
    const externalId = `${owner}/${repo}#${issue.number}`;
    out.push({
      alias: `github:${externalId}`,
      title: issue.title,
      body: issue.body ?? '',
      labels,
      provider: 'github',
      externalId,
      url: issue.url ?? `https://github.com/${owner}/${repo}/issues/${issue.number}`,
    });
  }
  return out;
}

/** Parse a Jira fixture list: `{ issues: [{ key, summary, description?, labels?, url? }] }`. */
export function issuesFromJiraFixture(
  fixture: {
    issues?: Array<{ key: string; summary: string; description?: string; labels?: string[]; url?: string }>;
  },
): ImportIssue[] {
  const issues = fixture?.issues;
  if (!Array.isArray(issues)) {
    throw err('E_INVALID_CONFIG', 'Jira import fixture must include an issues array');
  }
  return issues.map((issue) => {
    if (!issue?.key?.trim() || !issue.summary?.trim()) {
      throw err('E_INVALID_CONFIG', 'Jira fixture issue needs key and summary');
    }
    if (issue.labels != null && !Array.isArray(issue.labels)) {
      throw err('E_INVALID_CONFIG', `Jira fixture ${issue.key} labels must be a string array`);
    }
    if (Array.isArray(issue.labels) && issue.labels.some((l) => typeof l !== 'string')) {
      throw err('E_INVALID_CONFIG', `Jira fixture ${issue.key} labels must be strings`);
    }
    return {
      alias: `jira:${issue.key}`,
      title: `${issue.key}: ${issue.summary}`,
      body: issue.description ?? '',
      labels: issue.labels,
      provider: 'jira' as const,
      externalId: issue.key,
      url: issue.url,
    };
  });
}
