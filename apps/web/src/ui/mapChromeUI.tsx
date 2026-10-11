/**
 * Shared map-board chrome — the components both the WORLD and CAMPAIGN boards
 * render, each one pinned to a slot solved by `mapChrome()` in ui/layout.ts.
 *
 * WHY THIS FILE EXISTS: the two boards used to place fifteen overlays with bare
 * literals and no shared stacking discipline, so on a 375×812 phone they
 * collided — the region banner clipped behind the mode tabs, HIDE SHIELDED cut
 * in half at the right edge, the zoom rail's `+` pill off-screen in landscape,
 * the campaign stage sheet unclosable because its ✕ had been pushed above y=0.
 * Every control here takes a `Slot`, and there is no way to render one without
 * asking the solver for a place to put it. Same relationship BaseHud has with
 * CHROME/hudHeight.
 *
 * SLOTS ARE ALREADY INSIDE THE SAFE AREA. `mapChrome()` is solved against the
 * viewport MINUS the device insets, and `slotStyle` adds the top/left inset
 * back when positioning — so every edge is honoured, including the two the old
 * screens ignored entirely (this was the only screen in the app using none of
 * `env(safe-area-inset-*)`).
 */
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { MAPCHROME, type Insets, type MapChromeLayout, type Slot } from './layout';
import { Btn, COLORS as C, Icon, Sprite } from './primitives';

/** Absolute placement for a solved slot, inside the safe area. */
export function slotStyle(s: Slot, inset: Insets): CSSProperties {
  return {
    position: 'absolute',
    left: s.left + inset.left,
    top: s.top + inset.top,
    width: s.width,
    height: s.height,
  };
}

// ---------------------------------------------------------------------------
// THE CHROME SWALLOWS ITS OWN POINTERS
//
// Every control here is a DESCENDANT of the board root, and the board root
// carries the pan gesture (map.tsx `panProps`). React events bubble up the
// component tree, so a press on GLOBE / WAR ROOM / HIDE SHIELDED / a zoom pill
// used to reach the board's `onPointerDown`, enter its pointer set, and PAN THE
// MAP behind the button — and a press with ≥ MAPCHROME.dragPx of finger drift
// (unavoidable on a phone) ALSO still fired the button, because IconBtn used a
// bare `onClick` with no drag gate. Jitter-pan behind essentially every press.
//
// Two rules, both needed, and both PURE so they can be asserted without a DOM
// (this package has no jsdom; see mapChromeUI.test.ts):
//  1. a chrome pointerdown is stopped, so the board never sees the pointer at
//     all. This is exactly what MapSheet's peek band already did for its own
//     drag handle — it was simply never generalised to the other wrappers.
//  2. a chrome press that DRIFTS past the same threshold the pan gate uses does
//     not fire its action, so a press that turns into a scroll of the rail is
//     abandoned rather than committed.
//
// The drift state hangs off the pressed ELEMENT in a WeakMap rather than a hook,
// which keeps every component in this file hook-free and therefore directly
// callable from a test.
// ---------------------------------------------------------------------------

/** The subset of a pointer event these rules read. */
interface ChromePointer {
  clientX: number;
  clientY: number;
  currentTarget: EventTarget;
  stopPropagation(): void;
}

interface Drift { x: number; y: number; drifted: boolean; clear: ReturnType<typeof setTimeout> | null }

const drift = new WeakMap<EventTarget, Drift>();

/** Rule 1 + the start of rule 2. Spread onto EVERY chrome wrapper. */
export function chromePointerDown(e: ChromePointer): void {
  e.stopPropagation();
  const prev = drift.get(e.currentTarget);
  if (prev?.clear) clearTimeout(prev.clear);
  drift.set(e.currentTarget, { x: e.clientX, y: e.clientY, drifted: false, clear: null });
}

/** Rule 2: cumulative displacement from the press origin, same threshold and
 *  same "cumulative, not per-event" discipline as the board's pan gate. */
export function chromePointerMove(e: ChromePointer): void {
  const g = drift.get(e.currentTarget);
  if (!g) return;
  if (Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) > MAPCHROME.dragPx) g.drifted = true;
}

/**
 * End of the press. The `click` that follows this pointerup must still SEE the
 * flag — that is the whole mechanism — so the record is dropped on the NEXT TASK
 * rather than here.
 *
 * Without this the flag went stale in the dangerous direction: one abandoned
 * drifted press left `drifted: true` on that element until its next pointerdown,
 * so a later click with no pointer sequence at all — Enter, a screen reader, a
 * synthetic click — was silently swallowed. Observed live: after a drifted press
 * on GLOBE, the GLOBE button was dead to keyboard activation. Same
 * clear-on-next-task discipline map.tsx's `resetTimer` uses for `didDragRef`.
 */
