// FAR cluster counters (plan §8.2, V1 "count sum = bases"; Gate A QA-9 / OB-5): the counters must account for
// every base on screen (a player reads "how many kingdoms are here"), stay ≤ 40, never sit on each other and
// never cover a control. clusterCounters() is the pure core of ui.mjs's FAR labels.
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterCounters } from './ui.mjs';

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function realm(seed, cols, rows, n, hubs = 20) { // clustered demo-like bases on unique deeds, one of them mine
  const r = rng(seed), H = Array.from({ length: hubs }, () => [r() * cols, r() * rows]), used = new Set(), out = [];
  for (let g = 0; out.length < n && g < n * 40; g++) {
    const h = H[Math.floor(r() * hubs)], sp = 1 + r() * 9, x = Math.floor(h[0] + (r() + r() - 1) * sp), y = Math.floor(h[1] + (r() + r() - 1) * sp);
    if (x < 0 || y < 0 || x >= cols || y >= rows || used.has(y * cols + x)) continue; used.add(y * cols + x); out.push({ x, y, mine: false });
  }
  out[0].mine = true; return out;
}
const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const rectOf = c => [c.px - c.w / 2, c.py - 14, c.px + c.w / 2, c.py + 14];

for (const [name, W, H, s, cols, rows, n] of [['phone fit', 390, 844, 2, 181, 132, 3343], ['desktop fit', 1280, 800, 5.6, 181, 132, 3343],
  ['desktop s 20', 1280, 800, 20, 226, 120, 3180], ['phone s 10', 390, 844, 10, 119, 59, 1017]]) {
  test(`${name}: counters sum to the bases on screen, ≤ 40, ≥ 44 px apart, ≥ 12 px clear of the UI`, () => {
    const bases = realm(n + W, cols, rows, n), cam = { x: cols / 2 + 3, y: rows / 2 - 2 };
    // phone-like chrome: top bar + chips, minimap top-right, tool column right-middle, nav bottom
    const chrome = [[0, 0, W, 108], [W - 146, 112, W, 300], [W - 62, H / 2 - 90, W, H / 2 + 90], [W / 2 - 60, H - 64, W / 2 + 60, H]];
    const box = [2, 2, W - 2, H - 2];
    const { list, onScreen } = clusterCounters({ bases, cam, s, W, H, chrome, box });
    const truth = bases.filter(b => { const sx = (b.x + 0.5 - cam.x) * s + W / 2, sy = (b.y + 0.5 - cam.y) * s + H / 2; return sx >= 0 && sy >= 0 && sx <= W && sy <= H; }).length;
    assert.equal(onScreen, truth);
    assert.equal(list.reduce((a, c) => a + c.n, 0), truth, 'every on-screen base is counted exactly once');
    assert.ok(list.length <= 40, `${list.length} counters`);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      assert.ok(!overlap(rectOf(a), rectOf(b)) && Math.hypot(a.px - b.px, a.py - b.py) >= 44, `counters ${a.n} and ${b.n} collide`);
    }
    for (const c of list) {
      const r = rectOf(c);
      assert.ok(r[0] >= box[0] - 1e-6 && r[1] >= box[1] - 1e-6 && r[2] <= box[2] + 1e-6 && r[3] <= box[3] + 1e-6, 'inside the safe viewport');
      // ≥ 12 px clear of every control (16 with the 4 px pad ui.mjs adds to measured rects): closer, a counter read
      // as the badge of the chip above it (fix iteration 1, T5)
      for (const k of chrome) assert.ok(!overlap(r, [k[0] - 12, k[1] - 12, k[2] + 12, k[3] + 12]), `counter ${c.n} within 12 px of a control`);
    }
    assert.equal(list.filter(c => c.mine).length, truth && bases.some(b => b.mine && (b.x + 0.5 - cam.x) * s + W / 2 >= 0) ? 1 : list.filter(c => c.mine).length, 'your base is in exactly one counter');
  });
}

test('world-anchored: a small pan does not reshuffle which bases share a counter', () => {
  const bases = realm(7, 181, 132, 3343), chrome = [], box = [0, 0, 1280, 800];
  const a = clusterCounters({ bases, cam: { x: 90, y: 66 }, s: 5.6, W: 1280, H: 800, chrome, box });
  const b = clusterCounters({ bases, cam: { x: 90.3, y: 66 }, s: 5.6, W: 1280, H: 800, chrome, box });
  const key = l => l.map(c => `${(c.u / c.n).toFixed(3)},${(c.v / c.n).toFixed(3)}`).sort().join(' ');
  // bases entering/leaving the screen edge may change edge cells; interior clusters keep their centroids
  const ka = new Set(key(a.list).split(' ')), kb = key(b.list).split(' ');
  assert.ok(kb.filter(k => ka.has(k)).length >= kb.length * 0.6);
});

