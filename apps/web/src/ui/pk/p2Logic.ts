/**
 * P2 pure rules. Each function is a 1:1 port of the named Kotlin function, with the same cases, so the JVM tests port
 * to vitest by name (LANE §3 universal rules). Web-only additions are marked WEB-ONLY and get their own tests.
 *
 * Sources:
 *   KitLogic.kt            UNKNOWN, priceText, priceDescription, orderCommands, commandDrawState, commandRoute,
 *                          outcomeLine, integerArtScale, sheetScrimAlpha
 *   CommandBarLayout.kt    CommandBarMetrics, commandBarLimit, commandBarPlacement (+ horizontalSlots/verticalFrame),
 *                          selectionRingBottom, namePlatePlacement, stateLineRuns
 *   BuildingsR2Logic.kt    blockDoors, haveNeedLine
 * Units: CSS px (Android dp × density = px; on the web 1 dp = 1 CSS px, so density is 1 and is dropped).
 */
import type {
  BadgeUi, CommandRoute, CommandState, CommandUi, Currency, NeedMoreDoorUi, PkViewport, PriceUi, PxInsets, PxRect,
  SheetSize,
} from './p2Types';

export const UNKNOWN = '…';

// ---- Prices (KitLogic.kt) ----

export function priceText(price: PriceUi): string {
  switch (price.status) {
    case 'CHECKING': return UNKNOWN;
    case 'UNAVAILABLE': return 'unavailable';
    case 'SERVER_ZERO': return price.amount ?? '0';
    default: return price.amount && price.amount.trim() !== '' ? price.amount : UNKNOWN;
  }
}

const CURRENCY_NAME: Record<Currency, string> = {
  SHARDS: 'Shards', GEMS: 'Gems', KEEP: 'KEEP', SKR: 'SKR', SOL: 'SOL', ITEM: 'items', // KitLogic.kt / P0 currencyName
};

export function priceDescription(price: PriceUi): string {
  if (price.description) return price.description;
  const name = CURRENCY_NAME[price.currency];
  switch (price.status) {
    case 'CHECKING': return `${name} price: checking`;
    case 'UNAVAILABLE': return `${name} price unavailable`;
    case 'SHORT': return `Costs ${priceText(price)} ${name}, not enough`;
    default: return `Costs ${priceText(price)} ${name}`;
  }
}

// ---- Commands (KitLogic.kt) ----

/** Primary last, exactly one primary, at most `max`. */
export function orderCommands(commands: CommandUi[], max = 5): CommandUi[] {
  const primary = commands.find((c) => c.primary);
  const rest = commands.filter((c) => c !== primary).map((c) => (c.primary ? { ...c, primary: false } : c));
  return primary === undefined ? rest.slice(0, max) : [...rest.slice(0, Math.max(max - 1, 0)), primary];
}

/** CHECKING price stays ENABLED (navigation); UNAVAILABLE draws DISABLED; SHORT draws SHORT. */
export function commandDrawState(ui: CommandUi): CommandState {
  if (ui.state !== 'ENABLED') return ui.state;
  if (ui.price?.status === 'UNAVAILABLE') return 'DISABLED';
  if (ui.price?.status === 'SHORT') return 'SHORT';
  return 'ENABLED';
}

export function commandRoute(ui: CommandUi): CommandRoute {
  switch (commandDrawState(ui)) {
    case 'ENABLED': return 'OPEN';
    case 'SHORT': return 'NEED_MORE';
    case 'DISABLED':
    case 'LOCKED': return 'EXPLAIN';
    default: return 'IGNORE';
  }
}

/** Only an authoritative refusal may say "Nothing was spent" (design correction 7). */
export function outcomeLine(action: string, authoritative: boolean, serverReason: string | null = null): string {
  if (!authoritative) return `Checking whether the ${action} went through.`;
  const why = serverReason?.trim().replace(/\.+$/, '');
  return why ? `${why}. Nothing was spent.` : `The ${action} didn't happen. Nothing was spent.`;
}

