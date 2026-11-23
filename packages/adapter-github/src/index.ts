import { err } from '@turbine-hall/turbine-contracts';
import type { Capability, ToolAdapter } from '@turbine-hall/turbine-tools';

export type GitHubIssueRef = {
  owner: string;
  repo: string;
  number: number;
};

export type GitHubComment = {
  id: string;
  body: string;
  issueNumber: number;
  updatedAt: string;
};

export type GitHubConfig = {
  /** e.g. https://api.github.com — unused in fixture mode */
  apiBaseUrl?: string;
  token?: string;
  /** Offline / CI: in-memory comments keyed by `owner/repo#number` */
  fixtures?: {
    comments?: Record<string, GitHubComment[]>;
  };
};

const issueKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;

function resolveToken(config: GitHubConfig): string | undefined {
  return config.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

function httpsApiBase(config: GitHubConfig): string {
  const api = (config.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  if (!/^https:\/\//i.test(api)) {
    throw err('E_ADAPTER', `GitHub apiBaseUrl must be https (got ${api})`);
  }
  return api;
}

export function createGitHubAdapter(config: GitHubConfig = {}): ToolAdapter {
  const fixtureComments = config.fixtures?.comments ?? {};

  return {
    id: 'github',
    capabilities: ['issue.read', 'issue.comment'] as Capability[],
    async healthCheck() {
      if (config.fixtures) return { ok: true, details: 'fixture-mode' };
      if (!resolveToken(config)) return { ok: false, details: 'Missing GITHUB_TOKEN / token' };
      try {
        httpsApiBase(config);
      } catch (e) {
        return { ok: false, details: (e as Error).message };
      }
      return { ok: true, details: 'configured' };
    },
    async invoke({ capability, arguments: args }) {
      if (capability !== 'issue.comment' && capability !== 'issue.read') {
        throw err('E_MISSING_CAPABILITY', `GitHub adapter does not support ${capability}`);
      }

      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const number = Number(args.number ?? args.issueNumber);
      if (!owner || !repo || !Number.isFinite(number) || number <= 0) {
        throw err('E_ADAPTER', 'GitHub owner, repo, and issue number are required');
      }
      const key = issueKey(owner, repo, number);

      if (capability === 'issue.read') {
        if (config.fixtures) {
          return { data: { owner, repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` }, externalOperationId: key };
        }
        throw err('E_ADAPTER', 'GitHub issue.read live mode is not used by packet mirror; configure fixtures for tests');
      }

      // issue.comment — upsert sticky when commentId provided, else create
      const body = String(args.body ?? '');
      if (!body) throw err('E_ADAPTER', 'comment body required');
      const commentId = args.commentId != null ? String(args.commentId) : undefined;

      if (config.fixtures) {
        const list = (fixtureComments[key] ??= []);
        if (commentId) {
          const existing = list.find((c) => c.id === commentId);
          if (!existing) throw err('E_ADAPTER', `fixture comment ${commentId} not found on ${key}`);
          existing.body = body;
          existing.updatedAt = new Date().toISOString();
          return { data: { id: existing.id, body: existing.body, created: false }, externalOperationId: existing.id };
        }
        const id = `ghc_${list.length + 1}`;
        const created: GitHubComment = { id, body, issueNumber: number, updatedAt: new Date().toISOString() };
        list.push(created);
        return { data: { id, body, created: true }, externalOperationId: id };
      }

      const token = resolveToken(config);
      if (!token) throw err('E_ADAPTER', 'GitHub token missing (GITHUB_TOKEN)');
      const api = httpsApiBase(config);
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      if (commentId) {
        const res = await fetch(`${api}/repos/${owner}/${repo}/issues/comments/${encodeURIComponent(commentId)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status !== 404) {
          if (!res.ok) throw err('E_ADAPTER', `GitHub comment update failed: ${res.status} ${res.statusText}`);
          const json = (await res.json()) as { id: number; body: string };
          return { data: { id: String(json.id), body: json.body, created: false }, externalOperationId: String(json.id) };
        }
        // Sticky comment deleted — fall through to create.
      }

      const res = await fetch(`${api}/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw err('E_ADAPTER', `GitHub comment create failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { id: number; body: string };
      return { data: { id: String(json.id), body: json.body, created: true }, externalOperationId: String(json.id) };
    },
  };
}

/** List fixture comments for tests. */
export function listFixtureComments(config: GitHubConfig, owner: string, repo: string, number: number): GitHubComment[] {
  return [...(config.fixtures?.comments?.[issueKey(owner, repo, number)] ?? [])];
}