// T5 HUD mix (D-166.2): the realm map wears the globe's light, so each realm's accent must be the one the globe
// shows for it (landmarks.js REALM_INFO, globe-owned); a drift would light the same realm two colours.
test('realm accents match the globe (landmarks.js REALM_INFO)', async () => {
  const { REALM_ACCENT } = await import('./ui.mjs');
  const { readFileSync } = await import('node:fs');
  // web port (patches.md P5): the globe is lane L3's worldv2/globe/; until it declares REALM_INFO, the concept globe's own
  // realm lines at 8acdf059 (fixtures/landmarks-realms.8acdf059.js.txt) stand in for it
  const { readdirSync, existsSync } = await import('node:fs'), gdir = new URL('../globe/', import.meta.url);
  const globeSrc = existsSync(gdir) ? readdirSync(gdir, { recursive: true }).filter(f => /\.(m?js|ts)$/.test(f) && !/\.(test|cases)\./.test(f))
    .map(f => readFileSync(new URL(f, gdir), 'utf8')).find(t => /\bREALM_INFO\b[^\n]*=/.test(t)) : null;
  const src = globeSrc ?? readFileSync(new URL('./fixtures/landmarks-realms.8acdf059.js.txt', import.meta.url), 'utf8');
  for (const [id, acc] of Object.entries(REALM_ACCENT)) {
    const key = `(?:${id}|'${id}')`; // 'seeker-reach' is a quoted key
    const m = src.match(new RegExp(`\\n\\s*${key}: \\{[^\\n]*?accent: '(#[0-9a-f]{6})'`, 'i')) ?? src.match(new RegExp(`\\n\\s*${key}: \\{[\\s\\S]*?accent: '(#[0-9a-f]{6})'`, 'i'));
    assert.ok(m, `${id} accent in landmarks.js`); assert.equal(acc.toLowerCase(), m[1].toLowerCase(), id);
  }
  // stage B (D-170): every realm with a pack gets its globe accent in the HUD (else the gold default: Elderwood,
  // Thornwake and Solana Reach would not look like themselves)
  const index = JSON.parse(readFileSync(PACK_ROOT + 'realm/index.json', 'utf8'));
  for (const r of index.realms) assert.ok(REALM_ACCENT[r.id], `${r.id} has a HUD accent`);
});

