/**
 * The path-keyword match: tracked files whose path mentions DISTINCTIVE words of the request.
 * Words are weighted by rarity across the repository (IDF), so a word that is in many paths ("section",
 * "content") cannot pull in unrelated files. This is the weakest relevance signal: a path containing a
 * word proves nothing about what the file does.
 *
 * The rule (stated wherever its result is shown):
 *   - words are 4+ characters, from the request, minus a stop list;
 *   - a word counts only if it is in at least one path and in at most 3% of the candidate paths;
 *   - a file's weight is the sum of ln(paths / paths-containing-the-word) over the words its path contains;
 *   - only files within half of the best weight are kept.
 */

export const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'add', 'update', 'make', 'user', 'users', 'can', 'should', 'when', 'will', 'new', 'all', 'not']);

export type PathWordMatch = {
  path: string;
  weight: number;
  /** Words found in the path, with how many candidate paths contain each, and how many paths there are. */
  words: Array<{ word: string; files: number; of: number }>;
};

/** Files that carry no information about the task by their path (dependencies, build output, binaries). */
export function isPathWordCandidate(path: string): boolean {
  return !/(^|\/)(node_modules|dist|build|\.next|coverage|public)\//.test(path) && !/\.(lock|png|jpe?g|svg|ico|woff2?|gif|webp|mp4)$/.test(path);
}

export function pathWordMatches(allFiles: string[], requestText: string): PathWordMatch[] {
  const words = [...new Set(requestText.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])].filter((w) => !STOP_WORDS.has(w));
  if (!words.length) return [];
  const files = allFiles.filter((f) => f && isPathWordCandidate(f));
  if (!files.length) return [];
  const lower = files.map((f) => f.toLowerCase());
  const idf = new Map<string, { weight: number; files: number }>();
  for (const w of words) {
    const df = lower.filter((f) => f.includes(w)).length;
    // Ignore words that match nothing or are everywhere (>3% of files).
    if (df > 0 && df / files.length <= 0.03) idf.set(w, { weight: Math.log(files.length / df), files: df });
  }
  const scored = files
    .map((path, i) => {
      const hit = [...idf.entries()].filter(([w]) => lower[i]!.includes(w));
      return {
        path,
        weight: hit.reduce((sum, [, v]) => sum + v.weight, 0),
        words: hit.map(([word, v]) => ({ word, files: v.files, of: files.length })),
      };
    })
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  const top = scored[0]?.weight ?? 0;
  return scored.filter((x) => x.weight >= top * 0.5);
}
