// Chunk B as Vite ships it (build-check.support.mjs). Why:
//   * loader.mjs decodes every PNG in a blob: Worker that runs the minified pngCore/imgCore source text. If the minifier
//     hoists or renames anything across them, every decode silently falls back to the main thread (the D-167 50 ms
//     stalls come back) — so the check runs on the real minified output, as build-realm.mjs's did;
//   * the plan's lazy budget: chunk B ≤ 240 KB gzip with everything the dive loads (first paint never carries it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChunkB, checkPngWorker, CHUNK_B_BUDGET_KB } from './build-check.support.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the minified PNG worker stays self-contained, and chunk B fits its lazy budget', async () => {
  const r = await buildChunkB();
  console.log(`chunk B: ${r.eagerGzKb} KB gz at the import, ${r.allGzKb} KB gz with the dive (${r.chunks.length} chunks)`);
  assert.equal(r.worker, null, `PNG worker: ${r.worker}`);
  assert.ok(r.allGzKb <= CHUNK_B_BUDGET_KB, `chunk B ${r.allGzKb} KB gz > ${CHUNK_B_BUDGET_KB}`);
  for (const lane of ['ground', 'life', 'bases', 'ui']) assert.ok(r.chunks.some(c => c.file.startsWith(`${lane}-`) && !c.eager), `${lane} is its own lazy chunk`);
  assert.ok(r.chunks.every(c => c.eager === (c.file === 'realm-view.js')), 'only the adapter loads at the import; the engine at enter');
});

test('teeth: a worker core that reaches outside its body is caught', async () => {
  const d = mkdtempSync(join(tmpdir(), 'wv2-worker-')), f = join(d, 'x.js');
  try {
    writeFileSync(f, 'const K=1;async function p(b,s,c,z){return K}const w=`const pngCore=${p};const imgCore=${p}`;');
    assert.match(await checkPngWorker([f]), /K is not defined/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