/** What a screen reader says for a command (CommandMedallion `spoken`). */
export function commandDescription(ui: CommandUi): string {
  const state = commandDrawState(ui);
  return [
    ui.caption,
    ui.price ? priceDescription(ui.price) : null,
    ui.sub ?? null,
    state === 'DISABLED' || state === 'LOCKED' ? ui.reason : null,
    (ui.badge as BadgeUi | null)?.description ?? null,
  ].filter((s): s is string => !!s && s.trim() !== '').join('. ');
}

// ---- Pixel art (KitLogic.kt) ----

/** Nearest whole scale ≥ 1 (Kotlin roundToInt: half rounds up). */
export function integerArtScale(targetPx: number, art: number): number {
  return Math.max(1, Math.floor(targetPx / art + 0.5));
}

/**
 * CSS size of `art`-px pixel art aimed at `targetCss` px on a `dpr` screen (LANE §4 pixel-art rule):
 * cssSize = art × k / dpr, k = integerArtScale(target × dpr, art). WEB-ONLY `maxCss` caps k so a 24 px icon aimed at
 * 36 px on a DPR 1 screen (k rounds 1.5 → 2 = 48 px) can be held to 24 px where 48 would overflow its face.
 */
export function artCssSize(targetCss: number, art: number, dpr: number, maxCss = Infinity): number {
  let k = integerArtScale(targetCss * dpr, art);
  while (k > 1 && (art * k) / dpr > maxCss) k -= 1;
  return (art * k) / dpr;
}

export function sheetScrimAlpha(size: SheetSize): number {
  return size === 'HALF' ? 0 : size === 'TALL' ? 0.4 : 0.6;
}

// ---- Command bar geometry (CommandBarLayout.kt) ----

/** DESIGN-SYSTEM §6 geometry (dp = CSS px). The COMPACT set is the 311-tall landscape row of LANE §4. */
export interface CommandBarMetrics {
  SIDE: number; PITCH: number; MIN_PITCH: number; BUTTON: number; PRIMARY_W: number; PRIMARY_H: number;
  PRIMARY_GAP: number; PILL_ABOVE: number; CAPTION: number; BLOCK_H: number; STEP_H: number;
  PRIMARY_TOP_FROM_BOTTOM: number; SECONDARY_TOP_FROM_BOTTOM: number; PRIMARY_RISE: number; HINT_ABOVE: number;
  HINT_H: number; STACK_TOP: number; STACK_BOTTOM: number; STACK_RIGHT: number; STACK_W: number; MARGIN: number;
  PLATE_GAP: number; STEM_W: number; STEM_OVERLAP: number; STEM_INSET: number; RING_MIN_W: number;
  RING_W_FACTOR: number; RING_H_FACTOR: number; RING_LIFT: number;
}

export const METRICS: CommandBarMetrics = {
  SIDE: 16, PITCH: 88, MIN_PITCH: 72, BUTTON: 68, PRIMARY_W: 120, PRIMARY_H: 92, PRIMARY_GAP: 8, PILL_ABOVE: 30,
  CAPTION: 29, BLOCK_H: 163, STEP_H: 16, PRIMARY_TOP_FROM_BOTTOM: 127, SECONDARY_TOP_FROM_BOTTOM: 107,
  PRIMARY_RISE: 20, HINT_ABOVE: 38, HINT_H: 32, STACK_TOP: 10, STACK_BOTTOM: 118, STACK_RIGHT: 8, STACK_W: 108,
  MARGIN: 8, PLATE_GAP: 16, STEM_W: 4, STEM_OVERLAP: 2, STEM_INSET: 8, RING_MIN_W: 104, RING_W_FACTOR: 1.45,
  RING_H_FACTOR: 0.53, RING_LIFT: 12,
};

