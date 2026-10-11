/**
 * Viewport orientation + base-view chrome metrics — ONE source of truth for both
 * the React overlay and the Phaser layer. Orientation is purely derived (App S.o,
 * L1699: innerWidth > innerHeight*1.1 ? 'land' : 'port'), so nothing has to be
 * stored or synced; two derivations, though, WOULD drift mid-rotation and leave
 * half the UI in the other orientation.
 *
 * Landscape became first-class on 2026-08-02. The base is a SQUARE 30×30 grid, so
 * rotating the phone flips which axis is scarce: at 915×412 the portrait chrome
 * (three stacked HUD rows ≈110px + a 92px bottom navbar) left ~116px of play
 * area. Landscape therefore collapses the HUD to a single scrolling row and
 * stands the navbar up as a rail on the RIGHT edge (right, not left: that is the
 * thumb that reaches on a phone held in landscape). Portrait is untouched.
 *
 * The metrics live here rather than inline in the components so the play-area
 * budget they produce is asserted numerically (layout.test.ts) instead of
 * eyeballed on a device.
 */
import { useEffect, useState } from 'react';
import { stampPkViewport } from './pk/viewportClass';
import { readGameUiViewport, subscribeGameViewport } from '../lib/gameViewport';

/** App S.o: landscape only past a 1.1 ratio, so a near-square window stays portrait. */
export function isPortraitSize(w: number, h: number): boolean {
  return !(w > h * 1.1);
}

export function isPortrait(): boolean {
  if (typeof window === 'undefined') return true;
  const { w, h } = readGameUiViewport();
  return isPortraitSize(w, h);
}

export function usePortrait(): boolean {
  const [port, setPort] = useState(isPortrait);
  useEffect(() => {
    const onResize = (): void => setPort(isPortrait());
    return subscribeGameViewport(onResize);
  }, []);
  return port;
}

/** CSS px. Every value is consumed by the components below it — see the test. */
export const CHROME = {
  /** Inner horizontal padding INSIDE the bar plate's border-image edge. Was 10
   *  when the HUD was a bare flex column; the plate's own 8px side slice now
   *  carries most of that visual inset, so the padding only keeps glyphs off
   *  the forged edge. */
  hudPad: 4,
  /** Gap between adjacent chips in the bar. */
  hudGap: 6,
  /** The bar's content row (owner 2026-08-15, M23 a11 — and the iOS-HIG/WCAG
   *  2.5.5 floor the map chrome codifies as MAPCHROME.tap). EVERY interactive
   *  thing in the bar is this tall: the chips stretch to it and the overflow
   *  control is exactly this square. */
  tapRow: 48,
  /** 9-slice plate insets from the hud-chrome master (T/B 6, L/R 8).
   *  border-width MUST equal border-image-slice or the corner slices resample
   *  and the forged rim renders differently at every viewport width. */
  barBorderY: 6,
  barBorderX: 8,
  /** 9-slice inset of the recessed chip well (all four sides). */
  chipBorder: 3,
  /**
   * 9-slice inset of a PRESSABLE tab — the nav destinations and the dock
   * buttons (hudChrome.tsx: hudTabStyle). Four rings, not the chip well's
   * three: outline / highlight / falloff / face is the minimum that reads as
   * forged metal rather than as a hairline rectangle, and the hairline
   * rectangle is the defect this replaces.
   *
   * It costs 2px per side more than the 2px border it replaced, and that cost
   * is paid out of the buttons' INNER PADDING, never out of navBar/dockRow —
   * both of those are pinned by tests and by every sheet that sits above the
   * navbar. See navBtnPad() below, which is the arithmetic that keeps a
   * portrait nav item exactly 72px tall.
   */
  tabBorder: 4,
  /** Base-tools dock: BUILDERS / LAYOUT / EXPAND / FIT as one 44px-tall row of
   *  contextual buttons. It FLOATS at the bottom-left corner rather than being
   *  reserved in playArea() — see the comment on playArea. */
  dockRow: 48,
  /**
   * Breathing room between the base-tools dock and the nav deck.
   *
   * The dock used to sit at `bottom: navBar` exactly -- a ZERO-pixel gap -- so
   * the moment the deck grew by a single pixel it ate the dock. The deck is now
   * height-pinned (hudChrome.hudDeckStyle) so it cannot grow, which makes the
   * overlap structurally impossible; this is the second half of that fix. A
   * flush seam also reads as one crowded slab rather than two separate control
   * groups, which is the owner's "many black bar things" complaint in miniature.
   * Costs 6px of board and is worth it.
   */
  dockGap: 6,
  /** Portrait navbar height incl. its padding — the offset sheets sit above. */
  navBar: 64,
  /** Landscape nav rail width incl. its padding. */
  rail: 76,
  /** Responsive HUD widths from the 2026-08-30 owner handout. */
  cluster: 560,
  wide: 980,
  /** The promoted builder queue uses the same minimum tap-height as the bar. */
  queueRow: 48,
  /** Buttons in the task rail — QUESTS · CACHE · MAIL · BAG · ARMY · FOUNDING.
   *  Five since D-096 (owner 2026-09-02: the base-wide troop count is a
   *  primary surface, so it lives here rather than three taps deep); six since
   *  D-103 (today's tester points and streak, same reasoning). The count is
   *  what stretches the rail, so baseChatPlacement reads it to know when the
   *  column reaches the launcher's slot. */
  taskButtons: 6,
  /** Selection sheets become bounded cards instead of full-bleed slabs. */
  sheetMax: 520,
  sheetMaxRail: 400,
  /** Whole-pixel breathing room around floating chrome. */
  clusterPad: 8,
} as const;

