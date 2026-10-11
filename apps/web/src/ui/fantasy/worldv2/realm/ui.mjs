// Realm-map browse UI (D-163, D-164.6, plan §8): mobile-first, portrait + landscape + desktop.
// It injects its own stylesheet (<style id="rmx-css">, rmx-* classes; C7) so it never depends on
// index.html. DOM only: tags and cluster counters are pooled; a steady frame writes only what changed
// (transforms, mostly), and layout runs on resize / card / minimap / panel changes, never per frame (§6.6).
// The minimap is drawn by GL (minimap.js); this file owns its DOM hit-div and gestures.
//
// Labels never cover the UI (Gate A QA-9, OB-5, PM-5): every frame the tag and counter placement starts
// from the measured chrome rects (top bar, chips, level panel, minimap + toggle, tools, nav, card, scale,
// search results), and a label must lie wholly inside the safe viewport. The label layer is the first child
// of the root, so controls always paint above it.
import { BANDS, SELECT_D, MY_BASE_D, DEED_DEG, TILES, plotRule, plotCentre } from './contracts.mjs';

/** Realm accent (the globe's light on this surface): mirrors src/landmarks.js REALM_INFO[id].accent, which is
 *  globe-owned and drags geo.js along; ui.test.mjs fails if the two ever differ. */
export const REALM_ACCENT = Object.freeze({ frostveil: '#8fe3ff', sunscar: '#ffbf4d', crownlands: '#ffd65c', stormcairn: '#9dbcff', cinderfall: '#ff8a4c',
  elderwood: '#86ec6c', thornwake: '#c6e65a', 'seeker-reach': '#c99dff' });

/**
 * The HUD rules for buttons, rows and inputs, re-emitted under `pre` (the root id). index.html (globe-owned)
 * still carries the legacy `#realmUI button{…}` (ID specificity), which beats every .hud-* class on a
 * realm-map button (HUD-STYLE §14.2); prefixing lifts every such HUD rule by the same one ID, so their order
 * among themselves is kept. Comments, :root token blocks and @keyframes are skipped; @media blocks recurse.
 */
