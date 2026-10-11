// pk-tokens.mjs — repository adaptation of the VERSION 2 PKW web token bridge.
// review 419baf51 R1-R5, e9c1eb73 W8/W10 and 90845456 F5.
//
// Inputs:  TOKENS.json           the design source of truth (design/final/TOKENS.json).
//          ALIAS-PROPOSALS.json  MS-F2a's review ledger of the 46 legacy M48 --pk-* names; binding per design review
//                                ruling ca622d60 §2.
// Outputs: <outDir>/pk-tokens.generated.css  production token bridge
//          <outDir>/pk-tokens.qa.css         dev-only design-QA colours (never imported by production)
//          <outDir>/pk-tokens.generated.md   generator rule, key → name tables, no-design-source list
// Usage:   node pk-tokens.mjs <TOKENS.source.json> <ALIAS-PROPOSALS.source.json> <outDir>
// Every check runs before anything is written. On a failure the script throws and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Pure core: importing this module neither reads inputs nor generates files.
export function generatePkTokens(tokBytes, aliasBytes) {
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const T = JSON.parse(tokBytes.toString('utf8'));
const A = JSON.parse(aliasBytes.toString('utf8'));
const fail = (msg) => { throw new Error(`gen-pk-tokens: ${msg}`); };

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const px = (n) => (n === 0 ? '0' : `${n}px`);
const C = T.color;
const get = (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), T);
const fmt = (p, raw) => (p.startsWith('motion.durationMs.') ? `${raw}ms` : typeof raw === 'number' ? px(raw) : String(raw));
const code = (s) => '`' + s + '`';

// The pinned TOKENS file has sealArm but no sealIn/sealOut keys. Never borrow an unrelated duration.
// Prefer those exact semantic keys if a future design adds them; otherwise use DESIGN-SYSTEM.md:521.
const sealDuration = (key, fallback) => {
  const present = Object.hasOwn(T.motion.durationMs, key);
  const value = present ? T.motion.durationMs[key] : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) fail(`motion.durationMs.${key} must be a positive integer`);
  return { value, source: present ? `motion.durationMs.${key}` : 'DESIGN-SYSTEM.md:521; review 419baf51 R4 / 90845456 F5' };
};
const SEAL_IN = sealDuration('sealIn', 160);
const SEAL_OUT = sealDuration('sealOut', 120);

// Literal VT323 fallback steps, distinct from TOKENS' unadmitted Press Start 2P scale.
// Source: delivered kit/p0/kitBase.css:29-37 cites Android PkwTokens.Type; review 90845456 F5.
const DISPLAY_STEPS = [['numeral-l', 30], ['primary', 26], ['title', 24], ['label', 22], ['caption', 20]];

// ---------------------------------------------------------------------------------------------------------------
// Fixed tables (each cites its authority; none of them invents a colour or a size)
// ---------------------------------------------------------------------------------------------------------------

// design review decisions that resolve a proposal ALIAS-PROPOSALS left pending (ruling ca622d60 §2).
const LEAD = {
  '--pk-seal': {
    path: 'color.parchment.hex',
    why: 'review ca622d60 §2: --pk-seal keeps its dialog-material meaning (parchment); DESIGN-SYSTEM.md:422 "Centred WoodFrame + parchment"',
  },
  '--pk-t-seal': {
    value: `${SEAL_IN.value}ms`, path: SEAL_IN.source,
    why: 'review 419baf51 R4 supersedes the relayed 180ms proposal; visual entrance only, arming stays 450ms',
  },
};
// The one name v2 adds (ca622d60 §2: the gold action gets its own name).
const SEAL_PRIMARY = { name: '--pk-seal-primary', path: 'color.gold.hex', why: 'review ca622d60 §2; DESIGN-SYSTEM.md:54 (Seal primary = gold)' };

// The 18 MOTION_MS <-> CSS pairs pinned by M48 ui/ds/tokens.test.ts:115-121 (COMPARISON.json motion_mirrors).
const MOTION_MIRRORS = [
  ['press', '--pk-t-press'], ['swap', '--pk-t-swap'], ['disclose', '--pk-t-disclose'], ['pop', '--pk-t-pop'],
  ['stagger', '--pk-stagger'], ['staggerSection', '--pk-stagger-section'], ['sheet', '--pk-t-sheet'],
  ['snap', '--pk-t-snap'], ['close', '--pk-t-close'], ['seal', '--pk-t-seal'], ['fly', '--pk-t-fly'],
  ['glint', '--pk-t-glint'], ['beat', '--pk-beat'], ['celebrate', '--pk-t-celebrate'], ['ribbon', '--pk-t-ribbon'],
  ['toast', '--pk-t-toast'], ['riseQuick', '--pk-rise-quick'], ['staggerQuick', '--pk-stagger-quick'],
];
const MIRROR_KEY = new Map(MOTION_MIRRORS.map(([k, n]) => [n, k]));

// Where each legacy group sits in M48 tokens.css @ 92ba5d3f (COMPARISON.json consumer_occurrences).
const LEGACY_GROUPS = { '--pk-edge': 'geometry (M48 tokens.css:44-47)', '--pk-glass-flat': 'materials (M48 tokens.css:49-54)', '--pk-step': 'motion (M48 tokens.css:60-63; 18 of these are the MOTION_MS mirrors)' };

// The existing layer scale: M48 tokens.css:55-58 @ 92ba5d3f, mirrored by ui/ds/z.ts. Names and values kept, except
// consent (the Seal) and celebrate, which move above toast and stay under the worker-error layer (d6013820 §2b,
// ca622d60 §2). 3100 / 3200 are the free slots REVIEW F06 proposes. [name, M48 value, v2 value]
const Z = [
  ['anchor', 900, 900], ['hud', 1000, 1000], ['tapaway', 1001, 1001], ['menu', 1002, 1002], ['chat', 1010, 1010],
  ['tutorial', 1020, 1020], ['cmd', 1045, 1045], ['sheet', 1050, 1050], ['tray', 1100, 1100], ['page', 1200, 1200],
  ['scout', 1400, 1400], ['toast', 3000, 3000], ['consent', 1500, 3100], ['celebrate', 1700, 3200],
];
const Z_CEILING = 3500; // worker error, outside #overlay-root (M48 z.ts header)

