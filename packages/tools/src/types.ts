export type Capability =
  | 'issue.read'
  | 'issue.comment'
  | 'issue.edit'
  | 'issue.transition'
  | 'repo.inspect'
  | 'repo.read'
  | 'workspace.write'
  | 'git.diff'
  | 'git.branch.create'
  | 'pr.create'
  | 'pr.review.read'
  | 'tests.run'
  | 'ci.read'
  | 'secrets.read_ref';

export interface ToolAdapter {
  id: string;
  capabilities: Capability[];
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
  invoke(input: {
    capability: Capability;
    workId: string;
    arguments: Record<string, unknown>;
    correlationId: string;
  }): Promise<{ data: unknown; externalOperationId?: string }>;
}
