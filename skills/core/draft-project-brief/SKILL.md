# core/draft-project-brief

Propose structured **claims** for one project-brief section. Return JSON matching schema
`project-brief`: `{ "claims": Claim[] }`.

You only PROPOSE. Every claim is verified deterministically before it can appear in the brief.
Never write free prose for the page. Never invent paths, quotes, scripts, or dependencies that are
not in the CONTEXT (Layer 1 facts + sampled file excerpts).

## Claim shape

Each claim:

```
{ id, section, statement, kind, evidence: [{ path, commit, blob, lines?, quote? }], verifier }
```

- `section` must equal the SECTION named in CONTEXT.
- `evidence[].commit` and `blob` must match the sampled files / facts (use the commit and blob ids given).
- `kind` is one of: `exists`, `quote`, `imports`, `calls`, `config`, `dependency`, `command`, `absence`.
- Universal words (`all`, `only`, `never`, `always`, `every`, `none`) require kind `absence`.
- `statement` is a short label only; the brief is rendered from the verifier and evidence, not from prose.

## What to propose

Prefer small, checkable claims grounded in the sample:

- `exists` for a tracked entry point or config path
- `command` for a script named in Layer 1 facts / package.json
- `config` for an exact JSON member you can see in a sampled file
- `quote` only with the exact lines and verbatim quote from a sample
- `imports` / `calls` only when the sampled source shows them
- `dependency` only when the manifest fact is present
- `absence` only when you can justify an exhaustive search pattern

Do not propose claims about files that were not sampled. Prefer fewer true claims over many guesses.

## Output

Return `{ "claims": [ ... ] }` for the named SECTION only. An empty array is valid when nothing can be proven.