// Reduced motion (TOKENS motion.reducedMotion). Only canonical --pk-dur-* names; legacy names are never re-declared.
const RM_ZERO = [...['readyBounceLoop', 'readyBouncePause', 'coinFly', 'commandStagger', 'invalidShake'].map((k) => `--pk-dur-${kebab(k)}`), '--pk-dur-drawer-row-stagger'];
const RM_FADE = [
  ...['plateIn', 'deckSwap', 'sheetIn', 'sheetOut', 'drawerIn', 'drawerOut', 'badgePop', 'toastIn', 'editorEnter', 'islandZoom', 'countUp'].map((k) => `--pk-dur-${kebab(k)}`),
  '--pk-dur-half-sheet-in', '--pk-dur-half-sheet-out',
  '--pk-dur-seal-in', '--pk-dur-seal-out',
];

// ---------------------------------------------------------------------------------------------------------------
// Resolve the 46 legacy names
// ---------------------------------------------------------------------------------------------------------------
if (!Array.isArray(A.aliases) || A.aliases.length !== 46 || A.names !== 46) fail(`ALIAS-PROPOSALS must list 46 names (got ${A.aliases?.length})`);
const legacy = A.aliases.map((a) => {
  const lead = LEAD[a.name];
  if (lead && Object.hasOwn(lead, 'value')) return { ...a, value: lead.value, design: true, key: lead.path, origin: lead.why };
  const key = lead ? lead.path : String(a.source_or_authority ?? '').split(';')[0].trim();
  const raw = key ? get(key) : undefined;
  if (raw !== undefined && typeof raw !== 'object') {
    const value = fmt(key, raw);
    if (!lead && value !== a.proposed_normal_value) fail(`${a.name}: TOKENS ${key} = ${value} but ALIAS-PROPOSALS proposes ${a.proposed_normal_value}`);
    return { ...a, value, design: true, key, origin: lead ? lead.why : a.source_or_authority };
  }
  if (lead) fail(`${a.name}: lead binding ${lead.path} does not resolve in TOKENS.json`);
  return { ...a, value: a.proposed_normal_value, design: false, key: null, origin: a.source_or_authority };
});
const LEGACY_SET = new Set(legacy.map((a) => a.name));
if (LEGACY_SET.size !== 46) fail('ALIAS-PROPOSALS names are not unique');
for (const [, n] of MOTION_MIRRORS) if (!LEGACY_SET.has(n)) fail(`motion mirror ${n} is not one of the 46 legacy names`);
if (new Set(MOTION_MIRRORS.map(([k]) => k)).size !== 18) fail('MOTION_MIRRORS must hold 18 unique JS keys');
for (const n of [...RM_ZERO, ...RM_FADE]) if (LEGACY_SET.has(n)) fail(`reduced-motion block may not re-declare legacy ${n}`);
const sealPrimaryValue = get(SEAL_PRIMARY.path);
if (typeof sealPrimaryValue !== 'string') fail(`${SEAL_PRIMARY.path} missing`);

const fallbackNote = (a) => (a.status === 'directive_bound_legacy_fallback' ? 'M48 legacy value kept, d6013820 §2d'
  : a.source_or_authority ? a.source_or_authority.split(';')[0].trim() : 'M48 legacy value');

// ---------------------------------------------------------------------------------------------------------------
// Main CSS
// ---------------------------------------------------------------------------------------------------------------
const out = [];
const L = (s = '') => out.push(s);
const rec = [];        // canonical TOKENS key -> name rows for the .md
const unsourced = [];  // values outside the legacy block that are not plain TOKENS values
const deferred = new Map(); // canonical names that are also legacy names: declared once, in the legacy block
const v = (name, val, c, ns) => {
  const full = `--pk-${name}`;
  rec.push({ key: c, name: full, value: val, inLegacy: LEGACY_SET.has(full) });
  if (ns) unsourced.push({ name: full, value: val, origin: c, kind: ns });
  if (LEGACY_SET.has(full)) { deferred.set(full, val); return; }
  L(`  ${full}: ${val};${c ? ` /* ${c} */` : ''}`);
};

L('/* pk-tokens.generated.css — VERSION 2 repository adaptation. GENERATED by pk-tokens.mjs from');
L(` *   TOKENS.source.json ("${T.name}", ${T.date}; sha256 ${sha256(tokBytes)}) and`);
L(` *   ALIAS-PROPOSALS.source.json (review ca622d60 + 419baf51; sha256 ${sha256(aliasBytes)}).`);
L(' * Do not hand-edit. Regenerate with the rule in pk-tokens.generated.md.');
L(' * Units: 1 dp = 1 CSS px, 1 sp = 1 CSS px, ms for durations. Radii are always 0.');
L(' * The design-QA overlay colours live in pk-tokens.qa.css, which is dev-only and never part of production. */');
L();
L(':root {');

L('  /* ===== Colour: base neutrals (TOKENS color.*) ===== */');
const plain = [
  ['ink', 'ink'], ['bg', 'bg'], ['surface', 'surface'], ['card', 'card'], ['charcoal', 'charcoal'],
  ['veil', 'veil'], ['veilHi', 'veil-hi'], ['border', 'border'], ['borderLt', 'border-lt'],
  ['text', 'text'], ['muted', 'text-muted'], ['faint', 'text-faint'],
];
for (const [k, n] of plain) v(n, C[k].hex, `color.${k}.hex`);
L();
L('  /* ===== Colour: verb ramps (hex = face, hi = top band, mid, lo = lip) ===== */');
for (const k of ['gold', 'green', 'blue', 'red', 'stone']) {
  L(`  /* ${k}: ${C[k].use.split(';')[0].slice(0, 90)} */`);
  v(k, C[k].hex, `color.${k}.hex`);
  for (const s of ['hi', 'lo', 'mid']) if (C[k][s]) v(`${k}-${s}`, C[k][s], `color.${k}.${s}`);
}
L();
L('  /* ===== Colour: status ramps (disabled, sent) ===== */');
for (const k of ['off', 'moss']) {
  v(k, C[k].hex, `color.${k}.hex`);
  for (const s of ['hi', 'lo']) v(`${k}-${s}`, C[k][s], `color.${k}.${s}`);
}
L();
L('  /* ===== Materials: parchment, cream, wood, ink on parchment ===== */');
v('parch', C.parchment.hex, 'color.parchment.hex');
v('parch-hi', C.parchment.hi, 'color.parchment.hi');
v('parch-lo', C.parchment.lo, 'color.parchment.lo');
v('cream', C.cream.hex, 'color.cream.hex');
v('cream-lo', C.cream.lo, 'color.cream.lo');
v('wood', C.wood.hex, 'color.wood.hex');
v('wood-hi', C.wood.hi, 'color.wood.hi');
v('wood-lo', C.wood.lo, 'color.wood.lo');
v('wood-seam', C.wood.seam, 'color.wood.seam');
v('ink-text', C.textOnParch.hex, 'color.textOnParch.hex');
v('ink-text-2', C.textOnParch.secondary, 'color.textOnParch.secondary');
L();
L('  /* ===== Status: reasons, errors, shortfall, selection ===== */');
v('danger', C.danger.hex, 'color.danger.hex — reason text on dark');
v('blood', C.blood.hex, 'color.blood.hex — error toast body');
v('short-bg', C.shortPill.hex, 'color.shortPill.hex');
v('short-text', C.shortPill.text, 'color.shortPill.text');
v('selected', C.selectedTint.hex, 'color.selectedTint.hex');
L();
L('  /* ===== Resources ===== */');
for (const k of Object.keys(C.resource)) v(`res-${kebab(k)}`, C.resource[k], `color.resource.${k}`);
L();
L('  /* ===== Scrims (color.scrim.seal is declared once, under its M48 name, in the legacy block) ===== */');
const scrim = { sheetHalf: 'half', sheetTall: 'tall', fullCard: 'full', commandShelf: 'shelf', seal: 'seal' };
for (const [k, n] of Object.entries(scrim)) v(`scrim-${n}`, C.scrim[k], `color.scrim.${k}`);
L();

