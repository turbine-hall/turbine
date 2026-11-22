import { z } from 'zod';

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
      })
      .default({
        jira: { enabled: false, siteUrl: null, credentialRef: null },
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
        })
        .default({
          currency: 'USD',
          maxEstimatedCost: 5,
          maxModelCalls: 15,
          maxExecutionAttempts: 2,
        }),
    })
    .default({
      perTask: {
        currency: 'USD',
        maxEstimatedCost: 5,
        maxModelCalls: 15,
        maxExecutionAttempts: 2,
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
      mode: z.enum(['manual-supervised', 'isolated-worktree']).default('manual-supervised'),
      requireIsolatedWorktree: z.boolean().default(true),
      allowNetwork: z.boolean().default(false),
    })
    .default({
      mode: 'manual-supervised',
      requireIsolatedWorktree: true,
      allowNetwork: false,
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