export function chromePointerUp(e: Pick<ChromePointer, 'currentTarget'>): void {
  const g = drift.get(e.currentTarget);
  if (!g) return;
  const target = e.currentTarget;
  if (g.clear) clearTimeout(g.clear);
  g.clear = setTimeout(() => drift.delete(target), 0);
}

/** True when the press that is ending on `target` moved far enough to be a drag.
 *  Read by the `click` that follows, which is what suppresses the action. */
export function chromeDrifted(target: EventTarget): boolean {
  return drift.get(target)?.drifted === true;
}

/**
 * DOUBLE-TAP: the window (ms) and the radius (px) that make two taps one gesture.
 *
 * Centralised for exactly the reason `MAPCHROME.dragPx` was: the local board
 * (screens/map.tsx) and the globe (screens/globe/PixelGlobe.tsx) each carried
 * their own `320` / `24`, so the two halves of the same screen could silently
 * disagree about what a double-tap is — and the map surface has ONE gesture
 * contract or it has none.
 *
 * `ui/layout.ts`'s MAPCHROME is the eventual home (as `dblMs` / `dblPx`); it
 * belongs to another track this phase, so the pair lives here beside the drift
 * guard that already reads `MAPCHROME.dragPx`. Same standing as the layout
 * metrics: a gesture threshold, not a game number — no cost, stat, cap or timer
 * moves with it.
 */
export const MAP_DBL = { ms: 320, px: 24 } as const;

/** Pointer props every wrapper in this file spreads onto its root node. */
export const chromePanGuard = {
  onPointerDown: chromePointerDown,
  onPointerMove: chromePointerMove,
  onPointerUp: chromePointerUp,
  onPointerCancel: chromePointerUp,
} as const;

/**
 * A 44×44 minimum touch target. `label` is always present — as visible text
 * when the viewport can afford it (desktop keeps the labelled pills the board
 * ships today) and as the accessible name when it cannot. There is no icon-only
 * button here without a name.
 */
export function IconBtn({
  glyph, label, showLabel, on, badge, onClick, accent, style,
}: {
  glyph: ReactNode; label: string; showLabel?: boolean; on?: boolean;
  badge?: ReactNode; onClick(): void; accent?: string | undefined; style?: CSSProperties;
}): React.JSX.Element {
  return (
    <button
      className="interactive"
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      {...chromePanGuard}
      // The drag gate the world layer's marker taps already use, applied to the
      // chrome: a press that drifted is a pan attempt, not a button press.
      onClick={(e) => { if (!chromeDrifted(e.currentTarget)) onClick(); }}
      style={{
        minWidth: MAPCHROME.tap, minHeight: MAPCHROME.tap,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        padding: showLabel ? '0 8px' : 0,
        fontFamily: 'inherit', fontSize: 15, letterSpacing: '1px', lineHeight: 1,
        background: on ? C.goldDp : 'rgba(20,18,26,.92)',
        border: `2px solid ${accent ?? (on ? C.gold : C.border)}`,
        color: on ? C.goldHi : C.text, cursor: 'pointer', whiteSpace: 'nowrap',
        ...style,
      }}>
      {glyph !== '' && glyph !== null && <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 19 }}>{glyph}</span>}
      {showLabel && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
      {badge !== undefined && <span style={{ color: on ? C.ink : C.textFaint, fontSize: 14 }}>{badge}</span>}
    </button>
  );
}

/**
 * THE one top row: back · mode tabs · truncating title · trailing controls.
 *
 * The title is `flex:1; minWidth:0` and ellipsises, which is what lets a long
 * valley name coexist with the tabs on a 320px phone instead of pushing the
 * search box off the right edge. The 216×54 `map_region_banner` sprite is
 * deliberately NOT here (owner decision, 2026-08-09): fixed-width handout art
 * spanning x 87→303 of a 390px phone was the single biggest cause of the
 * pile-up. It moved to the sheet header plate below, so the art stays in the
 * game without occupying the width the title and search need.
 */