L('  /* ===== Type families ===== */');
L('  /* Amendment 3 (LANE §5): display resolves to VT323 at 22 px until a docs/DECISIONS.md entry admits');
L(`   * ${T.type.families.display.name} (${T.type.families.display.status}). On admission set`);
L(`   * the display family to "${T.type.families.display.name}", monospace, and stop using --pk-font-display-standin-size. */`);
v('font-display', '"VT323", monospace', 'stand-in; TOKENS type.families.display.name = "' + T.type.families.display.name + '"', 'contract: LANE-WEB-UI-REHAUL.md §5 amendment 3');
v('font-display-standin-size', '22px', 'LANE-WEB-UI-REHAUL.md §5 amendment 3', 'contract');
v('font-body', `"${T.type.families.body.name}", monospace`, 'type.families.body.name');
L('  /* Literal kit display steps: Android PkwTokens.Type, kitBase.css:29-37; review 90845456 F5. */');
for (const [name, value] of DISPLAY_STEPS) v(`k-type-${name}`, px(value), 'Android PkwTokens.Type; kit/p0/kitBase.css:29-37; review 90845456 F5', 'sourced kit fallback, not a TOKENS.json addition');
L();
L('  /* ===== Type scale (sizes are the Press Start 2P / VT323 steps from TOKENS) ===== */');
for (const s of T.type.scale) v(`type-${kebab(s.token)}`, px(s.size), `type.scale[${s.token}] ${s.family}${/FLOOR/.test(s.use) ? ' — FLOOR' : ''}`);
v('text-outline-1', '1px', 'type.scale outline "1 dp ink"');
v('text-outline-2', '2px', 'type.scale outline "2 dp ink"');
L();

L('  /* ===== Spacing ===== */');
v('unit', px(T.space.unit), 'space.unit');
for (const n of T.space.scale) v(`s${n}`, px(n), 'space.scale');
v('gutter', px(T.space.screenGutter), 'space.screenGutter');
v('sheet-gutter', px(T.space.sheetGutter), 'space.sheetGutter');
L();

L('  /* ===== Radii and shape (stepped pixel corners, never rounded) ===== */');
v('radius', '0', 'shape.radius — the only radius, ever');
v('step-s-cut', '4px', 'shape.stepS "2 steps of 2 dp (corner cut 4 dp)"');
v('step-m-cut', '8px', 'shape.stepM "3 steps (corner cut 8 dp)"');
L('  /* shape.stepS as a size-independent clip-path (2 steps of 2 px per corner). */');
const sS = [
  '0 4px', '2px 4px', '2px 2px', '4px 2px', '4px 0',
  'calc(100% - 4px) 0', 'calc(100% - 4px) 2px', 'calc(100% - 2px) 2px', 'calc(100% - 2px) 4px', '100% 4px',
  '100% calc(100% - 4px)', 'calc(100% - 2px) calc(100% - 4px)', 'calc(100% - 2px) calc(100% - 2px)', 'calc(100% - 4px) calc(100% - 2px)', 'calc(100% - 4px) 100%',
  '4px 100%', '4px calc(100% - 2px)', '2px calc(100% - 2px)', '2px calc(100% - 4px)', '0 calc(100% - 4px)',
];
v('clip-s', `polygon(${sS.join(', ')})`, 'derived from shape.stepS', 'derived from the shape.stepS prose');
L('  /* --pk-clip-m is NOT emitted: the step widths of a 3-step 8 px cut are in KIT CornerProfiles.M, not TOKENS. */');
for (const k of Object.keys(T.shape.outline)) v(`outline-${kebab(k)}`, px(T.shape.outline[k]), `shape.outline.${k}`);
for (const k of Object.keys(T.shape.lip)) v(`lip-${kebab(k)}`, px(T.shape.lip[k]), `shape.lip.${k}`);
v('hi-band', px(T.shape.highlightBand), 'shape.highlightBand');
L('  /* elevation.e0..e4 are recipes, emitted as .pk-e* classes by the kit, not variables. No blur, ever. */');
L();

L('  /* ===== Sizes (pairs → -w/-h; square pairs → one name) ===== */');
const S = T.size;
const rename = { bidStepper: 'bid' };
const emitSize = (p, val, name) => {
  if (Array.isArray(val)) {
    if (val.length === 2 && val[0] !== val[1]) { v(`${name}-w`, px(val[0]), p); v(`${name}-h`, px(val[1]), p); }
    else v(name, px(val[0]), p);
  } else if (typeof val === 'number') v(name, px(val), p);
  else for (const k of Object.keys(val)) emitSize(`${p}.${k}`, val[k], `${name}-${kebab(k)}`);
};
v('min-tap', px(S.minTap), 'size.minTap');
for (const [k, val] of Object.entries(S)) {
  if (k === 'minTap') continue;
  if (k === 'topBar' || k === 'deck') {
    for (const [k2, v2] of Object.entries(val)) emitSize(`size.${k}.${k2}`, v2, k === 'deck' ? `size-deck-${kebab(k2)}` : `size-${kebab(k2)}`);
    continue;
  }
  emitSize(`size.${k}`, val, `size-${rename[k] || kebab(k)}`);
}
L('  /* Sizes from DESIGN-SYSTEM.md / cluster SPECs (not in TOKENS; see .md §6b) */');
v('size-tall-sheet-top', '104px', 'DESIGN-SYSTEM.md:330', 'sourced (DESIGN-SYSTEM.md)');
v('size-sheet-header-h', '136px', 'DESIGN-SYSTEM.md:335', 'sourced (DESIGN-SYSTEM.md)');
v('size-goldforge-hero-h', '204px', 'MAP-DESIGN-FOR-WEB.md §2.5 ← goldforge/SPEC:68', 'second-hand (SPEC not read)');
v('size-tab-stacked-h', '56px', 'MAP-DESIGN-FOR-WEB.md §2.5 ← account/SPEC:14', 'second-hand (SPEC not read)');
v('size-command-pitch', '88px', 'MAP-DESIGN-FOR-WEB.md §2.5 ← buildings/SPEC:65', 'second-hand (SPEC not read)');
L();

