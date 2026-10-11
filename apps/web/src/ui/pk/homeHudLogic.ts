/**
 * 1:1 port of AND:K/ui/hud/HudBudget.kt (the Home HUD space budget) plus KitLogic.integerArtScale. Pure: no React, no
 * DOM. The Android JVM test AND:KT/ui/hud/HudBudgetTest.kt (10 tests) is to be ported to vitest with the same case
 * names (lane §3 universal rules); it is not written here (no builds in this candidate lane).
 *
 * Parity rule: `homeHudPlan` decides edge folding against the 412 × 915 reference phone, exactly as Android does, so
 * both clients fold the same buttons for the same Ui. The per-viewport-class web budget is a separate measurement
 * (HomeHud.css header comment, and the preview's [data-pk-qa] overlay), not an input to the plan.
 */
import type { DeckButtonUi, DeckToolUi, EdgeButtonUi, FeatureId, HomeHudUi, ResourceChipUi, ResourceDrawerUi, ResourceRowUi } from './hudModel';
import { HudIds } from './hudModel';

/** PkwTokens.Budget (KIT-API.md:60). */
export const PK_BUDGET = { HOME_PERMANENT_HUD_MAX_PCT: 12, MAX_WORLD_MARKERS: 3, MAX_EDGE_BUTTONS: 2, MAX_RESOURCE_ROWS: 4 } as const;

/** HudBudget.kt:31 — every Home HUD position and size of design/final/home.html, in dp on the 412 × 915 phone. */
export const HudGeometry = {
  SCREEN_W: 412, SCREEN_H: 915, GUTTER: 8,
  LEVEL_X: 8, LEVEL_Y: 10, LEVEL: 40,
  STATUS_X: 44, STATUS_Y: 15, STATUS_W_MAX: 238, STATUS_H: 30,
  STACK_TOP: 10, STACK_W: 108, ROW_H: 26, ROW_GAP: 2,
  EDGE: 48, EDGE_RIGHT: 12, EDGE_TOP: 142, EDGE_LABEL_GAP: 2, EDGE_LABEL_H: 24, EDGE_LABEL_W_MAX: 74, EDGE_SPACING: 12,
  TAB_W: 44, TAB_H: 48, TAB_GAP: 4, TABS_BOTTOM: 103, MAX_LEFT_TABS: 2,
  DECK_BOTTOM: 14, DECK_GAP: 4, DECK_FIRST_W: 80, DECK_PRIMARY: 72, DECK_SMALL: 52, MAX_DECK: 4,
  TOOL: 52, TOOLS_GAP_ABOVE_DECK: 8, MAX_TOOLS: 3,
  CONTEXT_W: 108, CONTEXT_H: 48,
  HERALD_TOP: 56, HERALD_W_MAX: 412 - 8 - 108 - 8 - 8,
} as const;

/** HudBudget.kt:117 — 12 % → 0.12. */
export const HOME_HUD_BUDGET = PK_BUDGET.HOME_PERMANENT_HUD_MAX_PCT / 100;

export interface HudRect { left: number; top: number; width: number; height: number }
export interface DeckSlot { button: DeckButtonUi; width: number; height: number; leftCorner: boolean }
export interface HomeHudPlan {
  leftCluster: boolean;
  resources: ResourceChipUi[];
  rightEdge: EdgeButtonUi[];
  rightEdgeFolded: number;
  leftEdge: EdgeButtonUi[];
  deck: DeckSlot[];
  tools: DeckToolUi[];
  toolsLeft: boolean;
}

export function stackHeight(rows: number): number {
  return rows <= 0 ? 0 : rows * HudGeometry.ROW_H + (rows - 1) * HudGeometry.ROW_GAP;
}

export function edgeTop(index: number): number {
  const g = HudGeometry;
  return g.EDGE_TOP + index * (g.EDGE + g.EDGE_LABEL_GAP + g.EDGE_LABEL_H + g.EDGE_SPACING);
}

export function tabTop(index: number, count: number): number {
  const g = HudGeometry;
  return g.SCREEN_H - g.TABS_BOTTOM - (count - index) * g.TAB_H - (count - 1 - index) * g.TAB_GAP;
}