export type HudTier = 'compact' | 'mid' | 'wide';

export interface HudTierPlan {
  tier: HudTier;
  /** Only short landscape uses the right-hand navigation rail. */
  rail: boolean;
}

/** Width and orientation answer different layout questions. A 915x412 phone is
 * both `mid` (floating clusters) and `rail` (height is scarce), while a tall
 * 1024x768 window keeps a bottom deck. */
export function hudTier(vw: number, vh: number): HudTierPlan {
  return {
    tier: vw < CHROME.cluster ? 'compact' : vw < CHROME.wide ? 'mid' : 'wide',
    rail: vw > vh * 1.1 && vh < 500,
  };
}

export interface BaseChatPlacement {
  right: number;
  bottom: number;
}

const CHAT_EDGE = 10;
/** The closed launcher's painted reach above its `bottom`: the 48px target plus
 *  the unread bead's 8px overhang (ChatLauncher.tsx draws both). The solver
 *  needs it to tell when the task column reaches the launcher's slot. */


/** Top of the vertical task column in the non-rail tiers: under the HUD bar
 *  and the promoted builder queue. hudChrome.hudTaskRailStyle renders from
 *  this and baseChatPlacement below reads it, so the two cannot drift apart. */
export function taskRailTop(tier: HudTier): number {
  return tier === 'compact'
    ? hudHeight(true) + CHROME.queueRow + CHROME.clusterPad
    : CHROME.clusterPad + hudHeight(true) + CHROME.hudGap + CHROME.queueRow + CHROME.clusterPad;
}

/** The rail's extent along its own axis: every button and the gaps between. */
export function taskRailLength(): number {
  return CHROME.taskButtons * CHROME.tapRow + (CHROME.taskButtons - 1) * CHROME.hudGap;
}

/**
 * Closed global-chat launcher placement in the BASE / BUILD chrome.
 *
 * This deliberately consumes the SAME width/height solver as the navigation.
 * Treating every landscape-shaped viewport as a rail put chat over RAID at
 * 909×780, where the HUD correctly keeps its bottom deck. In true short
 * landscape the launcher moves above the horizontal task rail as well as left
 * of the navigation rail, so BAG remains independently reachable.
 *
 * The task column is the other thing the launcher must clear. It hangs from
 * the HUD and grew to five buttons with D-096 (ARMY), so at heights just above
 * the rail cutoff — a landscape window that keeps its bottom deck, 500–527px
 * tall in the mid tier — its last button reaches the corner slot above the
 * navbar. There the launcher steps LEFT of the column instead of painting over
 * a task control; everywhere taller it keeps the corner.
 *
 * Safe-area insets are added by the renderer exactly once; these are the plain
 * CSS-pixel chrome offsets, following the convention used throughout this file.
 */
export function baseChatPlacement(_vw: number, _vh: number): BaseChatPlacement {
  return { right: CHAT_EDGE, bottom: CHROME.navBar + CHROME.clusterPad };
}

/**
 * Vertical chrome the HUD occupies at the top of the base view.
 *
 * ONE ROW IN BOTH ORIENTATIONS (owner, reported from production three times:
 * "top black bars are ugly ... not aligned well for mobile"). Portrait used to
 * stack three flex-wrap rows that wrapped into FIVE visual rows — 200px, 25% of
 * a 375×812 phone, sitting on top of the board. The fix is not styling: the row
 * carries only what a player reads constantly (shards, KEEP, the overflow
 * control) and everything else moved into the overflow panel or the base-tools
 * dock, so a single non-wrapping row is enough.
 *
 * Portrait = 6 + 44 + 6 = 56 (7% of an 800px phone). The plate shows both its
 * lit top chamfer and its gold bottom rim.
 *
 * Landscape = 0 + 44 + 6 = 50. The top chamfer is dropped, not the rim: height
 * is the scarce axis once the phone is turned (the Seeker webview is 311px
 * tall) and the bottom rim is the edge that actually separates chrome from
 * world. Those 6px are what keep the board above the 260px floor asserted
 * below — 311 − 50 = 261.
 *
 * Excludes safe-area insets, same convention as playArea(); the camera reads
 * the REAL rect through baseCameraInsets().
 */