export function hudForRoot(css, pre) {
  const want = /\.hud-(btn|tool|filter|dest|x|row|input|range)\b/;
  const walk = src => {
    let out = '', i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i); if (open < 0) break;
      const head = src.slice(i, open).trim(); let depth = 1, j = open + 1;
      for (; j < src.length && depth; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@media')) { const inner = walk(body); if (inner) out += `${head}{${inner}}`; }
      else if (!head.startsWith('@') && !head.includes(':root') && want.test(head)) out += `${head.split(',').map(x => `${pre} ${x.trim()}`).join(',')}{${body}}`;
      i = j;
    }
    return out;
  };
  return walk(css.replace(/\/\*[\s\S]*?\*\//g, ''));
}

// Look = the shared HUD sheet (D-166.2, docs/HUD-STYLE.md, ../hud.js): the game supplies the material (VT323,
// --sk-* palette, square charcoal plates with gold pips, gold = the primary action, square icon + label tools),
// the globe supplies the light (the realm accent on the panels' top edge, glass, glow). This sheet holds only
// layout (position, size, gap) plus the few map-only bits the HUD sheet has no class for.
const STYLE = `
.rmx{position:absolute;inset:0;pointer-events:none;-webkit-user-select:none;user-select:none;z-index:1}
.rmx *{box-sizing:border-box}
.rmx button,.rmx input{pointer-events:auto}
.rmx-top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top) + 8px) calc(env(safe-area-inset-right) + 10px) 0 calc(env(safe-area-inset-left) + 10px);display:flex;align-items:center;gap:8px}
.rmx-title{min-width:0;flex:0 1 auto;display:flex;flex-direction:column;justify-content:center;gap:3px;min-height:48px;padding:6px 14px 4px}
.rmx-title b{display:block;font-size:16px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rmx-title small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rmx-title .hud-num{font-size:var(--hud-fs-ui)}
.rmx-search{position:relative;display:flex;align-items:center;margin-left:auto}
.rmx-search input{width:240px;padding-left:40px;pointer-events:auto}
.rmx-search .ico{position:absolute;left:9px;top:50%;margin-top:-12px;pointer-events:none}
.rmx-results{position:absolute;top:54px;right:0;width:min(330px,calc(100vw - 20px));max-height:min(60vh,420px);overflow:auto;display:flex;flex-direction:column;gap:4px;padding:10px 8px 8px;pointer-events:auto}
.rmx-results button{width:100%;text-align:left;font:400 var(--hud-fs-ui)/1 var(--hud-font);color:var(--sk-text);cursor:pointer}
.rmx-results button[aria-selected=true]{border-color:var(--sk-gold-dp);background:rgba(61,56,51,.94)}
.rmx-results span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rmx-results em{margin-left:auto;font-style:normal;color:var(--sk-gold-hi)}
.rmx-results .none{padding:6px 4px}
.rmx-chips{position:absolute;left:calc(env(safe-area-inset-left) + 10px);right:calc(env(safe-area-inset-right) + 10px);top:calc(env(safe-area-inset-top) + 64px);display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;pointer-events:auto;padding:2px 2px 6px}
.rmx-chips::-webkit-scrollbar{display:none}
.rmx-chips[data-over]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 56px),transparent)}
.rmx-chips .sm{display:none}
.rmx-lvl{position:absolute;z-index:3;top:calc(env(safe-area-inset-top) + 120px);left:calc(env(safe-area-inset-left) + 10px);pointer-events:auto;display:grid;grid-template-columns:auto 1fr 28px;gap:0 12px;align-items:center;width:min(320px,calc(100vw - 20px));padding:10px 14px 6px}
.rmx-lvl output{text-align:right}
.rmx-tools{position:absolute;right:calc(env(safe-area-inset-right) + 10px);display:flex;flex-direction:column;align-items:center;gap:8px}
.rmx-mini{position:absolute;pointer-events:auto;touch-action:none}
.rmx-mini-t{position:absolute}
.rmx-nav{position:absolute;display:flex;gap:8px;pointer-events:none}
.rmx-card{position:absolute;pointer-events:auto;display:flex;flex-direction:column;gap:10px;padding:16px 16px 0;overflow:auto}
.rmx-card .x{position:absolute;right:4px;top:6px;z-index:2}
.rmx-card .row{display:flex;gap:12px;align-items:center;padding-right:40px}
.rmx-card .who{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.rmx-card .nm{font:400 var(--hud-fs-title)/1.1 var(--hud-font);color:var(--sk-gold-hi);overflow-wrap:anywhere}
.rmx-card .tags{display:flex;flex-wrap:wrap;gap:4px}
.rmx-card .row2{display:flex;gap:12px;align-items:center}.rmx-card .row2 .facts{flex:1;min-width:0}
.rmx-card .keep{width:56px;height:53px;image-rendering:pixelated;flex:none;object-fit:contain}
.rmx-card div.keep{margin:-6px -4px -6px 0}
.rmx-card .facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:baseline;margin:0}
.rmx-card .facts dd{margin:0;min-width:0;font:400 var(--hud-fs-body)/1.15 var(--hud-font);color:var(--sk-text)}
.rmx-card .facts dd .hud-num{font-size:var(--hud-fs-ui)}
.rmx-card .note{margin:0;font:400 var(--hud-fs-cap)/1.1 var(--hud-font);color:var(--sk-text-faint)}
.rmx-card .acts{flex-wrap:wrap;margin:2px -16px 0;position:sticky;bottom:0;background:#1d1a24} /* opaque: the card scrolls under it */
.rmx-card .acts .hud-btn{flex:1 1 auto;min-width:0;padding-left:8px;padding-right:8px;flex-wrap:wrap;column-gap:6px;row-gap:0;line-height:1}
/* disabled by design: said, never only greyed (HUD-STYLE §1). Its own line under the icon + label, so the icon stays
   inside the button padding at phone width (fix iteration 2: the spyglass and swords overflowed SCOUT/ATTACK) */
.rmx-card .soon{flex-basis:100%;margin:0;text-align:center;font-size:var(--hud-fs-cap);line-height:1;color:var(--sk-text-dim)}
.rmx-labels{position:absolute;inset:0;overflow:hidden}
/* the selected OPEN deed (D-177 follow-up, owner: "could not tell which land deed was selected"): a bold gold outline, a
   tinted fill and a gentle pulse, the same at every zoom (the chart and TRUE draw no deed selection, MAP only a thin edge);
   never under 18 CSS px, so it reads at the landing's 5–12 px deeds; under the tags; a kingdom keeps its own selection */
.rmx-selbox{position:absolute;left:0;top:0;border:3px solid var(--sk-gold-hi,#f4d77b);background:rgba(244,215,123,var(--f,.3));box-shadow:0 0 0 2px #0b0a10,inset 0 0 0 1px #0b0a10;will-change:transform,opacity;pointer-events:none;animation:rmx-selp 1.6s ease-in-out infinite}
@keyframes rmx-selp{50%{opacity:.6}}
.rmx-l{position:absolute;left:0;top:0;will-change:transform;pointer-events:none}
.rmx-l.hud-count{justify-content:center;padding:1px 0 0}
/* a map marker, not a HUD badge: the counter carries a pin tail toward its kingdoms (fix iteration 1, T5) */
.rmx-l.hud-count::before,.rmx-l.hud-count::after{content:'';position:absolute;left:50%;top:100%;width:0;height:0;border-style:solid;border-color:transparent}
.rmx-l.hud-count::before{margin:1px 0 0 -6px;border-width:7px 6px 0;border-top-color:#1a171e}
.rmx-l.hud-count::after{margin:0 0 0 -4px;border-width:5px 4px 0;border-top-color:rgba(20,18,26,.95)}
.rmx-l.hud-count.is-mine::before{border-top-color:var(--sk-gold-dp)}
.rmx-l.hud-count.is-mine::after{border-top-color:rgb(61,56,51)}
.rmx-scale{position:absolute;pointer-events:none;white-space:nowrap;font-size:var(--hud-fs-ui);display:flex;align-items:center;gap:8px}
/* pixel-art scale bar (fix iteration 2): a two-tone bar of a whole number of deeds (or tiles in close views), never "px" */
.rmx-sbar{display:block;height:6px;box-sizing:content-box;border:2px solid #0b0a10;background:linear-gradient(90deg,var(--sk-gold) 0 50%,var(--sk-text) 50% 100%)}
.rmx-stats{position:absolute;left:8px;top:calc(env(safe-area-inset-top) + 120px);z-index:1;font:11px/1.35 ui-monospace,monospace;color:#fff;background:#000b;padding:6px 8px;white-space:pre;pointer-events:none;max-width:60vw}
.rmx-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
/* portrait phone: card = bottom sheet (forged gold rim), minimap top-right under the chips and folded while the
   card is open, icon-only exit, short chip labels */
.rmx[data-lay=portrait] .rmx-card{left:0;right:0;bottom:0;max-height:42%;padding-top:14px}
.rmx[data-lay=portrait] .rmx-card .acts{padding-bottom:calc(env(safe-area-inset-bottom) + 12px)}
.rmx[data-lay=portrait] .rmx-exit .rmx-lbl{display:none}
.rmx[data-lay=portrait] .rmx-exit{padding-left:0;padding-right:0}
.rmx[data-lay=portrait] .rmx-search:not(.open) input,.rmx[data-lay=portrait] .rmx-search:not(.open) .ico{display:none}
.rmx[data-lay=portrait] .rmx-search.open{position:absolute;left:calc(env(safe-area-inset-left) + 10px);right:calc(env(safe-area-inset-right) + 10px);top:calc(env(safe-area-inset-top) + 8px);z-index:2}
.rmx[data-lay=portrait] .rmx-search.open input{width:100%}
.rmx .rmx-search .sbtn{display:none}
.rmx[data-lay=portrait] .rmx-search:not(.open) .sbtn{display:inline-flex}
.rmx[data-lay=portrait] .rmx-stats{top:auto;bottom:calc(env(safe-area-inset-bottom) + 70px);max-width:calc(100vw - 16px)}
.rmx[data-lay=portrait] .rmx-chips{gap:3px}
.rmx[data-lay=portrait] .rmx-chips .hud-filter{padding-left:7px;padding-right:7px;min-width:44px} /* all six fit a 390-px phone; narrower ones scroll under the edge fade */
.rmx[data-lay=portrait] .rmx-chips .lg{display:none}
.rmx[data-lay=portrait] .rmx-chips .sm{display:inline}
.rmx[data-lay=wide] .rmx-card .hud-grip{display:none}
/* landscape + desktop: card = right panel */
.rmx[data-lay=wide] .rmx-card{right:calc(env(safe-area-inset-right) + 86px);top:calc(env(safe-area-inset-top) + 120px);width:330px;max-height:calc(100% - 136px)}
/* short landscape (phone on its side): a compact card that still scrolls under its footer */
@media (orientation:landscape) and (max-height:520px){.rmx-card{gap:6px}.rmx-card .note,.rmx-card .row2 .keep{display:none}.rmx-card .hud-avatar--lg{width:40px;height:40px}}
@media (prefers-reduced-motion: reduce){.rmx *{transition:none!important}.rmx-selbox{animation:none!important}}
`;

/** Prefix every top-level selector (not @-rules) with `pre`. */
const scope = (css, pre) => css.replace(/(^|})\s*([^{}@]+)\{/g, (m, close, sel) => `${close}${sel.split(',').map(x => `${pre} ${x.trim()}`).join(',')}{`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtN = v => Number(v).toLocaleString('en-US'); // the game's fmtN: en-US thousands commas
/**
 * The selected open deed's highlight box (D-177 follow-up: the owner could not tell which land deed was selected). sx, sy:
 * the deed's top-left corner on screen, s: CSS px per deed, W × H: the screen (CSS px). The box is the deed, never under
 * 18 CSS px (centred on it), so it reads at the landing's 5–12 px deeds; clipped 8 px past the screen (its border then lies
 * off-screen), so a TRUE-zoom deed thousands of px wide never becomes a huge layer; f = the fill alpha, 0.30 while the deed
 * is small, easing to 0.16 as it grows to half the screen: light over the close-up art, yet a screen-filling deed (its
 * outline off-screen) still reads as tinted and pulsing (SwiftShader check: 0.10 there was invisible). → { x, y, w, h, f } | null.
 */
export function deedBox(sx, sy, s, W, H) {
  const m = Math.max(s, 18), cx = sx + s / 2, cy = sy + s / 2;
  const x0 = Math.max(-8, cx - m / 2), y0 = Math.max(-8, cy - m / 2), x1 = Math.min(W + 8, cx + m / 2), y1 = Math.min(H + 8, cy + m / 2);
  if (x1 <= x0 || y1 <= y0) return null;
  const f = (0.30 - 0.14 * clamp((s - 96) / Math.max(1, Math.min(W, H) / 2 - 96), 0, 1)).toFixed(2);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), f };
}
/**
 * The scale bar (fix iteration 2, owner "unambiguous numbers"): a whole, round count of the game's own units whose bar
 * is 40–100 CSS px long — deeds while a deed is ≤ 100 CSS px, tiles (98 per deed) closer in. → [bar CSS px, label].
 */
export function scaleBar(s) {
  const tiles = s > 100, per = tiles ? s / TILES : s, NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const n = NICE.find(k => k * per >= 40) ?? NICE[NICE.length - 1];
  return [Math.round(n * per), `${fmtN(n)} ${tiles ? (n === 1 ? 'tile' : 'tiles') : (n === 1 ? 'deed' : 'deeds')}`];
}
/**
 * web port P7 (native 82c91fc): a kingdom's tag text. Until its live keep draws (compact), the tag is the avatar and the
 * name, cut to 11 code points plus an ellipsis past 12, with no level; once the keep draws it is the full name and level.
 */
