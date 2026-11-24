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

export type GitHubPullRequest = {
  number: number;
  nodeId: string;
  url: string;
  head: string;
  headSha: string;
  base: string;
  state: 'open' | 'merged' | 'closed';
  mergeQueueState?: 'queued' | 'ejected';
  queueReason?: string;
  mergedAt?: string;
  mergeSha?: string;
};

export type GitHubFixtureState = {
  comments?: Record<string, GitHubComment[]>;
  pullRequests?: Record<string, GitHubPullRequest[]>;
  statuses?: Record<string, Array<{ context: string; state: 'pending' | 'success' | 'failure'; description?: string }>>;
  protections?: Record<string, { mergeQueueRequired: boolean; requiredStatuses: string[] } | { error: string }>;
};

export type GitHubConfig = {
  /** e.g. https://api.github.com — unused in fixture mode */
  apiBaseUrl?: string;
  token?: string;
  /** Offline / CI: in-memory comments keyed by `owner/repo#number` */
  fixtures?: GitHubFixtureState;
};

const issueKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;

const MARKER_RE = /<!-- turbine-packet-mirror:([^\s]+) -->/;

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

const liveFetchInit = (): RequestInit => ({
  redirect: 'error',
  signal: AbortSignal.timeout(15_000),
});

export function createGitHubAdapter(config: GitHubConfig = {}): ToolAdapter {
  const fixtureComments = config.fixtures?.comments ?? {};

  return {
    id: 'github',
    capabilities: ['issue.read', 'issue.comment', 'pr.create', 'pr.read', 'pr.merge', 'commit.status', 'repo.rules.read'] as Capability[],
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
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      if (!owner || !repo) throw err('E_ADAPTER', 'GitHub owner and repo are required');
      const repoKey = `${owner}/${repo}`;

      if (capability === 'repo.rules.read') {
        const branch = String(args.branch ?? '');
        if (!branch) throw err('E_ADAPTER', 'branch is required');
        if (config.fixtures) {
          const value = config.fixtures.protections?.[`${repoKey}:${branch}`];
          if (!value || 'error' in value) {
            return { data: { status: 'unknown', reason: value && 'error' in value ? value.error : 'protection fixture missing' } };
          }
          return {
            data: {
              status: 'confirmed',
              mergeQueueRequired: value.mergeQueueRequired,
              turbineGateRequired: value.requiredStatuses.includes('turbine/gate'),
            },
          };
        }
        const token = resolveToken(config);
        if (!token) throw err('E_ADAPTER', 'GitHub token missing (GITHUB_TOKEN)');
        const api = httpsApiBase(config);
        const headers = liveHeaders(token);
        const list = await fetch(`${api}/repos/${owner}/${repo}/rulesets?includes_parents=true`, { headers, ...liveFetchInit() });
        if (!list.ok) return { data: { status: 'unknown', reason: `rulesets read failed: ${list.status}` } };
        const summaries = (await list.json()) as Array<{ id: number; enforcement?: string }>;
        let mergeQueueRequired = false;
        let turbineGateRequired = false;
        for (const summary of summaries.filter((entry) => entry.enforcement === 'active')) {
          const detail = await fetch(`${api}/repos/${owner}/${repo}/rulesets/${summary.id}`, { headers, ...liveFetchInit() });
          if (!detail.ok) return { data: { status: 'unknown', reason: `ruleset ${summary.id} read failed: ${detail.status}` } };
          const ruleset = (await detail.json()) as {
            conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
            rules?: Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>;
          };
          const includes = ruleset.conditions?.ref_name?.include ?? [];
          const excludes = ruleset.conditions?.ref_name?.exclude ?? [];
          const branchRef = `refs/heads/${branch}`;
          if (
            !includes.some((ref) => ref === branchRef || ref === '~DEFAULT_BRANCH' || ref === '~ALL') ||
            excludes.some((ref) => ref === branchRef || ref === '~DEFAULT_BRANCH' || ref === '~ALL')
          ) continue;
          mergeQueueRequired ||= ruleset.rules?.some((rule) => rule.type === 'merge_queue') ?? false;
          turbineGateRequired ||= ruleset.rules?.some(
            (rule) =>
              rule.type === 'required_status_checks' &&
              rule.parameters?.required_status_checks?.some((check) => check.context === 'turbine/gate'),
          ) ?? false;
        }
        return { data: { status: 'confirmed', mergeQueueRequired, turbineGateRequired } };
      }

      if (capability === 'pr.create') {
        const head = String(args.head ?? '');
        const headSha = String(args.headSha ?? '');
        const base = String(args.base ?? '');
        const title = String(args.title ?? '');
        const body = String(args.body ?? '');
        if (!head || !headSha || !base || !title) throw err('E_ADAPTER', 'PR head, headSha, base, and title are required');
        if (config.fixtures) {
          const list = (config.fixtures.pullRequests ??= {})[repoKey] ??= [];
          const existing = list.find((pr) => pr.head === head && pr.state === 'open');
          if (existing) return { data: existing, externalOperationId: String(existing.number) };
          const number = Math.max(0, ...list.map((pr) => pr.number)) + 1;
          const created: GitHubPullRequest = {
            number,
            nodeId: `PR_${number}`,
            url: `https://github.com/${repoKey}/pull/${number}`,
            head,
            headSha,
            base,
            state: 'open',
          };
          list.push(created);
          return { data: created, externalOperationId: String(number) };
        }
        const open = await liveJson(
          config,
          `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
          'GET',
        ) as Array<{ number: number; node_id: string; html_url: string; head: { sha: string; ref: string }; base: { ref: string } }>;
        const existing = open[0];
        if (existing) {
          return {
            data: {
              number: existing.number,
              nodeId: existing.node_id,
              url: existing.html_url,
              head: existing.head.ref,
              headSha: existing.head.sha,
              base: existing.base.ref,
              state: 'open',
            },
            externalOperationId: String(existing.number),
          };
        }
        const json = await liveJson(config, `/repos/${owner}/${repo}/pulls`, 'POST', { title, head, base, body }) as {
          number: number; node_id: string; html_url: string; head: { sha: string; ref: string }; base: { ref: string };
        };
        return {
          data: { number: json.number, nodeId: json.node_id, url: json.html_url, head: json.head.ref, headSha: json.head.sha, base: json.base.ref, state: 'open' },
          externalOperationId: String(json.number),
        };
      }

      const number = Number(args.number ?? args.issueNumber);
      if ((capability === 'pr.read' || capability === 'pr.merge') && (!Number.isInteger(number) || number <= 0)) {
        throw err('E_ADAPTER', 'positive PR number is required');
      }

      if (capability === 'commit.status') {
        const sha = String(args.sha ?? '');
        const state = String(args.state ?? '');
        const context = String(args.context ?? '');
        if (!sha || !['pending', 'success', 'failure'].includes(state) || !context) throw err('E_ADAPTER', 'valid status sha, state, and context are required');
        if (config.fixtures) {
          const list = (config.fixtures.statuses ??= {})[`${repoKey}@${sha}`] ??= [];
          list.push({ context, state: state as 'pending' | 'success' | 'failure', description: args.description == null ? undefined : String(args.description) });
          return { data: { sha, state, context } };
        }
        const data = await liveJson(config, `/repos/${owner}/${repo}/statuses/${encodeURIComponent(sha)}`, 'POST', {
          state,
          context,
          description: args.description,
        });
        return { data };
      }

      if (capability === 'pr.merge') {
        if (config.fixtures) {
          const pr = config.fixtures.pullRequests?.[repoKey]?.find((entry) => entry.number === number);
          if (!pr) throw err('E_ADAPTER', `fixture PR #${number} not found`);
          pr.mergeQueueState = 'queued';
          return { data: { number, queueState: 'queued' } };
        }
        const nodeId = String(args.nodeId ?? '');
        if (!nodeId) throw err('E_ADAPTER', 'PR nodeId is required for auto-merge');
        const data = await liveGraphql(
          config,
          `mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{number}}}`,
          { id: nodeId },
        );
        return { data };
      }

      if (capability === 'pr.read') {
        if (config.fixtures) {
          const pr = config.fixtures.pullRequests?.[repoKey]?.find((entry) => entry.number === number);
          if (!pr) throw err('E_ADAPTER', `fixture PR #${number} not found`);
          return { data: { ...pr } };
        }
        const json = await liveJson(config, `/repos/${owner}/${repo}/pulls/${number}`, 'GET') as {
          number: number; node_id: string; html_url: string; state: string; merged: boolean; merged_at?: string; merge_commit_sha?: string;
          head: { sha: string; ref: string }; base: { ref: string };
        };
        return {
          data: {
            number: json.number,
            nodeId: json.node_id,
            url: json.html_url,
            head: json.head.ref,
            headSha: json.head.sha,
            base: json.base.ref,
            state: json.merged ? 'merged' : json.state,
            mergedAt: json.merged_at,
            mergeSha: json.merge_commit_sha,
          },
        };
      }

      if (capability !== 'issue.comment' && capability !== 'issue.read') {
        throw err('E_MISSING_CAPABILITY', `GitHub adapter does not support ${capability}`);
      }
      if (!Number.isInteger(number) || number <= 0) {
        throw err('E_ADAPTER', 'GitHub issue number is required');
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
      let commentId = args.commentId != null ? String(args.commentId) : undefined;
      const marker = body.match(MARKER_RE)?.[0];

      if (config.fixtures) {
        const list = (fixtureComments[key] ??= []);
        if (!commentId && marker) {
          commentId = list.find((c) => c.body.includes(marker))?.id;
        }
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

      if (!commentId && marker) {
        const listRes = await fetch(`${api}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`, {
          method: 'GET',
          headers,
          ...liveFetchInit(),
        });
        if (listRes.ok) {
          const comments = (await listRes.json()) as Array<{ id: number; body: string }>;
          const hit = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
          if (hit) commentId = String(hit.id);
        }
      }

      if (commentId) {
        const res = await fetch(`${api}/repos/${owner}/${repo}/issues/comments/${encodeURIComponent(commentId)}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body }),
          ...liveFetchInit(),
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
        ...liveFetchInit(),
      });
      if (!res.ok) throw err('E_ADAPTER', `GitHub comment create failed: ${res.status} ${res.statusText}`);
      // Prefer Location header id if JSON decode fails after a successful create.
      const locationId = res.headers.get('location')?.match(/\/comments\/(\d+)\s*$/)?.[1];
      try {
        const json = (await res.json()) as { id: number; body: string };
        return { data: { id: String(json.id), body: json.body, created: true }, externalOperationId: String(json.id) };
      } catch (e) {
        if (locationId) {
          return { data: { id: locationId, body, created: true }, externalOperationId: locationId };
        }
        throw e;
      }
    },
  };
}

function liveHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function liveJson(config: GitHubConfig, path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const token = resolveToken(config);
  if (!token) throw err('E_ADAPTER', 'GitHub token missing (GITHUB_TOKEN)');
  const response = await fetch(`${httpsApiBase(config)}${path}`, {
    method,
    headers: liveHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...liveFetchInit(),
  });
  if (!response.ok) throw err('E_ADAPTER', `GitHub ${method} ${path} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function liveGraphql(config: GitHubConfig, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const token = resolveToken(config);
  if (!token) throw err('E_ADAPTER', 'GitHub token missing (GITHUB_TOKEN)');
  const response = await fetch(`${httpsApiBase(config).replace(/\/api\/v3$/, '/api')}/graphql`, {
    method: 'POST',
    headers: liveHeaders(token),
    body: JSON.stringify({ query, variables }),
    ...liveFetchInit(),
  });
  if (!response.ok) throw err('E_ADAPTER', `GitHub GraphQL failed: ${response.status} ${response.statusText}`);
  const json = await response.json() as { data?: unknown; errors?: Array<{ message?: string }> };
  if (json.errors?.length) throw err('E_ADAPTER', `GitHub GraphQL failed: ${json.errors.map((entry) => entry.message).join('; ')}`);
  return json.data;
}

/** List fixture comments for tests. */
export function listFixtureComments(config: GitHubConfig, owner: string, repo: string, number: number): GitHubComment[] {
  return [...(config.fixtures?.comments?.[issueKey(owner, repo, number)] ?? [])];
}
