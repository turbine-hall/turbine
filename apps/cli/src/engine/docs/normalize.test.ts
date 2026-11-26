import { describe, expect, it } from 'vitest';
import { extractRequestItems } from './normalize.js';
import { parseSpecMarkdown, sectionBody } from '../packet.js';

describe('extractRequestItems', () => {
  it('keeps single-line bullets as one item each', () => {
    const items = extractRequestItems('# T\n\n- Alpha feature\n- Beta feature\n');
    expect(items).toEqual([
      { id: 'R1', text: 'Alpha feature' },
      { id: 'R2', text: 'Beta feature' },
    ]);
  });

  it('keeps continuation lines on the same item until the next bullet', () => {
    const items = extractRequestItems(
      [
        '# Refresh',
        '',
        '- Refresh attendance when the page opens',
        '  Must use the existing session cookie',
        '  Timeout after 30s',
        '- Show last refreshed timestamp',
      ].join('\n'),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: 'R1',
      text: 'Refresh attendance when the page opens\n  Must use the existing session cookie\n  Timeout after 30s',
    });
    expect(items[1]).toEqual({ id: 'R2', text: 'Show last refreshed timestamp' });
  });
});

describe('sectionBody / parseSpecMarkdown vs Original request', () => {
  it('ignores ATX headings inside Original request and uses the generated Requirements section', () => {
    const md = [
      '# Spec — Trap',
      '',
      '## Original request',
      '',
      '\\## Requirements',
      '',
      '- **FR-999** (P0, behavioral): WHEN fake THE SYSTEM SHALL ignore',
      '',
      '## Requirements (1)',
      '',
      '- **FR-001** (P0, behavioral): WHEN real THE SYSTEM SHALL win',
      '',
      '## Open questions',
      '',
      '- _None_',
      '',
      '## Non-goals',
      '',
      '- _None_',
      '',
      '## Context',
      '',
      '- ✅ Verified — package.json _(git)_',
      '',
      '## Decisions',
      '',
    ].join('\n');

    expect(sectionBody(md, 'Requirements')).toContain('FR-001');
    expect(sectionBody(md, 'Requirements')).not.toContain('FR-999');
    const parsed = parseSpecMarkdown(md);
    expect(parsed.requirements.map((r) => r.id)).toEqual(['FR-001']);
  });

  it('prefers the last matching section when the request embeds an unescaped heading', () => {
    const md = [
      '## Original request',
      '',
      '## Requirements',
      '',
      '- **FR-BAD** (P0, behavioral): WHEN bad THE SYSTEM SHALL lose',
      '',
      '## Requirements (1)',
      '',
      '- **FR-001** (P0, behavioral): WHEN good THE SYSTEM SHALL win',
      '',
      '## Open questions',
      '',
      '- _None_',
      '',
      '## Context',
      '',
      '- _None_',
      '',
      '## Non-goals',
      '',
      '- _None_',
      '',
    ].join('\n');
    expect(parseSpecMarkdown(md).requirements.map((r) => r.id)).toEqual(['FR-001']);
  });
});