/** HudBudget.kt:157 — ATTACK (first, primary) 80 × 72, other primary 72 × 72, rest 52 × 52; first half left. */
export function deckSlots(deck: DeckButtonUi[], mirrored: boolean): DeckSlot[] {
  const g = HudGeometry;
  const sized = deck.slice(0, g.MAX_DECK).map((button, index) => {
    const w = !button.primary ? g.DECK_SMALL : index === 0 ? g.DECK_FIRST_W : g.DECK_PRIMARY;
    const h = button.primary ? g.DECK_PRIMARY : g.DECK_SMALL;
    return { button, width: w, height: h };
  });
  const ordered = mirrored ? [...sized].reverse() : sized;
  const leftCount = Math.floor((ordered.length + 1) / 2);
  return ordered.map((s, i) => ({ ...s, leftCorner: i < leftCount }));
}

/** HudBudget.kt:175 */
export function homeHudPlan(ui: HomeHudUi): HomeHudPlan {
  const resources = ui.resources.slice(0, PK_BUDGET.MAX_RESOURCE_ROWS);
  if (!ui.deckVisible) {
    return { leftCluster: false, resources, rightEdge: [], rightEdgeFolded: 0, leftEdge: [], deck: [], tools: [], toolsLeft: false };
  }
  const badged = ui.rightEdge.filter((b) => b.badge != null);
  const left = ui.leftEdge.slice(0, HudGeometry.MAX_LEFT_TABS);
  const deck = deckSlots(ui.deck, ui.mirrored ?? false);
  let shown = badged.slice(0, PK_BUDGET.MAX_EDGE_BUTTONS);
  const buildSlot = deck.find((s) => s.button.id === HudIds.BUILD);
  const tools = ui.toolsOpen && buildSlot ? (ui.tools ?? []).slice(0, HudGeometry.MAX_TOOLS) : [];
  const plan = (): HomeHudPlan => ({
    leftCluster: true, resources, rightEdge: shown, rightEdgeFolded: badged.length - shown.length,
    leftEdge: left, deck, tools, toolsLeft: buildSlot?.leftCorner === true,
  });
  while (shown.length > 1 && coveredFraction(plan()) > HOME_HUD_BUDGET) shown = shown.slice(0, -1);
  return plan();
}

/** HudBudget.kt:194 */
export function hasDeckTools(ui: HomeHudUi): boolean {
  return (ui.tools ?? []).length > 0 && ui.deck.slice(0, HudGeometry.MAX_DECK).some((b) => b.id === HudIds.BUILD);
}

/** HudBudget.kt:216 — the "+n" door's target, or null (then "+n" is a count only). */
export function edgeOverflowTarget(plan: HomeHudPlan, ui: HomeHudUi): FeatureId | null {
  return ui.rightEdgeOverflow != null && plan.rightEdgeFolded > 0 && plan.rightEdge.length > 0 ? ui.rightEdgeOverflow : null;
}

/** HudBudget.kt:220 — every painted permanent box of the plan on the reference phone. */
export function homeHudRects(plan: HomeHudPlan): HudRect[] {
  const g = HudGeometry;
  const out: HudRect[] = [];
  if (plan.leftCluster) {
    out.push({ left: g.LEVEL_X, top: g.LEVEL_Y, width: g.LEVEL, height: g.LEVEL });
    out.push({ left: g.STATUS_X, top: g.STATUS_Y, width: g.STATUS_W_MAX, height: g.STATUS_H });
  }
  if (plan.resources.length > 0) {
    out.push({ left: g.SCREEN_W - g.GUTTER - g.STACK_W, top: g.STACK_TOP, width: g.STACK_W, height: stackHeight(plan.resources.length) });
  }
  plan.rightEdge.forEach((_, i) => {
    const x = g.SCREEN_W - g.EDGE_RIGHT - g.EDGE;
    const top = edgeTop(i);
    out.push({ left: x, top, width: g.EDGE, height: g.EDGE });
    out.push({ left: x + g.EDGE / 2 - g.EDGE_LABEL_W_MAX / 2, top: top + g.EDGE + g.EDGE_LABEL_GAP, width: g.EDGE_LABEL_W_MAX, height: g.EDGE_LABEL_H });
  });
  plan.leftEdge.forEach((_, i) => out.push({ left: 0, top: tabTop(i, plan.leftEdge.length), width: g.TAB_W, height: g.TAB_H }));
  const base = g.SCREEN_H - g.DECK_BOTTOM;
  let x = g.GUTTER;
  plan.deck.filter((s) => s.leftCorner).forEach((s) => { out.push({ left: x, top: base - s.height, width: s.width, height: s.height }); x += s.width + g.DECK_GAP; });
  let right = g.SCREEN_W - g.GUTTER;
  [...plan.deck.filter((s) => !s.leftCorner)].reverse().forEach((s) => { out.push({ left: right - s.width, top: base - s.height, width: s.width, height: s.height }); right -= s.width + g.DECK_GAP; });
  return out;
}

