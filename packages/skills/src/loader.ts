import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHashText, err } from '@turbine-hall/turbine-contracts';

export type SkillManifest = {
  id: string;
  version: string;
  source: string;
  license: string;
  contentHash: string;
  runnerCompatibility: string[];
  inputs: string[];
  outputs: string[];
  requiredCapabilities: string[];
  resourceLimits: { maxModelCalls?: number };
  prompt: string;
};

export function loadSkills(rootDir: string): SkillManifest[] {
  const dir = join(rootDir, 'skills', 'core');
  if (!existsSync(dir)) return [];
  const out: SkillManifest[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'skill.json');
    const promptPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(manifestPath) || !existsSync(promptPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Omit<
      SkillManifest,
      'prompt' | 'contentHash'
    >;
    const prompt = readFileSync(promptPath, 'utf8');
    out.push({
      ...manifest,
      prompt,
      contentHash: contentHashText(prompt),
    });
  }
  return out;
}

export function getSkill(rootDir: string, skillId: string): SkillManifest {
  const skill = loadSkills(rootDir).find((s) => s.id === skillId);
  if (!skill) throw err('E_NOT_FOUND', `Skill not found: ${skillId}`);
  return skill;
}