export function tagName(name, compact) {
  const cps = Array.from(String(name ?? ''));
  return compact && cps.length > 12 ? cps.slice(0, 11).join('') + '…' : cps.join('');
}
/** web port P7 (native 560fe54): the kingdom whose placed tag holds the tap (CSS px), topmost first, or null. */
export function tagAt(placedTags, sx, sy) {
  for (let i = placedTags.length - 1; i >= 0; i--) { const { r, b } = placedTags[i]; if (sx >= r[0] && sx <= r[2] && sy >= r[1] && sy <= r[3]) return b; }
  return null;
}
const SEP = 44, MAX_COUNTERS = 40, MAX_TAGS = 16, PAD = 4; // counter separation / cap (plan §8.2), tag cap (§6.6), chrome padding
// counters keep CLEAR px more than PAD from every control (16 px in all): a counter a few px under a chip read as
// that chip's badge (fix iteration 1, T5); the clearance also holds the pin tail
const CLEAR = 12;

const counterW = n => Math.max(28, 16 + 8 * String(n).length), COUNTER_H = 28; // .hud-count: VT323 20 px, advance 0.4 em (HUD-STYLE §9)
/**
 * Centroid → kept inside the safe box and off every chrome rect: step to the nearest free side of the rect it
 * touches (a few passes, measured from the centroid), else the nearest free spot on a spiral. Sets c.px, c.py, c.w.
 */
function placeCounter(c, chrome, box) {
  const w = counterW(c.n), h = COUNTER_H, x0 = clamp(c.sx / c.n, box[0] + w / 2, box[2] - w / 2), y0 = clamp(c.sy / c.n, box[1] + h / 2, box[3] - h / 2);
  const inBox = (x, y) => x - w / 2 >= box[0] && x + w / 2 <= box[2] && y - h / 2 >= box[1] && y + h / 2 <= box[3];
  const hits = (x, y) => { for (const r of chrome) if (x - w / 2 < r[2] && x + w / 2 > r[0] && y - h / 2 < r[3] && y + h / 2 > r[1]) return r; return null; };
  let x = x0, y = y0;
  for (let pass = 0, r; pass < 6 && (r = hits(x, y)); pass++) {
    let best = null, bd = Infinity;
    for (const [px, py] of [[r[0] - w / 2, y], [r[2] + w / 2, y], [x, r[1] - h / 2], [x, r[3] + h / 2]]) {
      if (!inBox(px, py)) continue; const d = Math.abs(px - x0) + Math.abs(py - y0); if (d < bd) { bd = d; best = [px, py]; }
    }
    if (!best) break; [x, y] = best;
  }
  if (hits(x, y)) spiral: for (let rad = 8; rad < 480; rad += 8) for (let a = 0; a < 16; a++) {
    const px = x0 + Math.cos(a * Math.PI / 8) * rad, py = y0 + Math.sin(a * Math.PI / 8) * rad;
    if (inBox(px, py) && !hits(px, py)) { x = px; y = py; break spiral; }
  }
  c.px = x; c.py = y; c.w = w;
}
/**
 * FAR cluster counters (plan §8.2, V1 "count sum = bases"): pure, so it is unit-tested (ui.test.mjs).
 * bases: [{x, y, mine}] in deed cells; cam: {x, y}; s: CSS px per deed; W, H: viewport CSS px; chrome: padded
 * UI rects [l, t, r, b]; box: the safe viewport [l, t, r, b]. World-anchored cells on a √2 ladder of deed sizes
 * (≥ sep CSS px) grow until ≤ max cells hold the on-screen bases; every on-screen base lands in exactly one cell,
 * so the counts add up to the bases on screen (Gate A QA-9: cells under 4 bases and the 41st+ cell were dropped).
 * Counters are pushed off the chrome, and any two closer than sep (or overlapping) merge, keeping the sum.
 * → { list: [{ n, px, py, w, u, v, mine }], onScreen }   (u, v = the cluster's deed-space centroid × n)
 */
export function clusterCounters({ bases, cam, s, W, H, chrome = [], box, sep = SEP, max = MAX_COUNTERS, clear = CLEAR, cells = new Map(), make = () => ({}) }) {
  if (clear) chrome = chrome.map(r => [r[0] - clear, r[1] - clear, r[2] + clear, r[3] + clear]);
  let k = Math.max(0, Math.ceil(2 * Math.log2(sep / s))), on = 0;
  for (let guard = 0; guard < 48; guard++, k++) {
    const g = Math.SQRT2 ** k; cells.clear(); on = 0; let m = 0;
    for (const b of bases) {
      const sx = (b.x + 0.5 - cam.x) * s + W / 2, sy = (b.y + 0.5 - cam.y) * s + H / 2; if (sx < 0 || sy < 0 || sx > W || sy > H) continue; on++;
      const key = Math.floor((b.x + 0.5) / g) * 65536 + Math.floor((b.y + 0.5) / g); let c = cells.get(key);
      if (!c) { c = make(m++); c.n = 0; c.sx = 0; c.sy = 0; c.u = 0; c.v = 0; c.mine = false; cells.set(key, c); }
      c.n++; c.sx += sx; c.sy += sy; c.u += b.x + 0.5; c.v += b.y + 0.5; if (b.mine) c.mine = true;
    }
    if (cells.size <= max) break;
  }
  const L = [...cells.values()];
  for (const c of L) placeCounter(c, chrome, box);
  for (let changed = true, it = 0; changed && it < 16; it++) {
    changed = false;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j]; if (!a.n || !b.n) continue;
      const dx = Math.abs(a.px - b.px), dy = Math.abs(a.py - b.py);
      if (Math.hypot(dx, dy) >= sep && (dx >= (a.w + b.w) / 2 + PAD || dy >= COUNTER_H + PAD)) continue;
      a.n += b.n; a.sx += b.sx; a.sy += b.sy; a.u += b.u; a.v += b.v; a.mine ||= b.mine; b.n = 0; placeCounter(a, chrome, box); changed = true;
    }
  }
  return { list: L.filter(c => c.n), onScreen: on };
}