L('  /* ===== Motion: easings ===== */');
for (const [k, e] of Object.entries(T.motion.easing)) v(`ease-${kebab(k)}`, e, `motion.easing.${k}`);
L('  /* ===== Motion: durations ===== */');
for (const [k, d] of Object.entries(T.motion.durationMs)) v(`dur-${kebab(k)}`, `${d}ms`, `motion.durationMs.${k}`);
if (!Object.hasOwn(T.motion.durationMs, 'sealIn')) v('dur-seal-in', `${SEAL_IN.value}ms`, SEAL_IN.source, 'sourced design duration absent from TOKENS');
if (!Object.hasOwn(T.motion.durationMs, 'sealOut')) v('dur-seal-out', `${SEAL_OUT.value}ms`, SEAL_OUT.source, 'sourced design duration absent from TOKENS');
v('dur-half-sheet-in', '180ms', 'DESIGN-SYSTEM.md:516', 'sourced (DESIGN-SYSTEM.md)');
v('dur-half-sheet-out', '140ms', 'DESIGN-SYSTEM.md:516', 'sourced (DESIGN-SYSTEM.md)');
v('dur-drawer-row-stagger', '20ms', 'DESIGN-SYSTEM.md:517', 'sourced (DESIGN-SYSTEM.md)');
v('dur-crossfade', '120ms', 'motion.reducedMotion "cross-fade 120 ms"', 'TOKENS prose (motion.reducedMotion), DESIGN-SYSTEM.md:528');
L();

L('  /* ===== Z-order: the existing --z-* layer scale (M48 tokens.css:55-58; JS mirror ui/ds/z.ts) =====');
L(`   * Names and values kept, except consent (the Seal) and celebrate: toast < Seal < celebration < ${Z_CEILING}`);
L('   * (worker error, outside #overlay-root). d6013820 §2b; slots per REVIEW F06. No second z vocabulary. */');
for (const [n, old, now] of [...Z].sort((a, b) => a[2] - b[2])) {
  L(`  --z-${n}: ${now}; /* ${old === now ? 'M48 value' : `raised from ${old} (d6013820 §2b)`} */`);
}
L();

L('  /* ===== Legacy M48 names (tokens.css @ 92ba5d3f), each declared exactly once with a literal value =====');
L('   * Value = the TOKENS.json design value where ALIAS-PROPOSALS maps the name to a design token, otherwise the');
L('   * proposed legacy fallback ("no design source" in the .md). Consumers keep their names (no P0 renames). These');
L('   * names are never re-declared below, not even for reduced motion, so a last-declaration-wins parser such as');
L('   * tokens.test.ts customProperties() reads exactly these values for the MOTION_MS mirror pins. */');
for (const a of legacy) {
  if (LEGACY_GROUPS[a.name]) L(`  /* ${LEGACY_GROUPS[a.name]} */`);
  const mirror = MIRROR_KEY.has(a.name) ? `; MOTION_MS.${MIRROR_KEY.get(a.name)}` : '';
  const src = a.design ? `${a.key}${LEAD[a.name] ? (a.name === '--pk-t-seal' ? ' (review 419baf51 R4)' : ' (review ca622d60 §2: dialog material)') : ''}` : `no design source: ${fallbackNote(a)}`;
  L(`  ${a.name}: ${a.value}; /* ${src}${mirror} */`);
  if (a.name === '--pk-seal') L(`  ${SEAL_PRIMARY.name}: ${sealPrimaryValue}; /* ${SEAL_PRIMARY.path} (review ca622d60 §2: the gold Seal action) */`);
}
L('}');
L();

L('/* ===== Viewport classes (LANE §10.1, §10.6). Default = phone portrait. =====');
L(' * review e9c1eb73 W10: the host classifies dimensions and writes html[data-pk-vp] before kit mount.');
L(' * Parts read --pk-vp-class / --pk-hud-edge. CSS mirrors the attribute; it does not classify the viewport. */');
L(':root {');
v('vp-class', 'phone-portrait', 'pre-host fallback; LANE §10.1', 'class supplied by the host JS classifier');
v('vp-height', 'regular', 'review e9c1eb73 W10; sheet-only landscape short-height sub-class', 'host sets data-pk-vp-height; no layout media query');
v('hud-edge', 'max(var(--pk-gutter), env(safe-area-inset-left), env(safe-area-inset-right))', 'phone: space.screenGutter', 'phone = space.screenGutter; tablet 12 / desktop 16 are v1 defaults from the space scale');
L('}');
for (const [viewport, edge] of [
  ['phone-portrait', 'max(var(--pk-gutter), env(safe-area-inset-left), env(safe-area-inset-right))'],
  ['phone-landscape', 'max(var(--pk-gutter), env(safe-area-inset-left), env(safe-area-inset-right))'],
  ['tablet-portrait', 'var(--pk-s12)'], ['tablet-landscape', 'var(--pk-s12)'], ['desktop', 'var(--pk-s16)'],
]) {
  L(`html[data-pk-vp="${viewport}"] {`);
  L(`  --pk-vp-class: ${viewport};`);
  L(`  --pk-hud-edge: ${edge};`);
  L('}');
}
L('html[data-pk-vp-height="short"] {');
L('  --pk-vp-height: short;');
L('}');
L();

const rmBody = (indent) => [
  ...RM_ZERO.map((n) => `${indent}${n}: 0ms;`),
  ...RM_FADE.map((n) => `${indent}${n}: var(--pk-dur-crossfade);`),
];
L('/* ===== Reduced motion (motion.reducedMotion: "' + T.motion.reducedMotion + '") =====');
L(' * One recipe, two triggers, as ui/ds/motion.ts combines them: the OS preference (applies before JS runs) and');
L(' * html[data-motion="reduce"], which useMotion() sets to OS preference OR the in-game REDUCE MOTION toggle.');
L(' * Loops, fly-ins, staggers and the shake go to 0ms; slides and pops cross-fade. Holds and guards (toastHold,');
L(' * bannerHold, sealArm, tapThroughLock, celebrate) are untouched: they are timing and safety, not movement.');
L(' * Only canonical --pk-dur-* names appear here; consumers suppress loops and movement under the same attribute. */');
L('@media (prefers-reduced-motion: reduce) {');
L('  :root {');
for (const s of rmBody('    ')) L(s);
L('  }');
L('}');
L('html[data-motion="reduce"] {');
for (const s of rmBody('  ')) L(s);
L('}');
const css = out.join('\n') + '\n';

