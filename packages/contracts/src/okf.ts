import { z } from 'zod';

/**
 * OKF v0.3 frontmatter shapes (Open Knowledge Format).
 * Version handling for OKF lives only in this module and `okf-profile.ts`.
 * Spec: https://github.com/open-knowledge-format/open-knowledge-format/blob/main/SPEC.md
 */

/** Pinned OKF minor version this codebase produces and accepts. */
export const OKF_VERSION = '0.3' as const;

/** RFC 3339 date-time or full-date (OKF §5). */
export const OkfTimestampSchema = z
  .string()
  .refine(
    (s) =>
      /^\d{4}-\d{2}-\d{2}$/.test(s) ||
      /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s),
    'expected an RFC 3339 date or date-time',
  );
export type OkfTimestamp = z.infer<typeof OkfTimestampSchema>;

/**
 * Actor identity (OKF §7): `kind/id` for agents/tools, or `scheme:id` for humans/teams/processes.
 * Only `human:` yields the human-reviewed trust tier.
 */
export const OkfActorSchema = z
  .string()
  .min(1)
  .regex(/^([^\s/:]+\/\S+|[A-Za-z][A-Za-z0-9+.-]*:\S+)$/, 'expected an OKF actor (kind/id or scheme:id)');
export type OkfActor = z.infer<typeof OkfActorSchema>;

/**
 * Build a `human:<id>` actor that always satisfies {@link OkfActorSchema}.
 * Whitespace and other illegal id characters become `-`; empty input → `human:unknown`.
 */
export function okfHumanActor(name: string): OkfActor {
  const raw = name.trim().replace(/^human:/i, '');
  const id = raw
    .replace(/[^A-Za-z0-9+._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const actor = `human:${id || 'unknown'}`;
  return OkfActorSchema.parse(actor);
}

export const OkfStatusSchema = z.enum(['draft', 'stable', 'deprecated']);
export type OkfStatus = z.infer<typeof OkfStatusSchema>;

export const OkfUsageWindowSchema = z
  .object({
    from: OkfTimestampSchema,
    to: OkfTimestampSchema,
  })
  .strict();
export type OkfUsageWindow = z.infer<typeof OkfUsageWindowSchema>;

export const OkfSourceEntrySchema = z
  .object({
    /** Stable join key for Markdown footnotes `[^id]`. */
    id: z.string().min(1).optional(),
    /** Absolute URL, in-bundle path, or scope descriptor (OKF §5.1 / §6.2). */
    resource: z.string().min(1),
    title: z.string().min(1).optional(),
    author: OkfActorSchema.optional(),
    usage_count: z.number().int().nonnegative().optional(),
    last_modified: OkfTimestampSchema.optional(),
    usage_window: OkfUsageWindowSchema.optional(),
  })
  .strict();
export type OkfSourceEntry = z.infer<typeof OkfSourceEntrySchema>;

export const OkfGeneratedSchema = z
  .object({
    by: OkfActorSchema,
    at: OkfTimestampSchema.optional(),
  })
  .strict();
export type OkfGenerated = z.infer<typeof OkfGeneratedSchema>;

export const OkfVerifiedEventSchema = z
  .object({
    by: OkfActorSchema,
    at: OkfTimestampSchema,
  })
  .strict();
export type OkfVerifiedEvent = z.infer<typeof OkfVerifiedEventSchema>;

/** `verified` may be one mapping or a list (OKF §5.2). */
export const OkfVerifiedSchema = z.union([OkfVerifiedEventSchema, z.array(OkfVerifiedEventSchema)]);
export type OkfVerified = z.infer<typeof OkfVerifiedSchema>;

/**
 * Known OKF concept frontmatter keys. Unknown keys (extensions, including `x-*`) are preserved
 * by producers that edit in place (OKF §4.1) and are not rejected by consumers.
 */
export const OkfConceptFrontmatterSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    resource: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    sources: z.array(OkfSourceEntrySchema).optional(),
    usage_window: OkfUsageWindowSchema.optional(),
    generated: OkfGeneratedSchema.optional(),
    verified: OkfVerifiedSchema.optional(),
    status: z.string().min(1).optional(),
    superseded_by: z.string().min(1).optional(),
    stale_after: OkfTimestampSchema.optional(),
  })
  .passthrough();
export type OkfConceptFrontmatter = z.infer<typeof OkfConceptFrontmatterSchema>;

/** Bundle-root `index.md` metadata (OKF §8.1). */
export const OkfBundleIndexFrontmatterSchema = z
  .object({
    okf_version: z.literal(OKF_VERSION).or(z.string().min(1)),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
  })
  .passthrough();
export type OkfBundleIndexFrontmatter = z.infer<typeof OkfBundleIndexFrontmatterSchema>;

export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

/** Normalise `verified` to a list of events that have both `by` and `at` (OKF §5.2). */
export function okfVerifiedEvents(verified: unknown): OkfVerifiedEvent[] {
  if (verified == null || verified === '') return [];
  const list = Array.isArray(verified) ? verified : [verified];
  const out: OkfVerifiedEvent[] = [];
  for (const item of list) {
    const parsed = OkfVerifiedEventSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseOkfInstant(value: string): number | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00Z`);
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Trust tier from current verification events only (OKF §5.3).
 * An event is current when `at >= generated.at`, or when `generated` is absent.
 */
export function okfTrustTier(input: {
  generated?: { by?: string; at?: string } | null;
  verified?: unknown;
}): OkfTrustTier {
  const generatedAt = input.generated?.at ? parseOkfInstant(input.generated.at) : undefined;
  const current = okfVerifiedEvents(input.verified).filter((e) => {
    if (generatedAt === undefined) return true;
    const at = parseOkfInstant(e.at);
    return at !== undefined && at >= generatedAt;
  });
  if (!current.length) return 'unverified';
  if (current.some((e) => e.by.startsWith('human:'))) return 'human-reviewed';
  return 'machine-confirmed';
}

/** Known lifecycle statuses. Any other non-empty status is not treated as stable (OKF §5.4). */
export function okfEffectiveStatus(status: unknown): 'draft' | 'stable' | 'deprecated' | 'unknown' {
  if (status == null || status === '') return 'stable';
  if (status === 'draft' || status === 'stable' || status === 'deprecated') return status;
  return 'unknown';
}
