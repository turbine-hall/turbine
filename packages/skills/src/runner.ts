import { err } from '@turbine-hall/turbine-contracts';
import type { ModelAdapter } from '@turbine-hall/turbine-models';
import type { SkillManifest } from './loader.js';

/**
 * Skills are untrusted text. They cannot expand tool grants.
 * The engine supplies grants separately; this runner only produces structured content.
 */
export async function runSkill(input: {
  skill: SkillManifest;
  /** Extra skill prompts concatenated into the same model call (single schema / artifact). */
  companionSkills?: SkillManifest[];
  model: ModelAdapter;
  workId: string;
  roleId: string;
  context: string;
  schemaId: string;
  maxOutputTokens: number;
  grantedCapabilities: string[];
}): Promise<{ content: unknown; usage?: { inputTokens?: number; outputTokens?: number } }> {
  const allSkills = [input.skill, ...(input.companionSkills ?? [])];
  for (const skill of allSkills) {
    for (const required of skill.requiredCapabilities) {
      if (!input.grantedCapabilities.includes(required) && required !== 'none') {
        // informational capabilities like none are fine; missing real caps block
        if (required !== 'none') {
          throw err(
            'E_MISSING_CAPABILITY',
            `Skill ${skill.id} requires capability ${required} which was not granted`,
          );
        }
      }
    }
  }

  // Skill text cannot self-grant — we intentionally ignore any capability claims in prompt.
  const companionBlock = (input.companionSkills ?? []).map((s) => s.prompt).join('\n\n---\n');
  const prompt = companionBlock
    ? `${input.skill.prompt}\n\n---\n${companionBlock}\n\n---\nCONTEXT\n${input.context}\n`
    : `${input.skill.prompt}\n\n---\nCONTEXT\n${input.context}\n`;
  return input.model.run({
    workId: input.workId,
    roleId: input.roleId,
    skillIds: allSkills.map((s) => s.id),
    prompt,
    schemaId: input.schemaId,
    maxOutputTokens: input.maxOutputTokens,
    budgetId: input.workId,
  });
}