// ---------------------------------------------------------------------------------------------------------------
// Dev-only QA CSS
// ---------------------------------------------------------------------------------------------------------------
const qa = [
  '/* pk-tokens.qa.css — VERSION 2. GENERATED by gen-pk-tokens.mjs from TOKENS.json color.budgetOverlay',
  ` * ("${C.budgetOverlay.use}").`,
  ' *',
  ' * DEV-ONLY. This file must NEVER be imported by the production bundle: not from styles.css, tokens.css or',
  ' * pk-tokens.generated.css, and not from any eager or lazy production chunk. Load it only behind the dev-only',
  ' * design-QA seam (LANE-WEB-UI-REHAUL.md:239, the [data-pk-qa] HUD-budget overlay; :201, the /?pkqa=kit gallery),',
  " * for example `if (import.meta.env.DEV) import('./pk-tokens.qa.css')`, so production builds drop it. */",
  '[data-pk-qa] {',
  `  --pk-qa-hud: ${C.budgetOverlay.hud}; /* color.budgetOverlay.hud */`,
  `  --pk-qa-transient: ${C.budgetOverlay.transient}; /* color.budgetOverlay.transient */`,
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------------------------
// Checks (fail loud; nothing is written if one fails)
// ---------------------------------------------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (text, name) => (text.match(new RegExp(`(?<![a-z0-9-])${esc(name)}(?![a-z0-9-])`, 'g')) || []).length;
const declarations = (text, name) => (text.match(new RegExp(`(?<![a-z0-9-])${esc(name)}\\s*:`, 'g')) || []).length;
const braces = (text) => {
  let depth = 0;
  for (const ch of text.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth++;
    if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
};
for (const [n, val] of deferred) {
  const a = legacy.find((x) => x.name === n);
  if (a.value !== val) fail(`${n}: canonical value ${val} differs from legacy value ${a.value}`);
}
for (const n of [...LEGACY_SET, SEAL_PRIMARY.name]) {
  if (occurrences(css, n) !== 1) fail(`${n} appears ${occurrences(css, n)} times in the CSS (want 1)`);
  if (declarations(css, n) !== 1) fail(`${n} is declared ${declarations(css, n)} times (want 1)`);
}
for (const [n] of Z) if (declarations(css, `--z-${n}`) !== 1) fail(`--z-${n} must be declared once`);
const zv = Object.fromEntries(Z.map(([n, , now]) => [n, now]));
if (Z.length !== 14 || new Set(Z.map(([n]) => n)).size !== 14) fail('Z must hold the 14 existing names');
if (!(zv.toast < zv.consent && zv.consent < zv.celebrate && zv.celebrate < Z_CEILING && zv.page < zv.consent)) fail('z order broken');
const sortedZ = [...Z].map(([, , now]) => now).sort((a, b) => a - b);
if (new Set(sortedZ).size !== 14) fail('two z layers share a value');
for (const k of Object.keys(T.motion.durationMs)) {
  const n = `--pk-dur-${kebab(k)}`;
  const want = RM_ZERO.includes(n) || RM_FADE.includes(n) ? 3 : 1; // :root + one per reduce trigger
  if (declarations(css, n) !== want) fail(`${n} declared ${declarations(css, n)} times (want ${want})`);
}
const optionalSealKeys = ['sealIn', 'sealOut'].filter((key) => Object.hasOwn(T.motion.durationMs, key));
if (Object.keys(T.motion.durationMs).length !== 27 + optionalSealKeys.length) fail('TOKENS motion.durationMs changed beyond optional sealIn/sealOut; review the reduced-motion lists');
for (const name of ['--pk-dur-seal-in', '--pk-dur-seal-out']) if (declarations(css, name) !== 3) fail(`${name} requires one normal declaration and both reduce triggers`);
for (const [name] of DISPLAY_STEPS) if (declarations(css, `--pk-k-type-${name}`) !== 1) fail(`display token ${name} must be declared once`);
const mediaQueries = [...css.matchAll(/@media\s*([^\{]+)\{/g)].map((m) => m[1].trim());
if (mediaQueries.length !== 1 || mediaQueries[0] !== '(prefers-reduced-motion: reduce)') fail('only the reduced-motion media query is allowed');
if (/--pk-z-/.test(css) || /--pk-z-/.test(qa)) fail('a --pk-z-* name survived');
if (/P0 wins/.test(css)) fail('stale "P0 wins" comment survived');
if (/data-pk-qa|--pk-qa-/.test(css)) fail('QA selectors leaked into the production CSS');
if (!braces(css) || !braces(qa)) fail('unbalanced braces');
if (!css.includes('@media (prefers-reduced-motion: reduce) {') || !css.includes('html[data-motion="reduce"] {')) fail('reduced motion must have both triggers');

// ---------------------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------------------
const ms = (s) => Number(String(s).replace(/ms$/, ''));
const byName = new Map(legacy.map((a) => [a.name, a]));
const fallbacks = legacy.filter((a) => !a.design);
const mirrorsDesign = MOTION_MIRRORS.filter(([, n]) => byName.get(n).design);
const mirrorsFallback = MOTION_MIRRORS.filter(([, n]) => !byName.get(n).design);
const M = [];
const P = (s = '') => M.push(s);

P('# pk-tokens.generated.css v2 repository adaptation: rule, mappings and integration obligations');
P();
P('Version 2 adapted for the repository under review 419baf51 R1–R5, e9c1eb73 W8/W10 and 90845456 F5. The immutable review ledger is retained; explicit lead bindings supersede its Seal material and entrance proposals. Generation is not source integration, test execution or runtime acceptance.');
P();
P('| Input | sha256 |');
P('|---|---|');
P(`| TOKENS.json ("${T.name}", ${T.date}) | \`${sha256(tokBytes)}\` |`);
P(`| ALIAS-PROPOSALS.json (MS-F2a, ${A.aliases.length} names, status ${A.status}) | \`${sha256(aliasBytes)}\` |`);
P();
P('Generator: `apps/web/scripts/pk-tokens.mjs`. Inputs: `apps/web/src/ui/pk/TOKENS.source.json` and `ALIAS-PROPOSALS.source.json`. Generate into a separate metadata directory, then place only production CSS and this mapping document under `src/ui/pk/`; keep QA CSS outside production source.');
P();
P('    node apps/web/scripts/pk-tokens.mjs <TOKENS.source.json> <ALIAS-PROPOSALS.source.json> <metadata-output-directory>');
P();
P('It writes `pk-tokens.generated.css`, `pk-tokens.qa.css` and this file. It runs the checks in §8 first and writes nothing if one fails. Output carries no timestamp, so a re-run on the same inputs is byte-identical.');
P();
P('## 0. Changes from v1');
P();
P('v1 is the reviewed object: `pk-tokens.generated.css` sha256 `fb7b9e6f…`, `.md` `26686394…`.');
P();
P('- **F04, six directly read names missing.** Now declared: `--pk-t-disclose` = 160ms (`motion.durationMs.toastIn`), and `--pk-aura`, `--pk-dialog-max`, `--pk-lift`, `--pk-lift-sm`, `--pk-light-edge` with their M48 values (no design source, §6a).');
P(`- **Legacy compatibility.** All 46 legacy names are declared exactly once, including all 18 MOTION_MS mirrors. Toast hold is 4000ms; snapHint is 120ms; glass-flat and beat retain their legacy fallback. review 419baf51 R4 binds Seal entrance to ${SEAL_IN.value}ms from ${SEAL_IN.source}, superseding the ledger's relayed 180ms proposal. Arming remains a separate 450ms guard.`);
P(`- **F06, two z vocabularies.** The \`--pk-z-*\` ordinals 1–9 and the stale "P0 wins" comment are gone. The bridge declares the 14 existing \`--z-*\` names (§5) with their M48 values, except \`--z-consent\` 1500 → ${zv.consent} and \`--z-celebrate\` 1700 → ${zv.celebrate}: toast (${zv.toast}) < Seal < celebration < worker error (${Z_CEILING}).`);
P('- **F07, reduced motion.** One recipe, two triggers: `@media (prefers-reduced-motion: reduce)` and `html[data-motion="reduce"]`, which motion.ts `useMotion()` sets to the OS preference OR the in-game toggle. v1\'s `--pk-stagger: 0ms` override is removed. It re-declared a legacy name, and tokens.test.ts `customProperties()` keeps the last declaration, so the MOTION_MS.stagger pin would have read 0ms. Legacy names are never re-declared; see §7 item 2 for the one reduced-mode consumer this affects.');
P(`- **F08, \`--pk-seal\`.** \`--pk-seal\` is the Seal's dialog material again (pk.css:38 \`background\`), with the design value parchment \`${byName.get('--pk-seal').value}\` (ca622d60 §2; DESIGN-SYSTEM.md:422). The gold action is the new \`--pk-seal-primary\` = \`${sealPrimaryValue}\` (\`color.gold.hex\`). **Read §7 item 1 before applying.**`);
P('- **QA selectors.** The `[data-pk-qa]` block moved to `pk-tokens.qa.css`, which is dev-only (REVIEW "remaining seams"; ca622d60 §2).');
P('- **Generator.** Moved beside the artifacts. It now reads ALIAS-PROPOSALS.json, writes all three files and checks itself.');
P('- **Repository amendments:** Seal visual in/out durations, five literal VT323 display steps (90845456 F5), and root viewport attribute selectors (e9c1eb73 W10). No layout media query remains; the host must classify dimensions before mounting the kit.');
P();
P('## 1. Generator rule');
P();
P('1. **Prefix and case.** Every design property is `--pk-<name>`, and camelCase keys become kebab-case (`borderLt` → `border-lt`). The only other names are the 14 `--z-*` layers (§5).');
P('2. **Units.** 1 dp = 1 sp = 1 CSS px. Numbers become `Npx`, except 0, which stays `0`. Durations become `Nms`. Colours are copied verbatim.');
P('3. **Colours.** `color.<k>.hex` → `--pk-<k>`, and sub-keys `hi`/`lo`/`mid`/`seam` → `--pk-<k>-<sub>`. Renames: `muted`/`faint` → `text-*`, `parchment` → `parch`, `textOnParch` → `ink-text`/`ink-text-2`, `shortPill` → `short-bg`/`short-text`, `selectedTint` → `selected`. `resource.<k>` → `--pk-res-<k>`. `scrim.<k>` → `--pk-scrim-{half,tall,full,shelf,seal}`. `budgetOverlay.*` → `--pk-qa-*`, in `pk-tokens.qa.css` only. `use` strings are not emitted; the verb ramps carry the first clause as a comment.');
P('4. **Type.** `type.scale[i].token` → `--pk-type-<token>` remains unchanged. Display uses VT323 until a DECISIONS entry admits Press Start 2P. The five `--pk-k-type-*` fallback tokens are literal 30/26/24/22/20px, sourced to the delivered kit citing Android PkwTokens.Type (90845456 F5). Remove the five equivalent calc declarations from the repository copy of kitBase.css so the generator owns these values. Other kit constants remain sourced `--pk-k-*` declarations at the top of kitBase.css (W8); no TOKENS.json additions.');
P('5. **Spacing.** `space.unit` → `--pk-unit`. Each `space.scale` value n → `--pk-s<n>`. `screenGutter` → `--pk-gutter`, `sheetGutter` → `--pk-sheet-gutter`. `gridPhone` is prose and is not emitted.');
P('6. **Shape.** `radius` → `--pk-radius: 0`. `outline.<k>` → `--pk-outline-<k>`, `lip.<k>` → `--pk-lip-<k>`, `highlightBand` → `--pk-hi-band`. `stepS` → `--pk-step-s-cut` plus the size-independent polygon `--pk-clip-s`. `stepM` → `--pk-step-m-cut` only. `elevation.*` are kit classes, not variables.');
P('7. **Sizes.** `size.<k>` → `--pk-size-<k>`. The `topBar.*` children drop the segment; the `deck.*` children keep `deck-`. A two-value array with different values → `-w`/`-h`; a square pair or a single value → one name. Nested objects append the sub-key. `bidStepper` → `bid`. `minTap` → `--pk-min-tap`.');
P('8. **Motion.** `easing.<k>` → `--pk-ease-<k>`; `durationMs.<k>` → `--pk-dur-<k>`. Added design values: half-sheet in/out, drawer-row stagger and crossfade. Seal in/out use the exact `motion.durationMs.sealIn`/`sealOut` keys when present; the pinned input lacks them, so DESIGN-SYSTEM.md:521 supplies 160/120ms. No unrelated duration is used as a surrogate.');
P('9. **Reduced motion.** One override list, written twice with identical bodies: inside `@media (prefers-reduced-motion: reduce) { :root {…} }`, which applies before JS runs, and as `html[data-motion="reduce"] {…}`, the attribute motion.ts keeps equal to OS OR in-game toggle (specificity 0,1,1 beats `:root`). Loops, fly-ins, staggers and the shake → `0ms`. Slides and pops → `var(--pk-dur-crossfade)` (120 ms). Holds and guards (toastHold, bannerHold, sealArm, tapThroughLock, celebrate) are untouched. Only `--pk-dur-*` names appear there.');
P('10. **Legacy names.** Each of the 46 ALIAS-PROPOSALS names is declared exactly once with a literal value. Mapped TOKENS values must agree with the ledger; unsourced names retain their documented fallback. Two lead bindings supersede ledger proposals: `--pk-seal` is parchment (ca622d60 §2), and `--pk-t-seal` is the sourced Seal entrance (419baf51 R4). The overlapping canonical `--pk-scrim-seal` is declared only in the legacy block after value agreement is checked.');
P('11. **Added name.** `--pk-seal-primary` ← `color.gold.hex` (ca622d60 §2).');
P('12. **Z-order.** The 14 `--z-*` names of M48 tokens.css:55-58, with the §5 values. There is no other z vocabulary.');
P('13. **Viewport classes.** The five exact `html[data-pk-vp="<class>"]` selectors mirror host classification into custom properties. Default is phone-portrait until the host stamps a class. `html[data-pk-vp-height="short"]` sets the sheet-only short sub-class independently of class. The host chooses short only for landscape height ≤359px. No CSS layout media query is emitted.');
P('14. **Not emitted.** `budget.*` and `pixelArt.*` go to TS (MAP §2.6). `sea`, `numeralXL` and `icon24Celebration` are excluded (LANE §5 amendment 2). `--pk-clip-m` needs KIT `CornerProfiles.M`.');
P();
P('## 2. Key → name table (TOKENS.json and design docs → CSS)');
P();
P('| Source | Name | Value |');
P('|---|---|---|');
for (const r of rec) P(`| ${r.key} | ${code(r.name)}${r.inLegacy ? ' (declared in the legacy block)' : ''} | ${code(r.value)} |`);
P(`| ${SEAL_PRIMARY.path} | ${code(SEAL_PRIMARY.name)} | ${code(sealPrimaryValue)} |`);
P();
P('## 3. The 46 legacy M48 names');
P();
P(`${legacy.length} names, each declared once. ${legacy.length - fallbacks.length} take a design value and ${fallbacks.length} take a fallback (§6a). "M48" is tokens.css @ 92ba5d3f. "v1" is the reviewed candidate, where — means v1 did not declare the name.`);
P();
P('| # | Name | M48 | v1 | v2 | Source |');
P('|---|---|---|---|---|---|');
legacy.forEach((a, i) => P(`| ${i + 1} | ${code(a.name)} | ${code(a.legacy_value)} | ${a.candidate_value == null ? '—' : code(a.candidate_value)} | ${code(a.value)} | ${a.design ? `${a.key}${LEAD[a.name] ? ` (${LEAD[a.name].why})` : ''}` : '**no design source**'} |`));
P();
P('## 4. The 18 JS motion mirrors (MOTION_MS ↔ CSS)');
P();
P(`The pairs pinned by M48 ui/ds/tokens.test.ts:115-121. All 18 are legacy names from §3, so each is declared once. ${mirrorsDesign.length} take a design duration; ${mirrorsFallback.length} have no design duration and carry the ALIAS-PROPOSALS fallback.`);
P();
P('| JS key | CSS name | M48 | v2 | Source |');
P('|---|---|---|---|---|');
for (const [k, n] of MOTION_MIRRORS) {
  const a = byName.get(n);
  P(`| ${k} | ${code(n)} | ${a.legacy_value} | ${a.value} | ${a.design ? a.key : `**no design source**: ${fallbackNote(a)}`} |`);
}
P();
P('motion.ts `MOTION_MS` must equal these values in the same admitted change:');
P();
P('```ts');
P('export const MOTION_MS = {');
const mm = MOTION_MIRRORS.map(([k, n]) => `${k}: ${ms(byName.get(n).value)}`);
for (let i = 0; i < mm.length; i += 6) P(`  ${mm.slice(i, i + 6).join(', ')},`);
P('} as const;');
P('```');
P();
P('## 5. Z-order');
P();
P('| Name | M48 | v2 | Note |');
P('|---|---|---|---|');
for (const [n, old, now] of [...Z].sort((a, b) => a[2] - b[2])) P(`| ${code(`--z-${n}`)} | ${old} | ${now} | ${old === now ? 'kept' : `raised (d6013820 §2b; slot per REVIEW F06)`} |`);
P();
P(`Design order (MAP §2.6, citing KIT:52) and its home in this scale: hud → \`--z-hud\`, command bar → \`--z-cmd\`, sheet → \`--z-sheet\`, toast → \`--z-toast\`, seal → \`--z-consent\`, celebration → \`--z-celebrate\`. Layers outside #overlay-root (worker error ${Z_CEILING}, boundaries 5000, loading shell 99999, renderer dialog 100000) are not tokens. ui/ds/z.ts must equal:`);
P();
P('```ts');
P('export const Z = {');
for (const [n, , now] of Z) P(`  ${n}: ${now},`);
P('} as const;');
P('```');
P();
P('## 6. No design source');
P();
P(`### 6a. Legacy fallbacks (${fallbacks.length})`);
P();
P('Each value is the ALIAS-PROPOSALS `proposed_normal_value`, kept until a design counterpart is named. A fallback is a compatibility value, not an approved design mapping.');
P();
P('| Name | Value | Origin |');
P('|---|---|---|');
for (const a of fallbacks) P(`| ${code(a.name)} | ${code(a.value)} | ${a.status}${a.source_or_authority ? `; ${a.source_or_authority}` : '; M48 tokens.css legacy value'}. ${a.note} |`);
P();
P('### 6b. Other values not taken directly from TOKENS.json');
P();
P('| Name | Value | Origin | Confidence |');
P('|---|---|---|---|');
for (const u of unsourced) P(`| ${code(u.name)} | ${code(u.value)} | ${u.origin} | ${u.kind} |`);
P(`| \`--z-*\` (14) | §5 | M48 tokens.css:55-58 values; consent and celebrate per d6013820 §2b with REVIEW F06 slots | legacy + ruling |`);
P('| viewport classification | JS host: landscape and height ≤480 → phone-landscape; width 768–1199 with portrait or height ≥481 → matching tablet orientation; width ≥1200 and height ≥481 → desktop; otherwise phone-portrait. Short means landscape height ≤359, for sheets only. | v2 edges preserved in JS; review e9c1eb73 W10 | host hunk must be accepted before activation |');
P();
P('## 7. Consumer and test obligations, open items');
P();
P(`1. **Seal foreground (blocking for \`--pk-seal\`).** pk.css:37 gives \`.pk-seal\` \`color:var(--sk-text)\`, light text. On the v2 parchment body (\`${byName.get('--pk-seal').value}\`) that text is close to invisible. In the same admitted change the Seal's foreground must move to \`--pk-ink-text\` (\`${C.textOnParch.hex}\`, \`color.textOnParch.hex\`), and every caller that colours Seal text light must be checked. Do not ship \`--pk-seal\` v2 without that change. The design's WoodFrame around the parchment is P2 consumer work.`);
P('2. **Reduced Seal fade.** 419baf51 R2: pk.css:89 must read `var(--pk-dur-crossfade)` rather than the legacy `--pk-t-seal` entrance value. Other legacy visual consumers are already gated off under reduced motion. Kit Seal consumers should use canonical `--pk-dur-seal-in`/`--pk-dur-seal-out`, which crossfade under both triggers. Legacy aliases remain declared exactly once. These consumer edits are coordinated hunks, not performed by the generator.');
P(`3. **JS mirrors and pins (rewrite, never delete).** motion.ts \`MOTION_MS\` → §4. z.ts \`Z.consent\`/\`Z.celebrate\` → ${zv.consent}/${zv.celebrate}, and its header comment about "every Seal (1500)". tokens.test.ts:87-89 (\`--pk-scrim-seal\`, \`--pk-seal\`, \`--pk-page\`) → the §3 v2 values. tokens.test.ts:101-111 → consent ${zv.consent}, celebrate ${zv.celebrate}, and \`Z.consent < Z.toast\` becomes toast < consent < celebrate < ${Z_CEILING}. tokens.test.ts:114-124 → the §4 values. tokens.test.ts parses tokens.css only: if this file ships as its own import, the tests must parse it too.`);
P(`4. **Motion mirrors without a design duration:** ${mirrorsFallback.map(([k]) => k).join(', ')}. Seal entrance follows ${SEAL_IN.source} (${SEAL_IN.value}ms); exit follows ${SEAL_OUT.source} (${SEAL_OUT.value}ms). The 450ms arming guard remains separate (\`--pk-dur-seal-arm\`).`);
P('5. **Viewport host dependency (W10).** The delivered viewport.ts only reads CSS and copies the class back to an attribute. With attribute-only CSS this is circular: the host must classify dimensions and stamp data-pk-vp/data-pk-vp-height before syncViewportClass and before mounting the kit, then update on resize/orientation change. Use the existing layout.ts/useWindowSize seam, not component-specific breakpoints. Replace bridge-amendment.css with a comment-only compatibility import; its old media block must not ship.');
P(`6. **Z numbers.** ${zv.consent}/${zv.celebrate} are REVIEW F06's proposed slots. d6013820 §2b fixes the order only. The numbers are confirmed at composition.`);
P('7. **QA import seam.** `pk-tokens.qa.css` may load only behind `import.meta.env.DEV` or an equivalent dev-only gate. A production-bundle check should assert that `--pk-qa-` never appears in dist.');
P('8. **Hoisted-block dependency.** `--pk-light-edge` and `--pk-aura` read `--hud-acc`, `--hud-acc-hi` and `--hud-acc-a` from the hoisted HUD block in tokens.css, so load this file wherever that block is loaded. A last-declaration-wins parser sees the reduced values for the `--pk-dur-*` names in §1 rule 9; no test pins those names.');
P('9. **Instance names.** `--pk-seal-w`, `--pk-vp-top` and `--pk-vp-bottom` are set inline by primitives.tsx and are correctly not declared here.');
P('10. **Unchanged omissions.** `--pk-clip-m`, `sea`, `numeralXL`, `icon24Celebration` (§1 rule 14).');
P();
P('## 8. Checks the generator runs before writing');
P();
P('- ALIAS-PROPOSALS lists 46 unique names. Every design-mapped value equals its TOKENS value, and every lead binding resolves.');
P('- Each of the 46 legacy names and `--pk-seal-primary` occurs exactly once in the CSS, as its one declaration. The match is bounded, so `--pk-stagger` does not count `--pk-stagger-section`.');
P('- The 18 motion mirrors are legacy names with 18 unique JS keys.');
P(`- The 14 \`--z-*\` names are each declared once with unique values, and page < toast < consent < celebrate < ${Z_CEILING}.`);
P('- The pinned TOKENS has 27 durations; only exact optional sealIn/sealOut additions are admitted without a reduced-motion-list review. Each duration has one normal declaration and, where applicable, one per reduced-motion trigger. Seal in/out each have both reduced-mode overrides; the five literal display steps occur once.');
P('- No `--pk-z-` in either CSS file, no "P0 wins", and no `data-pk-qa`/`--pk-qa-` in the production CSS.');
P('- Braces balance in both CSS files (comments stripped), and both reduce triggers are present.');
P('- The only media query is prefers-reduced-motion; all viewport selectors are root attributes.');
P();
P(`Result of this run: ${legacy.length} legacy names (${legacy.length - fallbacks.length} design, ${fallbacks.length} fallback), 18 motion mirrors (${mirrorsDesign.length} design, ${mirrorsFallback.length} fallback), ${Z.length} z layers, ${RM_ZERO.length + RM_FADE.length} reduced-motion overrides per trigger, ${rec.length + 1} canonical rows in §2.`);
const md = M.join('\n') + '\n';
return { css, qa, md };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI only: validate the complete in-memory result before creating or writing output files.
// ---------------------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const [, , tokPath, aliasPath, outDir] = process.argv;
if (!tokPath || !aliasPath || !outDir) {
  console.error('usage: node pk-tokens.mjs <TOKENS.source.json> <ALIAS-PROPOSALS.source.json> <outDir>');
  process.exit(2);
}
const { css, qa, md } = generatePkTokens(fs.readFileSync(tokPath), fs.readFileSync(aliasPath));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'pk-tokens.generated.css'), css);
fs.writeFileSync(path.join(outDir, 'pk-tokens.qa.css'), qa);
fs.writeFileSync(path.join(outDir, 'pk-tokens.generated.md'), md);
console.log(`wrote ${outDir}: css ${css.split('\n').length - 1} lines, qa ${qa.split('\n').length - 1} lines, md ${md.split('\n').length - 1} lines`);
}