// index.html (globe-owned) keeps a legacy `#realmUI button{…}` rule whose ID specificity beats any .hud-* class,
// which would put the old rounded Pixelify look back on every realm-map button. hudForRoot re-emits the HUD
// control rules under the root id: every emitted selector must carry the prefix, token blocks (:root) and
// @keyframes must stay global/untouched, @media nesting must survive, and commas inside comments or data URLs
// must never split a selector.
test('hudForRoot lifts the HUD control rules above the legacy #realmUI button rule', async () => {
  const { hudForRoot } = await import('./ui.mjs');
  const css = `:root{--hud-acc:#e3ae3c}
/* controls: stone, gold, wells (a, b, c) */
.hud-btn,.hud-tool{border-radius:0;background:url("data:image/png;base64,AA,BB") center}
.hud-filter.is-on,.hud-filter[aria-pressed="true"]{color:gold}
.hud-panel{background:red}
@keyframes hud-pulse{50%{opacity:.5}}
@media (hover:hover){.hud-btn:hover:not(:disabled){filter:brightness(1.1)}.hud-panel:hover{x:y}}
.hud-range::-webkit-slider-thumb{width:16px}`;
  const out = hudForRoot(css, '#realmUI');
  assert.ok(!out.includes(':root') && !out.includes('@keyframes') && !out.includes('.hud-panel'), 'tokens, keyframes and non-control rules are left alone');
  assert.ok(out.includes('#realmUI .hud-btn,#realmUI .hud-tool{'), 'selector lists are prefixed part by part');
  assert.ok(out.includes('base64,AA,BB'), 'a comma inside a data URL is body, not a selector separator');
  assert.ok(out.includes('#realmUI .hud-filter.is-on,#realmUI .hud-filter[aria-pressed="true"]{'));
  assert.ok(out.includes('@media (hover:hover){#realmUI .hud-btn:hover:not(:disabled){'), '@media blocks recurse');
  assert.ok(out.includes('#realmUI .hud-range::-webkit-slider-thumb{'), 'pseudo-elements keep working (no :is wrapper)');
  for (const rule of out.replace(/@media[^{]*\{/g, '').split('}').filter(r => r.includes('{'))) for (const sel of rule.slice(0, rule.indexOf('{')).split(',')) assert.ok(sel.trim().startsWith('#realmUI '), sel);
});

// fix iteration 2 (owner: "unambiguous numbers"): the scale readout was "1 deed ≈ 12 px", a screen-dependent developer
// number. The bar must name a whole, round count of the game's own units (deeds; tiles once a deed is wider than the
// bar can be) and stay a readable 40–100 CSS px at every zoom the camera allows (s 1 … 6272).
test('scaleBar: round deed/tile counts, bar 40–100 CSS px at every zoom', async () => {
  const { scaleBar } = await import('./ui.mjs');
  for (let s = 0.8; s <= 6272; s *= 1.07) {
    const [w, label] = scaleBar(s), m = label.match(/^([\d,]+) (deed|deeds|tile|tiles)$/);
    assert.ok(m, `label "${label}" at s ${s.toFixed(2)}`);
    const n = Number(m[1].replace(/,/g, ''));
    assert.ok([1, 2, 5].includes(n / 10 ** Math.floor(Math.log10(n))), `round count ${n}`);
    assert.equal(m[2].startsWith('deed'), s <= 100, `unit at s ${s.toFixed(2)}`);
    assert.ok(w >= 40 && w <= 100, `bar ${w} px at s ${s.toFixed(2)}`);
    assert.equal((n === 1) === !m[2].endsWith('s'), true, 'singular only for 1');
  }
  assert.deepEqual(scaleBar(12), [60, '5 deeds']);
  assert.deepEqual(scaleBar(3136), [64, '2 tiles']);
});

// D-177 follow-up (owner, choosing land to buy: "could not tell which land deed was selected"): the chart (the landing) and
// TRUE draw no deed selection and MAP only a thin edge, so ui.mjs draws the selected OPEN deed as a bold box that must read at
// every zoom. At the landing a deed is 5–12 CSS px: the box is never under 18 px and stays centred on the deed. At TRUE a deed
// is up to thousands of px: the box is clipped just past the screen (never a huge layer) and its fill lightens so it never
// veils the close-up art, yet stays visible when the deed fills the screen. Off screen it is hidden.
test('deedBox: the selected open deed reads at every zoom (≥ 18 px at the landing, clipped and lighter at TRUE)', async () => {
  const { deedBox } = await import('./ui.mjs');
  const centre = (b, sx, sy, s) => [b.x + b.w / 2 - (sx + s / 2), b.y + b.h / 2 - (sy + s / 2)];
  for (const [s, W, H] of [[12, 1280, 800], [5.6, 1280, 800], [2.1, 390, 844]]) { // landing d 24 @2, the fits (desk, phone)
    const b = deedBox(600 % W, 400, s, W, H);
    assert.ok(b && b.w >= 18 && b.h >= 18, `s ${s}: a ${b?.w}×${b?.h} box is too small to see`);
    for (const c of centre(b, 600 % W, 400, s)) assert.ok(Math.abs(c) <= 0.5, `s ${s}: the box is off the deed centre by ${c}`);
    assert.equal(b.f, '0.30', 'a small deed gets the full tint');
  }
  const map = deedBox(465, 225, 350, 1280, 800); // MAP d 700 @2 (select()'s SELECT_D): the box is the deed itself
  assert.deepEqual([map.x, map.y, map.w, map.h], [465, 225, 350, 350]); assert.ok(+map.f < 0.30 && +map.f > 0.16, `MAP fill ${map.f}`);
  const tru = deedBox(-1500, -1200, 3136, 390, 844); // TRUE close-up on a phone: the deed covers the screen
  assert.ok(tru.w <= 390 + 16 && tru.h <= 844 + 16 && tru.x >= -8 && tru.y >= -8, `TRUE box ${tru.w}×${tru.h} at ${tru.x},${tru.y} is not clipped`);
  assert.equal(tru.f, '0.16', 'a screen-filling deed keeps a light but visible tint (its outline is off-screen)');
  assert.equal(deedBox(2000, 400, 12, 1280, 800), null, 'off screen: hidden');
});

// D-191: the "N of M" figures and the FAR counters come from the filtered list, so a hidden kingdom is never counted as
// shown; and the engine's own chip row (used only without a host HUD) offers Unshielded, not Shielded, with the same
// three labels as the host chip. A counter that still summed every kingdom would contradict a map that hides them.
test('D-191: counters and the shown count read the filtered list; the chrome offers Unshielded / No shield', () => {
  const src = readFileSync(new URL('ui.mjs', import.meta.url), 'utf8');
  assert.match(src, /function announce\(\) \{ E\.sr\.textContent = `\$\{api\.filtered\.length\} kingdoms shown`;/, 'the aria-live announcement counts filtered-in kingdoms');
  assert.match(src, /shown = api\.filtered\.length, all = R\.bases\.length/, 'the header shows "shown" of "all"');
  assert.match(src, /clusterCounters\(\{ bases: api\.filtered,/, 'FAR counters cluster the filtered list only');
  assert.match(src, /data-f="unshielded" aria-pressed="false" aria-label="Unshielded"><span class="lg">Unshielded<\/span><span class="sm">No shield<\/span>/);
  assert.ok(!/aria-label="Shielded"/.test(src) && !/data-f="shield"/.test(src), 'no Shielded chip (the card\'s "Shielded" tag is another word and stays)');
  const bases = [{ x: 1, y: 1, mine: false, level: 3 }, { x: 2, y: 1, mine: true, level: 9 }, { x: 40, y: 30, mine: false, level: 12 }];
  const { list } = clusterCounters({ bases: bases.filter(b => b.level >= 7), cam: { x: 20, y: 15 }, s: 4, W: 390, H: 844, chrome: [], box: [0, 0, 390, 844], cells: new Map(), make: () => ({}) });
  assert.equal(list.reduce((n, c) => n + c.n, 0), 2, 'a level filter of 7+ leaves two kingdoms in the counters');
});