// hud: the ../hud.js module (map.js imports it with this file at the dive; node tests never load its PNG icons)
// host (web port P7): the React HUD owns the chrome and the card. host = { card(b), cardOpen?(), focusOffset?() → [x, y],
//   chromeRects?() → [[l, t, r, b]] root-relative CSS px }: the concept's top bar, chips, level panel, tools, nav and card
//   are not shown; tags and counters keep off the host's rects instead; the minimap and the scale pill stay.
export function createUI(root, api, { avatarURL = () => '', keepThumb = null, hud = null, host = null } = {}) {
  // Scoped under the root's id when it has one: index.html's `#realmUI button{…}` (ID specificity) would
  // otherwise restyle every rmx button inside the globe (C7: this UI never depends on index.html).
  hud?.injectHudCss(); // idempotent: the globe may have injected the same sheet already
  if (!document.getElementById('rmx-css')) { const st = document.createElement('style'); st.id = 'rmx-css'; const pre = root.id ? '#' + CSS.escape(root.id) : '';
    st.textContent = (pre ? (hud ? hudForRoot(hud.HUD_CSS, pre) : '') + scope(STYLE, pre) : STYLE); document.head.appendChild(st); }
  const el = document.createElement('div'); el.className = 'rmx hud'; el.hidden = true; root.appendChild(el);
  root.style.pointerEvents = 'none';
  const I = (n, lbl = '') => `<i class="hud-i hud-i--${n}" aria-hidden="true"></i>${lbl}`;
  el.innerHTML = `
    <div class="rmx-labels"><div class="rmx-selbox" hidden></div></div>
    <div class="rmx-top">
      <button class="hud-btn rmx-exit" data-a="exit" aria-label="Back to globe">${I('prev', '<span class="rmx-lbl">Globe</span>')}</button>
      <div class="rmx-title hud-panel" aria-live="polite"><b class="hud-display"></b><small class="hud-cap"></small></div>
      <div class="rmx-search" role="search">
        <button class="hud-tool hud-tool--icon sbtn" data-a="search" aria-label="Search kingdoms">${I('scout')}</button>
        <span class="ico">${I('scout')}</span>
        <input class="hud-input" type="search" placeholder="Search kingdoms" aria-label="Search kingdoms by name" autocomplete="off" enterkeyhint="go">
        <div class="rmx-results hud-panel" role="listbox" hidden></div>
      </div>
    </div>
    <div class="rmx-chips" role="toolbar" aria-label="Filters">
      <button class="hud-filter is-on" data-f="all" aria-pressed="true">All</button>
      <button class="hud-filter" data-f="mine" aria-pressed="false">Mine</button>
      <button class="hud-filter" data-f="clan" aria-pressed="false">Clan</button>
      <button class="hud-filter" data-f="attack" aria-pressed="false" aria-label="Attackable"><span class="lg">Attackable</span><span class="sm">Attack</span></button>
      <button class="hud-filter" data-f="unshielded" aria-pressed="false" aria-label="Unshielded"><span class="lg">Unshielded</span><span class="sm">No shield</span></button>
      <button class="hud-filter" data-a="lvl" aria-expanded="false" aria-label="Level 1–20"><span class="lg">Level 1–20</span><span class="sm">Lv 1–20</span></button>
    </div>
    <div class="rmx-lvl hud-panel" hidden>
      <span class="hud-cap">Min</span><input class="hud-range" type="range" min="1" max="20" value="1" data-l="0" aria-label="Minimum keep level"><output class="hud-num">1</output>
      <span class="hud-cap">Max</span><input class="hud-range" type="range" min="1" max="20" value="20" data-l="1" aria-label="Maximum keep level"><output class="hud-num">20</output>
    </div>
    <div class="rmx-tools">
      <button class="hud-tool hud-tool--icon" data-a="in" aria-label="Zoom in">${I('plus')}</button>
      <button class="hud-tool hud-tool--icon" data-a="out" aria-label="Zoom out">${I('minus')}</button>
      <button class="hud-tool mine" data-a="mine" aria-label="Go to my base">${I('locate', 'My base')}</button>
    </div>
    <div class="rmx-mini hud-frame" aria-label="Realm minimap: tap to fly, drag the box to pan, pinch or scroll to zoom, double-tap to reset" role="img"></div>
    <button class="hud-tool hud-tool--icon rmx-mini-t" data-a="minit" aria-label="Hide minimap" aria-pressed="true">${I('map')}</button>
    <div class="rmx-nav"><button class="hud-tool hud-tool--icon" data-a="prev" aria-label="Previous base">${I('prev')}</button><button class="hud-tool hud-tool--icon" data-a="next" aria-label="Next base">${I('next')}</button></div>
    <div class="rmx-card hud-panel" role="dialog" aria-label="Base details" hidden></div>
    <div class="rmx-scale hud-pill" aria-hidden="true"></div>
    <div class="rmx-stats" hidden></div>
    <div class="rmx-sr" aria-live="polite"></div>`;
  const $ = s => el.querySelector(s);
  const E = { top: $('.rmx-top'), exit: $('[data-a=exit]'), titleBox: $('.rmx-title'), title: $('.rmx-title b'), sub: $('.rmx-title small'), search: $('.rmx-search'), input: $('.rmx-search input'), results: $('.rmx-results'),
    chips: $('.rmx-chips'), chipBtns: [...el.querySelectorAll('.rmx-chips .hud-filter')], lvl: $('.rmx-lvl'), lvlChip: $('[data-a=lvl]'), mini: $('.rmx-mini'), miniT: $('.rmx-mini-t'), tools: $('.rmx-tools'), labels: $('.rmx-labels'), selBox: $('.rmx-selbox'),
    nav: $('.rmx-nav'), card: $('.rmx-card'), scale: $('.rmx-scale'), stats: $('.rmx-stats'), sr: $('.rmx-sr') };
  const q = new URLSearchParams(location.search); E.stats.hidden = !q.has('stats');
  if (host) for (const e of [E.top, E.chips, E.lvl, E.tools, E.nav, E.card]) e.style.display = 'none';
  let R = null, lay = '', miniOpen = true, miniPin = false, focusTop = 0, searchIdx = [], results = [], resSel = -1, cardFor = undefined;

  // ---- layout: portrait phone vs landscape/desktop (event-driven: resize, card, minimap, show) ----
  const setStyle = (e, st) => { const c = e._st ?? (e._st = {}); for (const k in st) if (c[k] !== st[k]) { e.style[k] = st[k]; c[k] = st[k]; } };
  // portrait: the minimap folds while the base card is open (the card and the minimap would both cover the
  // selected plot: GA2-19); its toggle stays and pins it open again for that card
  // fix iteration 2: while the whole realm is on screen the minimap would only repeat the view: it and its toggle hide
  let wholeRealm = false;
  const miniShown = () => miniOpen && !wholeRealm && (lay !== 'portrait' || E.card.hidden || miniPin);
  const CARD_W = 330; let cardR = 86; // wide card: width; right offset = the tool column (MY BASE sets its width) + gaps
  function layout() {
    const W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight, l = W < H && W < 700 ? 'portrait' : 'wide';
    if (l !== lay) { lay = l; el.dataset.lay = l; E.card.classList.toggle('hud-panel--sheet', l === 'portrait'); }
    const sa = safe(), shown = miniShown(), cardH = E.card.hidden ? 0 : E.card.offsetHeight;
    // minimap: portrait top-right inside 132×132 under the chips; landscape/desktop bottom-left inside 180×120. The frame
    // takes the realm's own aspect (fix iteration 2: a square frame letterboxed Frostveil and showed a neighbour's land)
    const [bw, bh] = lay === 'portrait' ? [132, 132] : [180, 120], ar = R ? R.cols / R.rows : bw / bh;
    let mw = bw, mh = Math.round(bw / ar); if (mh > bh) { mh = bh; mw = Math.round(bh * ar); }
    mw = Math.max(72, mw); mh = Math.max(72, mh);
    const m = lay === 'portrait' ? { w: mw, h: mh, x: W - mw - 10 - sa.r, y: 122 + sa.t } : { w: mw, h: mh, x: 10 + sa.l, y: H - mh - 12 - sa.b };
    setStyle(E.mini, { left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px', display: shown ? '' : 'none' });
    setStyle(E.miniT, { display: wholeRealm ? 'none' : '' });
    setStyle(E.miniT, lay === 'portrait' ? { left: (m.x + m.w - 48) + 'px', top: (shown ? m.y + m.h + 8 : m.y) + 'px' } : { left: (shown ? m.x + m.w + 8 : m.x) + 'px', top: (m.y + m.h - 48) + 'px' });
    if (E.miniT.getAttribute('aria-pressed') !== String(shown)) { E.miniT.setAttribute('aria-pressed', String(shown)); E.miniT.setAttribute('aria-label', shown ? 'Hide minimap' : 'Show minimap'); }
    // tools on the right edge, centred on whole pixels (pixel art never sits on a half pixel); above the sheet
    const th = E.tools.offsetHeight || 168, cardTop = H - cardH;
    cardR = sa.r + 10 + (E.tools.offsetWidth || 64) + 12; setStyle(E.card, { right: lay === 'portrait' ? '' : cardR + 'px' });
    setStyle(E.tools, { top: Math.max(focusTop + 8, Math.min(Math.round((H - th) / 2), lay === 'portrait' && cardH ? cardTop - th - 12 : H)) + 'px' });
    // next/prev: above the card (portrait) or bottom-centre of the free map area (wide), never over the minimap
    const nw = E.nav.offsetWidth || 104;
    if (lay === 'portrait') setStyle(E.nav, { left: Math.round((W - nw) / 2) + 'px', bottom: (cardH + 10 + (cardH ? 0 : sa.b)) + 'px', top: '' });
    else {
      const free = E.card.hidden ? W : W - CARD_W - cardR, clearMini = m.x + (shown ? m.w + 8 : 0) + 48 + 12 + nw / 2;
      setStyle(E.nav, { left: Math.round(Math.max(free / 2, clearMini) - nw / 2) + 'px', bottom: (14 + sa.b) + 'px', top: '' });
    }
    // scale: portrait above the ◀ ▶ row, wide above the minimap
    setStyle(E.scale, lay === 'portrait' ? { left: (10 + sa.l) + 'px', bottom: (cardH + 10 + (cardH ? 0 : sa.b) + 48 + 8) + 'px', top: '' } : { left: m.x + 'px', bottom: (shown ? H - m.y + 8 : 70 + sa.b) + 'px', top: '' });
    focusTop = E.chips.offsetTop + E.chips.offsetHeight;
    miniRectCache = shown ? { x: m.x, y: m.y, w: m.w, h: m.h } : null;
    chromeDirty = true;
  }
  let miniRectCache = null, safeCache = null;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  el.appendChild(probe);
  function safe() {
    if (safeCache) return safeCache; const cs = getComputedStyle(probe), px = v => parseFloat(v) || 0;
    return (safeCache = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) });
  }

  // ---- chrome rects (CSS px, root-relative, padded): what tags and counters must never cover ----
  const chrome = []; let chromeDirty = true, chromeGen = 0;
  function measureChrome() {
    chromeDirty = false; chrome.length = 0; chromeGen++;
    const o = el.getBoundingClientRect();
    const add = (l, t, r, b) => { if (r > l && b > t) chrome.push([l - o.left - PAD, t - o.top - PAD, r - o.left + PAD, b - o.top + PAD]); };
    const shown = e => e && !e.hidden && e.getClientRects().length > 0;
    for (const e of [E.exit, E.titleBox, E.search, E.results, E.lvl, E.mini, E.miniT, E.tools, E.nav, E.card, E.scale, E.stats]) if (shown(e)) { const r = e.getBoundingClientRect(); add(r.left, r.top, r.right, r.bottom); }
    for (const r of host?.chromeRects?.() ?? []) add(r[0] + o.left, r[1] + o.top, r[2] + o.left, r[3] + o.top); // (P7: root-relative)
    const cr = E.chips.getBoundingClientRect(); // chips: each chip's visible part (the row scrolls)
    for (const c of E.chipBtns) { const r = c.getBoundingClientRect(); add(Math.max(r.left, cr.left), r.top, Math.min(r.right, cr.right), r.bottom); }
    const over = E.chips.scrollWidth - E.chips.scrollLeft - E.chips.clientWidth > 2; // scroll affordance: fade the edge while more chips lie right
    if (over !== E.chips.hasAttribute('data-over')) E.chips.toggleAttribute('data-over', over);
  }
  E.chips.addEventListener('scroll', () => { chromeDirty = true; api.core?.invalidate(); }, { passive: true });
  const dirty = () => { chromeDirty = true; api.core?.invalidate(); };

  // ---- actions ----
  el.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a, f = e.target.closest('[data-f]')?.dataset.f;
    if (f) { api.setFilter({ kind: f }); chips(); announce(); if (f === 'mine') { const m = R?.bases.find(b => b.mine); if (m) api.select(m, true); } return; }
    if (!a) return; api.core?.input();
    if (a === 'exit') api.exit();
    else if (a === 'in') api.zoomBy(2.2); else if (a === 'out') api.zoomBy(1 / 2.2);
    else if (a === 'mine') api.myBase();
    else if (a === 'next') api.step(1); else if (a === 'prev') api.step(-1);
    else if (a === 'lvl') { E.lvl.hidden = !E.lvl.hidden; E.lvlChip.setAttribute('aria-expanded', String(!E.lvl.hidden)); dirty(); }
    else if (a === 'search') { E.search.classList.add('open'); E.input.focus(); dirty(); }
    else if (a === 'minit') { const cardUp = lay === 'portrait' && !E.card.hidden;
      if (miniShown()) { if (cardUp) miniPin = false; else miniOpen = false; } else { miniOpen = true; if (cardUp) miniPin = true; }
      layout(); api.core?.invalidate(); }
    else if (a === 'close') api.select(null);
    else if (a === 'look') { const b = api.selected; if (b) { const p = plotOf(b); api.flyToD(p.x, p.y, MY_BASE_D, 800); } }
  });
  E.lvl.addEventListener('input', e => {
    const i = +e.target.dataset.l; if (Number.isNaN(i)) return; const ins = E.lvl.querySelectorAll('input'), outs = E.lvl.querySelectorAll('output');
    let lo = +ins[0].value, hi = +ins[1].value; if (lo > hi) { if (i === 0) hi = lo; else lo = hi; ins[0].value = lo; ins[1].value = hi; }
    outs[0].textContent = lo; outs[1].textContent = hi;
    E.lvlChip.querySelector('.lg').textContent = `Level ${lo}–${hi}`; E.lvlChip.querySelector('.sm').textContent = `Lv ${lo}–${hi}`;
    E.lvlChip.setAttribute('aria-label', `Level ${lo}–${hi}`); E.lvlChip.classList.toggle('is-on', lo > 1 || hi < 20);
    api.setFilter({ lvl: [lo, hi] }); announce(); dirty();
  });
  function chips() { const k = api.filter.kind; E.chips.querySelectorAll('[data-f]').forEach(c => { const on = c.dataset.f === k; if (c.classList.contains('is-on') !== on) { c.classList.toggle('is-on', on); c.setAttribute('aria-pressed', String(on)); } }); }
  function announce() { E.sr.textContent = `${api.filtered.length} kingdoms shown`; head(); }
  function head() {
    if (!R) return; if (E.title.textContent !== R.name) E.title.textContent = R.name;
    const f = api.filter, shown = api.filtered.length, all = R.bases.length, filtered = f.kind !== 'all' || f.lvl[0] > 1 || f.lvl[1] < 20;
    const n = v => `<span class="hud-num">${fmtN(v)}</span>`, t = `${n(R.meta.grid.deeds)} deeds · ${n(all)} kingdoms${filtered ? ` · ${n(shown)} shown` : ''}`;
    if (E.sub._t !== t) { E.sub.innerHTML = t; E.sub._t = t; chromeDirty = true; }
  }

  // ---- search (prefix over a prebuilt index; ≤ 8 results; keyboard nav) ----
  const plotOf = b => api.plotAt?.(b) ?? (b.free || typeof b.level !== 'number' ? { x: b.x + 0.5, y: b.y + 0.5 } : plotCentre(b.x, b.y, b.level));
  function buildIndex() { searchIdx = R.bases.map(b => [b.name.toLowerCase(), b]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
  function lower(qs) { let lo = 0, hi = searchIdx.length; while (lo < hi) { const m = (lo + hi) >> 1; if (searchIdx[m][0] < qs) lo = m + 1; else hi = m; } return lo; }
  function runSearch() {
    const qs = E.input.value.trim().toLowerCase(); results = [];
    if (qs) { for (let i = lower(qs); i < searchIdx.length && results.length < 8 && searchIdx[i][0].startsWith(qs); i++) results.push(searchIdx[i][1]);
      if (results.length < 8) for (const [n, b] of searchIdx) { if (results.length >= 8) break; if (!n.startsWith(qs) && n.includes(qs)) results.push(b); } }
    resSel = results.length ? 0 : -1; drawResults(qs);
  }
  function drawResults(qs) {
    if (!qs) { if (!E.results.hidden) { E.results.hidden = true; dirty(); } return; }
    if (E.results.hidden) { E.results.hidden = false; dirty(); }
    E.results.innerHTML = results.length ? results.map((b, i) => `<button class="hud-row${b.mine ? ' is-mine' : ''}" role="option" data-i="${i}" aria-selected="${i === resSel}"><img class="hud-avatar${b.mine ? ' is-mine' : ''}" src="${esc(avatarURL(b.avatar))}" alt=""><span>${esc(b.name)}</span><em class="hud-num">L${b.level}</em></button>`).join('') : '<div class="none hud-body hud-dim">No kingdom by that name</div>';
  }
  function choose(i) { const b = results[i]; if (!b) return; closeSearch(); api.select(b, true); }
  function closeSearch() { E.input.value = ''; E.results.hidden = true; E.search.classList.remove('open'); E.input.blur(); dirty(); }
  E.input.addEventListener('input', runSearch);
  E.input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { resSel = Math.min(results.length - 1, resSel + 1); drawResults(E.input.value.trim()); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { resSel = Math.max(0, resSel - 1); drawResults(E.input.value.trim()); e.preventDefault(); }
    else if (e.key === 'Enter') choose(Math.max(0, resSel));
    else if (e.key === 'Escape') { closeSearch(); e.stopPropagation(); }
  });
  E.input.addEventListener('blur', () => setTimeout(() => { if (!E.input.value) { E.search.classList.remove('open'); dirty(); } }, 150));
  E.results.addEventListener('pointerdown', e => { const i = e.target.closest('[data-i]')?.dataset.i; if (i != null) { e.preventDefault(); choose(+i); } });

  // ---- card (bottom sheet in portrait with a drag handle + swipe for next/prev; right panel otherwise) ----
  function card(b) {
    if (host) { cardFor = b; host.card?.(b); return; } // P7: the host's panel is the card (scout, raid, choose land)
    cardFor = b; const c = E.card;
    if (!b) { miniPin = false; if (!c.hidden) { c.hidden = true; layout(); } return; }
    const lonlat = (x, y) => { const lon = -180 + (R.x0 + x + 0.5) * DEED_DEG, lat = 90 - (R.y0 + y + 0.5) * DEED_DEG; return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`; };
    const num = v => `<span class="hud-num">${v}</span>`, head = '<i class="hud-grip" aria-hidden="true"></i><button class="hud-x x" data-a="close" aria-label="Close"></button>';
    if (b.free) {
      c.innerHTML = `${head}
        <div class="row"><div class="who"><div class="nm">Open deed</div><p class="note">No kingdom yet · wild land</p></div></div>
        <dl class="facts"><dt class="hud-cap">Realm</dt><dd>${esc(R.name)}</dd><dt class="hud-cap">Parcel</dt><dd>${num(`${R.x0 + b.x}, ${R.y0 + b.y}`)}</dd><dt class="hud-cap">Location</dt><dd>${num(lonlat(b.x, b.y))}</dd></dl>
        <div class="acts hud-foot"><button class="hud-btn hud-btn--ghost" data-a="look">View deed</button></div>`;
    } else {
      const p = plotRule(b.level), kt = keepThumb ? keepThumb(b.level) : null;
      const tags = (b.mine ? '<span class="hud-tag hud-tag--gold">Your base</span>' : '')
        + (b.shield === true ? '<span class="hud-tag hud-tag--blue">Shielded</span>' : b.shield === false ? '' : '<span class="hud-tag">Shield unknown</span>')
        + (b.attackable ? '<span class="hud-tag hud-tag--red">You can attack</span>' : ''); // P4 (native 94e5052): the owner's wording
      const thumb = kt?.w ? `<div class="keep" role="img" aria-label="Illustration of a level ${b.level} kingdom" style="width:${kt.w}px;height:${kt.h}px;background:url('${esc(kt.src)}') -${kt.x}px -${kt.y}px no-repeat"></div>`
        : kt?.src ? `<img class="keep" src="${esc(kt.src)}" alt="Illustration of a level ${b.level} kingdom">` : '';
      c.innerHTML = `${head}
        <div class="row"><img class="hud-avatar hud-avatar--lg${b.mine ? ' is-mine' : ''}" src="${esc(avatarURL(b.avatar))}" alt="">
          <div class="who"><div class="nm">${esc(b.name)}</div>
          <div class="hud-level"><span>Keep level <b>${b.level}</b>/20</span><span class="hud-meter" style="--p:${(b.level / 20 * 100).toFixed(0)}%"><i></i></span></div>
          ${tags ? `<div class="tags">${tags}</div>` : ''}</div></div>
        <div class="row2"><dl class="facts">${b.trophies != null ? `<dt class="hud-cap">Trophies</dt><dd>${num(fmtN(b.trophies))}</dd>` : ''}<dt class="hud-cap">Clan</dt><dd>${b.clan ? esc(b.clan) : '—'}</dd><dt class="hud-cap">Claim</dt><dd>${num(`${p.claim}×${p.claim}`)} tiles</dd><dt class="hud-cap">Location</dt><dd>${num(lonlat(b.x, b.y))}</dd></dl>${thumb}</div>
        <div class="acts hud-foot">${b.mine ? '<button class="hud-btn" disabled title="Enter base comes with the live feed">Enter base<small class="soon">soon</small></button>'
          : `<button class="hud-btn" disabled title="Coming with the live feed"><i class="hud-i hud-i--scout" aria-hidden="true"></i>Scout<small class="soon">soon</small></button><button class="hud-btn" disabled title="Coming with the live feed"><i class="hud-i hud-i--attack" aria-hidden="true"></i>Attack<small class="soon">soon</small></button>`}
          <button class="hud-btn hud-btn--gold" data-a="look">Look closer</button></div>`;
    }
    c.hidden = false; layout();
  }
  // swipe on the card: left/right = next/prev; down = close (portrait sheet)
  let sw = null;
  E.card.addEventListener('pointerdown', e => { if (e.target.closest('button,input')) return; sw = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
  E.card.addEventListener('pointerup', e => {
    if (!sw) return; const dx = e.clientX - sw.x, dy = e.clientY - sw.y; sw = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) api.step(dx < 0 ? 1 : -1);
    else if (lay === 'portrait' && dy > 60 && Math.abs(dy) > Math.abs(dx)) api.select(null);
  });

  // ---- minimap hit-div: tap → flyTo, drag the viewport box → live pan, pinch/wheel → zoom, double-tap → reset ----
  // A box drag freezes the minimap's own camera at pointerdown and maps the finger's delta through that frozen
  // rect (Gate A PM-3: a zoomed minimap follows the main view, so mapping the absolute finger position through
  // the moving rect fed back into itself: 1.8× the move at z 0.5, 3.3× at z 1).
  const mp = new Map(); let mDown = null, mPinch = null, mLastTap = 0;
  const mpos = e => { const r = E.mini.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const mm = () => api.minimap;
  const endDrag = () => { if (mDown?.box) { mm()?.unfreeze?.(); mDown.box = false; } };
  E.mini.addEventListener('pointerdown', e => {
    E.mini.setPointerCapture(e.pointerId); const [x, y] = mpos(e); mp.set(e.pointerId, { x, y }); api.core?.input();
    if (mp.size === 1) {
      mDown = { x, y, t: e.timeStamp, box: !!mm()?.inBox(x, y, api.lastView), moved: false };
      if (mDown.box) { mm().freeze(); mDown.cam = [api.cam.x, api.cam.y]; mDown.dpp = mm().deedPerPx(); }
    }
    if (mp.size === 2) { const [a, b] = [...mp.values()]; mPinch = Math.hypot(a.x - b.x, a.y - b.y); if (mDown) mDown.moved = true; endDrag(); }
  });
  E.mini.addEventListener('pointermove', e => {
    const p = mp.get(e.pointerId); if (!p) return; const [x, y] = mpos(e); p.x = x; p.y = y;
    if (mp.size === 2 && mPinch) { const [a, b] = [...mp.values()], d = Math.hypot(a.x - b.x, a.y - b.y); mm()?.zoomBy(d / mPinch); mPinch = d; return; }
    if (!mDown) return; if (Math.hypot(x - mDown.x, y - mDown.y) > 4) mDown.moved = true;
    if (mDown.moved && mDown.box) { api.cam.set(mDown.cam[0] + (x - mDown.x) * mDown.dpp, mDown.cam[1] + (y - mDown.y) * mDown.dpp, null); api.core?.input(); }
  });
  E.mini.addEventListener('pointerup', e => {
    if (!mp.delete(e.pointerId)) return; if (mp.size) return; mPinch = null;
    if (mDown && !mDown.moved) {
      if (e.timeStamp - mLastTap < 300) { mm()?.reset(); mLastTap = 0; }
      else { mLastTap = e.timeStamp; const w = mm()?.toDeed(mDown.x, mDown.y); if (w) api.flyToD(w[0], w[1], Math.max(api.cam.d, BANDS.mapStart), 600); }
    } else if (mDown?.box) api.cam.settle();
    endDrag(); mDown = null;
  });
  E.mini.addEventListener('pointercancel', e => { mp.delete(e.pointerId); endDrag(); mDown = null; mPinch = null; });
  E.mini.addEventListener('wheel', e => { e.preventDefault(); mm()?.zoomBy(Math.exp(-e.deltaY * 0.004)); api.core?.input(); }, { passive: false });

  // ---- labels: cluster counters (s < 24) and avatar tags (s ≥ 24, ≤ 16) ----
  // Pooled elements; each remembers what it shows (_c class, _t text, _id tag base, _tf transform) and a
  // steady frame writes only the transforms that changed.
  const pool = []; let used = 0;
  const label = () => { let l = pool[used]; if (!l) { l = document.createElement('div'); l.className = 'rmx-l'; E.labels.appendChild(l); pool[used] = l; } used++; return l; };
  const cls = (l, c) => { if (l._c !== c) { l.className = c; l._c = c; } };
  const tf = (l, t) => { if (l._tf !== t) { l.style.transform = t; l._tf = t; } if (l.hidden) l.hidden = false; };
  const hit = (r, list, n) => { for (let i = 0; i < n; i++) { const p = list[i]; if (r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]) return true; } return false; };
  const inside = (r, box) => r[0] >= box[0] && r[1] >= box[1] && r[2] <= box[2] && r[3] <= box[3];
  const lstats = { counters: 0, counterSum: 0, basesOnScreen: 0, tags: 0 };

  // cluster counters never take pointer events (a finger landing on one must still pinch the map); a tap
  // on the canvas asks hitCluster() first (map.js onTap) and zooms into that cluster
  const clusters = []; // [{ sx, sy, r, x, y }] of the counters on screen
  const cells = new Map(), cpool = [], make = i => cpool[i] ?? (cpool[i] = {}); // pooled cell objects: no per-frame allocation
  function counters(view, box) {
    const { list, onScreen } = clusterCounters({ bases: api.filtered, cam: api.cam, s: view.s, W: view.W, H: view.H, chrome, box, cells, make });
    clusters.length = 0; let sum = 0;
    for (const c of list) {
      sum += c.n;
      const l = label(); if (l._id !== undefined) { l._id = undefined; l._t = undefined; }
      cls(l, c.mine ? 'rmx-l hud-count is-mine' : 'rmx-l hud-count'); const t = String(c.n); if (l._t !== t) { l.textContent = t; l._t = t; }
      if (l._w !== c.w) { l.style.width = c.w + 'px'; l._w = c.w; } // exact box: whole-pixel placement, no -50 % half pixel
      tf(l, `translate(${Math.round(c.px - c.w / 2)}px,${Math.round(c.py - COUNTER_H / 2)}px)`);
      clusters.push({ sx: c.px, sy: c.py, r: 22, x: c.u / c.n, y: c.v / c.n });
    }
    lstats.counters = clusters.length; lstats.counterSum = sum; lstats.basesOnScreen = onScreen;
  }
  const placed = [], tagHits = []; // tagHits (P7): this frame's placed tags, for hitTag
  function tags(view, box) {
    tagHits.length = 0;
    const cam = api.cam, s = view.s, H = view.H, sel = api.selected, hov = api.hovered, cardOpen = host ? (host.cardOpen?.() ?? !!cardFor) : !E.card.hidden;
    const trueBand = view.d >= BANDS.trueFull, mapClose = view.d >= BANDS.impostor[0], tile = s / TILES;
    const cand = api.tagCandidates?.(view) ?? defaultCandidates(view);
    cand.sort((a, b) => b.priority - a.priority);
    placed.length = 0; for (const r of chrome) placed.push(r); const nChrome = placed.length; let n = 0;
    for (const v of cand) {
      if (n >= MAX_TAGS) break; const b = v.base, isSel = b === sel;
      if (isSel && cardOpen) continue;                  // the open card (and the gold outline) already name it
      if (trueBand && !isSel && b !== hov) continue;    // TRUE: the kingdom is the hero; only the selected/hovered tag
      // From d 200 the keep sits mid-plot: the tag goes above the claim's north edge (walls stand ~1.5 tiles
      // tall there) and above a shield dome's crown, never over the kingdom it names (Gate A OB-2)
      let ay = v.sy;
      if (mapClose) {
        const cy = (plotOf(b).y - cam.y) * s + H / 2, S = plotRule(b.level).claim; // the plot, not the deed centre (plotOffset)
        ay = Math.min(ay, cy - (S / 2 + 1.5) * tile - 6);
        if (b.shield) ay = Math.min(ay, cy - 0.8 * (S / 2 + 2) * tile - 6);
      }
      const full = api.drawsBase ? api.drawsBase(b, view) : true, nm = tagName(b.name, !full); // P7: compact until the keep draws
      const big = isSel, w = tagW(nm, full ? b.level : '', big), h = big ? 36 : 24;
      let x = v.sx; if (b.mine || isSel) x = clamp(x, box[0] + w / 2 + 3, box[2] - w / 2 - 3); // own / selected tag slides in at the edge
      const r = [x - w / 2 - 3, ay - 4 - h, x + w / 2 + 3, ay - 4];
      if (!inside(r, box) || hit(r, placed, placed.length)) continue;
      placed.push(r); n++; tagHits.push({ r, b });
      const l = label(); if (l._t !== undefined) { l._t = undefined; l._id = undefined; }
      cls(l, 'rmx-l hud-nametag' + (b.mine ? ' is-mine' : '') + (big ? ' is-sel' : ''));
      if (l._w !== '') { l.style.width = ''; l._w = ''; }
      const av = avatarURL(b.avatar), key = `${b.id}|${av}|${nm}|${full ? b.level : ''}`; // P7: a picture that loads later, the level at hand-over
      if (l._id !== key) { l._id = key; l.innerHTML = `<img src="${esc(av)}" alt=""><span>${esc(nm)}</span>${full ? `<em>${b.level}</em>` : ''}`; }
      tf(l, `translate(${Math.round(x)}px,${Math.round(ay - 4)}px) translate(-50%,-100%)`);
    }
    lstats.tags = n; lstats.tagsOverChrome = 0; for (let i = nChrome; i < placed.length; i++) if (hit(placed[i], placed, nChrome)) lstats.tagsOverChrome++;
  }
  // W1 S7: the FAR counters are a pure function of the camera, the screen, the filtered list and the chrome rects; a frame
  // that changes none of them (the band rehearsal, the idle clock, a pulse) reuses the last layout instead of re-clustering
  // every base and touching the DOM (ui p95 15.9 ms at FAR on SwiftShader while the rehearsal drew)
  let lastSig = '', lastList = null;
  function labels(view) {
    if (view.s < BANDS.uiDots) {
      const c = api.cam, sig = `${c.x},${c.y},${view.s},${view.W},${view.H},${chromeGen}`;
      if (sig === lastSig && lastList === api.filtered) return;
      lastSig = sig; lastList = api.filtered;
    } else lastSig = '';
    used = 0; const sa = safe(), box = [sa.l + 2, sa.t + 2, view.W - sa.r - 2, view.H - sa.b - 2];
    lstats.counters = lstats.counterSum = lstats.basesOnScreen = lstats.tags = 0;
    if (view.s < BANDS.uiDots) { counters(view, box); lstats.mode = 'counters'; }
    else { clusters.length = 0; lstats.mode = 'tags'; if (view.speed < 1500) tags(view, box); }
    if (lstats.mode !== 'tags' || view.speed >= 1500) tagHits.length = 0;
    for (let i = used; i < pool.length; i++) if (!pool[i].hidden) pool[i].hidden = true;
  }
  // .hud-nametag width estimate (collision boxes): avatar + 1 px rule, 5 px gaps, 6 px right pad, 2 px border;
  // VT323 advance 0.4 em at the sheet's --hud-fs-cap (name) / --hud-fs-body (level; the selected tag's name)
  let fs = null;
  // (P7: measured as drawn: the shown name, and the level only when it shows)
  const tagW = (name, level, big) => { fs ??= (() => { const c = getComputedStyle(document.documentElement), v = (k, d) => parseFloat(c.getPropertyValue(k)) || d; return { cap: v('--hud-fs-cap', 16), body: v('--hud-fs-body', 18) }; })();
    return (big ? 35 : 23) + 5 + Array.from(name).length * 0.4 * (big ? fs.body : fs.cap) + (level === '' ? 0 : 5 + String(level).length * 0.4 * fs.body) + 8; };
  // SHELL's candidates until BASES provides tagCandidates(view): the plot centre (plotOffset), a marker's height above
  function defaultCandidates(view) {
    const cam = api.cam, s = view.s, W = view.W, H = view.H, out = [], sel = api.selected, inSet = api.filteredSet;
    const lift = Math.min(BANDS.keepMinCss, s * 0.6);
    for (const b of api.filtered.length < 4000 ? api.filtered : api.filtered.slice(0, 4000)) {
      let sx = (b.x + 0.5 - cam.x) * s + W / 2, sy = (b.y + 0.5 - cam.y) * s + H / 2; if (sx < -60 - s || sy < -40 - s || sx > W + 60 + s || sy > H + 60 + s) continue; // deed-level cull first
      const p = plotOf(b); sx = (p.x - cam.x) * s + W / 2; sy = (p.y - cam.y) * s + H / 2 - lift * 0.5; if (sx < -60 || sy < -40 || sx > W + 60 || sy > H + 60) continue;
      const pr = (b === sel ? 1e9 : 0) + (b.mine ? 1e8 : 0) + (inSet?.has(b) ? 1e6 : 0) + b.level * 1e3 - Math.hypot(sx - W / 2, sy - H / 2);
      out.push({ base: b, sx, sy, priority: pr });
    }
    if (sel && !sel.free && !out.some(o => o.base === sel)) { const p = plotOf(sel), sx = (p.x - cam.x) * s + W / 2, sy = (p.y - cam.y) * s + H / 2; out.push({ base: sel, sx, sy, priority: 2e9 }); }
    return out;
  }

  function selBox(view) { // the selected open deed's box (deedBox)
    const b = api.selected, e = E.selBox, [sx, sy] = b?.free ? api.cam.deedToScreen(b.x, b.y) : [0, 0], r = b?.free ? deedBox(sx, sy, view.s, view.W, view.H) : null;
    if (!r) { if (!e.hidden) e.hidden = true; return; }
    setStyle(e, { width: r.w + 'px', height: r.h + 'px', transform: `translate(${r.x}px,${r.y}px)` });
    if (e._f !== r.f) { e.style.setProperty('--f', r.f); e._f = r.f; }
    if (e.hidden) e.hidden = false;
  }
  let statsT = 0, scaleT = '', cueOn = false;
  const ui = {
    el,
    show(r) { R = r; el.hidden = false; el.style.setProperty('--hud-acc', REALM_ACCENT[r.id] ?? '#e3ae3c'); buildIndex(); head(); chips(); E.lvl.hidden = true; layout(); },
    hide() { el.hidden = true; closeSearch(); },
    refresh() { head(); chips(); },
    card,
    escape() { if (!E.results.hidden || E.search.classList.contains('open')) { closeSearch(); return true; } if (!E.lvl.hidden) { E.lvl.hidden = true; dirty(); return true; } if (cardFor) { api.select(null); return true; } return false; },
    miniRect: () => miniRectCache,
    /** CSS px the camera centre should sit from a selected base so the base shows in the uncovered area. */
    focusOffset() { // the plot lands mid-way in the free map area: between the chips and the sheet, or left of the panel
      if (host) return host.focusOffset?.() ?? [0, 0]; // P7
      if (E.card.hidden) return [0, 0];
      return lay === 'portrait' ? [0, Math.round((E.card.offsetHeight - focusTop) / 2)] : [Math.round((CARD_W + cardR) / 2), 0]; },
    /** The cluster counter under a canvas tap (CSS px), or null. */
    /** P7: the kingdom whose tag lies under a canvas tap (CSS px), or null. */
    hitTag: (sx, sy) => tagAt(tagHits, sx, sy),
    /** P7: the host's chrome moved or changed size: re-measure before the next labels. */
    chromeChanged: dirty,
    hitCluster(sx, sy) { let best = null, bd = Infinity; for (const c of clusters) { const d = Math.hypot(c.sx - sx, c.sy - sy); if (d < c.r && d < bd) { bd = d; best = c; } } return best; },
    /** Label accounting for QA: counters, their sum, bases on screen (FAR); tags and tags over chrome (MAP+). */
    stats: () => ({ ...lstats, chromeRects: chrome.length }),
    /** The measured chrome rects (CSS px, padded) — QA overlap checks. */
    chromeRects: () => chrome.map(r => r.slice()),
    frame(view) {
      const T = api.core?.tally ?? ((n, f) => f()); // W1 S7: attribute the HUD's frame work (stats().frameParts)
      if (chromeDirty) T('ui.chrome', measureChrome);
      T('ui.labels', () => labels(view));
      selBox(view);
      // band readiness cue (W1 S2): while the zoom waits at a band gate, the scale pill (the approved HUD's own element and
      // type) also says how much of the next band's detail is ready; nothing new is drawn anywhere else
      const [bw, bl] = scaleBar(view.s), cue = view.gate?.held ? `detail ${Math.min(99, Math.floor((view.gate.progress ?? 0) * 100))}%` : '', st = `${bw}|${bl}|${cue}`;
      if (st !== scaleT) { scaleT = st; E.scale.innerHTML = `<i class="rmx-sbar" style="width:${bw}px"></i><span class="hud-num">${bl}</span>${cue ? `<span class="hud-num">· ${cue}</span>` : ''}`; if (!!cue !== cueOn) { cueOn = !!cue; chromeDirty = true; } }
      const r = view.rect, whole = R && Math.min(r.fx1, R.cols) - Math.max(r.fx0, 0) >= 0.97 * R.cols && Math.min(r.fy1, R.rows) - Math.max(r.fy0, 0) >= 0.97 * R.rows;
      if (!!whole !== wholeRealm) { wholeRealm = !!whole; layout(); api.core?.invalidate(); }
      if (!E.stats.hidden && performance.now() - statsT > 250) { statsT = performance.now(); const S = api.stats();
        E.stats.textContent = `${S.realm} ${S.band} d=${S.d.toFixed(0)} s=${S.s.toFixed(1)} fade=${S.fadeWeight.toFixed(2)}\nfps p50 ${S.fps.p50.toFixed(0)} · p95 ${S.fps.p95FrameMs.toFixed(1)} ms · cpu ${S.frameMs.toFixed(1)} ms\ndraws ${S.drawCalls} · inst ${S.instances} · gpu ${S.gpuMB.realm.toFixed(1)} MB (globe ${S.gpuMB.globe ?? 'n/a'}) · heap ${S.cpuMB} MB\nidle ${S.idlePhase} · loaded ${(S.bytesLoaded / 1048576).toFixed(2)} MB · first ${S.firstFrameMs.toFixed(0)} ms\ndecode ${S.decodePath}${S.legacyPack ? ' · LEGACY pack' : ''} · losses ${S.contextLosses}\n${Object.entries(S.modules).map(([k, v]) => k + ': ' + v).join('\n')}`; }
    },
  };
  const onResize = () => { safeCache = null; fs = null; if (!el.hidden) { layout(); api.core?.invalidate(); } };
  addEventListener('resize', onResize);
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { // root or card size changes without a window resize (globe layout, card content, fonts)
    ro = new ResizeObserver(() => { if (!el.hidden) { layout(); api.core?.invalidate(); } });
    ro.observe(root); ro.observe(E.card);
  }
  /** web port P11: the engine is being thrown away: drop the window listener and the observer (map.mjs dispose). */
  ui.dispose = () => { removeEventListener('resize', onResize); ro?.disconnect(); ro = null; el.hidden = true; };
  document.fonts?.ready?.then(() => { chromeDirty = true; api.core?.invalidate(); });
  (hud?.loadHudFont() ?? Promise.resolve(false)).then(() => { chromeDirty = true; if (!el.hidden) layout(); api.core?.invalidate(); }); // VT323: never blocks the first frame
  return ui;
}
