import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type StageStatus = 'done' | 'now' | 'todo';

export type BoardStage = {
  id: string;
  name: string;
  status: StageStatus;
};

export type BoardRequirement = {
  id: string;
  priority: string;
  statement: string;
};

export type BoardTask = {
  id: string;
  headline: string;
  title: string;
  type: string;
  risk: string;
  track: string;
  state: string;
  next: string;
  notes: string[];
  stages: BoardStage[];
  requirements: BoardRequirement[];
  questions: string[];
  updatedAt: string;
};

const STAGES: Array<{ id: string; name: string; states: string[] }> = [
  { id: 'req', name: 'Request', states: ['IMPORTED', 'ASSESSING'] },
  { id: 'spec', name: 'Requirements', states: ['NEEDS_CLARIFICATION', 'REQUIREMENTS_REVIEW'] },
  { id: 'plan', name: 'Plan', states: ['REQUIREMENTS_APPROVED', 'PLANNING', 'PLAN_REVIEW'] },
  { id: 'code', name: 'Code', states: ['PLAN_APPROVED', 'IMPLEMENTING', 'CHANGES_REQUESTED'] },
  { id: 'review', name: 'Code review', states: ['AI_REVIEW', 'HUMAN_CODE_REVIEW'] },
  { id: 'checks', name: 'Checks', states: ['VERIFYING'] },
  { id: 'accept', name: 'Acceptance', states: ['HUMAN_ACCEPTANCE'] },
];

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function section(markdown: string, heading: string): string {
  const match = markdown.match(new RegExp(`^## ${heading}\\s*$`, 'm'));
  if (!match || match.index === undefined) return '';
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function bullets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^- (.+)$/);
    if (match?.[1]) out.push(match[1].trim());
  }
  return out;
}

export function stagesFor(state: string): BoardStage[] {
  const index = state === 'ACCEPTED' ? STAGES.length : STAGES.findIndex((stage) => stage.states.includes(state));
  return STAGES.map((stage, i) => ({
    id: stage.id,
    name: stage.name,
    status: index === -1 ? 'todo' : i < index ? 'done' : i === index ? 'now' : 'todo',
  }));
}

function parseStatus(markdown: string): Omit<BoardTask, 'id' | 'stages' | 'requirements' | 'questions' | 'updatedAt'> {
  const headline = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  const meta = markdown.match(
    /\*\*(.+?)\*\*\s·\s(\S+)\s·\srisk:\s(\S+)\s·\strack:\s(\S+)\s·\sstate:\s`([^`]+)`/,
  );
  const next = markdown.match(/^>\s+\*\*Next —[^:]*:\*\*\s+(.+)$/m)?.[1]?.trim() ?? '';
  return {
    headline,
    title: meta?.[1] ?? 'Untitled task',
    type: meta?.[2] ?? '',
    risk: meta?.[3] ?? '',
    track: meta?.[4] ?? '',
    state: meta?.[5] ?? 'UNKNOWN',
    next,
    notes: bullets(section(markdown, 'What just happened')),
  };
}

function parseQuestions(markdown: string): string[] {
  return bullets(section(markdown, 'Open questions'))
    .filter((line) => !line.startsWith('_'))
    .map((line) => line.replace(/\*\*/g, ''))
    .filter((line) => line && !/^none$/i.test(line));
}

function parseRequirements(specJson: string, specMarkdown: string): BoardRequirement[] {
  if (specJson) {
    try {
      const data = JSON.parse(specJson) as { requirements?: BoardRequirement[] };
      if (Array.isArray(data.requirements)) {
        return data.requirements.map((item) => ({
          id: item.id,
          priority: item.priority ?? '',
          statement: item.statement ?? '',
        }));
      }
    } catch {
      // The packet markdown is the fallback.
    }
  }
  const out: BoardRequirement[] = [];
  for (const line of section(specMarkdown, 'Requirements').split('\n')) {
    const match = line.trim().match(/^- \*\*([\w.-]+)\*\*\s*\(([^)]+)\):\s*(.+)$/);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    out.push({
      id: match[1],
      priority: match[2].split(',')[0]?.trim() ?? '',
      statement: match[3].trim(),
    });
  }
  return out;
}

/** Read every task packet under `<project>/.turbine/tasks`. */
export function loadTasks(projectRoot: string): BoardTask[] {
  const tasksDir = join(projectRoot, '.turbine', 'tasks');
  if (!existsSync(tasksDir)) return [];
  const tasks: BoardTask[] = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(tasksDir, entry.name);
    const statusPath = join(dir, 'STATUS.md');
    if (!existsSync(statusPath)) continue;
    const spec = readText(join(dir, 'SPEC.md'));
    const status = parseStatus(readText(statusPath));
    tasks.push({
      id: entry.name,
      ...status,
      stages: stagesFor(status.state),
      requirements: parseRequirements(readText(join(dir, 'evidence', 'spec.json')), spec),
      questions: parseQuestions(spec),
      updatedAt: statSync(statusPath).mtime.toISOString(),
    });
  }
  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return tasks;
}