/**
 * WEB-ONLY: LANE §4 `land` row ("buttons 60, primary 108×72"). Derived, not sourced: the bottoms of the faces stay
 * where the full-size bar has them (primary bottom H-35, secondary bottom H-39), the pitch keeps 88 and the
 * tightest pitch is face + 4, the block shrinks by the 20 px the primary lost. Open question in CommandBar.md.
 */
export const METRICS_COMPACT: CommandBarMetrics = {
  ...METRICS, BUTTON: 60, MIN_PITCH: 64, PRIMARY_W: 108, PRIMARY_H: 72, PRIMARY_TOP_FROM_BOTTOM: 107,
  SECONDARY_TOP_FROM_BOTTOM: 99, PRIMARY_RISE: 8, BLOCK_H: 143,
};

/** Android parity: 4 in portrait (a square screen counts as portrait), 5 in landscape. */
export function commandBarLimit(screenW: number, screenH: number): number {
  return screenH >= screenW ? 4 : 5;
}

/** WEB-ONLY (LANE §5 amendment 4, MAP-DESIGN-FOR-WEB §4.3 item 3): at most 3 below 360 px wide. Own test. */
export const WEB_COMPACT_WIDTH = 360;
export const MAX_COMMANDS_COMPACT = 3;
export function webCommandLimit(screenW: number, screenH: number): number {
  const android = commandBarLimit(screenW, screenH);
  return screenW < WEB_COMPACT_WIDTH ? Math.min(android, MAX_COMMANDS_COMPACT) : android;
}

/** WEB-ONLY: which classes dock the bar in a bottom-right band instead of a full-width bottom shelf (LANE §4). */
export function barDocked(vp: PkViewport['vp']): boolean {
  return vp === 'desktop' || vp === 'tablet-landscape' || vp === 'phone-landscape';
}

export function metricsFor(vp: PkViewport['vp']): CommandBarMetrics {
  return vp === 'phone-landscape' ? METRICS_COMPACT : METRICS;
}

export type BarSide = 'BOTTOM' | 'TOP';
export interface CommandSlotSpec { primary: boolean; priced: boolean }
export interface CommandSlot { index: number; button: PxRect; column: PxRect }
export interface CommandBarPlacement {
  side: BarSide;
  band: PxRect;
  step: PxRect;
  footprint: PxRect;
  slots: CommandSlot[];
  dropped: number[];
  hintTop: number | null;
  coversAnchor: boolean;
  pillTop: number;
}

export function intersects(a: PxRect, b: PxRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function overlapArea(a: PxRect, b: PxRect): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}
function within(r: PxRect, outer: PxRect): boolean {
  return r.left >= outer.left && r.top >= outer.top && r.right <= outer.right && r.bottom <= outer.bottom;
}
const rect = (left: number, top: number, right: number, bottom: number): PxRect => ({ left, top, right, bottom });

/** The resource stack (DESIGN-SYSTEM §6 TopBar); it stays on screen while a building is selected. */
export function resourceStackRect(screenW: number, insets: PxInsets, m: CommandBarMetrics = METRICS): PxRect {
  const right = screenW - insets.right - m.STACK_RIGHT;
  return rect(right - m.STACK_W, insets.top + m.STACK_TOP, right, insets.top + m.STACK_BOTTOM);
}

/**
 * WEB-ONLY wrapper: the docked band's left edge. Android lays the bar across the whole screen; docked classes give it
 * the natural width of its own commands at the bottom-right (LANE §4 desktop / 844×390 / land), so the horizontal
 * port runs unchanged inside [bandLeft, screenW].
 */
export function dockedBandLeft(screenW: number, insets: PxInsets, specs: CommandSlotSpec[], m: CommandBarMetrics): number {
  const secondaries = specs.filter((s) => !s.primary).length;
  const hasPrimary = specs.some((s) => s.primary);
  const natural = m.SIDE * 2
    + (secondaries > 0 ? (secondaries - 1) * m.PITCH + m.BUTTON : 0)
    + (hasPrimary ? m.PRIMARY_W + (secondaries > 0 ? m.PRIMARY_GAP : 0) : 0);
  return Math.max(insets.left, screenW - insets.right - natural);
}

