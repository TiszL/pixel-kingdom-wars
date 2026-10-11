// The web port's own pins (patches.md). Each names the regression it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createCamera, landing } from './camera.mjs';
import { BANDS } from './contracts.mjs';
import { PACK_ROOT } from './test-pack.support.mjs';
import { tagName, tagAt } from './ui.mjs';
import { filterPasses } from './map.mjs';

const dir = new URL('./', import.meta.url);
// code only: the verbatim engine's comments still describe the concept (its virtual module, its demo lane)
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const shipped = () => [...readdirSync(dir).filter(f => /\.(mjs|ts)$/.test(f) && !/\.(test|cases|fixture|support)\.mjs$|\.test\.ts$|\.d\.mts$/.test(f)).map(f => [f, readFileSync(new URL(f, dir), 'utf8')]),
  ...readdirSync(new URL('glsl/', dir)).map(f => [`glsl/${f}`, readFileSync(new URL(`glsl/${f}`, dir), 'utf8')])];

// P1: the lanes must be real dynamic imports, or Vite cannot split them into the chunks the dive loads (a missing lane
// would run on SHELL's stub: WILD ground everywhere, no kingdoms, no life).
test('P1: the three lanes load through literal dynamic imports; no virtual module is left', () => {
  const map = code(readFileSync(new URL('map.mjs', dir), 'utf8'));
  assert.ok(!map.includes("'realm:lanes'"), 'no build-realm.mjs virtual module');
  for (const l of ['ground', 'life', 'bases']) assert.match(map, new RegExp(`${l}: \\(\\) => import\\('\\./${l}\\.mjs'\\)`), `${l} lane`);
});

// P3/P4: players must never see the prototype's invented kingdoms or pre-decision copy (owner regressions: "prototype
// data", "In range" instead of "You can attack").
test('P3/P4: no demo population and no "In range" in anything the web ships', () => {
  const bad = [];
  for (const [f, text] of shipped()) {
    const src = code(text);
    for (const re of [/stubDemoBases|adoptGlobeMine|generateDemoBases|\bdemoBases\b|demo-bases/, /In range/, /prototype data/i]) if (re.test(src)) bad.push(`${f}: ${re}`);
  }
  assert.deepEqual(bad, []);
  assert.match(readFileSync(new URL('ui.mjs', dir), 'utf8'), /You can attack/);
});

// D-177 (owner 2026-09-26, "overview first"): Enter map lands on the whole realm; a phone in portrait gets the tighter
// 0.97 margin, everything else 0.92. A different fit would land the dive on a crop of the realm or leave a wide border.
test('D-177: the whole-realm fit is min(W/cols, H/rows) × (0.97 portrait under 700 px, else 0.92)', () => {
  for (const [W, H, k] of [[390, 844, 0.97], [844, 390, 0.92], [768, 1024, 0.92], [1280, 800, 0.92], [699, 700, 0.97]]) {
    const cam = createCamera(); cam.setGrid(140, 90); cam.setViewport(W, H, 2);
    assert.ok(Math.abs(cam.sFit() - Math.min(W / 140, H / 90) * k) < 1e-9, `${W}×${H}`);
    assert.equal(cam.sMin(), cam.sFit(), 'the lowest rest is the fit');
  }
});

