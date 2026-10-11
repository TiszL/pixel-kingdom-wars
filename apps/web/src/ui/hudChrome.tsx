/**
 * HUD CHROME — the material the single-row top bar is built from.
 *
 * WHY THIS IS ART AND NOT A BORDER COLOUR. The owner's complaint, filed from
 * production three times, was "black bars": #1a171e is the right plate colour
 * behind gold numerals read against a bright board, and it is already the HUD
 * panel colour in code. What the plate had was no EDGE, no MATERIAL and no
 * LIGHT, so it read as a void punched out of the game.
 *
 * The 2026-08-29 craft pass replaced every master here after the owner rejected
 * the first set as "web UI, not a game". Six things were wrong and each has an
 * answer below:
 *
 *  1. FLAT CHIPS → the readouts sit in recessed seats with a lit rim (brightest
 *     on top, one step down the left, darker right, darkest along the bottom),
 *     not a hairline rectangle.
 *  2. GENERIC SQUARE → the overflow control is a chamfered raised iron plate
 *     carrying the keep's own crenellations, with two rows of standing
 *     thickness beneath its face.
 *  3. KEEP LOOKED ORDINARY → see hudChipStyle(). This one is a CORRECTNESS
 *     problem: production feedback #1 was a player spending KEEP by accident
 *     because it looked like an ordinary resource.
 *  4. UNDIFFERENTIATED STRIP → the bar has a lit stone crown, a shadowed inner
 *     well, a forged gold rim with its own specular row, and riveted end straps
 *     whose rivets sit in the BOTTOM corners too (landscape drops border-top, so
 *     top-only ornament would vanish in the hardest orientation to lay out).
 *  5. NOTHING ALIVE → HUD_CHROME_CSS + useHudFlash() below.
 *  6. PLAIN RED DOT → a hanging gold-ringed red gem, outlined hard enough to
 *     read against grass and bezelled warm enough to read against the bar.
 *
 * The six PNGs total 1,720 bytes and are imported the way icons.ts imports its
 * game-v4 masters (four levels up to the repo root). vite.config.ts sets
 * `assetsInlineLimit: 0`, so they are emitted as files and NEVER enter the JS
 * bundle — this chrome costs the 1000 KB first-paint wall nothing.
 *
 * THREE RULES THAT ARE EASY TO BREAK SILENTLY:
 *  1. border-width MUST equal border-image-slice. At 1:1 the corner slices are
 *     never scaled, so they stay byte-identical at 320px and at 1024px. Change
 *     one without the other and every corner resamples.
 *  2. `fill` is required in border-image-slice or the plate's middle is
 *     transparent and the "black bar" comes back as a see-through one.
 *  3. Every animation here moves by WHOLE PIXELS. A transform:scale() on a 16px
 *     sprite resamples every pixel off the grid — the previous badge pulse blurred
 *     the one element that must never be missed. Integer translate only.
 * Every stretched slice is uniform along its stretch axis, so the chrome is
 * pixel-identical even where a browser ignores image-rendering:pixelated.
 */
import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from 'react';
import { useEffect, useRef, useState } from 'react';
import { CHROME, HUD_QUEUE, type HudTier, hudHeight, taskRailTop } from './layout';

import barPlate from '../../../../art/game-v4/ui/hudchrome-hud_bar_frame_9slice.png';
import chipWell from '../../../../art/game-v4/ui/hudchrome-hud_plate_shard_9slice.png';
import keepWell from '../../../../art/game-v4/ui/hudchrome-hud_plate_keep_9slice.png';
import badgeAlert from '../../../../art/game-v4/ui/hudchrome-hud_alert_tag.png';
import overflowPress from '../../../../art/game-v4/ui/hudchrome-hud_btn_overflow_press.png';
import overflowIdle from '../../../../art/game-v4/ui/hudchrome-hud_btn_overflow_idle.png';
import tabIdle from '../../../../art/game-v4/ui/hudchrome-hud_tab_idle_9slice.png';
import tabSunk from '../../../../art/game-v4/ui/hudchrome-hud_tab_sunk_9slice.png';
import tabGold from '../../../../art/game-v4/ui/hudchrome-hud_tab_gold_9slice.png';
import tabGoldSunk from '../../../../art/game-v4/ui/hudchrome-hud_tab_gold_sunk_9slice.png';
import dockIdle from '../../../../art/game-v4/ui/hudchrome-hud_dock_idle_9slice.png';
import dockSunk from '../../../../art/game-v4/ui/hudchrome-hud_dock_sunk_9slice.png';

export const HUD_ART = {
  barPlate, chipWell, keepWell, badgeAlert, overflowPress, overflowIdle,
  tabIdle, tabSunk, tabGold, tabGoldSunk, dockIdle, dockSunk,
} as const;

/**
 * PALETTE — the eight colours this file draws with, sampled verbatim from the
 * accepted game-v4 masters exactly as the PNG kit is (see the studio lane's
 * palette.py, which names the source file for every entry).
 *
 * They are literals rather than imports from primitives.tsx COLORS because
 * COLORS is the App's *UI* palette and this is the forged-metal ramp of the
 * KEEP and the wall kit — the two overlap on #1A171E and nowhere else, and
 * pretending otherwise is how a chrome edge quietly becomes a web-UI grey.
 */
const FORGE = {
  outline: '#1A171E',
  well: '#2F2C34',
  goldL: '#F4D77B',
  goldM: '#E3AE3C',
  goldS: '#9C6F1E',
} as const;

/** The bar plate's own centre fill. Anything that has to read as the SAME slab
 *  of chrome as the bar — the bottom deck, the landscape rail — is this colour
 *  and not a near-black of its own choosing. */
export const HUD_FIELD = FORGE.well;

/**
 * The keyboard focus ring's bright row, and the one colour here that is
 * DELIBERATELY not from FORGE.
 *
 * A gold ring was tried first and it disappears on the KEEP chip: that plate is
 * forged from seven colours of the gold ramp, so a gold line just inside its
 * gold bezel is invisible — on the one readout whose entire purpose is that it
 * does not look like the others. Focus has to be legible on EVERY plate in the
 * kit or it is not a focus indicator, so it borrows the parchment the HUD already
 * writes its numbers in: the highest-contrast ink the game draws, and the only
 * one that reads on stone and on gold alike.
 */
const FOCUS_INK = '#EFE8D6';

/**
 * The bar plate. Portrait keeps the lit top chamfer; landscape sets the top
 * border to 0 and keeps the rim (see hudHeight — those 6px are the difference
 * between a 261px and a 255px board in the 311px-tall Seeker webview).
 *
 * Safe-area is applied as INNER PADDING, never as an outer offset, so the
 * forged rim still reaches the physical screen edges on a notched device.
 */
export function hudPlateStyle(portrait: boolean): CSSProperties {
  const { barBorderY: y, barBorderX: x } = CHROME;
  return {
    borderStyle: 'solid',
    borderWidth: portrait ? `${y}px ${x}px` : `0 ${x}px ${y}px`,
    borderImageSource: `url(${barPlate})`,
    borderImageSlice: `${y} ${x} ${y} ${x} fill`,
    borderImageRepeat: 'stretch',
    imageRendering: 'pixelated',
    boxSizing: 'border-box',
  };
}

/** Complete placement for the bar. Compact remains the accepted full-bleed
 * strip; mid/wide shrink-wrap it into a floating game cluster. */
export function hudBarStyle(_portrait: boolean, _tier: HudTier, _rail: boolean): CSSProperties {
  return {
    position: 'absolute', zIndex: 1000,
    top: 'calc(8px + env(safe-area-inset-top))',
    left: 'calc(8px + env(safe-area-inset-left))',
    width: 'max-content', maxWidth: 'calc(100% - 16px - env(safe-area-inset-left) - env(safe-area-inset-right))',
    display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
  };
}