/**
 * Port of `commandBarPlacement`. `bandLeft` (WEB-ONLY, default 0) narrows the bar to a docked band; with 0 it is the
 * Android function. `previous` keeps the side while it still clears the anchor, so the bar does not jump during a pan.
 */
export function commandBarPlacement(
  screenW: number, screenH: number, insets: PxInsets, specs: CommandSlotSpec[], anchor: PxRect | null, hint: boolean,
  previous: BarSide | null = null, m: CommandBarMetrics = METRICS, bandLeft = 0,
): CommandBarPlacement {
  const bandInsets = { ...insets, left: Math.max(insets.left, bandLeft) };
  const { slotsX, dropped } = horizontalSlots(screenW, bandInsets, specs, m);
  const frames = {
    BOTTOM: verticalFrame('BOTTOM', bandLeft, screenW, screenH, insets, hint, m),
    TOP: verticalFrame('TOP', bandLeft, screenW, screenH, insets, hint, m),
  };
  const order = [...new Set<BarSide>([...(previous ? [previous] : []), 'BOTTOM', 'TOP'])];
  const clear = anchor === null ? order[0] : order.find((s) => !intersects(frames[s].footprint, anchor));
  const side = clear ?? order.reduce((best, s) =>
    overlapArea(frames[s].footprint, anchor!) < overlapArea(frames[best].footprint, anchor!) ? s : best);
  const frame = frames[side];
  const slots = slotsX.map(([index, left, width]) => {
    const spec = specs[index]!; // index comes from horizontalSlots over specs.indices
    const top = spec.primary ? frame.primaryTop : frame.secondaryTop;
    const button = rect(left, top, left + width, top + (spec.primary ? m.PRIMARY_H : m.BUTTON));
    const columnTop = spec.priced ? top - m.PILL_ABOVE : top;
    const columnBottom = spec.primary ? button.bottom : button.bottom + m.CAPTION;
    return { index, button, column: rect(left, columnTop, left + width, columnBottom) };
  });
  return {
    side, band: frame.band, step: frame.step, footprint: frame.footprint, slots, dropped, hintTop: frame.hintTop,
    coversAnchor: clear === undefined && anchor !== null, pillTop: frame.pillTop,
  };
}

function horizontalSlots(screenW: number, insets: PxInsets, specs: CommandSlotSpec[], m: CommandBarMetrics):
  { slotsX: Array<[number, number, number]>; dropped: number[] } {
  const left = insets.left + m.SIDE;
  const right = screenW - insets.right - m.SIDE;
  let primaryIndex = -1;
  specs.forEach((s, i) => { if (s.primary) primaryIndex = i; });
  const secondaries = specs.map((_, i) => i).filter((i) => i !== primaryIndex);
  const out: Array<[number, number, number]> = [];
  let limit = right;
  if (primaryIndex >= 0) {
    const x = Math.max(insets.left, right - m.PRIMARY_W);
    out.push([primaryIndex, x, m.PRIMARY_W]);
    limit = x - m.PRIMARY_GAP;
  }
  const room = limit - left - m.BUTTON;
  const fit = room < 0 ? 0 : Math.min(secondaries.length, Math.floor(room / m.MIN_PITCH) + 1);
  const kept = secondaries.slice(0, fit);
  const pitch = kept.length <= 1 ? m.PITCH : Math.min(m.PITCH, room / (kept.length - 1));
  kept.forEach((index, i) => out.push([index, left + i * pitch, m.BUTTON]));
  return { slotsX: out.sort((a, b) => a[0] - b[0]), dropped: secondaries.slice(fit) };
}

interface Frame { band: PxRect; step: PxRect; footprint: PxRect; primaryTop: number; secondaryTop: number; hintTop: number | null; pillTop: number }

