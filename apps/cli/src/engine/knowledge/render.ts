import {
  OKF_VERSION,
  PUBLISHED_CLAIM_STATUSES,
  TURBINE_OKF_PROFILE,
  contentHashText,
  okfHumanActor,
  okfTrustTier,
  turbineOkfConceptPath,
  type BriefState,
  type Convention,
  type RepoSnapshot,
  type StoredClaim,
  type UnconfirmedItem,
} from '@turbine-hall/turbine-contracts';
import { shouldQuoteOkfString, splitFrontmatter } from './frontmatter.js';

export type BundleFiles = Map<string, string>;

export type RenderBundleInput = {
  snapshot: RepoSnapshot;
  /** Published brief claims at the snapshot commit (verified + attested). */
  claims: StoredClaim[];
  brief: BriefState | null;
  /** Withdrawn claims to record in log.md (id, section, reason, when). */
  withdrawn: Array<{ id: string; section: string; reason: string; at?: string }>;
  /** Previous log.md body (without title), if any — new entries are prepended. */
  previousLogBody?: string;
  /** CLI version string for generated.by / verified.by process actors. */
  cliVersion: string;
  /** Project display name. */
  projectName: string;
  /** SPDX license from the repo if declared; omit when unknown (never guess). */
  license?: string;
  /**
   * Prior concept bodies keyed by relative path, used to keep `generated.at` when content is unchanged
   * and to preserve unknown frontmatter keys on regenerate.
   */
  previousFiles?: Map<string, string>;
};

const oneLine = (t: string) => t.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');

/**
 * `generated.at` is the real change time (OKF §5.2 / §5.3). Reuse the previous value when
 * content is unchanged so same store+commit stays byte-identical; never invent a fake past date.
 */
function generatedAtFor(previousAt: string | undefined, contentChanged: boolean, nowIso?: string): string {
  if (!contentChanged && previousAt) return previousAt;
  const now = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (previousAt && previousAt >= now) {
    // Keep chronology: a rewrite must not look older than the prior generation.
    const prevMs = Date.parse(previousAt);
    if (Number.isFinite(prevMs)) return new Date(prevMs + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return now;
}

function yamlScalar(value: string): string {
  if (shouldQuoteOkfString(value) || /[:#{}[\],&*?|>!%@`]/.test(value) || value.includes('\n') || value.includes("'")) {
    return JSON.stringify(value);
  }
  return value;
}

function emitFrontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(...emitYamlValue(key, value, 0));
  }
  lines.push('---');
  return lines.join('\n');
}

function emitYamlValue(key: string, value: unknown, indent: number): string[] {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return [`${pad}${key}:`];
  if (typeof value === 'string') return [`${pad}${key}: ${yamlScalar(value)}`];
  if (typeof value === 'number' || typeof value === 'boolean') return [`${pad}${key}: ${value}`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${key}: []`];
    const out = [`${pad}${key}:`];
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined);
        if (!entries.length) {
          out.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstVal] = entries[0]!;
        if (typeof firstVal === 'string' || typeof firstVal === 'number' || typeof firstVal === 'boolean') {
          out.push(`${pad}- ${firstKey}: ${typeof firstVal === 'string' ? yamlScalar(firstVal) : firstVal}`);
        } else {
          out.push(`${pad}- ${firstKey}:`);
          out.push(...emitYamlValue('', firstVal, indent + 2).map((l) => l.replace(/^ {2}/, '    ')));
        }
        for (const [k, v] of entries.slice(1)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out.push(`${pad}  ${k}: ${typeof v === 'string' ? yamlScalar(v) : v}`);
          } else if (v !== undefined) {
            out.push(...emitYamlValue(k, v, indent + 1));
          }
        }
      } else if (typeof item === 'string') {
        out.push(`${pad}- ${yamlScalar(item)}`);
      } else {
        out.push(`${pad}- ${JSON.stringify(item)}`);
      }
    }
    return out;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return [`${pad}${key}: {}`];
    // flow style for small generated/verified mappings
    if (
      entries.length <= 3 &&
      entries.every(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    ) {
      const inner = entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? yamlScalar(v) : v}`).join(', ');
      return [`${pad}${key}: { ${inner} }`];
    }
    const out = [`${pad}${key}:`];
    for (const [k, v] of entries) out.push(...emitYamlValue(k, v, indent + 1));
    return out;
  }
  return [`${pad}${key}: ${JSON.stringify(value)}`];
}

