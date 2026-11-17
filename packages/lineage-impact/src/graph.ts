import type { ArtifactDependencyEdge } from '@turbine-hall/turbine-contracts';
import { createId, err } from '@turbine-hall/turbine-contracts';

export function createEdge(input: {
  workId: string;
  upstreamArtifactId: string;
  upstreamRevisionHash: string;
  downstreamArtifactId: string;
  downstreamRevisionHash: string;
  reason: string;
  affectedObligationIds: string[];
}): ArtifactDependencyEdge {
  return {
    id: createId('edge'),
    ...input,
  };
}

export function assertAcyclic(edges: ArtifactDependencyEdge[]): void {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.upstreamArtifactId) ?? [];
    list.push(e.downstreamArtifactId);
    adj.set(e.upstreamArtifactId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(node: string): void {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      throw err('E_INVALID_CONFIG', `Dependency cycle detected at ${node}`);
    }
    visiting.add(node);
    for (const next of adj.get(node) ?? []) dfs(next);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of adj.keys()) dfs(node);
}

export function transitiveDownstream(
  edges: ArtifactDependencyEdge[],
  changedArtifactId: string,
): {
  artifactIds: string[];
  obligationIds: string[];
  unknown: boolean;
} {
  assertAcyclic(edges);
  const byUpstream = new Map<string, ArtifactDependencyEdge[]>();
  for (const e of edges) {
    const list = byUpstream.get(e.upstreamArtifactId) ?? [];
    list.push(e);
    byUpstream.set(e.upstreamArtifactId, list);
  }

  const artifactIds = new Set<string>();
  const obligationIds = new Set<string>();
  const queue = [changedArtifactId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of byUpstream.get(current) ?? []) {
      if (!artifactIds.has(edge.downstreamArtifactId)) {
        artifactIds.add(edge.downstreamArtifactId);
        queue.push(edge.downstreamArtifactId);
      }
      for (const oid of edge.affectedObligationIds) obligationIds.add(oid);
    }
  }

  // Conservative: if changed artifact has no outgoing edges but there are downstream
  // obligation kinds that typically depend on it, callers mark unknown.
  const unknown = edges.length === 0;
  return {
    artifactIds: [...artifactIds],
    obligationIds: [...obligationIds],
    unknown,
  };
}

/** Which artifact types are expected downstream of each type (framework §3.2 minimum lineage). */
export const EXPECTED_DOWNSTREAM: Record<string, string[]> = {
  source: ['specification'],
  specification: ['plan'],
  plan: ['change-report'],
  'change-report': ['review', 'test-report'],
};

export type GraphImpact = {
  /** Artifacts reachable from the changed one (excluding it). */
  artifactIds: string[];
  /** Decisions bound to the changed artifact or anything downstream of it. */
  decisionIds: string[];
  obligationIds: string[];
  /** True when a downstream artifact exists that the graph cannot reach (missing edge). */
  unknown: boolean;
  missing: Array<{ artifactId: string; type: string }>;
};

/**
 * Impact by walking explicit edges (framework §3.2–3.3). If an artifact of an expected
 * downstream type was created after the changed artifact but is not reachable, a link is
 * missing: impact is UNKNOWN and callers must fall back to conservative invalidation.
 */
export function graphImpact(input: {
  edges: ArtifactDependencyEdge[];
  artifacts: Array<{ id: string; type: string; createdAt: string }>;
  decisions: Array<{ id: string; gate: string; artifactIds: string[]; invalidatedAt?: string }>;
  changedArtifactId: string;
}): GraphImpact {
  const down = transitiveDownstream(input.edges, input.changedArtifactId);
  const reach = new Set([input.changedArtifactId, ...down.artifactIds]);
  const changed = input.artifacts.find((a) => a.id === input.changedArtifactId);
  const missing: GraphImpact['missing'] = [];
  if (changed) {
    // Every artifact of a downstream type created after the changed revision derives from it,
    // so it must be reachable. Walk the expected chain transitively.
    const types = new Set<string>();
    const queue = [...(EXPECTED_DOWNSTREAM[changed.type] ?? [])];
    while (queue.length) {
      const t = queue.shift()!;
      if (types.has(t)) continue;
      types.add(t);
      queue.push(...(EXPECTED_DOWNSTREAM[t] ?? []));
    }
    for (const type of types) {
      const later = input.artifacts.filter(
        (a) => a.type === type && a.id !== changed.id && a.createdAt >= changed.createdAt,
      );
      if (later.length && !later.some((a) => reach.has(a.id))) {
        missing.push(...later.map((a) => ({ artifactId: a.id, type })));
      }
    }
  }
  const decisionIds = input.decisions
    .filter((d) => !d.invalidatedAt && d.gate !== 'exception' && d.artifactIds.some((id) => reach.has(id)))
    .map((d) => d.id);
  return { artifactIds: down.artifactIds, decisionIds, obligationIds: down.obligationIds, unknown: missing.length > 0, missing };
}