export function MapTopBar({
  L, inset, mode, onMode, onBack, title, trailing,
}: {
  L: MapChromeLayout; inset: Insets;
  mode: 'world' | 'campaign'; onMode(m: 'world' | 'campaign'): void;
  onBack(): void; title: string; trailing?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="interactive"
      {...chromePanGuard}
      style={{
        position: 'absolute', left: 0, right: 0, top: 0, zIndex: 1200, boxSizing: 'border-box',
        height: L.bar.height + inset.top,
        paddingTop: inset.top,
        paddingLeft: MAPCHROME.pad + inset.left,
        paddingRight: MAPCHROME.pad + inset.right,
        display: 'flex', alignItems: 'stretch', gap: MAPCHROME.gap,
        background: 'linear-gradient(rgba(16,14,20,.97), rgba(16,14,20,.84))',
        // boxShadow, NOT borderBottom: a border eats 2px of the content box and
        // the 44px tabs inside came out 42px tall — under the touch minimum the
        // whole bar exists to guarantee.
        boxShadow: `0 2px 0 ${C.ink}`,
      }}>
      <IconBtn glyph={<Icon name="close" size={20} />} label="BASE" onClick={onBack}
        style={{ height: '100%', flex: 'none' }} />
      {(['world', 'campaign'] as const).map((m) => (
        <Btn key={m} variant={mode === m ? 'gold' : 'sec'} fontSize={13}
          style={{ height: '100%', minWidth: MAPCHROME.tap, padding: '0 9px', flex: 'none' }}
          onClick={() => onMode(m)}>
          {m === 'world' ? 'WORLD' : 'CAMPAIGN'}
        </Btn>
      ))}
      <span style={{
        flex: '1 1 0', minWidth: 0, alignSelf: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: C.gold, fontSize: 17, letterSpacing: '2px',
      }}>{title}</span>
      {trailing}
    </div>
  );
}

/** The right-hand toggle cluster: a column in portrait, a row in landscape. */
export function IconRail({ L, inset, children }: {
  L: MapChromeLayout; inset: Insets; children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="interactive" {...chromePanGuard} style={{
      position: 'absolute', zIndex: 1000,
      top: L.rail.top + inset.top,
      right: MAPCHROME.pad + inset.right,
      display: 'flex', flexDirection: L.portrait ? 'column' : 'row',
      gap: MAPCHROME.gap, alignItems: 'stretch',
    }}>
      {children}
    </div>
  );
}

/**
 * The row directly under the bar — the world board's expanded search, the
 * campaign's ACT strip. Horizontally scrolling (`.hud-strip`, the same pattern
 * the landscape HUD uses) so more pills than fit can never wrap into a second
 * row and start colliding again.
 */
export function UnderBar({ L, inset, scroll, children }: {
  L: MapChromeLayout; inset: Insets; scroll?: boolean; children: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={scroll ? 'interactive hud-strip' : 'interactive'}
      {...chromePanGuard}
      style={{
        ...slotStyle(L.underBar, inset), height: undefined,
        minHeight: L.underBar.height,
        maxHeight: L.underBar.height + L.searchMax,
        zIndex: 1001, display: 'flex', gap: MAPCHROME.gap,
        ...(scroll
          ? { overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none', alignItems: 'stretch' }
          : { flexDirection: 'column', alignItems: 'stretch' }),
      }}>
      {children}
    </div>
  );
}

/** Zoom cluster. Renders nothing when the solver found no band for it — pinch,
 *  wheel and double-tap zoom all work, so it is a convenience, not the only way.
 *
 *  THE HOME SLOT IS THE BOARD'S TO NAME. The local boards recentre with it; the
 *  globe flies MY PARCEL / CHOOSE LAND from it (D-097), which is what let the
 *  globe drop its separate icon rail on a 390 px phone. Same 44 px button either
 *  way — only the glyph and the accessible name change. */
export function ZoomRail({
  L, inset, sheetH, zoomBy, onHome, homeLabel = 'RECENTRE', homeGlyph = '⌂', step,
}: {
  L: MapChromeLayout; inset: Insets; sheetH: number;
  zoomBy(d: number): void; onHome?: (() => void) | undefined;
  homeLabel?: string | undefined; homeGlyph?: ReactNode; step: number;
}): React.JSX.Element | null {
  if (!L.zoom) return null;
  const column = L.zoom.width === MAPCHROME.tap;
  const btn: CSSProperties = { width: MAPCHROME.tap, height: MAPCHROME.tap, fontSize: 24, flex: 'none' };
  return (
    <div className="interactive" {...chromePanGuard} style={{
      position: 'absolute', zIndex: 1000,
      right: MAPCHROME.pad + inset.right,
      // Bottom-anchored ON THE SHEET, not on a magic 210: the sheet publishes
      // its measured height and the cluster rides above it in both states.
      bottom: sheetH + MAPCHROME.pad + inset.bottom,
      display: 'flex', flexDirection: column ? 'column' : 'row', gap: MAPCHROME.gap,
    }}>
      <IconBtn glyph="+" label="ZOOM IN" onClick={() => zoomBy(step)} style={btn} />
      <IconBtn glyph="−" label="ZOOM OUT" onClick={() => zoomBy(-step)} style={btn} />
      {onHome && <IconBtn glyph={homeGlyph} label={homeLabel} onClick={onHome} style={{ ...btn, fontSize: 19 }} />}
    </div>
  );
}

/**
 * The 216×54 `map_region_banner` sprite in its new home: the sheet's header
 * plate. Owner decision 2026-08-09 — retire it from the top bar, keep the art
 * in play. Scaled to 176×44 (exact 4:1 aspect, so no distortion) so the peek
 * band is one 44px row like everything else.
 */
export function RegionPlate({ title, sub }: { title: string; sub: string }): React.JSX.Element {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: 176, height: 44, flex: 'none' }}>
      <Sprite name="map_region_banner" w={176} h={44} />
      <span style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', paddingBottom: 4,
        color: C.text, fontSize: 16, letterSpacing: '1px', lineHeight: 1,
        overflow: 'hidden',
      }}>
        <span style={{ maxWidth: 164, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ color: C.gold, fontSize: 11, letterSpacing: '1px' }}>{sub}</span>
      </span>
    </span>
  );
}