/** Floating children consume input; the exposed space between them is scene. */
export function hudBarRowStyle(): CSSProperties {
  return { display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 8,
    minHeight: CHROME.tapRow, minWidth: 0, pointerEvents: 'none' };
}

/** Which plate a chip is cut from. `keep` is not decoration — see below. */
export type HudPlate = 'shard' | 'keep';

/**
 * The recessed well a readout or a bar-level control sits in.
 *
 * THE KEEP PLATE IS A CORRECTNESS FEATURE, NOT A FLOURISH. Shards are mined and
 * refunded; KEEP is bought, and the first thing production reported was a player
 * spending it by accident because both currencies carried identical visual
 * weight. The two masters are therefore separated CATEGORICALLY rather than by
 * a shade: the shard plate contains ZERO colours from the gold ramp and the KEEP
 * plate is forged from seven of them, so the pair still reads as "ordinary" vs
 * "precious" box-filtered to 4×4 — i.e. in peripheral vision, which is the only
 * place the distinction has to work.
 *
 * BOTH INSETS STAY AT 3px. A 4px KEEP bezel would look richer, but HUD_CHIP.base
 * (43) was MEASURED and includes this border on both sides; widening it would
 * move the chip-drop solver that stops a 7-digit shard count rendering clipped
 * on a 320px phone. The plates earn their difference from material instead.
 */
export function hudChipStyle(plate: HudPlate = 'shard'): CSSProperties {
  const b = CHROME.chipBorder;
  return {
    borderStyle: 'solid',
    borderWidth: b,
    borderImageSource: `url(${plate === 'keep' ? keepWell : chipWell})`,
    borderImageSlice: `${b} fill`,
    borderImageRepeat: 'stretch',
    imageRendering: 'pixelated',
    boxSizing: 'border-box',
  };
}

// ===========================================================================
// PRESSABLE TABS — the bottom nav and the base-tools dock
// ===========================================================================

/**
 * Which plate a pressable tab is cut from.
 *
 *  nav   a lit stone-and-iron tab. The five destinations.
 *  gold  the same tab forged in gold. RAID only — it is the primary action and
 *        it was already gold, so this changes its MATERIAL, not its identity.
 *  dock  the same tab one step down the ramp: dimmer crown, darker face, no
 *        gold anywhere. The base tools float OVER the board where the nav sits
 *        on a deck at its edge, so they have to read as subordinate.
 */
export type HudTab = 'nav' | 'gold' | 'dock';

const TAB_ART: Record<HudTab, { idle: string; sunk: string }> = {
  nav: { idle: tabIdle, sunk: tabSunk },
  gold: { idle: tabGold, sunk: tabGoldSunk },
  dock: { idle: dockIdle, sunk: dockSunk },
};

/**
 * A pressable forged tab.
 *
 * WHY `sunk` IS GEOMETRY AND NOT A COLOUR. The shipped nav said "this one is
 * special" with a flat #E3AE3C fill on RAID and said nothing at all about which
 * destination you are currently in — the BUILD tab looks identical whether the
 * build tray is open or shut. A fill cannot carry either fact: it survives
 * neither a greyscale accessibility filter nor peripheral vision.
 *
 * So the two states are the same plate under INVERTED LIGHT, which is the
 * language hud-kit's overflow button already speaks. Raised: lit crown along
 * the top and the left, an iron face, two rows of standing thickness at the
 * foot. Sunk: the crown becomes the shadow the socket wall casts, the lit edge
 * moves to the bottom-right where the bounce is, the face drops into the hole
 * and the thickness is spent. Cover the colour and the geometry alone still
 * says it moved — the studio lane asserts exactly that in pure greyscale
 * (lanes/hud-bottom/gates.py G5), because "must survive greyscale" is a
 * requirement and not a hope.
 *
 * THE 1:1 RULE, restated because it is as easy to break here as on the bar:
 * borderWidth MUST equal borderImageSlice. At 1:1 the four corner slices are
 * blitted rather than resampled, so a tab is byte-identical at the 52px of a
 * dock button and the 78px of a nav item on a 412px phone. `fill` is required
 * or the tab's middle is transparent and the black rectangle comes back as a
 * see-through one.
 */
export function hudTabStyle(tab: HudTab = 'nav', sunk = false): CSSProperties {
  const b = CHROME.tabBorder;
  const art = TAB_ART[tab];
  return {
    borderStyle: 'solid',
    borderWidth: b,
    borderImageSource: `url(${sunk ? art.sunk : art.idle})`,
    borderImageSlice: `${b} fill`,
    borderImageRepeat: 'stretch',
    imageRendering: 'pixelated',
    boxSizing: 'border-box',
    background: 'transparent',
    // The containing block for the tab's focus ring, which has to be drawn on a
    // pseudo-element — see HUD_CHROME_CSS: a border-image with `fill` paints
    // over any inset shadow on the element itself. Costs no layout.
    position: 'relative',
  };
}

/**
 * The FORGED RIM that separates chrome from world along the navigation's
 * board-facing edge — the bottom deck's top edge in portrait, the right rail's
 * left edge in landscape.
 *
 * It is the bar's own rim slice, restated in CSS: a hard outline, then the
 * gold specular / body / shadow rows, then the seat. Same five rows, same five
 * colours, so the top of the screen and the bottom of the screen are bounded by
 * the SAME forged line rather than by a plate at one end and a fade at the
 * other. That symmetry is most of why the bottom stopped looking broken next to
 * the bar.
 *
 * Stacked inset box-shadows rather than a border: a border would take part in
 * the height arithmetic that CHROME.navBar pins, and these must cost zero
 * layout. Later shadows paint behind earlier ones, so increasing offsets stack
 * outward-in. Every row is exactly 1px with no blur and no spread — a blurred
 * rim is the gradient mush this whole lane exists to remove.
 */
export function hudDeckRim(portrait: boolean): string {
  const rows = [FORGE.outline, FORGE.goldL, FORGE.goldM, FORGE.goldS, FORGE.outline];
  return rows
    .map((c, i) => (portrait ? `inset 0 ${i + 1}px 0 0 ${c}` : `inset ${i + 1}px 0 0 0 ${c}`))
    .join(',');
}

/**
 * The navigation DECK: a bottom bar in portrait, a right-hand rail in
 * landscape. Right rather than left because that is the thumb that reaches when
 * a phone is held in landscape.
 *
 * It is a style function rather than markup because the items inside it are the
 * app's, not the kit's — but the geometry has to be single-sourced or the
 * render harness that this lane is judged on would be free to drift from the
 * product it claims to show.
 *
 * NOTHING HERE MAY GROW. CHROME.navBar (92) and CHROME.rail (76) are subtracted
 * by playArea(), depended on by every bottom sheet in sheets.tsx, and pinned by
 * layout.test.ts; the deck's own height is padding + one item and the item's
 * padding is solved in navBtnPad(). The field and the rim are a background and
 * inset box-shadows precisely because neither takes part in that arithmetic.
 */
export function hudDeckStyle(_portrait: boolean, _tier: HudTier = 'compact', _rail = false): CSSProperties {
  return {
    position: 'absolute', zIndex: 1000, display: 'flex', gap: 8,
    right: 'calc(8px + env(safe-area-inset-right))',
    bottom: 'calc(8px + env(safe-area-inset-bottom))',
    pointerEvents: 'none',
  };
}