export function hudHeight(portrait: boolean): number {
  return (portrait ? CHROME.barBorderY : 0) + CHROME.tapRow + CHROME.barBorderY;
}

/**
 * A nav destination's INNER padding, solved so that the forged tab frame costs
 * the layout nothing.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO LITERALS. The nav items used to wear a
 * plain `2px solid` border; the forged tab is a CHROME.tabBorder (4px) 9-slice.
 * Tailwind's preflight puts everything in `box-sizing: border-box`, but these
 * buttons have no fixed height — they are content + padding + border — so the
 * extra 2px per side would have grown a portrait item from 72px to 76px and the
 * navbar from 92 to 100. CHROME.navBar is not a preference: every bottom sheet
 * in sheets.tsx offsets itself by it, playArea() subtracts it, and
 * layout.test.ts pins it. So the frame is paid for out of padding instead, and
 * the arithmetic lives here where the constants it balances against do.
 *
 * PORTRAIT   4 + 4 + 26 (icon) + 4 (gap) + 24 (16px VT323 line) + 6 + 4 = 72
 * RAIL       4 + 2 + 20 (icon) + 2 (gap) + 19.5 (13px VT323 line) + 3 + 4 = 54.5
 *
 * THE PORTRAIT ITEM IS 5px SHORTER THAN THE ONE IT REPLACES, and that is a fix,
 * not a trim for the frame's sake. The old padding (9/10) plus a 2px border
 * MEASURED 77px in Chromium, so the navbar element was 97px tall while
 * CHROME.navBar — the number playArea() subtracts and every bottom sheet in
 * sheets.tsx offsets itself by — said 92. The line-box of 16px VT323 is 24px,
 * not the 19 that estimate assumed. Nothing looked broken while the base-tools
 * dock was a flat chip: it sits at `bottom: navBar`, so its lowest 5px were
 * simply hidden behind the navbar. Give the dock a bevelled foot and the lie
 * becomes visible as a clipped button. Rather than move navBar (which would
 * shift every sheet and cost the board 5px), the item is made the height the
 * constant already promises — so the sheets now sit exactly flush on the deck,
 * the dock rests ON it instead of behind it, and the board gets 5px back.
 *
 * The RAIL is deliberately left alone: 54.5px x 5 + gaps + padding = 305 inside
 * the 311px Seeker webview, so it fits today and every landscape number in
 * layout.test.ts stays exactly as measured. Landscape is the orientation where
 * a well-meant 5px is most likely to cost something.
 *
 * Horizontal padding is 0 in both: the 4px frame already holds the label off
 * the edge, and the rail is only 60px wide inside its own padding.
 */
export function navBtnPad(rail: boolean): string {
  return rail ? '2px 0 3px' : '4px 0 6px';
}

/**
 * Chip geometry, CSS px, MEASURED — not estimated.
 *
 * Every figure comes from rendering the real HudChip in headless Chromium with
 * the real VT323 face (apps/web/src/assets/fonts/VT323-latin-v18.woff2) and
 * reading getBoundingClientRect: a chip is a fixed frame plus one advance per
 * character of its value, exactly. 43 + 7.2n reproduced every measured width to
 * the tenth of a pixel (3ch 64.6 · 6ch 86.2 · 9ch 107.8).
 *
 * WHY THE MODEL IS VALUE-AWARE INSTEAD OF NOMINAL. A first attempt budgeted a
 * fixed "typical" width per chip. In the browser that let a 320px phone holding
 * 7,038,871 shards render a chip 12px narrower than its content, and because
 * the chips may shrink, the number came out clipped as "7,038,87" — the exact
 * defect the old landscape strip was reported for. A currency a player is about
 * to spend must never be a truncated number, so the solver is given the string
 * that will actually be drawn and drops a chip rather than squeeze one.
 */
export const HUD_CHIP = {
  /** Icon, inner gap, 6px padding and the 3px chip-well border on both sides. */
  base: 43,
  /** VT323 at 18px: one advance, every glyph (it is a fixed-width face). */
  charW: 7.2,
  /** BarMini (52) plus its gap (5) — the mine-buffer bar riding SHARDS. */
  mineBar: 57,
  /** CHROME.tapRow square. Never shrinks, never scrolls out of reach. */
  overflow: 44,
} as const;

/** Rendered width of a chip whose value is `chars` characters long. */
export const hudChipW = (chars: number): number => HUD_CHIP.base + HUD_CHIP.charW * chars;

/** The strings the bar is about to draw — passed in so the solver budgets the
 *  real content rather than a guess about it. */
