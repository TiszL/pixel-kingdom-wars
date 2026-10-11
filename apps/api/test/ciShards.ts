/** Duration-balanced API shards for CI (`vitest run --shard=i/n`, see vitest.config.ts).
 *
 * 2026-10-10 (release/r2-j-ci-shard-harness): vitest's default sharding sorts files by a
 * hash of their path and cuts the list into equal FILE counts, ignoring how long a file
 * takes. API files range from under 1 s to 27 min, so the 16 shards of one run measured
 * 32-115 min (CI run 38043546234) and shard 5 hit the 120-minute job limit and was
 * cancelled after 42 of its 53 files. This packs files by measured duration instead
 * (longest first, each onto the least-loaded shard), which with the committed timings
 * puts every shard within a minute of the 69-minute mean.
 *
 * Every job computes the same plan from the same file list, so each file runs in exactly
 * one shard (scripts/src/ci-api-shards.test.ts pins that). A file missing from the
 * timings (a new test) gets the median measured cost, so it is still scheduled.
 * Refresh the timings from a complete run with scripts/ci-api-shard-timings.mjs. */
import { readFileSync } from 'node:fs';

export type ApiShardTimings = { source: string; seconds: Record<string, number> };

export function loadApiShardTimings(): ApiShardTimings {
  return JSON.parse(readFileSync(new URL('./ci-shard-timings.json', import.meta.url), 'utf8')) as ApiShardTimings;
}

/** Files are paths relative to apps/api with forward slashes, e.g. `test/alpha.test.ts`.
 * Returns `count` shards whose disjoint file lists together hold every input file once,
 * each with its planned duration in seconds. */
export function planApiShards(files: readonly string[], count: number, seconds: Readonly<Record<string, number>>): { files: string[]; seconds: number }[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const measured = Object.values(seconds).sort((a, b) => a - b);
  const fallback = measured.length ? measured[Math.floor(measured.length / 2)]! : 1;
  const cost = (file: string) => (Object.hasOwn(seconds, file) ? seconds[file]! : fallback);
  // No match at all means the path keys drifted (e.g. a vitest moduleId change), which
  // would silently fall back to count-based packing. Fail instead.
  if (files.length && !files.some(file => Object.hasOwn(seconds, file))) throw new Error('no API test file matches a measured duration; check the timing keys');
  // Sort before packing so the plan never depends on the order the runner globbed files in.
  const order = [...new Set(files)].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  for (const file of order) {
    let target = shards[0]!;
    for (const shard of shards) if (shard.seconds < target.seconds) target = shard;
    target.files.push(file);
    target.seconds += cost(file);
  }
  return shards;
}