export type SheetState = 'hidden' | 'peek' | 'expanded';

/**
 * The board's ONE bottom sheet, in three states.
 *
 * It replaces two floating dialogs and two floating status containers. Those
 * status pills (FREE RAIDS / TARGETS, campaign progress) used to sit at
 * `bottom: 12` and were BURIED under the z-1100 target sheet even when it was
 * minimised; here they live in the peek band, which is the sheet's resting
 * state, so they are always readable.
 *
 * `onHeight` publishes the measured CONTENT height (excluding the bottom
 * inset), which is what `mapChrome()` needs to place the zoom cluster.
 *
 * The header is drag-down-to-collapse and its ✕ is inside the visible band by
 * construction, because the body — never the sheet — is what scrolls.
 */
export function MapSheet({
  L, inset, state, onCollapse, onHeight, peek, children,
}: {
  L: MapChromeLayout; inset: Insets; state: SheetState;
  onCollapse(): void; onHeight(h: number): void;
  peek: ReactNode; children?: ReactNode;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) { onHeight(0); return undefined; }
    const publish = (): void => onHeight(Math.round(el.offsetHeight) - inset.bottom);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight, inset.bottom, state]);

  if (state === 'hidden') return null;

  return (
    <div
      ref={ref}
      className="interactive"
      // The peek band below stops its own pointerdown (it is a drag handle); the
      // EXPANDED body did not, so a drag inside the sheet panned the map behind
      // it. Same guard, one node up.
      {...chromePanGuard}
      style={{
        position: 'absolute', left: inset.left, right: inset.right, bottom: 0, zIndex: 1100,
        paddingBottom: inset.bottom,
        maxHeight: L.sheetMax + inset.bottom,
        display: 'flex', flexDirection: 'column',
        background: C.panel, borderTop: `2px solid ${C.borderLt}`, boxShadow: `0 -2px 0 ${C.ink}`,
      }}>
      {/* PEEK BAND — one 44px scrolling row: region plate + status pills. Also
          the drag handle: pulling it down collapses an expanded sheet. */}
      <div
        className="hud-strip"
        onPointerDown={(e) => { drag.current = { y: e.clientY }; e.stopPropagation(); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && e.clientY - d.y > 36) { drag.current = null; onCollapse(); }
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        style={{
          flex: 'none', height: MAPCHROME.peek, boxSizing: 'border-box',
          padding: '4px 8px', display: 'flex', alignItems: 'center', gap: MAPCHROME.gap,
          overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none',
          background: C.ink, borderBottom: children ? `2px solid ${C.borderLt}` : 'none',
          touchAction: 'pan-x', cursor: children ? 'grab' : 'default',
        }}>
        {peek}
      </div>
      {/* EXPANDED BODY — the ONLY scroller. The campaign stage sheet had no
          maxHeight and no overflow, so a tall body pushed its header (and the ✕)
          above y=0 and the sheet became unclosable. */}
      {children && (
        <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0 }}>
          {children}
        </div>
      )}
    </div>
  );
}