function sourceId(prefix: string, path: string, blob: string): string {
  // Digest of the full path+blob stays unique after truncation of the readable prefix.
  const digest = contentHashText(`${path}@${blob}`).replace(/^sha256:/, '').slice(0, 12);
  const readable = path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  const raw = `${prefix}-${readable}-${digest}`;
  return raw.slice(0, 64) || `${prefix}-${digest}`;
}

function citeFootnote(id: string, title: string): string {
  return `[^${id}]: ${oneLine(title)}`;
}

type SourceAcc = { id: string; resource: string; title: string };

function factSource(f: { source: { path: string; blob: string; commit: string } }, prefix: string): SourceAcc {
  return {
    id: sourceId(prefix, f.source.path, f.source.blob),
    resource: `git:${f.source.path}@${f.source.blob}`,
    title: `${f.source.path}@${f.source.blob.slice(0, 8)}`,
  };
}

/**
 * Render a complete Turbine OKF bundle as an in-memory file map.
 * Pure: same store state + commit → byte-identical output (aside from preserved generated.at).
 */
export function renderBundle(input: RenderBundleInput): BundleFiles {
  const { snapshot, claims, brief, withdrawn, cliVersion, projectName } = input;
  const commit = snapshot.commit;
  const files: BundleFiles = new Map();
  const turbineBy = `turbine/${cliVersion}`;
  const verifyBy = `process:turbine-verify/${cliVersion}`;

  const published = claims.filter((c) => (PUBLISHED_CLAIM_STATUSES as readonly string[]).includes(c.status));
  const approved = brief !== null && brief.approvedHash === brief.claimsHash;

  // --- index.md ---
  const indexFm: Record<string, unknown> = {
    okf_version: OKF_VERSION,
    title: projectName,
    description: `Repository knowledge for ${projectName}, generated by Turbine from verified facts and claims at a single commit.`,
    'x-turbine-profile': TURBINE_OKF_PROFILE,
    'x-turbine-commit': commit,
  };
  if (input.license) indexFm.license = input.license;
  const indexBody = [
    '# Project knowledge',
    '',
    `Bundle for commit \`${commit.slice(0, 12)}\`. Start here, then open concepts under the folders listed below.`,
    '',
    '# Project',
    '',
    `* [Overview](project/overview.md) - project summary and facts`,
    '',
    '# Structure',
    '',
    `* [Layout](structure/layout.md) - repository layout`,
    `* [Packages](structure/packages/) - workspace packages`,
    '',
    '# Commands',
    '',
    `* [Commands](commands/) - scripts and toolchain commands`,
    '',
    '# Conventions',
    '',
    `* [Conventions](conventions/) - confirmed conventions only`,
    '',
    '# Open questions',
    '',
    `* [Open questions](open-questions/) - unconfirmed items`,
    '',
    '# Brief',
    '',
    `* [Brief](brief/) - verified claim sections`,
    '',
  ].join('\n');
  files.set('index.md', `${emitFrontmatter(indexFm)}\n${indexBody}`);

  // --- README.md (no type) ---
  files.set(
    'README.md',
    [
      '---',
      'title: How this knowledge bundle is organised',
      'description: Layout, concept types, and how to update knowledge through Turbine.',
      `generated: { by: ${yamlScalar(turbineBy)}, at: ${yamlScalar('2020-01-01T00:00:00Z')} }`,
      '---',
      '',
      '# How this bundle is organised',
      '',
      'This directory is an [OKF](https://github.com/open-knowledge-format/open-knowledge-format) v0.3 knowledge bundle with the Turbine profile `turbine-okf/1`.',
      '',
      '## Concept types',
      '',
      '| Type | Folder | Meaning |',
      '| --- | --- | --- |',
      '| Turbine Project | `project/` | Project overview and facts |',
      '| Turbine Layout | `structure/` | Repository layout |',
      '| Turbine Package | `structure/packages/` | One package / workspace member |',
      '| Turbine Command | `commands/` | A script or toolchain command |',
      '| Turbine Convention | `conventions/` | A confirmed convention |',
      '| Turbine Open Question | `open-questions/` | Something that could not be proven |',
      '| Turbine Brief Section | `brief/` | Verified / attested claims for one brief section |',
      '',
      '## How to update knowledge',
      '',
      '- Facts change when the code changes. Run `turbine understand` to rebuild.',
      '- Brief corrections go through `turbine context show`, edit, `approve`, and `attest`.',
      '- Do not hand-edit generated concept bodies. Unknown frontmatter keys are kept; generated values are overwritten.',
      '- Export a validated copy with `turbine knowledge export <dir>` if you want to commit or share a snapshot.',
      '',
    ].join('\n'),
  );

  // --- project/overview.md ---
  {
    const path = turbineOkfConceptPath('Turbine Project');
    const facts = snapshot.facts;
    const sources: SourceAcc[] = [];
    const bullets: string[] = [];
    const defs: string[] = [];
    for (const f of facts) {
      const s = factSource(f, 'fact');
      if (!sources.some((x) => x.id === s.id)) sources.push(s);
      bullets.push(`- ${oneLine(f.statement)}[^${s.id}]`);
      defs.push(citeFootnote(s.id, s.title));
    }
    const contentKey = JSON.stringify({ facts: facts.map((f) => f.key), commit });
    const body = [
      '# Summary',
      '',
      `Project \`${projectName}\` at commit \`${commit.slice(0, 12)}\`. Every fact below is from the store with its proof.`,
      '',
      '# Facts',
      '',
      ...(bullets.length ? bullets : ['No facts in the store for this commit.']),
      '',
      ...[...new Set(defs)],
      '',
    ].join('\n');
    files.set(
      path,
      conceptFile({
        type: 'Turbine Project',
        title: projectName,
        description: `Overview of ${projectName}`,
        commit,
        turbineBy,
        verifyBy,
        contentKey,
        sources,
        body,
        verified: true,
        previous: input.previousFiles?.get(path),
      }),
    );
  }

  // --- structure/layout.md ---
  {
    const path = turbineOkfConceptPath('Turbine Layout');
    const layout = snapshot.facts.filter((f) => f.category === 'layout');
    const sources: SourceAcc[] = [];
    const bullets: string[] = [];
    const defs: string[] = [];
    for (const f of layout) {
      const s = factSource(f, 'layout');
      if (!sources.some((x) => x.id === s.id)) sources.push(s);
      bullets.push(`- ${oneLine(f.statement)}[^${s.id}]`);
      defs.push(citeFootnote(s.id, s.title));
    }
    // Always have at least one source (tree) for the required field.
    if (!sources.length) {
      sources.push({ id: 'tree', resource: `git:tree@${snapshot.tree}`, title: `tree@${snapshot.tree.slice(0, 8)}` });
      defs.push(citeFootnote('tree', sources[0]!.title));
      bullets.push(`- Repository tree \`${snapshot.tree.slice(0, 12)}\`[^tree]`);
    }
    const body = ['# Layout', '', ...bullets, '', ...[...new Set(defs)], ''].join('\n');
    files.set(
      path,
      conceptFile({
        type: 'Turbine Layout',
        title: 'Repository layout',
        description: 'Mechanically observed layout of the repository',
        commit,
        turbineBy,
        verifyBy,
        contentKey: JSON.stringify({ layout: layout.map((f) => f.key), tree: snapshot.tree }),
        sources,
        body,
        verified: true,
        previous: input.previousFiles?.get(path),
      }),
    );
  }

  // --- packages ---
  const packages = snapshot.facts.filter((f) => f.category === 'package');
  for (const pkg of packages) {
    const name = String((pkg.data as { name?: string } | undefined)?.name ?? pkg.key.replace(/^package:/, ''));
    let path: string;
    try {
      path = turbineOkfConceptPath('Turbine Package', name);
    } catch {
      continue; // unsafe name skipped — never invent a path
    }
    const entries = snapshot.facts.filter((f) => f.category === 'entry-point' && f.source.path.startsWith(pkg.source.path.replace(/package\.json$/, '') || ''));
    const pkgDir = String((pkg.data as { dir?: string } | undefined)?.dir ?? '.');
    const scripts = snapshot.facts.filter(
      (f) => f.category === 'script' && String((f.data as { dir?: string } | undefined)?.dir ?? '.') === pkgDir,
    );
    const deps = snapshot.dependencies.filter((d) => d.workspace === pkgDir || d.workspace === name);
    const s = factSource(pkg, 'pkg');
    const sources = [s];
    const body = [
      '# Entry points',
      '',
      ...(entries.length ? entries.map((e) => {
        const es = factSource(e, 'ep');
        sources.push(es);
        return `- ${oneLine(e.statement)}[^${es.id}]`;
      }) : ['_None._']),
      '',
      '# Scripts',
      '',
      ...(scripts.length ? scripts.map((e) => {
        const es = factSource(e, 'sc');
        sources.push(es);
        return `- ${oneLine(e.statement)}[^${es.id}]`;
      }) : ['_None._']),
      '',
      '# Dependencies',
      '',
      ...(deps.length
        ? deps.slice(0, 40).map((d) => {
            const es = factSource({ source: d.declared.source }, 'dep');
            sources.push(es);
            return `- ${oneLine(d.statement)}[^${es.id}]`;
          })
        : ['_None._']),
      '',
      ...uniqueDefs(sources),
      '',
    ].join('\n');
    files.set(
      path,
      conceptFile({
        type: 'Turbine Package',
        title: name,
        description: `Package ${name}`,
        commit,
        blob: pkg.source.blob,
        turbineBy,
        verifyBy,
        contentKey: JSON.stringify({ key: pkg.key, blob: pkg.source.blob }),
        sources: uniqueSources(sources),
        body,
        verified: true,
        previous: input.previousFiles?.get(path),
      }),
    );
  }

  // --- commands ---
  const commands = [
    ...snapshot.facts.filter((f) => f.category === 'command'),
    ...snapshot.facts.filter((f) => f.category === 'script'),
  ];
  const seenCmd = new Set<string>();
  for (const c of commands) {
    const data = (c.data ?? {}) as { name?: string; script?: string; dir?: string };
    const name = String(data.name ?? data.script ?? c.key);
    const workspace = String(data.dir ?? '.');
    const conceptKey = workspace === '.' || workspace === '' ? name : `${workspace}/${name}`;
    if (seenCmd.has(conceptKey)) continue;
    seenCmd.add(conceptKey);
    let path: string;
    try {
      path = turbineOkfConceptPath('Turbine Command', conceptKey);
    } catch {
      continue;
    }
    const s = factSource(c, 'cmd');
    const body = ['# Command', '', `- ${oneLine(c.statement)}[^${s.id}]`, '', citeFootnote(s.id, s.title), ''].join('\n');
    files.set(
      path,
      conceptFile({
        type: 'Turbine Command',
        title: conceptKey,
        description: oneLine(c.statement).slice(0, 120),
        commit,
        blob: c.source.blob,
        turbineBy,
        verifyBy,
        contentKey: JSON.stringify({ key: c.key, workspace, blob: c.source.blob }),
        sources: [s],
        body,
        verified: true,
        previous: input.previousFiles?.get(path),
      }),
    );
  }

  // --- conventions (confirmed only) ---
  for (const c of snapshot.conventions.filter((x) => x.status === 'confirmed')) {
    let path: string;
    try {
      path = turbineOkfConceptPath('Turbine Convention', c.key);
    } catch {
      continue;
    }
    const s = factSource(c, 'conv');
    const body = ['# Convention', '', `- ${oneLine(c.statement)}[^${s.id}]`, '', citeFootnote(s.id, s.title), ''].join('\n');
    files.set(
      path,
      conceptFile({
        type: 'Turbine Convention',
        title: c.topic,
        description: oneLine(c.statement).slice(0, 120),
        commit,
        blob: c.source.blob,
        turbineBy,
        verifyBy,
        contentKey: JSON.stringify({ key: c.key, blob: c.source.blob }),
        sources: [s],
        body,
        verified: true,
        previous: input.previousFiles?.get(path),
      }),
    );
  }

  // --- open questions (unconfirmed only) ---
  const openItems: Array<UnconfirmedItem | Convention> = [
    ...snapshot.unconfirmed,
    ...snapshot.conventions.filter((c) => c.status === 'unconfirmed'),
  ];
  for (const item of openItems) {
    let path: string;
    try {
      path = turbineOkfConceptPath('Turbine Open Question', item.key);
    } catch {
      continue;
    }
    const s = factSource(item, 'oq');
    const reason = 'reason' in item ? item.reason : 'unconfirmed convention';
    const body = [
      '# Question',
      '',
      `- ${oneLine(item.statement)} (${oneLine(reason)})[^${s.id}]`,
      '',
      citeFootnote(s.id, s.title),
      '',
    ].join('\n');
    files.set(
      path,
      conceptFile({
        type: 'Turbine Open Question',
        title: item.key,
        description: oneLine(item.statement).slice(0, 120),
        commit,
        blob: item.source.blob,
        turbineBy,
        verifyBy,
        contentKey: JSON.stringify({ key: item.key, reason }),
        sources: [s],
        body,
        verified: false,
        previous: input.previousFiles?.get(path),
      }),
    );
  }

  // --- brief sections ---
  const sections = new Set(published.map((c) => c.claim.section));
  if (brief) {
    // Include configured sections even if empty when we know brief state — use claims' sections + common defaults from published only
  }
  for (const section of [...sections].sort()) {
    let path: string;
    try {
      path = turbineOkfConceptPath('Turbine Brief Section', section);
    } catch {
      continue;
    }
    const sectionClaims = published.filter((c) => c.claim.section === section);
    const sources: SourceAcc[] = [];
    const bullets: string[] = [];
    const defs: string[] = [];
    for (const sc of sectionClaims) {
      const e = sc.claim.evidence[0]!;
      const sid = sourceId('claim', e.path, e.blob);
      sources.push({ id: sid, resource: `git:${e.path}@${e.blob}`, title: `${e.path}@${e.blob.slice(0, 8)}` });
      const label = sc.status === 'attested' ? 'human-attested' : 'verified';
      bullets.push(`- ${oneLine(renderClaimLine(sc))} _[${label}]_[^${sid}]`);
      defs.push(citeFootnote(sid, `${e.path}@${e.blob.slice(0, 8)}`));
    }
    // Concept-level human review only when the whole section is covered (approved brief, or every claim attested).
    const allAttested = sectionClaims.length > 0 && sectionClaims.every((c) => c.status === 'attested');
    const humanVerified = approved || allAttested;
    const body = [
      '# Claims',
      '',
      ...(bullets.length ? bullets : ['No published claims in this section.']),
      '',
      ...[...new Set(defs)],
      '',
    ].join('\n');
    let humanId: string | undefined;
    if (humanVerified) {
      if (brief?.approvedBy) humanId = okfHumanActor(brief.approvedBy);
      else {
        const fromReason = sectionClaims.find((c) => c.status === 'attested')?.reason?.match(/by ([^,]+)/)?.[1]?.trim();
        if (fromReason) humanId = okfHumanActor(fromReason);
      }
    }
    files.set(
      path,
      conceptFile({
        type: 'Turbine Brief Section',
        title: section,
        description: `Brief section ${section}`,
        commit,
        turbineBy,
        verifyBy,
        contentKey: JSON.stringify({
          section,
          ids: sectionClaims.map((c) => c.claim.id),
          approved,
        }),
        sources: uniqueSources(sources),
        body,
        verified: sectionClaims.length > 0,
        humanVerified,
        humanId,
        verifiedAt: humanVerified ? brief?.approvedAt ?? undefined : undefined,
        status: approved ? 'stable' : 'draft',
        previous: input.previousFiles?.get(path),
        allowEmptySources: true,
      }),
    );
  }

  // --- log.md ---
  const today = utcDateFromCommit(commit);
  const prev = (input.previousLogBody ?? '').replace(/^\s*# Directory Update Log\s*/i, '').trimStart();
  const prevWithoutToday = stripLogDay(prev, today, commit);
  const alreadyLogged = new Set<string>();
  for (const m of prevWithoutToday.matchAll(/Claim `([^`]+)` removed/g)) alreadyLogged.add(m[1]!);
  const logEntries: string[] = [];
  for (const w of withdrawn) {
    if (alreadyLogged.has(w.id)) continue;
    logEntries.push(`* **Withdrawal**: Claim \`${w.id}\` removed from brief section \`${w.section}\`: ${oneLine(w.reason)}`);
  }
  logEntries.push(
    `* **Update**: Knowledge bundle rebuilt for commit \`${commit.slice(0, 12)}\` (snapshot \`${snapshot.hash.replace(/^sha256:/, '').slice(0, 8)}\`).`,
  );
  const maxLog = 400 * 1024;
  const updateLine = logEntries[logEntries.length - 1]!;
  let withdrawals = logEntries.slice(0, -1);
  let history = prevWithoutToday;
  const build = () =>
    [`# Directory Update Log`, '', `## ${today}`, ...withdrawals, updateLine, '', history].join('\n');
  let combined = build();
  while (Buffer.byteLength(combined, 'utf8') > maxLog) {
    if (history.trim()) {
      const cut = history.lastIndexOf('\n## ');
      history = cut >= 0 ? history.slice(0, cut).replace(/\n+$/, '\n') : '';
    } else if (withdrawals.length > 1) {
      // Drop oldest new withdrawals; full audit remains in the store.
      const omitted = withdrawals.length - 1;
      withdrawals = [
        `* **Withdrawal**: ${omitted} older withdrawal(s) omitted from log.md (still in the store).`,
        withdrawals[withdrawals.length - 1]!,
      ];
    } else if (withdrawals.length === 1) {
      withdrawals = [`* **Withdrawal**: withdrawal details omitted from log.md (still in the store).`];
    } else {
      break;
    }
    combined = build();
    if (!history.trim() && withdrawals.length <= 1 && Buffer.byteLength(combined, 'utf8') > maxLog) {
      combined = [`# Directory Update Log`, '', `## ${today}`, updateLine, ''].join('\n');
      break;
    }
  }
  files.set('log.md', combined.replace(/\n+$/, '\n'));


  return files;
}