export interface HudBarValues {
  shards: string; keep: string; trophies: string; leagueRail: string; sol: string;
  /** Gems uses its native 24px chip; legacy currency artwork remains 20px. */
  currencyIconSize?: 20 | 24;
}

export type LeagueChipForm = 'full' | 'compact';

export interface HudBarPlan {
  tier: HudTier;
  rail: boolean;
  /** Content width between the plate's side borders and inner padding. */
  inner: number;
  /** Width the planned chips occupy, gaps included. Must be ≤ inner. */
  used: number;
  /** Progressive disclosure. SHARDS, KEEP and the overflow control are never
   *  optional; these three are promoted out of the overflow panel only when the
   *  row can hold them without crowding. */
  showMineBar: boolean;
  leagueForm: LeagueChipForm | null;
  leagueWidth: number;
  showTrophies: boolean;
  showSol: boolean;
  showShield: boolean;
}

/**
 * Solve the top bar's content for a viewport — the same shape of decision
 * mapChrome() makes for the map rail, and for the same reason: a control that
 * does not fit must be REMOVED from the row, never left to wrap (portrait's old
 * five ragged rows) or to scroll off the end (landscape's old strip, whose own
 * comment conceded "at 915px the pills need 987px").
 *
 * Excludes safe-area insets — device-supplied and 0 without a notch, same
 * convention as playArea(). The alert badge's 3px overhang past the overflow
 * control is not budgeted either: it sits in the plate's inner padding, which
 * is why that padding exists.
 */
export function hudBarPlan(
  vw: number,
  vh: number,
  values: HudBarValues & { shield?: string },
): HudBarPlan {
  const { tier, rail } = hudTier(vw, vh);
  const barW = tier === 'compact'
    ? vw - CHROME.clusterPad * 2
    : Math.min(vw - CHROME.clusterPad * 2, 720);
  const inner = barW - CHROME.barBorderX * 2 - CHROME.hudPad * 2;
  const { hudGap: gap } = CHROME;

  const shards = hudChipW(values.shards.length);
  const keep = hudChipW(values.keep.length) + (values.currencyIconSize ?? 20) - 20;
  // The floor: the two currencies every build and train action debits, and the
  // way to everything else. None of the three is ever dropped.
  const floor = shards + gap + keep + gap + HUD_CHIP.overflow;
  let used = floor;

  const fits = (w: number): boolean => used + gap + w <= inner;
  // Crest is 24px (4px wider than an ordinary icon). The full form's second
  // line is a 36px rail + gap + compact 11px label; budget the actual label so
  // a tier boundary cannot make the chip overrun its solved slot.
  const leagueCompact = HUD_CHIP.base + 4 + HUD_CHIP.charW * values.trophies.length;
  const leagueFull = HUD_CHIP.base + 4 + Math.max(
    HUD_CHIP.charW * values.trophies.length,
    40 + values.leagueRail.length * 5.5,
  );
  let leagueForm: LeagueChipForm | null = fits(leagueCompact) ? 'compact' : null;
  let leagueWidth = leagueForm ? leagueCompact : 0;
  if (leagueForm) used += gap + leagueWidth;
  const showTrophies = leagueForm !== null;

  // Mine fill is useful but not a destination. It yields to the league chip,
  // then takes any remaining space before SOL and shield.
  const showMineBar = used + HUD_CHIP.mineBar <= inner;
  if (showMineBar) used += HUD_CHIP.mineBar;
  const showSol = fits(hudChipW(values.sol.length));
  if (showSol) used += gap + hudChipW(values.sol.length);
  const showShield = values.shield != null && fits(hudChipW(values.shield.length));
  if (showShield) used += gap + hudChipW(values.shield!.length);
  // Full rank detail is an enhancement of an already-visible destination. It
  // may consume only leftover width; crossing a breakpoint must never evict a
  // mine signal, SOL or shield that a narrower viewport already displayed.
  if (leagueForm === 'compact' && used + (leagueFull - leagueCompact) <= inner) {
    used += leagueFull - leagueCompact;
    leagueForm = 'full';
    leagueWidth = leagueFull;
  }
  return { tier, rail, inner, used, showMineBar, leagueForm, leagueWidth, showTrophies, showSol, showShield };
}

export interface HudQueuePlan {
  cards: number;
  collapsed: boolean;
}

/** Fixed widths rendered by the queue components in hudChrome.tsx. */
export const HUD_QUEUE = {
  card: 184,
  socket: 104,
  more: 44,
} as const;

/** Compact and short-landscape surfaces use one truthful summary line. Wider
 * surfaces show as many job cards as fit, reserving an idle-builder action. */
