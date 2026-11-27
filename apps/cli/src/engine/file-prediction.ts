import { err } from '@turbine-hall/turbine-contracts';
import type { WorkStore } from '@turbine-hall/turbine-storage-sqlite';
import { normalizePlan } from './docs/normalize.js';

/**
 * Predicted files for fleet admit-time conflict checks.
 * Always a selection (or unknown) — never claimed complete (AGENTS.md rule 3).
 */
export type FilePrediction =
  | {
      kind: 'selection';
      /** Repo-relative paths; may be empty when both sources were readable but named nothing. */
      paths: string[];
      sources: { context: boolean; plan: boolean };
      labelled: 'selection';
      at: string;
    }
  | {
      kind: 'unknown';
      reason: string;
      labelled: 'selection';
      at: string;
    };

export type PredictionMiss = {
  predicted: string[];
  actual: string[];
  extras: string[];
  misses: string[];
  at: string;
};

function normalizePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  const colon = trimmed.indexOf(':');
  let path =
    colon > 0 && /^[a-z0-9._-]+$/i.test(trimmed.slice(0, colon))
      ? trimmed.slice(colon + 1)
      : trimmed;
  path = path.replace(/\/+/g, '/').replace(/^\.\//, '');
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

function readArtifactJson(store: WorkStore, art: { id: string }): unknown {
  let raw: string;
  try {
    raw = store.getArtifactContent(art.id);
  } catch (e) {
    throw err(
      'E_UNSAFE_EXECUTION',
      `file-prediction: unreadable artifact ${art.id}: ${(e as Error).message.split('\n')[0]}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw err(
      'E_UNSAFE_EXECUTION',
      `file-prediction: corrupt artifact ${art.id}: ${(e as Error).message.split('\n')[0]}`,
    );
  }
}

/** Build a prediction from the latest repo-context + plan artifacts (fail closed on corrupt reads). */
export function buildFilePrediction(store: WorkStore, workId: string, at = new Date().toISOString()): FilePrediction {
  let contextPaths: string[] | undefined;
  let planPaths: string[] | undefined;
  let contextPresent = false;
  let planPresent = false;

  const ctxArt = store.getLatestArtifact(workId, 'repo-context');
  if (ctxArt) {
    contextPresent = true;
    const content = readArtifactJson(store, ctxArt);
    const files = (content as { files?: Array<{ path?: string }> })?.files;
    if (!Array.isArray(files)) {
      return { kind: 'unknown', reason: 'repo-context missing files array', labelled: 'selection', at };
    }
    contextPaths = [
      ...new Set(files.map((f) => (typeof f?.path === 'string' ? normalizePath(f.path) : '')).filter(Boolean)),
    ].sort();
  }

  const planArt = store.getLatestArtifact(workId, 'plan');
  if (planArt) {
    planPresent = true;
    const content = readArtifactJson(store, planArt);
    // Fail closed: a missing/non-array steps field is not an empty selection (AGENTS.md rule 3).
    if (
      content === null ||
      typeof content !== 'object' ||
      !('steps' in (content as object)) ||
      !Array.isArray((content as { steps?: unknown }).steps)
    ) {
      return {
        kind: 'unknown',
        reason: 'plan artifact missing steps array',
        labelled: 'selection',
        at,
      };
    }
    const plan = normalizePlan(content);
    planPaths = [...new Set(plan.steps.flatMap((s) => s.files.map(normalizePath)).filter(Boolean))].sort();
  }

  if (!contextPresent && !planPresent) {
    return {
      kind: 'unknown',
      reason: 'no repo-context or plan artifact to derive a selection',
      labelled: 'selection',
      at,
    };
  }

  const paths = [...new Set([...(contextPaths ?? []), ...(planPaths ?? [])])].sort();
  return {
    kind: 'selection',
    paths,
    sources: { context: contextPresent, plan: planPresent },
    labelled: 'selection',
    at,
  };
}

/** Parse a stored file-prediction artifact; fail closed on corrupt/unknown shape. */
export function parseFilePrediction(content: unknown): FilePrediction {
  if (!content || typeof content !== 'object') {
    throw err('E_UNSAFE_EXECUTION', 'file-prediction artifact is not an object');
  }
  const c = content as FilePrediction;
  if (c.kind === 'selection') {
    if (!Array.isArray(c.paths) || c.labelled !== 'selection') {
      throw err('E_UNSAFE_EXECUTION', 'file-prediction selection has invalid paths/label');
    }
    // Empty array is a valid empty selection; blank/non-string entries are corrupt (fail closed).
    const paths: string[] = [];
    for (const raw of c.paths) {
      if (typeof raw !== 'string') {
        throw err('E_UNSAFE_EXECUTION', 'file-prediction selection path is not a string');
      }
      const path = normalizePath(raw);
      if (!path) {
        throw err('E_UNSAFE_EXECUTION', 'file-prediction selection path is empty after normalize');
      }
      paths.push(path);
    }
    return {
      kind: 'selection',
      paths: [...new Set(paths)].sort(),
      sources: {
        context: Boolean(c.sources?.context),
        plan: Boolean(c.sources?.plan),
      },
      labelled: 'selection',
      at: typeof c.at === 'string' ? c.at : new Date(0).toISOString(),
    };
  }
  if (c.kind === 'unknown') {
    if (typeof c.reason !== 'string' || c.labelled !== 'selection') {
      throw err('E_UNSAFE_EXECUTION', 'file-prediction unknown has invalid reason/label');
    }
    return {
      kind: 'unknown',
      reason: c.reason,
      labelled: 'selection',
      at: typeof c.at === 'string' ? c.at : new Date(0).toISOString(),
    };
  }
  throw err('E_UNSAFE_EXECUTION', 'file-prediction artifact has unknown kind');
}

/** Load latest prediction; missing → unknown (not yet recorded). Corrupt → throw (fail closed). */
export function readFilePrediction(store: WorkStore, workId: string): FilePrediction {
  const art = store.getLatestArtifact(workId, 'file-prediction');
  if (!art) {
    return {
      kind: 'unknown',
      reason: 'no file-prediction artifact recorded',
      labelled: 'selection',
      at: new Date().toISOString(),
    };
  }
  return parseFilePrediction(readArtifactJson(store, art));
}

export function predictionsConflict(a: FilePrediction, b: FilePrediction): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  const setB = new Set(b.paths);
  return a.paths.some((p) => setB.has(p));
}

/** True when candidate may not join the given active predictions. */
export function blocksAdmit(candidate: FilePrediction, active: FilePrediction[]): boolean {
  if (active.length === 0) return false;
  return active.some((a) => predictionsConflict(candidate, a));
}

export function comparePredictionToActual(predicted: string[], actual: string[]): PredictionMiss {
  const pred = new Set(predicted.map(normalizePath));
  const act = new Set(actual.map(normalizePath));
  const misses = [...pred].filter((p) => !act.has(p)).sort();
  const extras = [...act].filter((p) => !pred.has(p)).sort();
  return {
    predicted: [...pred].sort(),
    actual: [...act].sort(),
    extras,
    misses,
    at: new Date().toISOString(),
  };
}

export function actualPathsFromChangeReport(content: unknown): string[] {
  if (!content || typeof content !== 'object') {
    throw err('E_UNSAFE_EXECUTION', 'change-report is not an object');
  }
  const filesTouched = (content as { filesTouched?: unknown }).filesTouched;
  if (!Array.isArray(filesTouched)) {
    throw err('E_UNSAFE_EXECUTION', 'change-report missing filesTouched array');
  }
  return [
    ...new Set(filesTouched.map((f) => (typeof f === 'string' ? normalizePath(f) : '')).filter(Boolean)),
  ].sort();
}