function verticalFrame(side: BarSide, bandLeft: number, screenW: number, screenH: number, insets: PxInsets, hint: boolean,
  m: CommandBarMetrics): Frame {
  if (side === 'BOTTOM') {
    const base = screenH - insets.bottom;
    const shelfTop = base - m.BLOCK_H;
    const pillTop = shelfTop - m.HINT_ABOVE;
    const hintTop = hint ? pillTop : null;
    return {
      band: rect(bandLeft, shelfTop + m.STEP_H, screenW, screenH), step: rect(bandLeft, shelfTop, screenW, shelfTop + m.STEP_H),
      footprint: rect(bandLeft, hintTop ?? shelfTop, screenW, screenH),
      primaryTop: base - m.PRIMARY_TOP_FROM_BOTTOM, secondaryTop: base - m.SECONDARY_TOP_FROM_BOTTOM, hintTop, pillTop,
    };
  }
  const costTop = insets.top + m.STACK_BOTTOM + m.MARGIN;
  const primaryTop = costTop + m.PILL_ABOVE;
  const secondaryTop = primaryTop + m.PRIMARY_RISE;
  const bandTop = costTop - m.MARGIN;
  const bandBottom = secondaryTop + m.BUTTON + m.CAPTION + m.MARGIN;
  const stepBottom = bandBottom + m.STEP_H;
  const pillTop = stepBottom + m.MARGIN;
  const hintTop = hint ? pillTop : null;
  return {
    band: rect(bandLeft, bandTop, screenW, bandBottom), step: rect(bandLeft, bandBottom, screenW, stepBottom),
    footprint: rect(bandLeft, bandTop, screenW, hintTop !== null ? hintTop + m.HINT_H : stepBottom),
    primaryTop, secondaryTop, hintTop, pillTop,
  };
}

// ---- Name plate (CommandBarLayout.kt) ----

export function selectionRingBottom(anchor: PxRect, m: CommandBarMetrics = METRICS): number {
  const ringW = Math.max(m.RING_MIN_W, m.RING_W_FACTOR * (anchor.right - anchor.left));
  return anchor.bottom - m.RING_LIFT + (m.RING_H_FACTOR * ringW) / 2;
}

export type PlateSide = 'ABOVE' | 'BELOW';
export interface NamePlatePlacement { plate: PxRect; stem: PxRect; side: PlateSide; coversAnchor: boolean }

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export function namePlatePlacement(
  screenW: number, screenH: number, insets: PxInsets, anchor: PxRect, plateW: number, plateH: number, avoid: PxRect[],
  m: CommandBarMetrics = METRICS,
): NamePlatePlacement {
  const minX = insets.left + m.MARGIN;
  const maxX = Math.max(minX, screenW - insets.right - m.MARGIN - plateW);
  const minY = insets.top + m.MARGIN;
  const maxY = Math.max(minY, screenH - insets.bottom - m.MARGIN - plateH);
  const screen = rect(minX, minY, Math.max(minX + plateW, screenW - insets.right - m.MARGIN),
    Math.max(minY + plateH, screenH - insets.bottom - m.MARGIN));
  const centerX = (anchor.left + anchor.right) / 2;
  const x0 = clamp(centerX - plateW / 2, minX, maxX);
  const ringBottom = selectionRingBottom(anchor, m);
  const at = (x: number, y: number): PxRect => rect(x, y, x + plateW, y + plateH);
  const shiftedLeft = (r: PxRect): PxRect | null => {
    const hits = avoid.filter((a) => intersects(a, r));
    if (hits.length === 0) return null;
    const hit = hits.reduce((a, b) => (b.left < a.left ? b : a));
    const x = hit.left - m.MARGIN - plateW;
    return x < minX ? null : at(x, r.top);
  };
  const ok = (r: PxRect): boolean => within(r, screen) && !intersects(r, anchor) && avoid.every((a) => !intersects(a, r));
  const above = at(x0, anchor.top - m.PLATE_GAP - plateH);
  const below = at(x0, ringBottom + m.PLATE_GAP);
  const candidates: Array<[PxRect, PlateSide]> = [];
  candidates.push([above, 'ABOVE']);
  const aboveLeft = shiftedLeft(above); if (aboveLeft) candidates.push([aboveLeft, 'ABOVE']);
  candidates.push([below, 'BELOW']);
  const belowLeft = shiftedLeft(below); if (belowLeft) candidates.push([belowLeft, 'BELOW']);
  const chosen = candidates.find(([r]) => ok(r));
  const [plate, side]: [PxRect, PlateSide] = chosen ?? [at(x0, clamp(above.top, minY, maxY)), 'ABOVE'];
  const stemLeft = clamp(centerX - m.STEM_W / 2, plate.left + m.STEM_INSET,
    Math.max(plate.left + m.STEM_INSET, plate.right - (m.STEM_INSET + m.STEM_W)));
  let stem = side === 'ABOVE'
    ? rect(stemLeft, plate.bottom - m.STEM_OVERLAP, stemLeft + m.STEM_W, Math.max(plate.bottom - m.STEM_OVERLAP, anchor.top + m.STEM_OVERLAP))
    : rect(stemLeft, Math.min(plate.top + m.STEM_OVERLAP, ringBottom - m.STEM_OVERLAP), stemLeft + m.STEM_W, plate.top + m.STEM_OVERLAP);
  if (!chosen) stem = { ...stem, bottom: stem.top };
  return { plate, stem, side, coversAnchor: intersects(plate, anchor) };
}