/**
 * A forged strip: the bar's own plate, used for anything that has to read as a
 * piece of the same chrome without being part of the bar — the toast and the
 * first-run nudges today, the overflow panel since the bar shipped.
 *
 * Reusing barPlate is the point. A dedicated toast master would be one more
 * thing to keep in sync with a plate the owner has already accepted, and the
 * strip wants exactly what the bar has: a lit stone crown, a shadowed field,
 * riveted end straps and the gold rim underneath.
 */
export function hudStripStyle(): CSSProperties {
  return { ...hudPlateStyle(true), background: FORGE.well };
}

/**
 * The chrome's stylesheet. Mounted by every component that needs a `:active`
 * rule — `:active` cannot be expressed as an inline style, and the plate a tab
 * wears IS an inline style, which is why the rules below carry `!important`.
 *
 * Rendering it more than once is deliberate and harmless: the three consumers
 * (the overflow control, the nav, the dock) all mount together in the base
 * view, but each one stays independently renderable and independently testable
 * instead of depending on a sibling having been mounted first.
 */
export function HudChromeStyle(): React.JSX.Element {
  return <style>{HUD_CHROME_CSS}</style>;
}

/**
 * ONE DESTINATION in the bottom navigation.
 *
 * The DOM contract is frozen, not incidental:
 *  - the button's textContent is EXACTLY the label. TutorialOverlay anchors its
 *    BUILD and RAID coach-marks by `b.textContent?.trim() === 'BUILD'`, so a
 *    stray screen-reader span or a decorative character here silently breaks
 *    the tutorial with no test failing.
 *  - the label text is the accessible name. These buttons carry no aria-label
 *    and must not gain one, or that same lookup changes meaning.
 *
 * @param sunk the CURRENT destination (screen === this tab's screen). BUILD is
 *   the only one that can be true today — it is the one destination whose
 *   screen keeps the nav mounted — and it is exactly the state the old nav had
 *   no way to show.
 */
export function HudNavButton({
  label, icon, tab = 'nav', rail, wide: _wide, sunk, disabled, onClick,
}: {
  label: string;
  /** Rendered into the tab; must contribute no text. */
  icon: ReactNode;
  tab?: HudTab;
  /** Landscape: the nav is a vertical rail, so the item is smaller. */
  rail?: boolean;
  /** Wide desktop: a compact centred dock with fixed destinations. */
  wide?: boolean;
  sunk?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`interactive hud-tab hud-tab-${tab}`}
      {...(sunk ? { 'data-hud-sunk': '1' } : {})}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...hudTabStyle(tab, sunk),
        // Bar: divide the width. Rail: natural height, so five items fit inside
        // even the ~311px of usable height a phone-landscape window leaves.
        flex: 'none', minWidth: 64, minHeight: 56, pointerEvents: 'auto',
        display: 'flex', alignItems: 'stretch', justifyContent: 'center',
        padding: '4px 8px',
        fontSize: 14, lineHeight: 1,
        // The face is the plate now. Text on stone is the light text; text on
        // the gold plate is the ink, exactly as every gold button in the game.
        color: tab === 'gold' ? FORGE.outline : '#C4BBA4',
        cursor: disabled ? 'default' : 'pointer', letterSpacing: '1px',
        // REFUSED, not merely dim. Opacity alone said "faded" — and it left a
        // disabled RAID unmistakably GOLD, so the tab went on advertising itself
        // as the primary action while turning every tap down. The stylesheet
        // adds grayscale, which is what actually removes that claim; the opacity
        // is raised to 0.7 so the two together land at about the contrast 0.5
        // used to, instead of stacking into an unreadable label.
        opacity: disabled ? 0.7 : 1,
      }}>
      {/* One wrapper so a press can drop the WHOLE face by a pixel. Moving the
          children individually would separate the glyph from its label, and a
          bare text node cannot be moved at all. */}
      <span style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 2, flex: 1, minWidth: 0,
        // Belt and braces with the pinned deck height above: a two-word label
        // ("READ ONLY") must not reflow to two lines and try to grow the tile.
        // Clipping a refused label is strictly better than clipping the dock.
        whiteSpace: 'nowrap',
      }}>
        {icon}{label}
      </span>
    </button>
  );
}

/** Off-screen but announced — for text that must reach a screen reader without
 *  taking a single pixel of a 311px-tall webview. */
export const SR_ONLY: CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

/** How long a value-change acknowledgement lasts. Matches HUD_CHROME_CSS. */
export const HUD_FLASH_MS = 360;

/** Which way a readout just moved. */
export type HudFlash = 'up' | 'down';

/**
 * VALUE-CHANGE ACKNOWLEDGEMENT — the answer to "nothing is alive; values snap
 * between numbers with no acknowledgement".
 *
 * Returns a direction for HUD_FLASH_MS after `value` moves, and null otherwise.
 * Three properties matter more than the effect:
 *
 *  - IT NEVER FIRES ON MOUNT. `value` is null until the server balance loads, and
 *    a null→number transition is recorded silently. Otherwise every cold start
 *    would flash both currencies, which trains the player to ignore the signal
 *    that exists to catch a spend they did not intend.
 *  - IT COSTS NO LAYOUT. The direction lands on a data attribute; the CSS moves
 *    the chip's content by ONE WHOLE PIXEL and tints the well. Nothing reflows,
 *    so the width the solver in hudBarPlan() budgeted still holds mid-animation.
 *  - IT OBEYS BOTH SWITCHES. `reduceMotion` is the game's own REDUCE MOTION
 *    setting (state/store) and suppresses the attribute outright; the CSS is
 *    additionally wrapped in prefers-reduced-motion, so the OS switch alone is
 *    also enough. Either one on ⇒ the number changes instantly.
 *
 * A second change inside the window extends the window rather than restarting
 * the animation. That is deliberate: these are discrete player actions (a
 * collection, a purchase), not a stream, and re-triggering an animation mid-flight
 * is what makes a HUD feel jittery.
 */
export function useHudFlash(value: number | null, reduceMotion = false): HudFlash | null {
  const prev = useRef<number | null>(value);
  const [dir, setDir] = useState<HudFlash | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    // null on either side = "not loaded yet", never a change the player made.
    if (was == null || value == null || was === value) return undefined;
    if (reduceMotion) return undefined;
    setDir(value > was ? 'up' : 'down');
    const t = setTimeout(() => setDir(null), HUD_FLASH_MS);
    return () => clearTimeout(t);
  }, [value, reduceMotion]);
  return reduceMotion ? null : dir;
}

/**
 * HOW LONG AN INCREASE TAKES TO COUNT UP, and in how many whole steps.
 *
 * Eight steps at 40ms is the same 320ms a flash nearly is, spent as a stepped
 * count rather than a continuous ramp: VT323 is a fixed-width face, so a value
 * that eases would still redraw once per frame with nothing to show for most of
 * them. Stepping is also what makes the roll READ as a tally rather than as a
 * blur — the same reason every keyframe in this file is steps().
 */
export const HUD_ROLL_MS = 320;
const HUD_ROLL_STEPS = 8;

/**
 * The OS reduced-motion switch, READ IN JS.
 *
 * Every other animation in this file is CSS and is wrapped in
 * `@media (prefers-reduced-motion: no-preference)`, so the OS switch turns it
 * off for free. The count-up is the exception: it is a real number changing in
 * JavaScript, and no media query can stop it — a player who set the OS switch
 * would still watch their balance tick. So it is asked directly. Guarded because
 * matchMedia does not exist during SSR or in every test environment, and the
 * safe answer there is "motion is fine" (the game's own switch still applies).
 */
function osPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * COUNT-UP — "a resource that increases ticks up".
 *
 * Returns the number the chip should DRAW: normally the real value, and during
 * an increase a stepped tally climbing towards it. Four properties are the
 * whole feature:
 *
 *  - IT NEVER ROLLS ON MOUNT. Same null-guard as useHudFlash: the balance
 *    arriving from the server is not something the player earned, and a cold
 *    start that counts 0 → 7,038,871 is a slot machine, not an acknowledgement.
 *  - IT ONLY ROLLS UPWARD. This is a LAYOUT guarantee, not a taste one.
 *    hudBarPlan() budgets each chip from the string it is about to draw; every
 *    intermediate of an increase is ≤ the target, so a rolling chip always fits
 *    the width solved for its final value. A count DOWN would pass through
 *    strings LONGER than the budget and clip the currency mid-number — the exact
 *    defect the solver exists to prevent. A spend still flashes cold, which is
 *    the acknowledgement that matters there.
 *  - THE LAST FRAME IS ALWAYS THE REAL VALUE. The final step assigns `value`
 *    itself rather than the last interpolated integer, and the cleanup does too,
 *    so an interrupted roll cannot strand a wrong balance on screen.
 *  - IT OBEYS BOTH SWITCHES, and it is the one animation here that has to ASK
 *    about the second. `reduceMotion` is the game's own setting; the OS one
 *    normally arrives through the `prefers-reduced-motion` guard in
 *    HUD_CHROME_CSS, which cannot reach a number being changed in JavaScript.
 *    So this reads the media query itself — see osPrefersReducedMotion. Either
 *    switch on ⇒ the number simply changes.
 */
export function useHudRoll(value: number | null, reduceMotion = false): number | null {
  const prev = useRef<number | null>(value);
  const [shown, setShown] = useState<number | null>(value);
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    if (was == null || value == null || value <= was || reduceMotion || osPrefersReducedMotion()) {
      setShown(value);
      return undefined;
    }
    const span = value - was;
    let step = 0;
    setShown(was);
    const t = setInterval(() => {
      step += 1;
      if (step >= HUD_ROLL_STEPS) {
        clearInterval(t);
        setShown(value);
        return;
      }
      setShown(was + Math.round((span * step) / HUD_ROLL_STEPS));
    }, HUD_ROLL_MS / HUD_ROLL_STEPS);
    return () => { clearInterval(t); setShown(value); };
  }, [value, reduceMotion]);
  return shown;
}

/**
 * The chip's CONTENT, as one movable object.
 *
 * Every acknowledgement this chip can make — the press dip, the flash rise, the
 * flash drop — moves the readout by a whole pixel. Moving the children
 * individually would separate the glyph from its number (the nav tab carries the
 * same wrapper for the same reason) and a bare text child cannot be moved at
 * all, which is what made the flash animation reach only the elements.
 *
 * It is styled INLINE and merely CLASSED for CSS to find, because HudChip is
 * rendered in places that do not mount HUD_CHROME_CSS. A layout that lived in
 * the stylesheet would collapse the moment a chip rendered without it.
 *
 * The measured width is unchanged: HUD_CHIP.base (43) is border 6 + padding 12 +
 * icon 20 + gap 5, and this wrapper adds no padding, no margin and no border —
 * it only takes over the gap and the alignment the chip itself used to do.
 */
function HudChipFace({ children, overflowVisible = false }: {
  children: ReactNode;
  overflowVisible?: boolean;
}): React.JSX.Element {
  return (
    <span
      className="hud-face"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'inherit',
        gap: 5, flex: '1 1 auto', minWidth: 0,
        overflow: overflowVisible ? 'visible' : 'hidden', flexWrap: 'wrap',
      }}>
      {children}
    </span>
  );
}

/**
 * A chip in the bar or in the overflow panel.
 *
 * A clickable chip is a button to the keyboard and to assistive tech, the same
 * contract Pill has carried since the 2026-08-21 review found the TESTER pill
 * mouse-only. Since 2026-08-29 it also ANSWERS one: a clickable chip has a press
 * that moves geometry, a hover, and a focus ring — see HUD_CHROME_CSS. A chip
 * with no onClick is a readout and deliberately gets none of the three, so
 * "looks pressable" keeps meaning "is pressable".
 */
export function HudChip({
  children, onClick, ariaLabel, tutorialTarget, expanded, accent, style, grow, plate, flash, hot, reduceMotion,
}: {
  children: ReactNode;
  expanded?: boolean;
  onClick?: (() => void) | undefined;
  ariaLabel?: string | undefined;
  tutorialTarget?: string | undefined;
  /** Hot-state rim, e.g. a suppressed shield or a claimable cache. */
  accent?: string | undefined;
  style?: CSSProperties | undefined;
  grow?: boolean;
  /** 'keep' cuts the chip from the gold plate. Defaults to the plain stone one,
   *  so every panel row and every other readout stays ordinary and only the
   *  currency a player can spend by accident is precious. */
  plate?: HudPlate | undefined;
  /** Direction of the last value change — from useHudFlash(). Presentation
   *  only; the chip is otherwise pure and static-renderable. */
  flash?: HudFlash | null | undefined;
  /** WAITING FOR THE PLAYER — a claimable cache, mail holding escrowed rewards,
   *  a deed still to be chosen. It breathes on a slow cycle so it is found by
   *  peripheral vision without nagging, and `accent` stays the STATIC statement
   *  of the same fact so the state survives REDUCE MOTION and a still frame. */
  hot?: boolean | undefined;
  /** The game's own REDUCE MOTION setting. Stills the breathing without
   *  dropping the hot state itself. */
  reduceMotion?: boolean | undefined;
}): React.JSX.Element {
  return (
    <span
      className="interactive hud-chip"
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(expanded !== undefined ? { 'aria-expanded': expanded, 'aria-haspopup': 'dialog' as const } : {})}
      {...(tutorialTarget ? { 'data-tutorial-target': tutorialTarget } : {})}
      {...(flash ? { 'data-hud-flash': flash } : {})}
      {...(hot ? { 'data-hud-hot': '1' } : {})}
      {...(hot && reduceMotion ? { 'data-hud-still': '1' } : {})}
      {...(onClick ? {
        role: 'button', tabIndex: 0, onClick,
        onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
        },
      } : {})}
      style={{
        ...hudChipStyle(plate),
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        // Chips STRETCH to the row height, so every clickable one clears the
        // 44px tap floor without the row growing to accommodate padding.
        padding: '0 6px', fontSize: 18, lineHeight: 1, whiteSpace: 'nowrap',
        // minWidth:0 + overflow:hidden is what lets an implausible number clip
        // instead of pushing the overflow control off the end of the row.
        minWidth: onClick ? 48 : 0, minHeight: 48, overflow: 'visible', pointerEvents: 'auto',
        // The containing block for the flash overlay. `inset:0` on an absolutely
        // positioned ::after resolves against the PADDING box, so the wash stops
        // at the bezel — a flashing KEEP chip keeps its gold rim.
        position: 'relative',
        flex: grow ? '1 1 auto' : '0 0 auto',
        cursor: onClick ? 'pointer' : 'default',
        ...(accent ? { outline: `2px solid ${accent}`, outlineOffset: -2 } : {}),
        ...style,
      }}>
      <HudChipFace overflowVisible={style?.overflow === 'visible'}>{children}</HudChipFace>
    </span>
  );
}

/**
 * THE OVERFLOW CONTROL — one 44px square that opens everything the bar no
 * longer carries, and the single place a moved-but-time-sensitive action can
 * still announce itself.
 *
 * It is a RAISED PLATE, and the open state is the same plate driven into its
 * socket: the face and the crest drop 2px, the lit bevel and the cast shadow
 * swap sides, and the two rows of standing thickness are spent. Cover the colour
 * and the geometry alone still says it moved — which is what the first pass, a
 * hue swap on a flat square, did not.
 *
 * The badge is RED, not gold: the glyph is already gold and gold-on-gold does
 * not read as "attention". It is a tag, not a count, because the rule it
 * encodes (hudOverflowAlert) is boolean. It carries the only idle motion in the
 * chrome and honours both motion switches — the gem still reads when it stops.
 */
