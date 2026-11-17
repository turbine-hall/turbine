import { createId, err } from '@turbine-hall/turbine-contracts';
import type { Capability, ToolAdapter } from './types.js';

export class ToolBroker {
  private adapters = new Map<string, ToolAdapter>();
  private allow: Set<Capability>;
  private deny: Set<Capability>;

  constructor(input?: { allow?: string[]; deny?: string[] }) {
    this.allow = new Set((input?.allow ?? []) as Capability[]);
    this.deny = new Set((input?.deny ?? []) as Capability[]);
  }

  register(adapter: ToolAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  list(): ToolAdapter[] {
    return [...this.adapters.values()];
  }

  async invoke(input: {
    adapterId?: string;
    capability: Capability;
    workId: string;
    arguments: Record<string, unknown>;
    grants: Capability[];
  }): Promise<{ data: unknown; externalOperationId?: string; correlationId: string }> {
    if (this.deny.has(input.capability)) {
      throw err('E_MISSING_CAPABILITY', `Capability denied by policy: ${input.capability}`);
    }
    if (this.allow.size > 0 && !this.allow.has(input.capability)) {
      throw err('E_MISSING_CAPABILITY', `Capability not in allowlist: ${input.capability}`);
    }
    if (!input.grants.includes(input.capability)) {
      throw err(
        'E_MISSING_CAPABILITY',
        `Capability ${input.capability} was not granted for this run`,
      );
    }

    const adapter =
      (input.adapterId ? this.adapters.get(input.adapterId) : undefined) ??
      [...this.adapters.values()].find((a) => a.capabilities.includes(input.capability));

    if (!adapter) {
      throw err(
        'E_MISSING_CAPABILITY',
        `No tool adapter provides capability ${input.capability}`,
      );
    }

    const correlationId = createId('corr');
    const result = await adapter.invoke({
      capability: input.capability,
      workId: input.workId,
      arguments: input.arguments,
      correlationId,
    });
    return { ...result, correlationId };
  }
}
