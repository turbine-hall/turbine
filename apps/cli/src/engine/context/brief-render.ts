import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLISHED_CLAIM_STATUSES,
  contentHashText,
  type BriefState,
  type Claim,
  type ClaimVerifier,
  type StoredClaim,
} from '@turbine-hall/turbine-contracts';
import { contextPaths, writeAtomic } from './render.js';

/**
 * Render brief pages from published claims using verifier/evidence templates.
 * The free-text `statement` is never written to the page (it is only a label for storage).
 */

const oneLine = (t: string) => t.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

function cite(c: Claim): string {
  const e = c.evidence[0]!;
  const lines = e.lines ? `:L${e.lines.start}${e.lines.end !== e.lines.start ? `-${e.lines.end}` : ''}` : '';
  return `${e.path}@${e.blob.slice(0, 8)}${lines}`;
}

function renderVerifier(v: ClaimVerifier, c: Claim): string {
  switch (v.kind) {
    case 'exists':
      return v.symbol
        ? `\`${v.path}\` exports \`${v.symbol}\` _(${cite(c)})_`
        : `\`${v.path}\` is a tracked file _(${cite(c)})_`;
    case 'quote': {
      const q = c.evidence.find((e) => e.quote)?.quote ?? '';
      return `Quoted at _(${cite(c)})_: \`${oneLine(q).slice(0, 120)}\``;
    }
    case 'imports':
      return `\`${v.from}\` imports \`${v.specifier}\` _(${cite(c)})_`;
    case 'calls':
      return `\`${v.path}\` calls \`${v.callee}\` _(${cite(c)})_`;
    case 'config':
      return `\`${v.path}\` has \`${v.key.join('.')}\` = \`${JSON.stringify(v.value)}\` _(${cite(c)})_`;
    case 'dependency':
      return `Depends on \`${v.name}\` \`${v.spec}\` (${v.section}) in \`${v.workspace}\`${v.usedIn ? `, used in \`${v.usedIn}\`` : ''} _(${cite(c)})_`;
    case 'command':
      return `Script \`${v.script}\` in \`${v.workspace}\` runs \`${oneLine(v.command)}\` _(${cite(c)})_`;
    case 'absence':
      return v.pattern.type === 'literal'
        ? `No tracked file contains the literal \`${oneLine(v.pattern.text)}\`${v.exclude.length ? ` (excluding ${v.exclude.join(', ')})` : ''} _(${cite(c)})_`
        : `No JS/TS source imports \`${v.pattern.specifier}\`${v.exclude.length ? ` (excluding ${v.exclude.join(', ')})` : ''} _(${cite(c)})_`;
    default: {
      const _exhaustive: never = v;
      return _exhaustive;
    }
  }
}

/** One claim as a markdown bullet with a machine-readable marker (for parse-back of human edits). */
export function renderClaimBullet(stored: StoredClaim): string {
  const c = stored.claim;
  const label =
    stored.status === 'attested'
      ? `Human-attested${stored.reason ? ` (${oneLine(stored.reason)})` : ''}`
      : 'verified';
  return [
    `<!-- claim id=${c.id} kind=${c.kind} status=${stored.status} -->`,
    `- ${renderVerifier(c.verifier, c)} _[${label}]_`,
    `<!-- /claim id=${c.id} -->`,
  ].join('\n');
}

export function renderSectionBody(section: string, claims: StoredClaim[], state: BriefState): string {
  const published = claims.filter((c) => (PUBLISHED_CLAIM_STATUSES as readonly string[]).includes(c.status));
  const out: string[] = [];
  out.push(`# ${section}`);
  out.push('');
  const approved = state.approvedHash === state.claimsHash;
  if (approved) {
    out.push(`Verified claims at \`${state.commit.slice(0, 8)}\` (approved by ${state.approvedBy ?? 'unknown'} on ${state.approvedAt ?? 'unknown'}).`);
  } else {
    out.push(`Draft, not approved — verified claims at \`${state.commit.slice(0, 8)}\` (awaiting \`turbine context approve\`).`);
  }
  out.push('');
  if (!published.length) {
    out.push('_No published claims in this section._');
    out.push('');
    return out.join('\n');
  }
  for (const c of published) {
    out.push(renderClaimBullet(c));
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/** Parse claim ids still present in an edited section body. Missing markers mean the human removed those claims. */
export function parseClaimIdsFromSection(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(/<!-- claim id=([A-Za-z0-9][A-Za-z0-9._-]{0,63}) kind=/g)) {
    ids.push(m[1]!);
  }
  return [...new Set(ids)];
}

const BRIEF_BEGIN = /^<!-- turbine:brief begin ([^>]*?) -->\r?$/m;
const BRIEF_SECTION = /^<!-- turbine:brief begin ([^>]*?) -->\r?\n([\s\S]*?)\r?\n<!-- turbine:brief end -->\r?$/m;
const BRIEF_BEGIN_ANY = /^<!-- turbine:brief begin [^>]*? -->\r?$/gm;
const BRIEF_END_ANY = /^<!-- turbine:brief end -->\r?$/gm;

function attrs(raw: string): Record<string, string> {
  return Object.fromEntries([...raw.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]));
}