export function hudQueuePlan(
  vw: number,
  vh: number,
  jobs: number,
  builders: number,
): HudQueuePlan {
  const { tier, rail } = hudTier(vw, vh);
  const busy = Math.max(0, Math.min(jobs, builders));
  if (tier === 'compact' || rail) return { cards: 0, collapsed: true };
  const idle = builders > busy;
  const budget = Math.max(0, vw - CHROME.clusterPad * 2);
  const width = (cards: number): number => {
    const items = cards + Number(idle) + Number(cards < busy);
    return cards * HUD_QUEUE.card
      + (idle ? HUD_QUEUE.socket : 0)
      + (cards < busy ? HUD_QUEUE.more : 0)
      + Math.max(0, items - 1) * CHROME.hudGap;
  };
  let cards = busy;
  while (cards > 0 && width(cards) > budget) cards -= 1;
  return { cards, collapsed: false };
}

export type HudAttention = 'verifying' | 'idle' | 'buffer' | 'overflow' | null;

/** One animation winner prevents four unrelated controls from pulsing at once.
 * Elapsed jobs are `verifying`, never a fake collectible READY state: the
 * authoritative base refresh removes completed rows. */
export function hudAttention(s: {
  verifyingJobs: number;
  idleBuilders: number;
  bufferFull: boolean;
  overflow: boolean;
}): HudAttention {
  if (s.verifyingJobs > 0) return 'verifying';
  if (s.idleBuilders > 0) return 'idle';
  if (s.bufferFull) return 'buffer';
  if (s.overflow) return 'overflow';
  return null;
}

/**
 * THE BADGE RULE — the correctness requirement of the overflow control.
 *
 * Moving a control out of the always-visible row is only safe while a
 * TIME-SENSITIVE action inside it cannot become invisible. Three states in the
 * panel are time-sensitive: the daily cache is claimable (it expires), mail is
 * unread, and mail holds rewards still in escrow. Any of them lights the badge
 * on the overflow control, so the player sees from the bar alone that there is
 * something to collect.
 *
 * It lives here, beside the bar's other layout decisions, so it can be asserted
 * without mounting the overlay's whole fetch graph.
 */
export function hudOverflowAlert(s: {
  claimAvailable: boolean;
  mailUnread: number;
  mailPendingRewards: number;
}): boolean {
  return s.claimAvailable || s.mailUnread > 0 || s.mailPendingRewards > 0;
}

/** Window size, re-measured on resize AND orientationchange.
 *
 *  orientationchange matters: iOS Safari fires it with the OLD innerWidth/
 *  innerHeight on some versions and only then a `resize`, so a listener on
 *  `resize` alone can settle a frame late — and a chrome solver that ran
 *  against a stale viewport puts controls off-screen (the exact class of bug
 *  game/world/camera.ts was written to fix for the canvas cameras). */
export function useWindowSize(): { w: number; h: number } {
  const read = (): { w: number; h: number } => {
    const size = readGameUiViewport();
    if (typeof document !== 'undefined') stampPkViewport(document.documentElement, size.w, size.h);
    return size;
  };
  const [size, setSize] = useState(read);
  useEffect(() => {
    const measure = (): void => setSize((previous) => {
      const next = read();
      return next.w === previous.w && next.h === previous.h ? previous : next;
    });
    measure();
    return subscribeGameViewport(measure);
  }, []);
  return size;
}

/** Safe edges for tutorial cards and the guided objective strip. Tutorial
 * chrome must avoid the final HUD, not the old portrait/landscape guess:
 * non-rail compact/mid layouts reserve both the bottom deck and its floating
 * base-tools dock; short landscape reserves the right navigation rail and
 * horizontal task rail. */
export interface TutorialSurfaceInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function tutorialSurfaceInsets(vw: number, vh: number): TutorialSurfaceInsets {
  const { tier, rail } = hudTier(vw, vh);
  const top = tier === 'compact'
    ? hudHeight(isPortraitSize(vw, vh)) + CHROME.queueRow + CHROME.clusterPad
    : CHROME.clusterPad + hudHeight(true) + CHROME.hudGap + CHROME.queueRow + CHROME.clusterPad;
  const taskReserve = CHROME.tapRow + CHROME.clusterPad * 2;
  return {
    top,
    right: rail ? CHROME.rail + CHROME.clusterPad : taskReserve,
    bottom: rail
      ? taskReserve
      : tier === 'wide'
        ? CHROME.navBar + CHROME.clusterPad
        : CHROME.navBar + CHROME.dockGap + CHROME.dockRow + CHROME.clusterPad,
    left: CHROME.clusterPad,
  };
}

/** Keep the introductory card clear of a bottom-half control it is asking the
 * player to press. The camera card used to sit over FIT on compact phones: the
 * ring was technically correct, but the interactive card intercepted the tap.
 * Top-half targets keep the normal chrome-aware bottom inset; bottom-half
 * targets lift the card so its lower edge stops one cluster gap above the ring. */
