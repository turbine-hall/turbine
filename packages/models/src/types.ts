export interface ModelAdapter {
  id: string;
  provider: string;
  capabilities: {
    text: boolean;
    structuredOutput: boolean;
    toolCalling: boolean;
    maxContextTokens?: number;
  };
  run(request: {
    workId: string;
    roleId: string;
    skillIds: string[];
    prompt: string;
    schemaId: string;
    maxOutputTokens: number;
    budgetId: string;
  }): Promise<{
    content: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
    providerRequestId?: string;
  }>;
}
