import { z } from 'zod';

/** Human gates that cannot be switched off in config; they are relaxed only through approved lane policies. */
export const NON_DISABLEABLE_HUMAN_GATES = ['requirements', 'plan', 'codeReview', 'sqaAcceptance'] as const;

/** Hostname allow-list entry: labels and dots only (no scheme, path, or credentials). */
const sandboxHostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$|^localhost$/, {
    message: 'sandbox registry/proxy host must be a hostname (no scheme, path, or credentials)',
  });

/** http(s) URL whose host is allow-listed for model-proxy phases; rejects file:// and credentials. */
const sandboxProxyUrl = z
  .string()
  .refine((u) => {
    // Reject traversal in the raw string before URL normalization removes `..`.
    if (/(^|\/)\.\.(\/|$)/.test(u) || /%2e%2e/i.test(u)) return false;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (parsed.username || parsed.password) return false;
      if (parsed.pathname.includes('..')) return false;
      return sandboxHostname.safeParse(parsed.hostname).success;
    } catch {
      return false;
    }
  }, { message: 'sandboxModelProxyUrl must be http(s) without credentials or path traversal' });

const sandboxNetworkName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, { message: 'sandbox network must be a network name' });

export const ProjectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string(),
    root: z.string(),
    nonProductionOnly: z.boolean().default(true),
  }),
  framework: z.object({
    id: z.string().default('turbine'),
    version: z.string().default('0.5.0'),
    policyProfile: z.enum(['lightweight', 'standard', 'comprehensive']).default('standard'),
  }),
  /**
   * Git defaults for task worktrees and subtask/landing PRs.
   * Worktrees and PR heads are created from `defaultBaseBranch` (not whatever happens to be checked out).
   */
  git: z
    .object({
      /** Branch name PRs target and worktrees fork from (e.g. main). */
      defaultBaseBranch: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9._/-]+$/, {
          message: 'git.defaultBaseBranch must be a git branch name (letters, digits, . _ / -)',
        })
        .default('main'),
      /**
       * Max insertions+deletions vs the configured base when opening a subtask PR.
       * Exceeding this fails closed so agents cannot open mega-diffs against the wrong tip.
       */
      maxSubtaskPrChangedLines: z.number().int().positive().max(10_000).default(400),
    })
    .default({ defaultBaseBranch: 'main', maxSubtaskPrChangedLines: 400 }),
  inputs: z.object({
    default: z.enum(['file', 'text', 'jira']).default('file'),
    adapters: z
      .object({
        jira: z
          .object({
            enabled: z.boolean().default(false),
            siteUrl: z.string().nullable().default(null),
            credentialRef: z.string().nullable().default(null),
          })
          .default({ enabled: false, siteUrl: null, credentialRef: null }),
        github: z
          .object({
            enabled: z.boolean().default(false),
            /**
             * Documented enterprise API hint only. Live mirror uses `GITHUB_API_BASE_URL` (env)
             * or https://api.github.com — never this repo-owned field with the env token.
             */
            apiBaseUrl: z.string().nullable().default(null),
            credentialRef: z.string().nullable().default(null),
            /**
             * owner/repo values that may receive packet mirrors. Empty = no GitHub mirrors
             * (fail closed). Compared case-insensitively.
             */
            mirrorRepos: z.array(z.string()).default([]),
          })
          .default({ enabled: false, apiBaseUrl: null, credentialRef: null, mirrorRepos: [] }),
      })
      .default({
        jira: { enabled: false, siteUrl: null, credentialRef: null },
        github: { enabled: false, apiBaseUrl: null, credentialRef: null, mirrorRepos: [] },
      }),
  }),
  models: z.object({
    defaultProfile: z.string().default('analysis'),
    profiles: z
      .record(
        z.string(),
        z.object({
          provider: z.string(),
          model: z.string(),
          maxOutputTokens: z.number().int().positive().default(4000),
        }),
      )
      .default({
        analysis: {
          provider: 'mock',
          model: 'mock-default',
          maxOutputTokens: 4000,
        },
        implementation: {
          provider: 'mock',
          model: 'mock-default',
          maxOutputTokens: 8000,
        },
      }),
  }),
  budgets: z
    .object({
      perTask: z
        .object({
          currency: z.string().default('USD'),
          maxEstimatedCost: z.number().default(5),
          maxModelCalls: z.number().int().default(15),
          maxExecutionAttempts: z.number().int().default(2),
          /**
           * Optional retrospective cap on measured Turbine-side input+output tokens.
           * Null/omitted = no token budget. Unknown usage does not count toward the cap.
           * Further checked calls are refused once measured usage has reached the limit;
           * one call may finish above the remaining allowance (check uses completed usage).
           */
          maxTokens: z.number().int().positive().nullable().default(null),
        })
        .default({
          currency: 'USD',
          maxEstimatedCost: 5,
          maxModelCalls: 15,
          maxExecutionAttempts: 2,
          maxTokens: null,
        }),
    })
    .default({
      perTask: {
        currency: 'USD',
        maxEstimatedCost: 5,
        maxModelCalls: 15,
        maxExecutionAttempts: 2,
        maxTokens: null,
      },
    }),
  tools: z
    .object({
      allow: z.array(z.string()).default([
        'issue.read',
        'repo.inspect',
        'repo.read',
        'git.diff',
        'tests.run',
      ]),
      denied: z
        .array(z.string())
        .default(['issue.edit', 'issue.transition', 'pr.merge', 'production.deploy']),
    })
    .default({
      allow: ['issue.read', 'repo.inspect', 'repo.read', 'git.diff', 'tests.run'],
      denied: ['issue.edit', 'issue.transition', 'pr.merge', 'production.deploy'],
    }),
  execution: z
    .object({
      /**
       * `sandboxed-unattended` runs the implementer in Docker/Podman with only the task worktree
       * mounted (Part D). Other modes never run networked unattended work (`E_UNSAFE_EXECUTION`).
       */
      mode: z.enum(['manual-supervised', 'isolated-worktree', 'sandboxed-unattended']).default('manual-supervised'),
      requireIsolatedWorktree: z.boolean().default(true),
      allowNetwork: z.boolean().default(false),
      /** Wall-clock limit for one sandboxed-unattended run (FR-D6). Cap at Node's max timer delay. */
      sandboxWallClockMs: z.number().int().positive().max(2_147_483_647).default(1_800_000),
      /** Max combined stdout/stderr bytes from sandbox phases before limit-exceeded (FR-D6). */
      sandboxMaxOutputBytes: z.number().int().positive().default(8_000_000),
      /** Container image for sandboxed-unattended phases (no path traversal or leading '-'). */
      sandboxImage: z
        .string()
        .min(1)
        .max(512)
        .refine((s) => !s.includes('..') && !s.startsWith('/') && !s.startsWith('-') && !s.includes('\\'), {
          message: 'sandboxImage must not be an absolute path, start with -, or contain ..',
        })
        .default('docker.io/library/node:22-bookworm'),
      /** Hostnames allowed during setup (registries network scope). Empty → allow-list phases refuse. */
      sandboxRegistries: z.array(sandboxHostname).default([]),
      /**
       * Model-proxy base URL for implement/fix network scope. Required for live sandboxed-unattended
       * allow-list enforcement; operators supply the proxy (Turbine does not ship one).
       */
      sandboxModelProxyUrl: sandboxProxyUrl.optional(),
      /** Live implementer adapter id. Tests may still inject Engine.sandboxImplementer. */
      sandboxImplementer: z.enum(['claude-code', 'codex']).optional(),
      /**
       * Docker/Podman network for the registries (setup) scope. When unset, that scope is not
       * enforceable and preflight refuses (fail closed). Checks/commit use `--network none`.
       */
      sandboxAllowNetwork: sandboxNetworkName.optional(),
      /**
       * Docker/Podman network for the model-proxy (implement/fix) scope. Must be set and must
       * differ from `sandboxAllowNetwork` so the two scopes are not the same bridge.
       */
      sandboxModelProxyNetwork: sandboxNetworkName.optional(),
    })
    .default({
      mode: 'manual-supervised',
      requireIsolatedWorktree: true,
      allowNetwork: false,
      sandboxWallClockMs: 1_800_000,
      sandboxMaxOutputBytes: 8_000_000,
      sandboxImage: 'docker.io/library/node:22-bookworm',
      sandboxRegistries: [],
    }),
  quality: z
    .object({
      /** Commands run in the task worktree at VERIFYING, e.g. "npm run lint". Required. */
      checks: z.array(z.string()).default([]),
      /** Commands run in the worktree before checks, e.g. "npm ci". */
      setup: z.array(z.string()).default([]),
      timeoutMs: z.number().int().positive().default(600_000),
      /**
       * Run when a change adds or changes dependencies. "auto" picks from the lockfile
       * (npm audit / pnpm audit / yarn audit at high severity); "off" disables (the audit
       * obligation then needs a waiver); anything else is the exact command.
       */
      dependencyAudit: z.string().default('auto'),
    })
    .default({ checks: [], setup: [], timeoutMs: 600_000, dependencyAudit: 'auto' }),
  humanGates: z
    .object({
      /**
       * Must be true (or omitted). A false value is refused rather than silently ignored: gates are
       * relaxed only through lane policies a human approved (`turbine policy approve`).
       */
      requirements: z.boolean().default(true),
      plan: z.boolean().default(true),
      codeReview: z.boolean().default(true),
      sqaAcceptance: z.boolean().default(true),
      /**
       * When true, code-review and acceptance also require an APPROVED GitHub review on the
       * open PR for turbine/<work-id>, at the exact commit under review (checked with `gh`).
       * A PR author cannot approve their own PR, so an agent account cannot self-approve.
       */
      requirePrApproval: z.boolean().default(false),
    })
    .superRefine((g, ctx) => {
      for (const key of NON_DISABLEABLE_HUMAN_GATES) {
        if (g[key] === false) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `humanGates.${key} cannot be false: human gates are relaxed only through lane policies approved with \`turbine policy approve\` (.turbine/policies/*.yaml)`,
          });
        }
      }
    })
    .default({
      requirements: true,
      plan: true,
      codeReview: true,
      sqaAcceptance: true,
      requirePrApproval: false,
    }),
  /** Repository context (layer 2 brief). */
  context: z
    .object({
      brief: z
        .object({
          /** Section ids the brief may contain (lower-case, hyphenated). */
          sections: z
            .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
            .min(1)
            .max(32)
            .default(['architecture', 'security', 'getting-started', 'testing', 'deployment', 'data-model']),
          /** Max key files sampled as drafting input; the run reports how many were used. */
          sampleFileCap: z.number().int().min(1).max(200).default(40),
        })
        .default({
          sections: ['architecture', 'security', 'getting-started', 'testing', 'deployment', 'data-model'],
          sampleFileCap: 40,
        }),
    })
    .default({
      brief: {
        sections: ['architecture', 'security', 'getting-started', 'testing', 'deployment', 'data-model'],
        sampleFileCap: 40,
      },
    }),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