export function tutorialCardBottom(
  viewportHeight: number,
  baseBottom: number,
  anchor: { top: number } | null,
): number {
  if (!anchor || anchor.top <= viewportHeight * 0.55) return baseBottom;
  return Math.max(baseBottom, Math.ceil(viewportHeight - anchor.top + CHROME.clusterPad));
}

export interface Insets { top: number; right: number; bottom: number; left: number }
const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export interface ChromeRect { top: number; right: number; bottom: number; left: number }

/** Convert the measured base HUD and navigation rectangles into camera-safe
 * edge insets. Rects already include CSS env(safe-area-inset-*); the explicit
 * safe values cover the two edges that have no chrome in each orientation. */
export function baseCameraInsets(
  _chrome: HudTierPlan, viewport: { width: number; height: number },
  hud: ChromeRect, nav: ChromeRect, safe: Insets, queue?: ChromeRect,
): Insets {
  // Fit the largest square in the safe viewport. A floating corner only
  // reserves an edge when it actually intersects that square. Process the
  // top row before lower tools, so a shorter fitted square can clear a dock.
  // These hints never replace the independent exact HUD input exclusions.
  const result = { ...safe };
  const cap = Math.max(0, (viewport.height - safe.top - safe.bottom) / 3);
  const intersects = (rect: ChromeRect): boolean => {
    const width = Math.max(0, viewport.width - result.left - result.right);
    const height = Math.max(0, viewport.height - result.top - result.bottom);
    const side = Math.min(width, height);
    const left = result.left + (width - side) / 2;
    const top = result.top + (height - side) / 2;
    return rect.right > rect.left && rect.bottom > rect.top
      && rect.left < left + side && rect.right > left
      && rect.top < top + side && rect.bottom > top;
  };
  // A bottom control can shift the square into a previously clear top row.
  // Insets only grow to one of these three measured edges, so four passes suffice.
  for (let pass = 0; pass < 4; pass++) {
    const previous = result.top + result.bottom;
    for (const rect of [hud, queue]) {
      if (rect && intersects(rect)) result.top = Math.max(result.top,
        Math.min(safe.top + cap, Math.ceil(rect.bottom)));
    }
    if (intersects(nav)) result.bottom = Math.max(result.bottom,
      Math.min(safe.bottom + cap, Math.ceil(viewport.height - nav.top)));
    if (result.top + result.bottom === previous) break;
  }
  return result;
}

/**
 * The device's safe-area insets AS NUMBERS.
 *
 * Every other screen sprinkles `calc(<px> + env(safe-area-inset-*))` on each
 * offset, which is fine when the offsets are independent. The map chrome's are
 * NOT: the zoom cluster's position is derived from the sheet's, and the rail's
 * from the bar's, so a solver working in raw window pixels while the components
 * add insets afterwards over-allocates the viewport by (top + bottom) — 81px on
 * an iPhone 14 Pro — and slots that the solver proved disjoint can still touch.
 * Reading the insets once lets mapChrome() solve inside the REAL safe box and
 * every slot land in plain px.
 *
 * `viewport-fit=cover` is already set in index.html, so env() is live; it is 0
 * on hardware without a notch or gesture bar, which is why the numeric tests
 * can assume zero and still describe real devices.
 */
export function readSafeAreaInsets(): Insets {
  if (typeof document === 'undefined' || !document.body) return NO_INSETS;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
    + 'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);'
    + 'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const px = (v: string): number => Math.max(0, Math.round(Number.parseFloat(v) || 0));
  const out: Insets = {
    top: px(cs.paddingTop), right: px(cs.paddingRight),
    bottom: px(cs.paddingBottom), left: px(cs.paddingLeft),
  };
  probe.remove();
  return out;
}

