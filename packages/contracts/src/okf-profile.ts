import { z } from 'zod';
import { GitObjectIdSchema } from './context.js';
import { OKF_VERSION } from './okf.js';

/**
 * Turbine OKF profile `turbine-okf/1`: fixed concept types, folders, naming, required fields,
 * and required body headings (in order). Bundles remain valid OKF; the profile adds structure.
 */

export const TURBINE_OKF_PROFILE = 'turbine-okf/1' as const;

export const TURBINE_OKF_CONCEPT_TYPES = [
  'Turbine Project',
  'Turbine Layout',
  'Turbine Package',
  'Turbine Command',
  'Turbine Convention',
  'Turbine Open Question',
  'Turbine Brief Section',
] as const;
export type TurbineOkfConceptType = (typeof TURBINE_OKF_CONCEPT_TYPES)[number];

export const TurbineOkfConceptTypeSchema = z.enum(TURBINE_OKF_CONCEPT_TYPES);

/** Profile-required extension fields on concepts that cite git objects. */
export const TurbineOkfCommitFieldsSchema = z
  .object({
    'x-turbine-commit': GitObjectIdSchema,
    'x-turbine-blob': GitObjectIdSchema.optional(),
  })
  .passthrough();

export type TurbineOkfConceptProfile = {
  type: TurbineOkfConceptType;
  /** Directory under the bundle root (no trailing slash). Empty string = bundle root. */
  folder: string;
  /**
   * How the concept file is named within `folder`.
   * - `fixed`: use `fixedName` exactly
   * - `encoded`: percent-encode the concept key per OKF §6 / RFC 3986
   */
  naming: 'fixed' | 'encoded';
  fixedName?: string;
  /** Required frontmatter keys (beyond `type`). */
  requiredFields: readonly string[];
  /** Required ATX headings in the body, in order (exact text after `#` / `##` / …). */
  requiredHeadings: readonly string[];
  /** When true, `x-turbine-blob` is required in addition to `x-turbine-commit`. */
  requiresBlob: boolean;
};

export const TURBINE_OKF_PROFILE_CONCEPTS: readonly TurbineOkfConceptProfile[] = [
  {
    type: 'Turbine Project',
    folder: 'project',
    naming: 'fixed',
    fixedName: 'overview.md',
    requiredFields: ['title', 'description', 'generated', 'x-turbine-commit'],
    requiredHeadings: ['Summary', 'Facts'],
    requiresBlob: false,
  },
  {
    type: 'Turbine Layout',
    folder: 'structure',
    naming: 'fixed',
    fixedName: 'layout.md',
    requiredFields: ['title', 'description', 'generated', 'sources', 'x-turbine-commit'],
    requiredHeadings: ['Layout'],
    requiresBlob: false,
  },
  {
    type: 'Turbine Package',
    folder: 'structure/packages',
    naming: 'encoded',
    requiredFields: ['title', 'description', 'generated', 'sources', 'x-turbine-commit', 'x-turbine-blob'],
    requiredHeadings: ['Entry points', 'Scripts', 'Dependencies'],
    requiresBlob: true,
  },
  {
    type: 'Turbine Command',
    folder: 'commands',
    naming: 'encoded',
    requiredFields: ['title', 'description', 'generated', 'sources', 'x-turbine-commit', 'x-turbine-blob'],
    requiredHeadings: ['Command'],
    requiresBlob: true,
  },
  {
    type: 'Turbine Convention',
    folder: 'conventions',
    naming: 'encoded',
    requiredFields: ['title', 'description', 'generated', 'sources', 'x-turbine-commit', 'x-turbine-blob'],
    requiredHeadings: ['Convention'],
    requiresBlob: true,
  },
  {
    type: 'Turbine Open Question',
    folder: 'open-questions',
    naming: 'encoded',
    requiredFields: ['title', 'description', 'generated', 'sources', 'x-turbine-commit'],
    requiredHeadings: ['Question'],
    requiresBlob: false,
  },
  {
    type: 'Turbine Brief Section',
    folder: 'brief',
    naming: 'encoded',
    requiredFields: ['title', 'description', 'generated', 'status', 'x-turbine-commit'],
    requiredHeadings: ['Claims'],
    requiresBlob: false,
  },
] as const;

const byType = new Map(TURBINE_OKF_PROFILE_CONCEPTS.map((c) => [c.type, c]));

export function turbineOkfConceptProfile(type: string): TurbineOkfConceptProfile | undefined {
  return byType.get(type as TurbineOkfConceptType);
}

export function isTurbineOkfConceptType(type: string): type is TurbineOkfConceptType {
  return byType.has(type as TurbineOkfConceptType);
}

/** Basenames reserved by OKF §8 / §9 at every directory depth. */
const OKF_RESERVED_BASENAMES = new Set(['index', 'log']);

/**
 * Percent-encode a concept path segment per OKF §6 / RFC 3986 (spaces and reserved characters).
 * Keeps unreserved characters unescaped. Rejects empty, `.`, `..`, absolute, and leading-dot names
 * at the call site via `assertSafeConceptKey`.
 * Never emits the reserved basenames `index` / `log` (those would collide with OKF reserved files).
 */
export function encodeOkfConceptSegment(name: string): string {
  let enc = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  if (OKF_RESERVED_BASENAMES.has(enc)) {
    // Disambiguate without changing decode of ordinary names: append a percent-encoded marker.
    enc = `${enc}%2Eokf`;
  }
  return enc;
}

/**
 * Validate a concept key before encoding it into a path.
 * Refuses absolute paths, `..`, empty / `.` segments, NUL, backslash, and names that start with `.`
 * (OKF §3.2: a name starting with `.` is outside the bundle).
 */
export function assertSafeConceptKey(key: string): void {
  if (!key || key === '.' || key === '..') throw new Error('concept key must not be empty, ".", or ".."');
  if (key.startsWith('.')) throw new Error('concept key must not start with "." (outside the OKF bundle)');
  if (key.includes('\0') || key.includes('\\')) throw new Error('concept key must not contain NUL or backslash');
  if (key.startsWith('/') || key.includes('/../') || key.endsWith('/..') || key.includes('/./')) {
    throw new Error('concept key must not be an absolute path or contain ".." / "." segments');
  }
  for (const part of key.split('/')) {
    if (!part || part === '.' || part === '..' || part.startsWith('.')) {
      throw new Error(`concept key segment "${part}" is not allowed`);
    }
  }
}

/** Relative path of a concept file inside the bundle (forward slashes). */
export function turbineOkfConceptPath(type: TurbineOkfConceptType, key?: string): string {
  const profile = byType.get(type)!;
  if (profile.naming === 'fixed') {
    return profile.folder ? `${profile.folder}/${profile.fixedName}` : profile.fixedName!;
  }
  if (key === undefined) throw new Error(`concept type ${type} requires a key`);
  assertSafeConceptKey(key);
  const file = `${encodeOkfConceptSegment(key)}.md`;
  return `${profile.folder}/${file}`;
}

export const TurbineOkfBundleIndexExtrasSchema = z
  .object({
    okf_version: z.literal(OKF_VERSION),
    'x-turbine-profile': z.literal(TURBINE_OKF_PROFILE),
    'x-turbine-commit': GitObjectIdSchema,
  })
  .passthrough();
