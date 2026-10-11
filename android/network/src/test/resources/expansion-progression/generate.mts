/** Test-only reference: run with source tsx and an explicit source checkout. Never exports a pack. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = path.resolve(process.argv[2]!);
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { CAPS, GRID, PLOT_GEOMETRY, STRUCTURES, BUILDING_GEOMETRY, BUILD_COSTS, BUILD_COUNT_CAP_BY_KEEP } = await load('packages/shared/src/constants.ts');
const { claimRect } = await load('apps/api/src/game/footprints.ts');
const { plotVersionForClaim, plotBounds } = await load('packages/shared/src/plotGeometry.ts');
const { expansionOffer } = await load('apps/api/src/money/expansion.ts');
const cases = Array.from({ length: CAPS.expansionsMax + 1 }, (_, expansions) => {
  const claim = claimRect(expansions);
  const plotVersion = plotVersionForClaim(claim);
  return { expansions, claim, plotVersion, plot: plotBounds(plotVersion),
    offer: expansions === CAPS.expansionsMax ? null : expansionOffer(expansions, STRUCTURES.keep.maxLevel) };
});
const sourceFiles = ['packages/shared/src/constants.ts', 'packages/shared/src/plotGeometry.ts', 'apps/api/src/game/footprints.ts', 'apps/api/src/money/expansion.ts'];
const output = { schemaVersion: 1, sourceHashes: Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(readFileSync(path.join(source, file))).digest('hex')])),
  catalogue: { constants: { CAPS, GRID, PLOT_GEOMETRY, STRUCTURES: { keep: STRUCTURES.keep, wall: STRUCTURES.wall }, BUILDING_GEOMETRY,
    BUILD_COSTS: { wall: BUILD_COSTS.wall }, BUILD_COUNT_CAP_BY_KEEP: { wall: BUILD_COUNT_CAP_BY_KEEP.wall } } }, cases };
const filename = new URL('./source-reference.json', import.meta.url);
const encoded = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(filename, 'utf8') !== encoded) throw new Error('Expansion fixture differs from current source; review before regenerating');
} else writeFileSync(filename, encoded);
console.log(JSON.stringify({ cases: cases.length, finalClaim: cases.at(-1), sourceHashes: output.sourceHashes }));