/** Body of the PROJECT.md brief block (all sections). */
export function renderBriefProjectBody(sections: string[], bySection: Map<string, StoredClaim[]>, state: BriefState): string {
  const approved = state.approvedHash === state.claimsHash;
  const out: string[] = [];
  out.push('## Project brief');
  out.push('');
  if (approved) {
    out.push(`Verified claims at \`${state.commit.slice(0, 8)}\`.`);
  } else {
    out.push(`Draft, not approved — verified claims at \`${state.commit.slice(0, 8)}\`. Run \`turbine context approve\` after reviewing the claim diff.`);
  }
  if (state.samplePaths.length) {
    out.push('');
    out.push(`Drafting sample: ${state.samplePaths.length} file(s) (cap ${state.sampleCap}): ${state.samplePaths.map((p) => `\`${p}\``).join(', ')}.`);
  }
  out.push('');
  for (const section of sections) {
    out.push(`### ${section}`);
    out.push('');
    const claims = bySection.get(section) ?? [];
    const published = claims.filter((c) => (PUBLISHED_CLAIM_STATUSES as readonly string[]).includes(c.status));
    if (!published.length) {
      out.push('_No published claims._');
      out.push('');
      continue;
    }
    for (const c of published) {
      out.push(renderClaimBullet(c));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

export function briefPaths(projectRoot: string) {
  const dir = join(contextPaths(projectRoot).dir, 'brief');
  return { dir, section: (name: string) => join(dir, `${name}.md`) };
}

/**
 * Write `.turbine/context/brief/<section>.md` and merge the brief block into PROJECT.md.
 * Returns the paths written.
 */
export function writeBriefFiles(
  projectRoot: string,
  sections: string[],
  claims: StoredClaim[],
  state: BriefState,
  existingProject?: string,
): string[] {
  const written: string[] = [];
  const paths = briefPaths(projectRoot);
  mkdirSync(paths.dir, { recursive: true });
  const bySection = new Map<string, StoredClaim[]>();
  for (const s of sections) bySection.set(s, []);
  for (const c of claims) {
    const list = bySection.get(c.claim.section);
    if (list) list.push(c);
  }
  for (const section of sections) {
    const body = renderSectionBody(section, bySection.get(section) ?? [], state);
    const file = paths.section(section);
    writeAtomic(file, body);
    written.push(file);
  }

  const projectPath = contextPaths(projectRoot).project;
  const body = renderBriefProjectBody(sections, bySection, state);
  const marker = `<!-- turbine:brief begin commit=${state.commit} claims=${state.claimsHash} content=${contentHashText(body)} -->`;
  if (!existsSync(projectPath) && existingProject === undefined) return written;
  const text = existingProject ?? readFileSync(projectPath, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = `${marker}\n${body}\n<!-- turbine:brief end -->`.split('\n').join(eol);
  let next: string;
  if (BRIEF_SECTION.test(text)) {
    const begins = (text.match(BRIEF_BEGIN_ANY) ?? []).length;
    const ends = (text.match(BRIEF_END_ANY) ?? []).length;
    if (begins !== 1 || ends !== 1) throw new Error('.turbine/context/PROJECT.md has a damaged brief section; restore the turbine:brief markers');
    next = text.replace(BRIEF_SECTION, () => block);
  } else {
    next = `${text.replace(/\r?\n*$/, eol)}${eol}${block}${eol}`;
  }
  writeAtomic(projectPath, next);
  written.push(projectPath);
  return written;
}

/** Read attrs of the brief block in PROJECT.md, if present. */
export function readBriefMarker(projectMd: string): Record<string, string> | undefined {
  const m = BRIEF_BEGIN.exec(projectMd);
  return m ? attrs(m[1]!) : undefined;
}