function renderClaimLine(sc: StoredClaim): string {
  // Prefer verifier template text without importing the full brief-render (circular). Inline minimal.
  const v = sc.claim.verifier;
  switch (v.kind) {
    case 'exists':
      return v.symbol ? `\`${v.path}\` exports \`${v.symbol}\`` : `\`${v.path}\` is a tracked file`;
    case 'quote':
      return `Quoted at \`${sc.claim.evidence[0]?.path ?? 'source'}\``;
    case 'imports':
      return `\`${v.from}\` imports \`${v.specifier}\``;
    case 'calls':
      return `\`${v.path}\` calls \`${v.callee}\``;
    case 'config':
      return `\`${v.path}\` has \`${v.key.join('.')}\` = \`${JSON.stringify(v.value)}\``;
    case 'dependency':
      return `Depends on \`${v.name}\` \`${v.spec}\``;
    case 'command':
      return `Script \`${v.script}\` runs \`${oneLine(v.command)}\``;
    case 'absence':
      return v.pattern.type === 'literal'
        ? `No tracked file contains \`${oneLine(v.pattern.text)}\``
        : `No JS/TS source imports \`${v.pattern.specifier}\``;
    default:
      return sc.claim.statement;
  }
}

function conceptFile(input: {
  type: string;
  title: string;
  description: string;
  commit: string;
  blob?: string;
  turbineBy: string;
  verifyBy: string;
  contentKey: string;
  sources: SourceAcc[];
  body: string;
  verified: boolean;
  humanVerified?: boolean;
  humanId?: string;
  verifiedAt?: string;
  status?: string;
  previous?: string;
  allowEmptySources?: boolean;
}): string {
  void input.contentKey;
  const prevAt = extractGeneratedAt(input.previous);
  const contentChanged = !input.previous || extractBody(input.previous) !== input.body || extractTitle(input.previous) !== input.title;
  const at = generatedAtFor(prevAt, contentChanged);
  const fm: Record<string, unknown> = {
    type: input.type,
    title: input.title,
    description: input.description,
    generated: { by: input.turbineBy, at },
    'x-turbine-commit': input.commit,
  };
  if (input.blob) fm['x-turbine-blob'] = input.blob;
  if (input.status) fm.status = input.status;
  if (input.sources.length) {
    fm.sources = input.sources.map((s) => ({ id: s.id, resource: s.resource, title: s.title }));
  } else if (!input.allowEmptySources) {
    fm.sources = [{ id: 'commit', resource: `git:commit@${input.commit}`, title: `commit@${input.commit.slice(0, 8)}` }];
  }
  if (input.verified) {
    if (input.humanVerified && input.humanId) {
      const by = input.humanId.startsWith('human:') ? okfHumanActor(input.humanId) : okfHumanActor(input.humanId);
      fm.verified = { by, at: input.verifiedAt ?? at };
    } else {
      fm.verified = { by: input.verifyBy, at };
    }
  }
  // Extension keys are preserved at publish time via the YAML Document API (OKF §4.1).
  return `${emitFrontmatter(fm)}\n${input.body}`;
}