export function useSafeAreaInsets(): Insets {
  const [insets, setInsets] = useState(NO_INSETS);
  useEffect(() => {
    const measure = (): void => setInsets((prev) => {
      const next = readSafeAreaInsets();
      return prev.top === next.top && prev.right === next.right
        && prev.bottom === next.bottom && prev.left === next.left ? prev : next;
    });
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);
  return insets;
}

export interface PlayArea {
  /** chrome insets */
  top: number; bottom: number; right: number;
  /** unobstructed canvas left for the base */
  width: number; height: number;
}

/**
 * Unobstructed base-view area for a viewport, excluding safe-area insets (which
 * are device-supplied and 0 on hardware without a notch/gesture bar).
 *
 * The base-tools dock (CHROME.dockRow) is deliberately NOT subtracted. It is a
 * 44px row in the bottom-LEFT corner — the opposite corner from the chat
 * launcher, which has floated in that band since M23 — and the base camera fits
 * a square board into this area, so at rest the dock sits over letterboxing
 * rather than over the board. Reserving it would have cost more board than the
 * old three-row HUD gave back.
 */
export function playArea(vw: number, vh: number): PlayArea {
  // The scene occupies the full physical viewport. Measured fitting hints arrive
  // separately through base:insets; no rail or HUD changes its painted extent.
  return { top: 0, bottom: 0, right: 0, width: vw, height: vh };
}

/**
 * MAP-CHROME — the shared slot geometry for the WORLD and CAMPAIGN boards.
 *
 * WHY THIS EXISTS AT ALL: both boards used to place every control with a bare
 * literal (`top:10`, `top:52`, `top:96`, `bottom:210`, a fixed 216px banner, a
 * fixed 230px search box) and no shared stacking discipline, so on a 375×812
 * phone they collided — the region banner behind the mode tabs, HIDE SHIELDED
 * cut in half at the right edge, the zoom rail's `+` pill at y −11 in the
 * owner's measured landscape window. A slot solver makes that unrepresentable:
 * a control cannot be placed without asking for a slot, and the slots are
 * asserted numerically in layout.test.ts instead of eyeballed on a device.
 *
 * These are LAYOUT metrics, not game numbers — same standing as CHROME above.
 */
export const MAPCHROME = {
  /** Minimum touch target, every edge. iOS HIG 44pt / WCAG 2.5.5. */
  tap: 44,
  /** The ONE top-bar row: back · mode tabs · truncating title · search · stat. */
  bar: 44,
  /** Edge padding from the viewport (before safe-area insets). */
  pad: 8,
  /** Gap between adjacent controls inside a slot. */
  gap: 6,
  /** Bottom sheet at rest: one 44px row (region plate + status pills) + padding. */
  peek: 52,
  /** Expanded-sheet ceiling as a percentage of viewport height. */
  sheetPct: 55,
  /** Secondary controls carry TEXT labels only from this viewport width up;
   *  below it they are icon-only, which is what keeps the rail 44px wide. */
  labelMinW: 480,
  /** A LABELLED rail item: 44px glyph + gap + the longest label the rail
   *  carries ("HIDE SHIELDED", 13 chars of VT323 at 15px). Desktop keeps the
   *  labelled pills it ships today; only narrow viewports drop to icons. */
  railLabelW: 148,
  /** Cumulative pointer travel (px) past which a press is a DRAG, never a tap.
   *  ONE threshold for the whole map surface: the board's pan gate, the globe's
   *  rotate gate and the chrome buttons' drift guard all read it, so a press
   *  that pans can never also fire the button it started on. */
  dragPx: 8,
} as const;

/**
 * Side of a tap target that lives INSIDE a `scale(z)` layer, in that layer's
 * own units, so its ON-SCREEN size is MAPCHROME.tap at every zoom.
 *
 * The campaign stage nodes were the app's worst tap targets: the hit box was
 * the union of the children of a 0×0 span inside the scaled layer, so an
 * ordinary 43px node measured 43 × 0.7 = 30px on screen at minimum zoom. A
 * node's hit rect is sized from this, never from the sprite.
 */
export const hitSizeAt = (z: number): number => MAPCHROME.tap / z;

/** A chrome slot in viewport CSS px, excluding safe-area insets (device-supplied
 *  and 0 on hardware without a notch/gesture bar — same convention as playArea). */
export interface Slot { left: number; top: number; width: number; height: number }

export const slotRight = (s: Slot): number => s.left + s.width;
export const slotBottom = (s: Slot): number => s.top + s.height;

/** Canonical map-global-chat slot. Both the solver and the launcher consume
 * this helper so Campaign ACT controls cannot drift underneath a copied value. */
export const mapChatSlot = (): Slot => ({
  left: MAPCHROME.pad,
  top: MAPCHROME.bar + MAPCHROME.pad,
  width: MAPCHROME.tap,
  height: MAPCHROME.tap,
});

export interface MapChromeLayout {
  portrait: boolean;
  /** vw ≥ MAPCHROME.labelMinW — secondary controls may show text. */
  showLabels: boolean;
  /** Full-width 44px top row. */
  bar: Slot;
  /** Dedicated global-chat launcher slot. The under-bar starts after this slot
   *  so WORLD search and CAMPAIGN act tabs can never render underneath it. */
  chat: Slot;
  /** The row directly under the bar: the world map's expanded search field, the
   *  campaign's horizontally-scrolling ACT strip. Stops short of the rail. */
  underBar: Slot;
  /** Right-hand toggle cluster: a 44px icon COLUMN in portrait, a 44px-tall
   *  icon ROW in landscape (height is the scarce axis there — the same trade
   *  the base HUD makes when it collapses to one row). */
  rail: Slot;
  /** Zoom cluster above the sheet. NULL when the sheet leaves no band that
   *  clears the rail — pinch / wheel / double-tap are the primary zoom, so the
   *  rail is a convenience and may be dropped rather than overlap something. */
  zoom: Slot | null;
  /** The bottom sheet at the height the caller published. */
  sheet: Slot;
  /** Ceiling for an EXPANDED sheet: never tall enough to reach the rail. */
  sheetMax: number;
  /** Ceiling for the search results list (it scrolls inside this). */
  searchMax: number;
}

/**
 * Solve the map chrome for a viewport.
 *
 * @param sheetH  the bottom sheet's CURRENT measured height (0 hidden /
 *                MAPCHROME.peek / up to `sheetMax` expanded). Passed in rather
 *                than assumed because the zoom cluster's offset is derived from
 *                it — the magic `bottom: 210` it replaces was tuned to one
 *                board's one sheet and pushed the `+` pill off-screen on the
 *                other.
 * @param railRows how many 44px toggles the board puts in the rail.
 * @param zoomRows how many 44px buttons the zoom cluster has (+ / − / home).
 */
export function mapChrome(
  vw: number, vh: number,
  sheetH: number = MAPCHROME.peek,
  railRows = 3,
  zoomRows = 3,
): MapChromeLayout {
  const { tap, bar, pad, gap } = MAPCHROME;
  const portrait = isPortraitSize(vw, vh);
  const cluster = (n: number): number => n * tap + Math.max(0, n - 1) * gap;

  const barSlot: Slot = { left: 0, top: 0, width: vw, height: bar };
  const underTop = bar + pad;
  const chatSlot = mapChatSlot();

  // THE RAIL FITS OR IT LOSES ITS LABELS. Landscape lays the rail out as a ROW,
  // so its horizontal extent grows with railRows: a 4-row LABELLED rail is
  // 4·148 + 3·6 = 610px, which does not fit a 568×320 landscape phone at all.
  // This used to be computed and placed unconditionally, so the rail landed at
  // left −50 (off the left edge) and `underBar` collapsed to width 0 — the extra
  // GLOBE row made it reachable on a real device. There is no lower clamp to add
  // instead: a clamped 610px rail would simply overlap everything. So the rail
  // is SOLVED — labels first when the viewport can afford them, then the 44px
  // icon rail — and `showLabels` follows the shape that actually fits, because a
  // labelled button rendered into a 44px slot is the same bug one layer down.
  const railHoriz = (w: number): number => (portrait ? w : railRows * w + Math.max(0, railRows - 1) * gap);
  // A rail that leaves the under-bar row less than one touch target has eaten
  // the search field / ACT strip, which is the collapse-to-zero defect itself.
  const underLeft = slotRight(chatSlot) + gap;
  const fits = (w: number): boolean => {
    const railLeft = vw - pad - railHoriz(w);
    return railLeft >= 0 && railLeft - pad - underLeft >= tap;
  };
  const itemW = vw >= MAPCHROME.labelMinW && fits(MAPCHROME.railLabelW)
    ? MAPCHROME.railLabelW
    : tap;
  const showLabels = itemW === MAPCHROME.railLabelW;
  const railW = railHoriz(itemW);

  // Portrait has height to spare and width to protect → column. Landscape is
  // the reverse → row. `left` is clamped at 0 even so: at a viewport too narrow
  // for even the icon rail the controls must stay reachable rather than sit
  // outside the window where nothing can touch them.
  const railSlot: Slot = portrait
    ? { left: Math.max(0, vw - pad - itemW), top: underTop, width: itemW, height: cluster(railRows) }
    : { left: Math.max(0, vw - pad - railW), top: underTop, width: railW, height: tap };
  const railBottom = slotBottom(railSlot);

  // The sheet may never grow into the rail: capping it here is what makes
  // "no two slots overlap" true by construction instead of by convention.
  const sheetMax = Math.max(
    MAPCHROME.peek,
    Math.min(Math.round((vh * MAPCHROME.sheetPct) / 100), vh - railBottom - pad),
  );
  const sheet: Slot = {
    left: 0, top: vh - Math.min(sheetH, sheetMax), width: vw, height: Math.min(sheetH, sheetMax),
  };

  const underBar: Slot = {
    left: underLeft, top: underTop,
    width: Math.max(0, railSlot.left - pad - underLeft), height: tap,
  };

  // Zoom: try the orientation-preferred shape, then the other, then give up.
  const shapes: Slot[] = (portrait
    ? [[tap, cluster(zoomRows)], [cluster(zoomRows), tap]]
    : [[cluster(zoomRows), tap], [tap, cluster(zoomRows)]]
  ).map(([w, h]) => ({ left: vw - pad - w!, top: sheet.top - pad - h!, width: w!, height: h! }));
  const zoom = shapes.find((s) => s.top >= railBottom + gap && s.left >= 0) ?? null;

  const searchMax = Math.max(0, Math.min(
    Math.round(vh * 0.4),
    sheet.top - (underTop + tap) - pad,
  ));

  return {
    portrait, showLabels,
    bar: barSlot, chat: chatSlot, underBar, rail: railSlot, zoom, sheet, sheetMax, searchMax,
  };
}
