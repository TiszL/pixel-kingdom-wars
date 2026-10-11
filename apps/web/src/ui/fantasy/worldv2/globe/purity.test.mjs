// Chunk A stays a self-contained renderer: no React, store, API client, shared game data or first-paint module is
// imported, and nothing the port was told to drop comes back. Why: the globe is a lazy chunk (first paint must not
// grow, plan §1 and R18), the server is authoritative (the globe renders; it never fetches game state), and the
// concept's relief pipeline, deed-detail tiles, demo bases and Google Fonts link are out by decision (PLAN.md §3 L3;
// the Seeker pack forbids fonts.googleapis.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const sources = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).concat(['flat.glsl.js']);
const text = f => readFileSync(new URL(f, dir), 'utf8');

test('the globe modules import only each other, the frozen geography and (lazily) the island effects', () => {
  const allowed = new Set(['./flat.glsl.js', './glsl.mjs', './pin.mjs', './camera.mjs', './motion.mjs', './picking.mjs', './content.mjs', './labels.mjs', '../../runtime/geography/frozen-runs.mjs', '../../runtime/island-effects.mjs']);
  for (const f of sources) for (const m of text(f).matchAll(/(?:import\s[^'"]*from\s*|import\()\s*['"]([^'"]+)['"]/g))
    assert.ok(allowed.has(m[1]), `${f} imports ${m[1]}`);
  assert.match(text('globe.mjs'), /import\('\.\.\/\.\.\/runtime\/island-effects\.mjs'\)/, 'the 57 KB effects table stays out of chunk A (dynamic import)');
});

test('dropped concept pieces stay dropped: relief, deed-detail tiles, demo bases, Google Fonts, pre-decision copy', () => {
  // (flat.glsl.js is excluded: it is the pinned shader, byte-locked by stages.test.mjs; its comments name the relief pass)
  for (const f of sources.filter(x => x !== 'flat.glsl.js')) {
    const s = text(f);
    for (const bad of ['fonts.googleapis', 'generateDemoBases', 'demoBases', 'TERRAIN2', 'deedDetail', 'heightAt(', 'PHASE E', 'Proposed placement', 'In range', 'prototype data'])
      assert.ok(!s.includes(bad), `${f} carries "${bad}"`);
  }
});

test('the globe fetches nothing but pack files and the host reader (no API route)', () => {
  const s = text('globe.mjs');
  assert.deepEqual([...s.matchAll(/fetch\(([^,)]+)/g)].map(m => m[1].trim()), ['url(path']);
  assert.ok(!/\/api\/|\/globe\/fantasy/.test(s));
});
