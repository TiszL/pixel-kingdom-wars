/**
 * DETERMINISM GUARD #2 — the simulator's TRANSITIVE module graph.
 *
 * WHY THIS EXISTS SEPARATELY FROM banned-tokens.test.ts.
 *
 * banned-tokens.test.ts reads the TEXT of every file in packages/sim/src. That
 * catches a banned token written HERE and nothing else. It is completely blind to
 * a banned token that arrives by IMPORT — and one nearly did: WORLDMAP-GLOBE-PLAN
 * added `export * from './globe'` and `export * from './earthMask'` to
 * `@shardkeep/shared`'s barrel, which sim.ts and stats.ts import. That put the
 * globe's trig (Math.sin / Math.atan2 / Math.hypot) and a base64 land-mask decode
 * at module load inside the simulator's graph, while the text scan stayed green.
 * The plan's own guard was named — "packages/sim must never import globe.ts" — and
 * nothing enforced it, so the invariant held by luck for one commit.
 *
 * WHAT IT ASSERTS. Starting from packages/sim/src/index.ts, follow every static
 * import/export specifier and every dynamic `import()` through relative paths and
 * through `@shardkeep/shared` (barrel and subpaths). The reachable set must not
 * contain globe.ts or either earth mask. It is deliberately a GRAPH walk and not a
 * grep for the word "globe": the defect was a module reached three hops away
 * through a barrel, which no grep of sim's own source could ever see.
 *
 * The reachable set is also asserted to be non-empty and to contain the modules we
 * know are there, so a resolver bug cannot make this test pass by walking nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SIM_ENTRY = resolve(__dirname, '..', 'src', 'index.ts');
const SHARED_SRC = resolve(__dirname, '..', '..', 'shared', 'src');

/** Every module specifier in a source file: `from '…'`, bare `import '…'`, and
 *  `import('…')`. Quotes only — a computed specifier is not something we do. */
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*)\(?\s*['"]([^'"]+)['"]/g;

/** Resolve a specifier to a file on disk, or null if it leaves the workspace
 *  (npm packages — they cannot reach shared/globe.ts and are not our concern). */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith('.')) return withExt(resolve(dirname(fromFile), spec));
  // The one workspace dependency sim has. '@shardkeep/shared' → the barrel;
  // '@shardkeep/shared/globe' → src/globe.ts (package.json `exports`).
  if (spec === '@shardkeep/shared') return join(SHARED_SRC, 'index.ts');
  if (spec.startsWith('@shardkeep/shared/')) {
    return withExt(join(SHARED_SRC, spec.slice('@shardkeep/shared/'.length)));
  }
  return null;
}

function withExt(base: string): string | null {
  for (const p of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(p)) return p;
  return null;
}

/** Transitive closure of static + dynamic imports from `entry`. */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SPECIFIERS)) {
      const next = resolveSpecifier(file, m[1]!);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const graph = moduleGraph(SIM_ENTRY);
const rel = (p: string): string => p.slice(resolve(__dirname, '..', '..', '..').length + 1);

describe("the simulator's transitive imports", () => {
  it('walks a real graph (guard against a resolver that reaches nothing)', () => {
    // If this ever shrinks to sim's own files, the shared resolution above broke
    // and every assertion below would pass vacuously.
    expect(graph.size).toBeGreaterThanOrEqual(8);
    expect([...graph].map(rel)).toContain('packages/shared/src/index.ts');
    expect([...graph].map(rel)).toContain('packages/shared/src/constants.ts');
  });

  it('never reaches the globe or the earth masks', () => {
    // WHY IT MATTERS: the simulator must replay bit-identically on every engine
    // forever, and a golden replay is only as trustworthy as the code that can run
    // during it. globe.ts is trig by design (legal there — it is presentation and
    // placement, never a rule) and earthMask*.ts decodes a bitmask at module load.
    // Neither may be reachable from the deterministic replay path, and only a
    // graph walk can tell: the barrel that pulled them in is two hops from sim.
    // earthCountries*.ts are the same shape of hazard (a base64 decode plus a
    // string-table parse at module load) and, being generated, are exactly what a
    // future `export *` would drag in without anyone noticing.
    // parcelGrid.ts is worse than any of them: it imports the fine mask AND the
    // fine country index, and its first call streams 59,071 cells — a cost no
    // deterministic replay should be able to pay by accident.
    const banned = [
      'globe.ts',
      'earthMask.ts',
      'earthMaskFine.ts',
      'earthCountries.ts',
      'earthCountriesFine.ts',
      'parcelGrid.ts',
    ];
    const reached = [...graph].map(rel).filter((p) => banned.some((b) => p.endsWith(`/${b}`)));
    expect(
      reached,
      reached.length > 0
        ? `packages/sim can reach ${reached.join(', ')} — import it from '@shardkeep/shared/globe' at the CALL SITE, never re-export it from the shared barrel (see packages/shared/src/index.ts)`
        : undefined,
    ).toEqual([]);
  });
});