export function HudOverflowButton({ open, alert, flushTop, reduceMotion, onToggle }: {
  open: boolean;
  alert: boolean;
  /**
   * True when the bar's content row is flush against the viewport's top edge —
   * i.e. landscape, where the plate drops its top chamfer to save 6px.
   *
   * The badge normally overhangs the button by 3px so it reads as a bead pinned
   * ON the control rather than drawn inside it. With no border above the row
   * that overhang lands OFF-SCREEN and the top fifth of the badge is clipped by
   * the viewport — on the one control that must never be missed, in the one
   * orientation where the Seeker is hardest to lay out. So the overhang is
   * horizontal-only there: the 3px still has somewhere to go (the plate's inner
   * padding) but the bead stays whole.
   */
  flushTop?: boolean;
  /** The game's own REDUCE MOTION setting. The CSS already honours the OS
   *  switch; this honours the in-game one without dropping the .hud-badge class
   *  the badge rule is asserted through. */
  reduceMotion?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <>
      <HudChromeStyle />
      <button
        type="button"
        className="interactive hud-overflow"
        aria-label="More"
        aria-haspopup="dialog"
        aria-expanded={open}
        {...(alert ? { 'data-hud-alert': '1' } : {})}
        onClick={onToggle}
        style={{
          flex: '0 0 auto', width: CHROME.tapRow, height: CHROME.tapRow,
          alignSelf: 'center', border: 0, padding: 0, position: 'relative',
          background: `transparent url(${open ? overflowPress : overflowIdle}) center / ${CHROME.tapRow}px ${CHROME.tapRow}px no-repeat`,
          imageRendering: 'pixelated', cursor: 'pointer',
        }}>
        {alert && (
          <>
            <span
              className="hud-badge"
              aria-hidden="true"
              {...(reduceMotion ? { 'data-hud-still': '1' } : {})}
              style={{
                position: 'absolute', top: flushTop ? 0 : -3, right: -3, width: 16, height: 16,
                background: `url(${badgeAlert}) center / 16px 16px no-repeat`,
                imageRendering: 'pixelated', pointerEvents: 'none',
              }} />
            {/* The badge is a colour cue; this is the same fact for a screen
                reader, and it is what a test greps for. */}
            <span style={SR_ONLY}>ACTION NEEDED</span>
          </>
        )}
      </button>
    </>
  );
}

// ===========================================================================
// RESPONSIVE HUD SURFACES — player menu, builder queue and task rail
// ===========================================================================

/** The former anonymous overflow square now identifies the player/base. It
 * opens the same complete menu, so no destination is lost while the four
 * frequent tasks move to their labelled rail.
 *
 * `player-menu` is the first-run deck's anchor while the menu is CLOSED: FIT
 * BASE and QUESTS both live inside the panel now, so the card that asks for
 * either rings this opener first and the panel row once it is open
 * (tutorial/TutorialOverlay.tsx). The hook is dropped while open so the ring
 * moves onto the row rather than staying on a button that is already pressed. */
export function HudPlayerMenuButton({ art, level, open, alert, hot, reduceMotion, onToggle }: {
  art: ReactNode;
  level: number;
  open: boolean;
  alert: boolean;
  hot?: boolean;
  reduceMotion?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <HudChip
      ariaLabel={`Player menu — Keep level ${level}`} expanded={open} tutorialTarget={open ? undefined : 'player-menu'}
      onClick={onToggle}
      hot={hot}
      reduceMotion={reduceMotion}
      style={{
        width: CHROME.tapRow, height: CHROME.tapRow, flex: '0 0 auto', padding: 0,
        overflow: 'visible', ...(open ? { outline: `2px solid ${FORGE.goldM}`, outlineOffset: -2 } : {}),
      }}>
      <span aria-hidden="true" style={{ width: 25, height: 25, display: 'grid', placeItems: 'center' }}>
        {art}
      </span>
      <span aria-hidden="true" style={{
        position: 'absolute', right: 2, bottom: 1, minWidth: 15, height: 15,
        padding: '0 2px', fontSize: 13, lineHeight: '15px', textAlign: 'center',
        color: FORGE.goldL, background: FORGE.outline,
      }}>{level}</span>
      {alert && (
        <>
          <span className="hud-badge" aria-hidden="true"
            {...(reduceMotion ? { 'data-hud-still': '1' } : {})}
            style={{
              position: 'absolute', top: -3, right: -3, width: 16, height: 16,
              background: `url(${badgeAlert}) center / 16px 16px no-repeat`,
              imageRendering: 'pixelated', pointerEvents: 'none',
            }} />
          <span style={SR_ONLY}>ACTION NEEDED</span>
        </>
      )}
    </HudChip>
  );
}

export function hudQueueBandStyle(
  portrait: boolean,
  tier: HudTier,
  rail: boolean,
): CSSProperties {
  const common: CSSProperties = {
    position: 'absolute', zIndex: 1000, display: 'flex', alignItems: 'stretch',
    gap: CHROME.hudGap, pointerEvents: 'auto',
  };
  if (rail) {
    return {
      ...common,
      top: CHROME.clusterPad + hudHeight(true) + CHROME.hudGap,
      left: CHROME.clusterPad,
      width: `min(280px, calc(100% - ${CHROME.rail + CHROME.clusterPad * 2}px - env(safe-area-inset-right)))`,
    };
  }
  if (tier === 'compact') {
    return {
      ...common,
      top: `calc(${hudHeight(portrait)}px + env(safe-area-inset-top, 0px))`,
      left: 0, right: 0,
      paddingLeft: `calc(${CHROME.hudPad}px + env(safe-area-inset-left))`,
      paddingRight: `calc(${CHROME.hudPad}px + env(safe-area-inset-right))`,
    };
  }
  return {
    ...common,
    top: CHROME.clusterPad + hudHeight(true) + CHROME.hudGap,
    left: CHROME.clusterPad,
    width: 'max-content', maxWidth: `calc(100% - ${CHROME.clusterPad * 2}px)`,
    filter: 'drop-shadow(0 3px 0 rgba(11,10,14,.55))',
  };
}

export function HudQueueBand({ portrait, tier, rail, rootRef, children }: {
  portrait: boolean;
  tier: HudTier;
  rail: boolean;
  rootRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div ref={rootRef} className="interactive" style={hudQueueBandStyle(portrait, tier, rail)}>
      <HudChromeStyle />
      {children}
    </div>
  );
}

