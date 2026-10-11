import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_FILE, cssVars, hudTokens } from './world-hud.mjs';

// Why: HudStyleTest, RealmHudModelTest and GlobeHudPlanTest trust this reference as "the approved web HUD at the pin".
// A reference that was hand-edited, produced by a different exporter, or silently emptied would let the Kotlin HUD
// drift while every JVM test stays green. The source-dependent re-export (`--check`) is a local gate step; these checks
// need no source checkout.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ref = JSON.parse(fs.readFileSync(path.join(ROOT, OUT_FILE), 'utf8'));
const sha256 = b => createHash('sha256').update(b).digest('hex');

test('the reference names its pin and was written by this exact exporter', () => {
  assert.match(ref.header.pin, /^[0-9a-f]{40}$/);
  assert.equal(ref.header.suite, 'world-hud');
  assert.equal(ref.header.generatorSha256, sha256(fs.readFileSync(path.join(ROOT, 'tools/world-hud.mjs'))),
    'tools/world-hud.mjs changed without re-exporting the reference (node tools/world-hud.mjs --source <globe repo> --pin <sha>)');
});

test('the token export carries the whole game palette and the forged bevels', () => {
  const root = ref.tokens.root;
  for (const k of ['--sk-bg', '--sk-gold', '--sk-gold-hi', '--hud-ink', '--hud-stone', '--hud-bevel-stone', '--hud-bevel-gold', '--hud-rim', '--hud-fs-ui'])
    assert.ok(root[k], `missing ${k}`);
  assert.equal(root['--sk-gold'], '#e3ae3c');
  assert.equal(ref.tokens.media.dppx2['--hud-fs-body'], '18px');
  assert.equal(Object.keys(ref.realms).length, 8);
});

test('the approved chips are all six, with the three data-less ones present for the hide rule (D-169)', () => {
  assert.deepEqual(ref.chips.map(c => c.id), ['all', 'mine', 'clan', 'attack', 'shield', 'lvl']);
});

test('golden vectors are present and non-trivial', () => {
  assert.ok(ref.vectors.scaleBar.length > 400);
  assert.ok(ref.vectors.clusters.every(c => c.list.length > 0 && c.onScreen === c.list.reduce((a, x) => a + x.n, 0)));
  assert.ok(ref.vectors.labels.some(l => l.out === null) && ref.vectors.labels.some(l => l.out !== null));
});

test('the CSS variable reader keeps commas and nested parentheses inside a value', () => {
  assert.deepEqual(cssVars('--a:#fff;--b:rgba(1,2,3,.5);--c:inset 1px 1px 0 #000,inset -1px 0 0 #111'),
    { '--a': '#fff', '--b': 'rgba(1,2,3,.5)', '--c': 'inset 1px 1px 0 #000,inset -1px 0 0 #111' });
  const css = ':root{--x:1px}@media (min-resolution:2dppx){:root{--x:2px}}@media (orientation:portrait){:root{--y:var(--x)}}'
    + '@media (orientation:landscape) and (max-height:520px){:root{--z:3px}}';
  assert.deepEqual(hudTokens(css), { root: { '--x': '1px' }, media: { dppx2: { '--x': '2px' }, portrait: { '--y': 'var(--x)' }, shortLandscape: { '--z': '3px' } } });
});
