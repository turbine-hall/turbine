import { err } from '@turbine-hall/turbine-contracts';
import type { Capability, ToolAdapter } from '@turbine-hall/turbine-tools';

export type JiraIssue = {
  key: string;
  id: string;
  summary: string;
  description: string;
  issueType: string;
  priority?: string;
  status: string;
  labels: string[];
  assignee?: string;
  updatedAt: string;
  url: string;
  acceptanceCriteria?: string[];
};

export type JiraComment = {
  id: string;
  body: string;
  issueKey: string;
  updatedAt: string;
};

export type JiraConfig = {
  siteUrl: string;
  email?: string;
  apiToken?: string;
  /** Fixture mode for offline tests */
  fixtures?: Record<string, JiraIssue>;
  /** Fixture comment store keyed by issue key */
  commentFixtures?: Record<string, JiraComment[]>;
};

function adfToText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (typeof node === 'object') {
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.text) return n.text;
    const inner = (n.content ?? []).map(adfToText).join('');
    if (n.type === 'paragraph' || n.type === 'heading') return `${inner}\n`;
    return inner;
  }
  return '';
}

function textToAdf(body: string): unknown {
  const paragraphs = body.split(/\n\n+/).map((paragraph) => paragraph.trimEnd());
  const content = paragraphs
    .filter((paragraph, i, arr) => paragraph.length > 0 || (i > 0 && i < arr.length - 1))
    .map((paragraph) =>
      paragraph.length > 0
        ? { type: 'paragraph', content: [{ type: 'text', text: paragraph }] }
        : { type: 'paragraph', content: [] },
    );
  return {
    type: 'doc',
    version: 1,
    content: content.length > 0 ? content : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }],
  };
}

function httpsSiteBase(siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) {
    throw err('E_ADAPTER', `Jira siteUrl must be https (got ${base})`);
  }
  return base;
}

export function createJiraAdapter(config: JiraConfig): ToolAdapter {
  const commentFixtures = config.commentFixtures ?? {};

  return {
    id: 'jira',
    capabilities: ['issue.read', 'issue.comment'] as Capability[],
    async healthCheck() {
      if (config.fixtures) return { ok: true, details: 'fixture-mode' };
      if (!config.siteUrl || !config.apiToken || !config.email) {
        return { ok: false, details: 'Missing Jira siteUrl/email/apiToken' };
      }
      return { ok: true, details: `configured for ${config.siteUrl}` };
    },
    async invoke({ capability, arguments: args }) {
      if (capability !== 'issue.read' && capability !== 'issue.comment') {
        throw err('E_MISSING_CAPABILITY', `Jira adapter does not support ${capability}`);
      }
      const key = String(args.key ?? '');
      if (!key) throw err('E_ADAPTER', 'Jira issue key required');

      if (capability === 'issue.read') {
        if (config.fixtures?.[key]) {
          return { data: config.fixtures[key], externalOperationId: `fixture:${key}` };
        }

        if (!config.siteUrl || !config.apiToken || !config.email) {
          throw err(
            'E_ADAPTER',
            'Jira is not configured. Use `turbine tool connect jira` or provide fixtures for tests.',
          );
        }

        const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
        const url = `${httpsSiteBase(config.siteUrl)}/rest/api/3/issue/${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          throw err('E_ADAPTER', `Jira read failed: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as any;
        const issue: JiraIssue = {
          key: body.key,
          id: body.id,
          summary: body.fields?.summary ?? '',
          description: adfToText(body.fields?.description),
          issueType: body.fields?.issuetype?.name ?? 'Task',
          priority: body.fields?.priority?.name,
          status: body.fields?.status?.name ?? 'Unknown',
          labels: body.fields?.labels ?? [],
          assignee: body.fields?.assignee?.displayName,
          updatedAt: body.fields?.updated ?? new Date().toISOString(),
          url: `${config.siteUrl.replace(/\/$/, '')}/browse/${body.key}`,
        };
        return { data: issue, externalOperationId: body.id };
      }

      // issue.comment
      const bodyText = String(args.body ?? '');
      if (!bodyText) throw err('E_ADAPTER', 'comment body required');
      const commentId = args.commentId != null ? String(args.commentId) : undefined;

      if (config.fixtures || config.commentFixtures) {
        const list = (commentFixtures[key] ??= []);
        if (commentId) {
          const existing = list.find((c) => c.id === commentId);
          if (!existing) throw err('E_ADAPTER', `fixture comment ${commentId} not found on ${key}`);
          existing.body = bodyText;
          existing.updatedAt = new Date().toISOString();
          return { data: { id: existing.id, body: existing.body, created: false }, externalOperationId: existing.id };
        }
        const id = `jrc_${list.length + 1}`;
        const created: JiraComment = { id, body: bodyText, issueKey: key, updatedAt: new Date().toISOString() };
        list.push(created);
        return { data: { id, body: bodyText, created: true }, externalOperationId: id };
      }

      if (!config.siteUrl || !config.apiToken || !config.email) {
        throw err('E_ADAPTER', 'Jira is not configured for comments');
      }
      const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
      const base = httpsSiteBase(config.siteUrl);
      const headers = {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };

      if (commentId) {
        const res = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ body: textToAdf(bodyText) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404) {
          // Sticky comment deleted — fall through to create.
        } else {
          if (!res.ok) throw err('E_ADAPTER', `Jira comment update failed: ${res.status} ${res.statusText}`);
          const json = (await res.json()) as { id: string };
          return { data: { id: json.id, body: bodyText, created: false }, externalOperationId: json.id };
        }
      }

      const res = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: textToAdf(bodyText) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw err('E_ADAPTER', `Jira comment create failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { id: string };
      return { data: { id: json.id, body: bodyText, created: true }, externalOperationId: json.id };
    },
  };
}

export function listJiraFixtureComments(config: JiraConfig, key: string): JiraComment[] {
  return [...(config.commentFixtures?.[key] ?? [])];
}

export function issueToMarkdown(issue: JiraIssue): string {
  return [
    `# ${issue.key}: ${issue.summary}`,
    '',
    `Type: ${issue.issueType}`,
    `Status: ${issue.status}`,
    issue.priority ? `Priority: ${issue.priority}` : '',
    issue.assignee ? `Assignee: ${issue.assignee}` : '',
    '',
    '## Description',
    issue.description || '(empty)',
    '',
    issue.acceptanceCriteria?.length
      ? `## Acceptance Criteria\n${issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
