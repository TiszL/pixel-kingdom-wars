/**
 * First-paint budget. Fails the build if the bytes a NEW player must download
 * before anything renders exceed the budget below.
 *
 * This exists because a 6.9 MB entry chunk shipped without anyone noticing.
 * Vite's chunkSizeWarningLimit was set to 2048 and warnings scroll past; a
 * failing check does not.
 *
 * WHAT IT MEASURES: every JS file index.html references — the entry plus its
 * modulepreload set — gzipped, because gzipped is what crosses the network.
 * Lazily-loaded chunks (the Phaser engine) are deliberately NOT counted: the
 * point of splitting them out was that a player reaching the title screen never
 * pays for them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoCandidateArt } from './candidate-art-gate.mjs';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const RETIRED_RUNTIME_ASSET = /(?:trp_wyrmling|fx_breath_wyrm)/i;
const RETIRED_RUNTIME_URL = /(?:trp_wyrmling|fx_breath_wyrm)[^"'`\s]*\.svg/i;

// Local provider-art approval builds carry a loud marker in generated atlas meta.
// Vite copies public/ byte-for-byte, so refusing it here prevents a developer
// from accidentally packaging proof art even when production did not inherit
// the environment variable that originally enabled the candidate rasterizer.
const atlasMetaPath = join(DIST, 'atlas', 'meta.json');
try {
  assertNoCandidateArt(atlasMetaPath);
} catch (error) {
  console.error(`\n  FAIL: ${error instanceof Error ? error.message : String(error)}.`);
  console.error('  Regenerate atlases without SHARDKEEP_ART_CANDIDATE_ROOT before building.\n');
  process.exit(1);
}

/**
 * KB gzip. Set just above the measured value at the time of writing (956 KB)
 * so ordinary churn passes and a regression does not.
 *
 * This is a CEILING, not a target. The remaining bulk is Privy plus the EVM
 * crypto it drags in (ccip, secp256k1) on the critical path of a Solana-only
 * game; deferring it is worth roughly another 300 KB and is tracked in
 * docs/archive/operations/launch-readiness-2026-08.md. Lower this number when
 * that historical optimization target lands.
 */
const BUDGET_KB = 1000;

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const referenced = [...html.matchAll(/assets\/[^"']+\.js/g)].map((m) => m[0]);
const unique = [...new Set(referenced)];

if (unique.length === 0) {
  console.error('size-check: index.html references no JS — did the build run?');
  process.exit(1);
}

let total = 0;
const rows = unique.map((rel) => {
  const bytes = gzipSync(readFileSync(join(DIST, rel))).length;
  total += bytes;
  return { rel, kb: Math.round(bytes / 1024) };
}).sort((a, b) => b.kb - a.kb);

const totalKb = Math.round(total / 1024);
for (const r of rows.slice(0, 8)) console.log(`  ${String(r.kb).padStart(5)} KB  ${r.rel}`);
if (rows.length > 8) console.log(`  … ${rows.length - 8} smaller`);
console.log(`\n  first-paint JS: ${totalKb} KB gzip  (budget ${BUDGET_KB} KB)\n`);

// Report the lazy chunks too — informational. A split that quietly stopped
// splitting would show up here as an empty list long before players noticed.
const lazy = readdirSync(join(DIST, 'assets'))
  .filter((f) => f.endsWith('.js') && !unique.includes(`assets/${f}`))
  .map((f) => ({ f, kb: Math.round(gzipSync(readFileSync(join(DIST, 'assets', f))).length / 1024) }))
  .sort((a, b) => b.kb - a.kb);
if (lazy[0]) console.log(`  largest lazy chunk: ${lazy[0].kb} KB  assets/${lazy[0].f}  (not counted)`);

// Source filtering must happen before Vite's eager import graph is created.
// Merely refusing a key at runtime still publishes the deprecated bytes, where
// a future resolver or old controller can accidentally request them.
const retired = readdirSync(join(DIST, 'assets')).filter((file) => RETIRED_RUNTIME_ASSET.test(file));
if (retired.length > 0) {
  console.error(`\n  FAIL: production emitted retired runtime assets: ${retired.join(', ')}`);
  process.exit(1);
}
const retiredRefs = readdirSync(join(DIST, 'assets'))
  .filter((file) => /\.(?:js|css|html|json)$/.test(file))
  .filter((file) => RETIRED_RUNTIME_URL.test(readFileSync(join(DIST, 'assets', file), 'utf8')));
if (retiredRefs.length > 0) {
  console.error(`\n  FAIL: production code still references retired runtime assets: ${retiredRefs.join(', ')}`);
  process.exit(1);
}

if (totalKb > BUDGET_KB) {
  console.error(`\n  FAIL: first-paint JS is ${totalKb} KB, over the ${BUDGET_KB} KB budget.`);
  console.error('  Either split something out of the entry graph, or raise the budget');
  console.error('  DELIBERATELY in this file with a note saying why.\n');
  process.exit(1);
}