// P12 (D-177, G7 item 1; owner on native: "land on the whole-realm overview"). The concept landed at
// max(min(sStart·dpr, farEnd), fit·dpr): d ≈ 21 against a fit of 4–6, a crop about 5× inside the realm, so the player
// never saw the overview the owner chose. Every shipped realm, on a portrait phone, a landscape phone and a desktop, must
// land at its whole-realm fit with the whole realm on screen; the exit stays below 0.7 × that same fit.
test('P12: Enter map and a pinch-in dive land on the whole-realm fit (land.d ≈ fitD), the whole realm on screen', () => {
  const realms = JSON.parse(readFileSync(`${PACK_ROOT}realm/index.json`, 'utf8')).realms.map(r => r.id);
  assert.ok(realms.length >= 8, 'every realm of the pack');
  for (const id of realms) {
    const { cols, rows } = JSON.parse(readFileSync(`${PACK_ROOT}realm/${id}/realm.json`, 'utf8')).grid;
    for (const [W, H, dpr, k] of [[390, 844, 3, 0.97], [844, 390, 3, 0.92], [1280, 800, 2, 0.92]]) {
      const cam = createCamera(); cam.setGrid(cols, rows); cam.setViewport(W, H, dpr);
      const fitD = Math.min(W / cols, H / rows) * k * dpr, land = landing(cam), at = `${id} ${W}×${H}@${dpr}`;
      assert.ok(Math.abs(land.d - fitD) < 1e-9, `${at}: land.d ${land.d} = fitD ${fitD}`);
      assert.ok(land.d < BANDS.farEnd, `${at}: the overview is the painted chart (FAR)`);
      cam.set(land.x, land.y, land.d / dpr); // what enterInner does with it
      assert.ok(Math.abs(cam.d - fitD) < 1e-9, `${at}: the camera rests there (no floor above the fit)`);
      const r = cam.rect();
      assert.ok(r.x0 <= 0 && r.y0 <= 0 && r.x1 >= cols && r.y1 >= rows, `${at}: the whole realm is on screen`);
      assert.ok(cam.sMin() * 0.7 < cam.s, `${at}: landing is above the pinch-out exit`);
    }
  }
  // enterInner places the camera with it, not with the concept's crop rule
  const enter = code(readFileSync(new URL('map.mjs', dir), 'utf8'));
  const body = enter.slice(enter.indexOf('async function enterInner'), enter.indexOf('const api = {'));
  assert.match(body, /const \{ x, y, d: d0 \} = landing\(cam\);[^\n]*\n\s*cam\.set\(x, y, d0 \/ core\.dpr\);\s*land\.ms = [^;]+; land\.d = cam\.d;/);
  assert.equal(body.match(/cam\.set\(/g)?.length, 1, 'one placement');
  assert.doesNotMatch(body, /sStart \* core\.dpr/);
});

// P7 (native 82c91fc/560fe54): until its keep draws a tag is picture + name (cut at 12 code points), and a tap on a tag
// picks its kingdom, not the deed under the finger (at s 30 most of a tag lies over the deed to the north).
test('P7: compact tag names, and tag hits', () => {
  assert.equal(tagName('Abcdefghijkl', true), 'Abcdefghijkl', '12 code points stay whole');
  assert.equal(tagName('Abcdefghijklm', true), 'Abcdefghijk…');
  assert.equal(tagName('🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉', true), '🐉'.repeat(11) + '…', 'code points, not UTF-16 units');
  assert.equal(tagName('Abcdefghijklm', false), 'Abcdefghijklm', 'the full name once the keep draws');
  const a = { id: 1 }, b = { id: 2 };
  const placed = [{ r: [0, 0, 50, 24], b: a }, { r: [40, 10, 90, 34], b }];
  assert.equal(tagAt(placed, 45, 15), b, 'the tag placed last is on top');
  assert.equal(tagAt(placed, 10, 5), a); assert.equal(tagAt(placed, 95, 5), null);
});

// D-191 (owner 2026-09-28, endorsing a player: "instead of Shielded add or change it to Unshielded: the purpose of
// searching is to raid, their target should be the unshielded"): the chip keeps ONLY kingdoms whose shield bit is
// explicitly false. A read that carries no shield key is unknown (D-181: hidden, never faked) and must not pass, or an
// older server would offer every rival as an open target. The level range applies before any chip.
test('D-191: filterPasses — level range first; unshielded is strictly shield === false; unknown never passes', () => {
  const f = (kind, lvl = [1, 20]) => ({ kind, lvl });
  const open = { level: 5, shield: false, mine: false }, domed = { level: 5, shield: true, mine: false }, unknown = { level: 5, mine: false };
  assert.deepEqual([open, domed, unknown].map(b => filterPasses(f('unshielded'), b)), [true, false, false], 'only an explicit false passes Unshielded');
  assert.deepEqual([open, domed, unknown].map(b => filterPasses(f('all'), b)), [true, true, true]);
  assert.equal(filterPasses(f('unshielded', [7, 20]), open), false, 'the level range applies before the chip');
  assert.equal(filterPasses(f('all', [7, 20]), { level: 7, mine: false }), true); assert.equal(filterPasses(f('all', [7, 20]), { level: 6, mine: false }), false);
  assert.equal(filterPasses(f('mine'), { level: 3, mine: true }), true); assert.equal(filterPasses(f('mine'), open), false);
  assert.equal(filterPasses(f('shield'), domed), true, 'an unknown kind (the retired "shield") filters nothing rather than everything');
});

// D-191: there is no Shielded chip any more, on the host HUD or in the engine's own chrome, and both say the same words
// (long "Unshielded", short "No shield", aria "Unshielded"); the host maps its chip kind 1:1 onto the engine's.
test('D-191: the Unshielded chip replaces Shielded in the engine chrome, the host HUD and its copy; no "shield" kind is sent', () => {
  const ui = readFileSync(new URL('ui.mjs', dir), 'utf8');
  assert.match(ui, /data-f="unshielded" aria-pressed="false" aria-label="Unshielded"><span class="lg">Unshielded<\/span><span class="sm">No shield<\/span>/);
  assert.ok(!/data-f="shield"/.test(ui), 'the engine chrome offers no Shielded chip');
  const chrome = readFileSync(new URL('../hud/RealmMapChrome.tsx', dir), 'utf8'), copy = readFileSync(new URL('../copy.ts', dir), 'utf8');
  assert.match(chrome, /chip\('unshielded', M\.unshielded, M\.unshieldedShort\)/); assert.ok(!/chip\('shielded'/.test(chrome));
  assert.match(copy, /unshielded: 'Unshielded', unshieldedShort: 'No shield'/); assert.ok(!/shielded: 'Shielded', shieldedShort/.test(copy), 'no Shielded chip copy');
  const root = readFileSync(new URL('../WorldV2.tsx', dir), 'utf8');
  assert.match(root, /setFilter\(\{ kind: filter\.kind, lvl: \[filter\.lo, filter\.hi\] \}\)/, 'the host passes its chip kind straight through');
  assert.ok(!/'shield'/.test(code(root)) && !/'shield'/.test(code(readFileSync(new URL('../controller.ts', dir), 'utf8'))), 'the old engine kind "shield" is gone');
});

