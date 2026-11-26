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
  /** Identity of the newest merge-queue removal GitHub shows; an ejection counts only if it is a new one. */
  queueRemovalId?: string;
  /**
   * Whether the merge-queue history behind `mergeQueueState` / `queueRemovalId` could be read. Absent history
   * proves "no removal" only when this is true; an unreadable history proves nothing.
   */
  queueStateKnown?: boolean;
  /** Fixture only: enqueueing is refused with this reason (the PR is not ready for the queue). */
  queueRejection?: string;
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

const RULES_PAGE_SIZE = 100;
const MAX_RULE_PAGES = 10;

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
        // GitHub evaluates the exact branch itself ("Get rules for a branch"): every active ruleset that
        // applies, including parent/org rulesets, ~DEFAULT_BRANCH and fnmatch patterns. Never re-derive that locally.
        const rules: unknown[] = [];
        for (let page = 1; ; page++) {
          if (page > MAX_RULE_PAGES) return { data: { status: 'unknown', reason: `rules for ${branch} exceed ${MAX_RULE_PAGES} pages` } };
          const res = await fetch(
            `${api}/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=${RULES_PAGE_SIZE}&page=${page}`,
            { headers, ...liveFetchInit() },
          );
          if (!res.ok) return { data: { status: 'unknown', reason: `branch rules read failed: ${res.status}` } };
          const body = (await res.json()) as unknown;
          if (!Array.isArray(body)) return { data: { status: 'unknown', reason: 'branch rules response was not a list' } };
          rules.push(...body);
          if (body.length < RULES_PAGE_SIZE) break;
        }
        let mergeQueueRequired = false;
        let turbineGateRequired = false;
        for (const rule of rules) {
          const entry = rule as { type?: unknown; parameters?: { required_status_checks?: unknown } } | null;
          if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
            return { data: { status: 'unknown', reason: 'branch rules response contained an unreadable rule' } };
          }
          if (entry.type === 'merge_queue') mergeQueueRequired = true;
          if (entry.type === 'required_status_checks') {
            const checks = entry.parameters?.required_status_checks;
            if (!Array.isArray(checks)) return { data: { status: 'unknown', reason: 'a required_status_checks rule had unreadable parameters' } };
            if (checks.some((check) => (check as { context?: unknown } | null)?.context === 'turbine/gate')) turbineGateRequired = true;
          }
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
          const existing = list.find((pr) => pr.head === head && pr.base === base && pr.state === 'open');
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
        // Queue-only: the PR is added to the merge queue, which merges it. There is no direct merge, no admin
        // bypass and no ordinary auto-merge fallback (that would land without the queue's own checks).
        if (args.mode !== 'queue-only') throw err('E_ADAPTER', 'pr.merge only supports mode "queue-only"');
        // GitHub enforces this: the PR is enqueued for exactly the accepted head, never a head pushed meanwhile.
        const expectedHeadOid = String(args.expectedHeadOid ?? '');
        if (!expectedHeadOid) throw err('E_ADAPTER', 'expectedHeadOid is required to enqueue a pull request');
        if (config.fixtures) {
          const pr = config.fixtures.pullRequests?.[repoKey]?.find((entry) => entry.number === number);
          if (!pr) throw err('E_ADAPTER', `fixture PR #${number} not found`);
          if (pr.headSha !== expectedHeadOid) {
            throw err('E_ADAPTER', `fixture PR #${number} head ${pr.headSha} is not the expected head ${expectedHeadOid}`);
          }
          if (pr.queueRejection) throw err('E_ADAPTER', `GitHub did not enqueue PR #${number}: ${pr.queueRejection}`);
          pr.mergeQueueState = 'queued';
          return { data: { number, queueState: 'queued' } };
        }
        const nodeId = String(args.nodeId ?? '');
        if (!nodeId) throw err('E_ADAPTER', 'PR nodeId is required to enqueue a pull request');
        // `enqueuePullRequest` (GraphQL, "Add a pull request to the merge queue") takes the PR node id and an
        // optional expectedHeadOid; it fails when the repository has no merge queue or the PR is not ready.
        const data = (await liveGraphql(
          config,
          `mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id}}}`,
          { id: nodeId, oid: expectedHeadOid },
        )) as { enqueuePullRequest?: { mergeQueueEntry?: { id?: string } | null } | null } | null;
        const entryId = data?.enqueuePullRequest?.mergeQueueEntry?.id;
        // No entry means GitHub did not queue it: fail closed so the landing stays retryable.
        if (!entryId) throw err('E_ADAPTER', `GitHub did not return a merge-queue entry for PR #${number}`);
        return { data: { number, queueState: 'queued', mergeQueueEntryId: entryId } };
      }

      if (capability === 'pr.read') {
        if (config.fixtures) {
          const pr = config.fixtures.pullRequests?.[repoKey]?.find((entry) => entry.number === number);
          if (!pr) throw err('E_ADAPTER', `fixture PR #${number} not found`);
          return { data: { queueStateKnown: true, ...pr } };
        }
        const json = await liveJson(config, `/repos/${owner}/${repo}/pulls/${number}`, 'GET') as {
          number: number; node_id: string; html_url: string; state: string; merged: boolean; merged_at?: string; merge_commit_sha?: string;
          head: { sha: string; ref: string }; base: { ref: string };
        };
        const state = json.merged ? 'merged' : json.state;
        return {
          data: {
            number: json.number,
            nodeId: json.node_id,
            url: json.html_url,
            head: json.head.ref,
            headSha: json.head.sha,
            base: json.base.ref,
            state,
            mergedAt: json.merged_at,
            mergeSha: json.merge_commit_sha,
            ...(state === 'open' ? await liveQueueState(config, json.node_id) : {}),
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

/**
 * Merge-queue state from GitHub itself. Ejected needs the newest queue event to be a removal with a reason;
 * `queueRemovalId` names the newest removal so callers can tell an old removal from the current attempt's.
 * `queueStateKnown` is false when the history could not be read at all: then nothing else is reported, and the
 * absence of a removal id proves nothing (a caller needing a removal baseline must fail closed).
 */
async function liveQueueState(
  config: GitHubConfig,
  nodeId: string,
): Promise<{ mergeQueueState?: 'queued' | 'ejected'; queueReason?: string; queueRemovalId?: string; queueStateKnown: boolean }> {
  try {
    const data = (await liveGraphql(
      config,
      `query($id:ID!){node(id:$id){... on PullRequest{mergeQueueEntry{id} timelineItems(last:10,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ... on RemovedFromMergeQueueEvent{id reason}}}}}}`,
      { id: nodeId },
    )) as { node?: { mergeQueueEntry?: { id: string } | null; timelineItems?: { nodes?: Array<{ __typename?: string; id?: string; reason?: string | null }> } } | null };
    if (!data?.node || !Array.isArray(data.node.timelineItems?.nodes)) return { queueStateKnown: false };
    const nodes = data.node.timelineItems.nodes;
    const lastRemoval = [...nodes].reverse().find((node) => node.__typename === 'RemovedFromMergeQueueEvent' && node.id);
    const queueRemovalId = lastRemoval?.id;
    if (data.node.mergeQueueEntry) return { queueStateKnown: true, mergeQueueState: 'queued', ...(queueRemovalId ? { queueRemovalId } : {}) };
    const last = nodes.at(-1);
    const reason = last?.reason?.trim();
    if (last?.__typename === 'RemovedFromMergeQueueEvent' && last.id && reason) {
      return { queueStateKnown: true, mergeQueueState: 'ejected', queueReason: reason, queueRemovalId: last.id };
    }
    return { queueStateKnown: true, ...(queueRemovalId ? { queueRemovalId } : {}) };
  } catch {
    // Unconfirmed: preserve the recorded state.
  }
  return { queueStateKnown: false };
}

/** List fixture comments for tests. */
export function listFixtureComments(config: GitHubConfig, owner: string, repo: string, number: number): GitHubComment[] {
  return [...(config.fixtures?.comments?.[issueKey(owner, repo, number)] ?? [])];
}
