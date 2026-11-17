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

export type JiraConfig = {
  siteUrl: string;
  email?: string;
  apiToken?: string;
  /** Fixture mode for offline tests */
  fixtures?: Record<string, JiraIssue>;
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

export function createJiraAdapter(config: JiraConfig): ToolAdapter {
  return {
    id: 'jira',
    capabilities: ['issue.read'] as Capability[],
    async healthCheck() {
      if (config.fixtures) return { ok: true, details: 'fixture-mode' };
      if (!config.siteUrl || !config.apiToken || !config.email) {
        return { ok: false, details: 'Missing Jira siteUrl/email/apiToken' };
      }
      return { ok: true, details: `configured for ${config.siteUrl}` };
    },
    async invoke({ capability, arguments: args }) {
      if (capability !== 'issue.read') {
        throw err('E_MISSING_CAPABILITY', `Jira adapter does not support ${capability}`);
      }
      const key = String(args.key ?? '');
      if (!key) throw err('E_ADAPTER', 'Jira issue key required');

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
      const url = `${config.siteUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
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
    },
  };
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