/** HudBudget.kt:240 — union area clipped to the screen (overlaps count once). */
export function coveredArea(rects: HudRect[], screenW: number = HudGeometry.SCREEN_W, screenH: number = HudGeometry.SCREEN_H): number {
  const clamp = (v: number, hi: number): number => Math.min(Math.max(v, 0), hi);
  const clipped = rects.flatMap((r) => {
    const l = clamp(r.left, screenW), t = clamp(r.top, screenH), rr = clamp(r.left + r.width, screenW), b = clamp(r.top + r.height, screenH);
    return rr > l && b > t ? [{ left: l, top: t, width: rr - l, height: b - t }] : [];
  });
  const xs = [...new Set(clipped.flatMap((r) => [r.left, r.left + r.width]))].sort((a, b) => a - b);
  const ys = [...new Set(clipped.flatMap((r) => [r.top, r.top + r.height]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const cx = xs[i]!, cy = ys[j]!;
    if (clipped.some((r) => cx >= r.left && cx < r.left + r.width && cy >= r.top && cy < r.top + r.height)) area += (xs[i + 1]! - cx) * (ys[j + 1]! - cy);
  }
  return area;
}

export function coveredFraction(plan: HomeHudPlan): number {
  return coveredArea(homeHudRects(plan)) / (HudGeometry.SCREEN_W * HudGeometry.SCREEN_H);
}

/** HudBudget.kt:260 */
export function homeHudCoverage(ui: HomeHudUi): number {
  return coveredFraction(homeHudPlan(ui));
}

/** HudBudget.kt:265 — the dp an edge / deck icon draws at (before the web's integer-art snap). */
export function hudIconDp(icon: string, large: boolean): number {
  if (icon.startsWith('ui:') || icon.startsWith('pkw_ui_') || icon.startsWith('itm_')) return 32;
  if (icon.includes('portrait')) return 28;
  if (icon.startsWith('shape:')) return 24;
  return large ? 36 : 24;
}

/** HudBudget.kt:274 — the focused drawer row, else the first, else null. */
export function drawerFocus(ui: ResourceDrawerUi): ResourceRowUi | null {
  const rows = ui.groups.flatMap((g) => g.rows);
  return rows.find((r) => r.id === ui.focusRowId) ?? rows[0] ?? null;
}

/** KitLogic.kt:222 — device px per art px, nearest integer, at least 1. */
export function integerArtScale(targetPx: number, art: number): number {
  return art <= 0 ? 1 : Math.max(1, Math.floor(targetPx / art + 0.5));
}

/**
 * Lane §4 "Pixel art": the CSS size of [artPx] art meant to fill [targetCss] CSS px at [dpr]:
 * `artPx * k / dpr`, k = integerArtScale(targetCss * dpr, artPx). A 24 px icon at DPR 1 is 24 or 48, never 36.
 *
 * Web-only extension (open question in HomeHud.md): art LARGER than its box at the live DPR (the 60 px builder sprite
 * in a 30 px slot at DPR 1, the 40 px league crest in 20) draws at an integer DIVISOR, 1/d with
 * d = round(artPx / (targetCss * dpr)), instead of overflowing at 1×; and a half-way tie that would overflow the box
 * by more than 25 % steps back one integer (24 px art in a 36 px slot at DPR 1 draws at 24, not 48). Android never
 * meets either case at density 2.625 for the HUD sizes, so parity holds on the reference device.
 */
export function artCssSize(artPx: number, targetCss: number, dpr: number): number {
  const target = targetCss * dpr;
  if (artPx > target * 1.5) return artPx / (Math.max(1, Math.round(artPx / target)) * dpr);
  let k = integerArtScale(target, artPx);
  // Web-only: a tie rounded up past the box by more than a quarter (24 art in 36 at DPR 1 → 48) steps back down (→ 24).
  if (k > 1 && artPx * k > target * 1.25) k -= 1;
  return (artPx * k) / dpr;
}
