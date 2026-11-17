import { err } from '@turbine-hall/turbine-contracts';
import { createMockModelAdapter } from './mock.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';
import type { ModelAdapter } from './types.js';

const adapters = new Map<string, ModelAdapter>();

export function registerModel(adapter: ModelAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function ensureDefaultMock(): ModelAdapter {
  const existing = adapters.get('mock-default');
  if (existing) return existing;
  const mock = createMockModelAdapter('mock-default');
  registerModel(mock);
  return mock;
}

export function configureModelsFromProfiles(
  profiles: Record<string, { provider: string; model: string; maxOutputTokens?: number }>,
): void {
  ensureDefaultMock();
  for (const profile of Object.values(profiles)) {
    if (profile.provider === 'mock') {
      registerModel(createMockModelAdapter(profile.model));
      continue;
    }
    if (profile.provider === 'openai' || profile.provider === 'openai-compatible') {
      registerModel(
        createOpenAICompatibleAdapter({
          id: profile.model,
          model: profile.model,
        }),
      );
      continue;
    }
    // Unknown provider: keep discoverable but fail on use unless registered later
    if (!adapters.has(profile.model)) {
      registerModel(
        createOpenAICompatibleAdapter({
          id: profile.model,
          model: profile.model,
        }),
      );
    }
  }
}

export function getModel(id: string): ModelAdapter {
  ensureDefaultMock();
  const adapter = adapters.get(id);
  if (!adapter) throw err('E_NOT_FOUND', `Model not found: ${id}. Run turbine model add / check project.yaml`);
  return adapter;
}

export function listModels(): ModelAdapter[] {
  ensureDefaultMock();
  return [...adapters.values()];
}

export async function testModel(id: string): Promise<{ ok: boolean; details: string; content?: unknown }> {
  const model = getModel(id);
  const result = await model.run({
    workId: 'test',
    roleId: 'requirements-analyst',
    skillIds: [],
    prompt: 'healthcheck',
    schemaId: 'healthcheck',
    maxOutputTokens: 256,
    budgetId: 'test',
  });
  return {
    ok: !!result.content,
    details: `provider=${model.provider} id=${model.id} request=${result.providerRequestId ?? 'n/a'}`,
    content: result.content,
  };
}