export type StateTone = 'MUTED' | 'VALUE' | 'TIME' | 'READY' | 'DANGER';
export interface StateRun { text: string; tone: StateTone }

const STATE_TIME = /\b\d+h(?: \d+m)?\b|\b\d+m(?: \d+s)?\b|\b\d+:\d{2}\b|\b\d+s\b/g;
const STATE_VALUE = /[^\s·]*\d[^\s·]*/g;
const STATE_LEAD = /^(Ready|Spent)\b/;

/** Tints a server-formatted state line; joining the runs gives the line back unchanged. */
export function stateLineRuns(line: string): StateRun[] {
  if (line === '') return [];
  const tones: StateTone[] = Array.from({ length: line.length }, () => 'MUTED');
  for (const mm of line.matchAll(STATE_VALUE)) for (let i = mm.index!; i < mm.index! + mm[0].length; i++) tones[i] = 'VALUE';
  for (const mm of line.matchAll(STATE_TIME)) for (let i = mm.index!; i < mm.index! + mm[0].length; i++) tones[i] = 'TIME';
  const lead = STATE_LEAD.exec(line);
  if (lead) for (let i = 0; i < lead[0].length; i++) tones[i] = lead[0] === 'Spent' ? 'DANGER' : 'READY';
  const runs: StateRun[] = [];
  let start = 0;
  for (let i = 1; i <= line.length; i++) {
    if (i === line.length || tones[i] !== tones[start]) { runs.push({ text: line.slice(start, i), tone: tones[start]! }); start = i; }
  }
  return runs;
}

// ---- Need more (BuildingsR2Logic.kt) ----

export const MAX_BLOCK_DOORS = 2;

/** A block's doors, without the best door (it is the sheet's primary) and at most two. */
export function blockDoors(doors: NeedMoreDoorUi[], best: NeedMoreDoorUi | null): NeedMoreDoorUi[] {
  return doors.filter((d) => best === null || d.destination !== best.destination).slice(0, MAX_BLOCK_DOORS);
}

export function haveNeedLine(have: string | null, need: string | null): string {
  const v = (s: string | null): string => (s && s.trim() !== '' ? s : UNKNOWN);
  return `have ${v(have)} · need ${v(need)}`;
}

// ---- Token reads (single source: the CSS custom properties, so reduced motion applies) ----

/** A `--pk-dur-*` token in ms, read from :root; `fallback` only when no stylesheet is loaded (tests). */
export function tokenMs(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