function HudQueueRail({ pct, verifying }: { pct: number; verifying: boolean }): React.JSX.Element {
  return (
    <span aria-hidden="true" style={{
      width: 76, height: 5, display: 'block', background: FORGE.outline,
      boxShadow: `inset 0 0 0 1px ${FORGE.well}`,
    }}>
      <span style={{
        display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, Math.round(pct)))}%`,
        background: verifying ? FORGE.goldL : FORGE.goldM,
      }} />
    </span>
  );
}

/** A server job. `verifying` means its deadline elapsed and a base refresh is
 * reconciling it; it deliberately never claims a collectible READY state. */
export function HudQueueCard({ art, title, detail, pct, time, verifying, onboardingJob, hot, reduceMotion, onClick }: {
  art: ReactNode;
  title: string;
  detail: string;
  pct: number;
  time: string;
  verifying: boolean;
  onboardingJob?: string | undefined;
  hot?: boolean;
  reduceMotion?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" role="button"
      className="interactive hud-chip hud-queue-card"
      aria-label={`${title} — ${verifying ? 'finishing and verifying' : `${time} remaining`}`}
      {...(onboardingJob ? { 'data-onboarding-job': onboardingJob } : {})}
      {...(hot ? { 'data-hud-hot': '1' } : {})}
      {...(hot && reduceMotion ? { 'data-hud-still': '1' } : {})}
      onClick={onClick}
      style={{
        ...hudChipStyle('shard'), width: HUD_QUEUE.card, height: CHROME.queueRow,
        flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 7px 0 4px', color: SHEET_INK.text, fontFamily: 'inherit',
        cursor: 'pointer', position: 'relative', textAlign: 'left',
      }}>
      <span className="hud-face" style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0,
      }}>
        <span aria-hidden="true" style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', flex: 'none' }}>{art}</span>
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{
            fontSize: 14, color: SHEET_INK.dim, lineHeight: 1, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title} <span style={{ color: FORGE.goldL }}>{detail}</span></span>
          <HudQueueRail pct={pct} verifying={verifying} />
        </span>
        <span style={{
          flex: 'none', fontSize: verifying ? 13 : 16, color: verifying ? FORGE.goldL : SHEET_INK.text,
          whiteSpace: 'nowrap', letterSpacing: '.5px',
        }}>{verifying ? 'VERIFYING' : time}</span>
      </span>
    </button>
  );
}

export function HudQueueSummary({ children, onboardingJobs, onClick }: {
  children: ReactNode;
  onboardingJobs?: string | undefined;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" role="button" className="interactive hud-chip"
      aria-label="Builder queue" onClick={onClick}
      {...(onboardingJobs ? { 'data-onboarding-job': onboardingJobs } : {})}
      style={{
        ...hudChipStyle('shard'), width: 'max-content', maxWidth: '100%', minHeight: CHROME.queueRow, pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px',
        fontFamily: 'inherit', fontSize: 16, color: SHEET_INK.dim,
        whiteSpace: 'normal', cursor: 'pointer', position: 'relative',
      }}>
      <span className="hud-face" style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}>{children}</span>
    </button>
  );
}

export function HudQueueIdle({ hot, reduceMotion, onClick }: {
  hot?: boolean;
  reduceMotion?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" role="button" className="interactive hud-chip"
      aria-label="Idle builder — start a build"
      {...(hot ? { 'data-hud-hot': '1' } : {})}
      {...(hot && reduceMotion ? { 'data-hud-still': '1' } : {})}
      onClick={onClick}
      style={{
        ...hudChipStyle('shard'), width: HUD_QUEUE.socket, height: CHROME.queueRow,
        flex: 'none', display: 'grid', placeItems: 'center', padding: 0,
        color: FORGE.goldL, fontFamily: 'inherit', fontSize: 15, cursor: 'pointer', position: 'relative',
      }}>
      <span className="hud-face">+ BUILD</span>
    </button>
  );
}

export function HudQueueMore({ count }: { count: number }): React.JSX.Element {
  return (
    <span style={{
      width: HUD_QUEUE.more, height: CHROME.queueRow, display: 'grid', placeItems: 'center',
      color: SHEET_INK.faint, fontSize: 16,
    }}>+{count}</span>
  );
}

export function hudTaskRailStyle(tier: HudTier, rail: boolean): CSSProperties {
  if (rail) {
    return {
      position: 'absolute', zIndex: 1000, display: 'flex', gap: CHROME.hudGap,
      right: `calc(${CHROME.rail + 10}px + env(safe-area-inset-right))`,
      bottom: `calc(10px + env(safe-area-inset-bottom))`, pointerEvents: 'auto',
    };
  }
  // One formula with the chat launcher solver (layout.taskRailTop): the
  // launcher decides whether to clear this column from the same number.
  const top = taskRailTop(tier);
  return {
    position: 'absolute', zIndex: 1000, display: 'flex', flexDirection: 'column',
    gap: CHROME.hudGap, top: `calc(${top}px + env(safe-area-inset-top, 0px))`,
    right: `calc(${CHROME.clusterPad}px + env(safe-area-inset-right))`, pointerEvents: 'auto',
  };
}

export function HudTaskRail({ tier, rail, children }: {
  tier: HudTier;
  rail: boolean;
  children: ReactNode;
}): React.JSX.Element {
  return <div className="interactive" style={hudTaskRailStyle(tier, rail)}><HudChromeStyle />{children}</div>;
}

export function HudTaskButton({ ariaLabel, tutorialTarget, label, icon, count, settled, hot, reduceMotion, onClick }: {
  ariaLabel: string;
  tutorialTarget?: string;
  label: string;
  icon: ReactNode;
  count?: string;
  settled?: boolean;
  hot?: boolean;
  reduceMotion?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <HudChip ariaLabel={`${ariaLabel}${count ? ` — ${count}` : ''}`} tutorialTarget={tutorialTarget}
      onClick={onClick} hot={hot} reduceMotion={reduceMotion}
      style={{ width: CHROME.tapRow, height: CHROME.tapRow, flex: '0 0 auto', padding: 0, overflow: 'visible' }}>
      {icon}
      {count ? (
        <span aria-hidden="true" style={{
          position: 'absolute', top: -4, right: -3, minWidth: 17, height: 17,
          padding: '0 3px', fontSize: 13, lineHeight: '17px', textAlign: 'center',
          color: settled ? FORGE.goldL : SHEET_INK.text,
          background: settled ? FORGE.goldS : '#8F2C2C',
          boxShadow: `0 0 0 1px ${FORGE.outline}`,
        }}>{count}</span>
      ) : null}
      <span aria-hidden="true" style={{
        position: 'absolute', left: 0, right: 0, bottom: -1, textAlign: 'center',
        color: SHEET_INK.faint, fontSize: 9, letterSpacing: '.5px',
        textShadow: `1px 1px 0 ${FORGE.outline}`,
      }}>{label}</span>
    </HudChip>
  );
}

// ===========================================================================
// THE BUILDING SHEET — the surface a player touches more than any other
// ===========================================================================

/**
 * WHY THE SHEET'S CHROME LIVES HERE. It is the flattest thing on screen and the
 * one the player opens most: a dark slab with a text header, two grey stat
 * pills, a line of prose and a gold button. Everything it needs — a recessed
 * seat, a forged plate, a gold ramp, a press — already exists in this file, and
 * a second copy of any of it in sheets.tsx is how the sheet drifted away from
 * the bar in the first place. sheets.tsx keeps the DECISIONS (which building,
 * which stats, which action); this file supplies the MATERIAL.
 *
 * Text colours are literals for the same reason FORGE is: these sit on forged
 * metal, not on the App's card surfaces, and reaching for COLORS here is how a
 * chrome edge quietly becomes a web-UI grey.
 */
const SHEET_INK = { text: '#EFE8D6', dim: '#C4BBA4', faint: '#9C937F' } as const;

/**
 * A building's own progression, as a thing you can see rather than a word.
 *
 * The header used to say "MINE · LEVEL 4" and stop, which tells a player their
 * level but nothing about where it sits — L4 of a 5-level mine and L4 of a
 * 20-level keep looked identical. The rail is hard-edged and 6px tall (the same
 * BarMini height the shard chip carries), so it reads as the same instrument.
 */
export function HudLevelRail({ level, max, unit = 'LEVEL' }: {
  level: number;
  max: number;
  /** Walls level by TIER; every other structure by LEVEL. The caller owns the
   *  word because it owns the distinction. */
  unit?: string;
}): React.JSX.Element {
  const pct = max > 1 ? Math.max(0, Math.min(100, Math.round(((level - 1) / (max - 1)) * 100))) : 100;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      <span style={{ fontSize: 15, color: SHEET_INK.dim, letterSpacing: '1px', whiteSpace: 'nowrap' }}>
        {unit} <span style={{ color: FORGE.goldL, fontSize: 18 }}>{level}</span>
        <span style={{ color: SHEET_INK.faint }}>/{max}</span>
      </span>
      <span style={{
        flex: '1 1 auto', minWidth: 24, height: 6, display: 'block',
        background: FORGE.outline, boxShadow: `inset 0 0 0 1px ${FORGE.well}`,
      }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: FORGE.goldM }} />
      </span>
    </span>
  );
}

/**
 * The sheet's identity block: the building's OWN portrait, its name, its level.
 *
 * The portrait arrives as a node rather than a sprite name so this file keeps
 * its single dependency (layout.ts) — primitives.tsx already imports
 * hudStripStyle from here, and importing Sprite back would close that cycle.
 *
 * The seat is the chip well, not a bordered box: a portrait is something you
 * LOOK at, which is exactly what the recessed plate means everywhere else in
 * this kit.
 */
export function HudSheetHead({ art, title, level, max, unit }: {
  art: ReactNode;
  title: string;
  level: number;
  max: number;
  unit?: string;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8 }}>
      <span aria-hidden="true" style={{
        ...hudChipStyle('shard'),
        flex: 'none', width: 64, height: 64, display: 'grid', placeItems: 'center',
      }}>
        {art}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{
          fontSize: 24, letterSpacing: '2px', color: FORGE.goldL, lineHeight: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </span>
        <HudLevelRail level={level} max={max} {...(unit ? { unit } : {})} />
      </span>
    </div>
  );
}

/**
 * ONE STAT, BEFORE AND AFTER.
 *
 * The sheet used to render each stat as a bordered pill containing
 * "HP 1250 →1562", so the two numbers that a player is deciding between were the
 * same size, the same weight and inside the same grey box — the comparison the
 * whole sheet exists to support was the least legible thing on it. Here the
 * label is a fixed column so the values line up down the block, the current
 * value is ordinary text, and the one being bought for shards is the only gold
 * thing in the row.
 *
 * `next` absent means "this stat does not move" (RNG) or "already at max", and
 * the row deliberately shows no arrow rather than an arrow pointing at itself.
 */
export function HudStatDelta({ label, cur, next }: {
  label: string;
  cur: string;
  next?: string | undefined;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, minWidth: 0 }}>
      <span style={{ flex: 'none', width: 56, fontSize: 14, color: SHEET_INK.faint, letterSpacing: '1px' }}>
        {label}
      </span>
      <span style={{ fontSize: 18, color: SHEET_INK.text, whiteSpace: 'nowrap' }}>{cur}</span>
      {next !== undefined && next !== cur && (
        <>
          <span style={{ fontSize: 16, color: FORGE.goldS }}>▸</span>
          <span style={{ fontSize: 18, color: FORGE.goldL, whiteSpace: 'nowrap' }}>{next}</span>
        </>
      )}
    </div>
  );
}

/** The recessed block the stat rows sit in, captioned with what the right-hand
 *  column actually IS. Without the caption a gold number beside a white one is
 *  just a brighter number; with it the block is a quote for a purchase. */
export function HudStatBlock({ caption, children }: {
  caption?: string | undefined;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div style={{ ...hudChipStyle('shard'), padding: '6px 8px', marginBottom: 8 }}>
      {caption && (
        <div style={{
          fontSize: 13, letterSpacing: '1px', color: SHEET_INK.faint,
          paddingLeft: 64, paddingBottom: 2,
        }}>
          {caption}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * THE PRIMARY ACTION, and the reason it is a tab plate rather than a bigger
 * button: RAID is the primary action of the whole game and it is a forged gold
 * plate, so the primary action of a sheet has to be recognisably the same
 * object. It inherits the gold press from HUD_CHROME_CSS for free — the class
 * is the nav's, deliberately, not a copy of its rules.
 *
 * It is full-width and CHROME.tapRow tall, so it is the largest single thing in
 * the sheet as well as the only gold one; a secondary action beside it stays an
 * ordinary Btn and cannot be mistaken for this.
 */
export function HudPrimaryButton({ children, disabled, onClick }: {
  children: ReactNode;
  disabled?: boolean | undefined;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <>
      <HudChromeStyle />
      <button
        type="button"
        className="interactive hud-tab hud-tab-gold"
        disabled={disabled}
        onClick={onClick}
        style={{
          ...hudTabStyle('gold'),
          width: '100%', minHeight: CHROME.tapRow, padding: '0 10px',
          display: 'flex', alignItems: 'stretch', justifyContent: 'center',
          fontFamily: 'inherit', fontSize: 19, letterSpacing: '1px',
          color: FORGE.outline, cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.7 : 1, marginBottom: 6,
        }}>
        {/* One wrapper so the press drops the WHOLE face — same contract as the
            nav tab, and the reason `.hud-tab:active>*` can be one rule. */}
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, flex: 1, minWidth: 0, flexWrap: 'wrap', padding: '8px 0', overflowWrap: 'normal',
        }}>
          {children}
        </span>
      </button>
    </>
  );
}

/**
 * The chrome's whole stylesheet — see HudChromeStyle above for who mounts it.
 * The overflow control is one of them because it is the one element of the bar
 * the width solver is forbidden to drop (HUD_CHIP.overflow is part of
 * hudBarPlan's floor), so wherever a flashing chip is mounted, these rules are
 * mounted with it.
 *
 * `!important` on every pressed plate is load-bearing: the idle plate is an
 * inline style, and an inline declaration outranks a stylesheet rule without it.
 *
 * `:not(:disabled)` is not tidiness. BUILD and RAID are disabled while base
 * actions are locked (a live raid, the multi-base read cutover); a disabled
 * control that still sinks under a finger is a control claiming to have done
 * something it refused to do.
 *
 * THE ONE-PIXEL FACE DIP is outside the reduced-motion block on purpose. It is
 * not an animation the interface plays at you — it is the direct consequence of
 * your finger being on the plate, it lasts exactly as long as the touch, and
 * without it the frame goes into its socket while the label stays floating
 * above the hole.
 *
 * Every keyframe is `steps(...)`, and every transform is an integer pixel. A
 * smooth interpolation would put the sprites on fractional coordinates for most
 * of the animation, which is the one thing this art may not do.
 *
 * THE FLASH IS A RIM, NOT A WASH. A flat tint over the whole seat was tried
 * first and it flattens the recess and dulls the numerals for a third of a
 * second — the value is hardest to read exactly when the player is looking at it
 * because it moved. So the colour lands as a hard 1px inset rim at full strength
 * with only a faint tint behind it: the frame catches light, the number does not
 * change legibility, and the recess survives.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE 2026-08-29 INTERACTION PASS. The owner's third verdict on this HUD was
 * that it "looks like shit … rework UI HUD again to be game like interactive".
 * The layout was already where they had asked for it and the plates were
 * already forged, so the remaining defect was not another bevel: NOTHING
 * ANSWERED A FINGER except the three tab plates. Specifically —
 *
 *  - a chip was pressable (role=button since the bar shipped) and said nothing
 *    at all when pressed, so SHARDS, KEEP, SOL and all twelve panel rows took a
 *    tap in silence and only the screen change afterwards proved it landed;
 *  - the whole HUD had NO hover and NO focus ring anywhere, so on a desktop
 *    nothing lit under the pointer and a keyboard user could not see where they
 *    were — on controls that are deliberately reachable by keyboard;
 *  - `disabled` was carried by opacity alone, which reads as "dim", not as
 *    "refused" — and a disabled RAID stayed unmistakably GOLD, i.e. it went on
 *    claiming to be the primary action while refusing every tap;
 *  - `data-hud-alert` was written onto the overflow control and NO RULE EVER
 *    READ IT: the one control that must catch the eye had a dead attribute.
 *
 * Four rules answer those, and each keeps this file's existing discipline:
 *
 *  1. PRESS MOVES GEOMETRY. A pressed chip's seat gains a hard shadow along its
 *     top edge and its face drops one whole pixel — the readout going further
 *     INTO its recess, which is the chip's own idiom, where a tab's is a raised
 *     plate going down into its socket.
 *  2. RELEASE IS THE ONLY THING THAT EASES. Press is instant (it is your finger,
 *     not an animation); the return is a two-step transition, so the face is
 *     seen coming back instead of teleporting. Two steps, not a curve: an
 *     interpolated transform puts pixel art on fractional coordinates.
 *  3. HOVER IS BEHIND `hover:hover`. A hover style applied on a touchscreen
 *     STICKS to the last thing tapped, which would leave a permanently lit chip
 *     on the platform this HUD is mostly used on.
 *  4. HOT BREATHES, IT DOES NOT BLINK. Something waiting for the player cycles
 *     its rim through the gold ramp and is never absent for long — a signal that
 *     switches off is missed at exactly the wrong moment, and `accent` remains
 *     the static statement of the same fact for a still frame or REDUCE MOTION.
 *
 * WHERE THE OVERFLOW CONTROL'S ALERT LANDS, and why it is not on the button.
 * The breathing rim was tried on the plate itself first — `data-hud-alert` is on
 * the button, so it was the obvious target — and rendering it proved it wrong:
 * an inset ring paints over the plate's own chamfer, and a control the previous
 * lane forged as a raised iron object went back to reading as an outlined
 * rectangle, i.e. the "generic square" complaint, restored by the fix for a
 * different one. So the alert lives on the BEAD, which is already the thing that
 * means "action needed"; the attribute keeps a real job as the STATIC ring that
 * says the same thing when nothing may move.
 *
 * EVERY RING IN HERE IS DRAWN ON A PSEUDO-ELEMENT, and that is not a style
 * preference — it is the only thing that works. A `border-image` with `fill`
 * paints the middle slice over the whole PADDING BOX, and the border paints
 * ABOVE the element's own inset box-shadows, so a ring written straight onto a
 * chip or a tab is computed, reported by getComputedStyle, and then covered by
 * the plate. It was written that way first and rendering caught it: the ring was
 * live in the DOM and invisible in the photograph, on every 9-sliced surface in
 * the kit. `::after` has always carried the value flash for exactly this reason;
 * `::before` now carries press, hover, focus and hot, so the two never collide.
 *
 * The ring is a box-shadow on that pseudo-element rather than an `outline`
 * because `outline` is already spoken for: it is how `accent` draws the static
 * hot rim, and two outlines on one element cannot both be seen.
 *
 * IT IS TWO-TONE AND `!important`, and both halves were found by rendering it.
 * A plain gold ring DISAPPEARED on the KEEP chip — that plate is forged from the
 * gold ramp, so a gold line just inside its gold bezel is invisible on the one
 * readout whose whole point is that it does not look like the others. The dark
 * row underneath gives the ring an edge on every plate in the kit. And a CSS
 * animation outranks an ordinary declaration, so on a chip that was BREATHING
 * (a claimable cache, a full mine buffer) the hot rim simply ate the focus ring:
 * a keyboard user lost their place on exactly the controls most worth reaching.
 */
const HUD_CHROME_CSS = `
.hud-overflow:active{background-image:url(${overflowPress}) !important}
.hud-tab-nav:active:not(:disabled){border-image-source:url(${tabSunk}) !important}
.hud-tab-gold:active:not(:disabled){border-image-source:url(${tabGoldSunk}) !important}
.hud-tab-dock:active:not(:disabled){border-image-source:url(${dockSunk}) !important}
.hud-tab:active:not(:disabled)>*,.hud-tab[data-hud-sunk]>*{transform:translateY(1px)}
.hud-tab:disabled{filter:grayscale(1) brightness(.78)}
.hud-chip[role=button]:active::before,.hud-chip[data-hud-hot]::before,.hud-tab[data-hud-hot]::before,.hud-chip[role=button]:focus-visible::before,.hud-tab:focus-visible::before,.hud-overflow:focus-visible::before{content:'';position:absolute;inset:0;pointer-events:none}
@media (hover:hover){
.hud-tab:hover:not(:disabled),.hud-overflow:hover{filter:brightness(1.16)}
.hud-chip[role=button]:hover::before{content:'';position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 1px ${FORGE.goldM}}
}
.hud-chip[role=button]:active::before{box-shadow:inset 0 2px 0 0 rgba(26,23,30,.8),inset 0 -1px 0 0 ${FORGE.goldS}}
.hud-chip[role=button]:active>.hud-face{transform:translateY(1px)}
.hud-chip[role=button]:focus-visible,.hud-tab:focus-visible,.hud-overflow:focus-visible{outline:none}
.hud-chip[role=button]:focus-visible::before,.hud-tab:focus-visible::before,.hud-overflow:focus-visible::before{box-shadow:inset 0 0 0 1px ${FORGE.outline},inset 0 0 0 3px ${FOCUS_INK} !important}
.hud-overflow[data-hud-alert] .hud-badge{box-shadow:0 0 0 1px ${FORGE.goldS}}
@media (prefers-reduced-motion: no-preference){
.hud-tab>*,.hud-chip>.hud-face{transition:transform 90ms steps(2,end)}
.hud-tab:active>*,.hud-chip[role=button]:active>.hud-face{transition:none}
.hud-chip[data-hud-hot]:not([data-hud-still])::before,.hud-tab[data-hud-hot]:not([data-hud-still])::before{animation:hud-hot 2.4s steps(1,end) infinite}
@keyframes hud-hot{0%,75%{box-shadow:inset 0 0 0 1px ${FORGE.goldS}}25%{box-shadow:inset 0 0 0 1px ${FORGE.goldL}}50%{box-shadow:inset 0 0 0 1px ${FORGE.goldM}}}
.hud-badge:not([data-hud-still]){animation:hud-badge-bob 1.8s steps(1,end) infinite,hud-badge-halo 2.4s steps(1,end) infinite}
@keyframes hud-badge-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(1px)}}
@keyframes hud-badge-halo{0%,75%{box-shadow:0 0 0 1px ${FORGE.goldS}}25%{box-shadow:0 0 0 2px ${FORGE.goldL}}50%{box-shadow:0 0 0 1px ${FORGE.goldM}}}
.hud-chip[data-hud-flash]::after{content:'';position:absolute;inset:0;pointer-events:none;animation:hud-chip-flash ${HUD_FLASH_MS}ms steps(1,end) forwards}
.hud-chip[data-hud-flash="up"]::after{background:rgba(244,215,123,.22);box-shadow:inset 0 0 0 1px #F4D77B}
.hud-chip[data-hud-flash="down"]::after{background:rgba(187,208,214,.22);box-shadow:inset 0 0 0 1px #BBD0D6}
@keyframes hud-chip-flash{0%{opacity:1}34%{opacity:.55}67%{opacity:.25}100%{opacity:0}}
.hud-chip[data-hud-flash="up"]>*{animation:hud-chip-rise ${HUD_FLASH_MS}ms steps(1,end)}
.hud-chip[data-hud-flash="down"]>*{animation:hud-chip-drop ${HUD_FLASH_MS}ms steps(1,end)}
@keyframes hud-chip-rise{0%{transform:translateY(1px)}50%,100%{transform:translateY(0)}}
@keyframes hud-chip-drop{0%{transform:translateY(-1px)}50%,100%{transform:translateY(0)}}}`;