function uniqueSources(sources: SourceAcc[]): SourceAcc[] {
  const seen = new Set<string>();
  const out: SourceAcc[] = [];
  for (const s of sources) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

function uniqueDefs(sources: SourceAcc[]): string[] {
  return uniqueSources(sources).map((s) => citeFootnote(s.id, s.title));
}

function extractGeneratedAt(file?: string): string | undefined {
  if (!file) return undefined;
  const m = file.match(/generated:\s*\{[^}]*\bat:\s*"([^"]+)"/);
  return m?.[1];
}

function extractTitle(file?: string): string | undefined {
  if (!file) return undefined;
  const split = splitFrontmatter(file);
  if (!split.ok) return undefined;
  return typeof split.data.title === 'string' ? split.data.title : undefined;
}

function extractBody(file?: string): string | undefined {
  if (!file) return undefined;
  const idx = file.indexOf('\n---\n');
  if (idx < 0) return undefined;
  return file.slice(idx + 5);
}


function utcDateFromCommit(commit: string): string {
  // Stable date from commit id so same commit → same log heading.
  const n = Number.parseInt(commit.slice(0, 8), 16);
  const day = (n % 28) + 1;
  return `2020-01-${String(day).padStart(2, '0')}`;
}

function stripLogDay(prev: string, day: string, commit: string): string {
  if (!prev.trim()) return '';
  const parts = prev.split(/^## /m);
  const kept: string[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const lines = part.split('\n');
    const heading = lines[0]!.trim();
    const body = lines.slice(1).join('\n');
    if (heading === day && body.includes(commit.slice(0, 12))) continue;
    kept.push(`## ${part.trimEnd()}`);
  }
  return kept.length ? `${kept.join('\n\n')}\n` : '';
}

/** Content fingerprint of a rendered bundle (paths + bytes), for up-to-date checks. */
export function bundleContentHash(files: BundleFiles): string {
  const parts = [...files.entries()]
    .filter(([p]) => p !== 'log.md') // log may append; compare concepts separately
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, body]) => `${p}\n${contentHashText(body)}`);
  return contentHashText(parts.join('\n'));
}

export function trustTierOfFile(frontmatter: Record<string, unknown>): ReturnType<typeof okfTrustTier> {
  return okfTrustTier({
    generated: frontmatter.generated as { by?: string; at?: string } | undefined,
    verified: frontmatter.verified,
  });
}
