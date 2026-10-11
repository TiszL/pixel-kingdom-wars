/**
 * The base is a SQUARE 30×30 grid, so turning the phone flips which axis is
 * scarce — and the chrome that was sized for portrait (three stacked HUD rows +
 * a bottom navbar) is what makes landscape unplayable, not the canvas. At the
 * owner's measured phone-landscape window (915×412) that chrome left ~116px of
 * board.
 *
 * These assertions are the budget the landscape layout was designed to, tied to
 * the same CHROME constants the components render from: re-stack the HUD, drop
 * the rail back to the bottom, or fatten either one, and the play area falls
 * back under budget here instead of on a device.
 */
import { describe, expect, it } from 'vitest';
import {
  baseCameraInsets, baseChatPlacement, CHROME, hitSizeAt, HUD_CHIP, hudAttention, hudBarPlan, hudChipW, hudHeight,
  hudOverflowAlert, hudQueuePlan, hudTier, isPortraitSize, MAPCHROME, mapChatSlot, mapChrome, navBtnPad, playArea,
  slotBottom, slotRight, tutorialCardBottom, tutorialSurfaceInsets, type Slot,
} from './layout';
// hudDeckStyle lives in hudChrome, but the contract it must honour (CHROME.navBar)
// lives here and is what every other consumer subtracts — so the guard belongs
// beside the number it protects.
import { hudDeckStyle } from './hudChrome';

/** The owner's measured landscape VIEWPORT: a 915×412 window, of which ~311px
 *  of height reaches the page (the rest is browser/TWA chrome). window.innerHeight
 *  — what isPortrait() reads — is the 311, so that is what the layout gets. */
const LAND: [number, number] = [915, 311];
/** The same device in portrait, viewport-not-window for the same reason. */
const PORT: [number, number] = [412, 814];

describe('base camera chrome measurement', () => {
  it('does not reserve portrait chrome that is clear of the fitted square', () => {
    expect(baseCameraInsets({ tier: 'compact', rail: false }, { width: 390, height: 844 },
      { top: 0, right: 390, bottom: 132, left: 0 },
      { top: 742, right: 390, bottom: 844, left: 0 },
      { top: 28, right: 4, bottom: 24, left: 3 })).toEqual({
      top: 28, right: 4, bottom: 24, left: 3,
    });
  });

  it('uses floating landscape control measurements without reserving their whole column', () => {
    expect(baseCameraInsets({ tier: 'mid', rail: true }, { width: 844, height: 390 },
      { top: 0, right: 756, bottom: 42, left: 0 },
      { top: 326, right: 836, bottom: 382, left: 628 },
      { top: 0, right: 20, bottom: 8, left: 12 })).toEqual({
      top: 42, right: 20, bottom: 8, left: 12,
    });
  });
});

describe('floating HOME fit rather than full-width corner reservations', () => {
  it.each([1, 1.3, 2])('keeps the landscape builder and navigation clear at font scale %s', (font) => {
    const result = baseCameraInsets({ tier: 'mid', rail: true }, { width: 873, height: 393 },
      { left: 8, top: 8, right: 548, bottom: 16 + 48 * font },
      { left: 650, top: 393 - 16 - 56 * font, right: 865, bottom: 385 },
      { top: 0, bottom: 8, left: 0, right: 0 },
      { left: 8, top: 24 + 48 * font, right: 170, bottom: 24 + 96 * font });
    expect(result.top).toBe(Math.ceil(16 + 48 * font));
    expect(result.bottom).toBe(8);
    expect(393 - result.top - result.bottom).toBeGreaterThan(270);
  });

  it('reserves a large centred panel but bounds oversized text hints', () => {
    const result = baseCameraInsets({ tier: 'compact', rail: false }, { width: 320, height: 480 },
      { left: 0, top: 0, right: 320, bottom: 300 },
      { left: 0, top: 310, right: 320, bottom: 480 },
      { top: 20, bottom: 10, left: 0, right: 0 });
    expect(result).toEqual({ top: 170, bottom: 160, left: 0, right: 0 });
  });
});

describe('orientation is one derivation', () => {
  it('classifies the measured windows', () => {
    expect(isPortraitSize(...LAND)).toBe(false);
    expect(isPortraitSize(...PORT)).toBe(true);
  });

  it('keeps a near-square window in portrait (App S.o needs a 1.1 ratio)', () => {
    expect(isPortraitSize(1000, 950)).toBe(true); // 1.05 — not landscape
    expect(isPortraitSize(1000, 900)).toBe(false); // 1.11 — landscape
  });
});

describe('tutorial surfaces follow the final HUD contract', () => {
  const matrix = [
    [320, 568], [375, 812], [412, 915], [915, 412], [1024, 768], [1440, 900],
  ] as const;

  it.each(matrix)('reserves task, queue and navigation chrome at %sx%s', (w, h) => {
    const plan = hudTier(w, h);
    const inset = tutorialSurfaceInsets(w, h);
    expect(inset.top).toBeGreaterThanOrEqual(CHROME.tapRow + CHROME.queueRow);
    if (plan.rail) {
      expect(inset.right).toBeGreaterThanOrEqual(CHROME.rail);
      expect(inset.bottom).toBeGreaterThanOrEqual(CHROME.tapRow);
    } else {
      expect(inset.right).toBeGreaterThanOrEqual(CHROME.tapRow);
      expect(inset.bottom).toBeGreaterThanOrEqual(CHROME.navBar);
    }
  });

  it('keeps compact and mid tutorial surfaces above the base-tools dock', () => {
    for (const [w, h] of [[375, 812], [768, 1024]] as const) {
      const inset = tutorialSurfaceInsets(w, h);
      const dockTop = h - CHROME.navBar - CHROME.dockGap - CHROME.dockRow;
      expect(h - inset.bottom).toBeLessThanOrEqual(dockTop - CHROME.clusterPad);
    }
  });

  it('lifts a tutorial card above a bottom-half target instead of covering it', () => {
    const baseBottom = tutorialSurfaceInsets(375, 812).bottom;
    const anchor = { top: 665 };
    const bottom = tutorialCardBottom(812, baseBottom, anchor);
    expect(812 - bottom).toBeLessThanOrEqual(anchor.top - CHROME.clusterPad);
    expect(bottom).toBeGreaterThan(baseBottom);
  });

  it('keeps the normal chrome inset when there is no low target', () => {
    expect(tutorialCardBottom(812, 100, null)).toBe(100);
    expect(tutorialCardBottom(812, 100, { top: 200 })).toBe(100);
  });
});

describe('landscape reclaims vertical space in the base view', () => {
  const land = playArea(...LAND);

  it('collapses the HUD to a single tap-height row (≤ 56px of top chrome)', () => {
    expect(hudHeight(false)).toBeLessThanOrEqual(56);
    // Exactly one row, and that row must hold a 44px tap box (M23 a11: the
    // owner's mobile complaint was the sub-30px gear). EVERY control in the bar
    // is now this tall — the chips stretch to the row instead of centring 26px
    // readouts in it — so the floor can never be undercut by a chip again.
    expect(CHROME.tapRow).toBeGreaterThanOrEqual(44);
    // The row sits inside a 9-slice plate. Landscape drops the plate's top
    // chamfer and keeps its gold bottom rim: height is the scarce axis once the
    // phone is turned, and the rim is the edge that separates chrome from
    // world. Those 6px are exactly what keeps the board over its floor below.
    expect(hudHeight(false)).toBe(CHROME.tapRow + CHROME.barBorderY);
    expect(land.top).toBe(0); // the mid-width cluster floats
  });

  it('leaves the full scene beneath floating controls', () => {
    expect(land.bottom).toBe(0);
    expect(land.right).toBe(0);
  });

  it('holds the board floor the Seeker webview is sized against', () => {
    // 260px is the floor this suite has pinned since landscape became
    // first-class; it survives the single-row rebuild with 1px to spare.
    expect(land.height).toBeGreaterThanOrEqual(260);
    // WHY THE OLD `> before * 1.8` RATIO IS GONE. It compared landscape against
    // the PORTRAIT chrome of the day — three stacked HUD rows (128px) plus the
    // navbar. The HUD-IMPLEMENT rebuild cut portrait top chrome from 128px to
    // 56px, so that ratio now measures how bad portrait used to be, not whether
    // landscape is playable, and it would fall for the right reason. The
    // absolute floor above is the invariant that actually protects the player;
    // this is the part of the old claim that still means something.
    const rotated = LAND[1] - hudHeight(true) - CHROME.navBar;
    expect(land.height).toBeGreaterThan(rotated * 1.5);
  });

  it('preserves the full landscape width instead of reserving a rail', () => {
    expect(land.width).toBe(LAND[0]);
    // The binding dimension for a square board is still the short axis, and it
    // grew: that is the whole point of paying 76px of width for 92px of height.
    expect(Math.min(land.width, land.height)).toBeGreaterThan(LAND[1] - hudHeight(true) - CHROME.navBar);
  });

  it('fits five rail items inside that usable height', () => {
    // WHAT THIS USED TO ASSERT, AND WHY IT CHANGED. The model was
    // `20 + 2 + 15 + 9 + 4 = 50` per item, and the ceiling it checked against
    // was LAND[1] — but the "15" was an ESTIMATE of a 13px VT323 line box and
    // the real one, measured in headless Chromium against the real woff2, is
    // 19.5. So the model under-counted every item by 4.5px, and it was the same
    // class of estimate that left CHROME.navBar 5px short of the element it
    // names (see navBtnPad). The numbers below are measured, not guessed, and
    // the item is now built out of the constants it is actually made of — so
    // raising CHROME.tabBorder, or retuning navBtnPad, fails HERE instead of on
    // a Seeker.
    const [top, , bottom] = navBtnPad(true).split(' ').map(Number.parseFloat);
    const item = CHROME.tabBorder * 2 + top! + bottom! + 20 + 2 + 19.5;
    expect(item).toBe(54.5);
    const rail = item * 5 + 4 * 4 + 8 * 2; // 5 items, 4 gaps, 8px padding
    expect(rail).toBeLessThanOrEqual(LAND[1]);
  });
});

describe('portrait is one row too', () => {
  const port = playArea(...PORT);

  it('gives the board back the four rows the HUD used to stack on it', () => {
    // WHAT THIS USED TO ASSERT, AND WHY IT CHANGED. It pinned `port.top === 128`
    // — two 26px readout rows + a 44px tap row + gaps + padding — as the shape
    // of a three-row portrait HUD. Those three rows carried 16 always-visible
    // controls that `flexWrap: 'wrap'` broke into FIVE visual rows on a 375px
    // phone: 200px, 25% of the viewport, sitting on the play field. The owner
    // reported it from production three times. The rebuild leaves the bar one
    // non-wrapping row inside its 9-slice plate, so the number this pins is now
    // 6 + 44 + 6 and the rule it encodes is "portrait chrome is a row, not a
    // stack" — re-stack it and this fails.
    expect(hudHeight(true)).toBe(CHROME.barBorderY + CHROME.tapRow + CHROME.barBorderY);
    expect(port.top).toBe(0);
    expect(port.height).toBe(PORT[1]);
    // PLAYFIELD FIRST: the brief's budget is ~12% of an 800px-tall phone. This
    // is the assertion that fails if anything is ever added back to the row.
    expect(hudHeight(true) / 800).toBeLessThanOrEqual(0.12);
    expect(port.bottom).toBe(0); // the 92 the sheets already sit above
    expect(port.right).toBe(0); // no rail
  });

  it('never lets the top bar cost more than the bottom navigation', () => {
    // A status bar that outweighs the app's five destinations is the shape of
    // the defect, not a measurement of it.
    expect(hudHeight(true)).toBeLessThan(CHROME.navBar);
  });
});

// ===========================================================================
// THE SINGLE-ROW BAR — hudBarPlan()
//
// The bar cannot wrap (hudBarRowStyle sets flex-wrap:nowrap) and it cannot
// scroll, so the only way a control reaches the player is by FITTING. These
// assertions are that fit, at the four widths the game is actually played at.
// ===========================================================================

describe('the top bar fits its viewport in one row', () => {
  /** A typical mid-game player. Every figure the solver works from is the
   *  string that will actually be drawn, so the fixtures are strings. */
  const TYPICAL = { shards: '12,500', keep: '4,200', trophies: '412', leagueRail: '38 TO GOLD', sol: '1.250' };
  /** The same player after a good week. Nine characters of shards is what broke
   *  the first, nominal-width version of this solver in the browser. */
  const RICH = { shards: '7,038,871', keep: '1,204,880', trophies: '4,120', leagueRail: 'TOP TIER', sol: '12.500' };

  /** 320 is the narrowest supported phone; 360×800 is the Solana Seeker in
   *  portrait; 915×311 is the same device's landscape webview. */
  const WIDTHS: Array<[string, number, number]> = [
    ['320×568 (narrowest supported)', 320, 568],
    ['360×800 (Seeker portrait)', 360, 800],
    ['390×844 (iPhone 14/15)', 390, 844],
    ['412×814 (large Android)', 412, 814],
    ['768×1024 (tablet portrait)', 768, 1024],
    ['915×311 (Seeker landscape)', 915, 311],
    ['1024×768 (tablet landscape)', 1024, 768],
  ];

  it.each(WIDTHS)('never plans more content than fits at %s', (_label, w, h) => {
    // Both wealth levels: a bar that fits only while the player is poor is not
    // a bar that fits.
    for (const values of [TYPICAL, RICH]) {
      expect(hudBarPlan(w, h, values).used)
        .toBeLessThanOrEqual(hudBarPlan(w, h, values).inner);
    }
  });

  it('models the real chip: a fixed frame plus one glyph advance per character', () => {
    // Measured in headless Chromium against the real VT323 face. If someone
    // changes the chip's padding, border or font size and does not re-measure,
    // the solver silently starts lying and chips start clipping — so the
    // measurements are pinned here with the widths they came from.
    expect(hudChipW(3)).toBeCloseTo(64.6, 1);
    expect(hudChipW(6)).toBeCloseTo(86.2, 1);
    expect(hudChipW(9)).toBeCloseTo(107.8, 1);
    // The mine-buffer bar is BarMini's 52px plus its 5px gap, nothing else.
    expect(HUD_CHIP.mineBar).toBe(57);
  });

  it('keeps SHARDS, KEEP and the overflow control at every width — they are the floor', () => {
    // These three are not optional at any size, so the floor must fit the
    // narrowest supported phone even for a rich player. If it ever does not,
    // the bar has grown a chip that does not belong in it.
    const floor = hudChipW(RICH.shards.length) + CHROME.hudGap
      + hudChipW(RICH.keep.length) + CHROME.hudGap + HUD_CHIP.overflow;
    expect(floor).toBeLessThanOrEqual(hudBarPlan(320, 568, RICH).inner);
  });

  it('sheds the mine-buffer bar rather than clip a currency or ranked destination', () => {
    // THE REGRESSION THIS CATCHES, caught in a real browser before it shipped:
    // with fixed nominal widths, 320px + a 9-character shard count rendered the
    // chip 12px narrower than its content and the number came out as
    // "7,038,87". A player is about to SPEND that number. The bar is a signal
    // and can go; a digit cannot.
    expect(hudBarPlan(320, 568, TYPICAL).showMineBar).toBe(true);
    expect(hudBarPlan(320, 568, RICH).showMineBar).toBe(false);
    // Give the same rich player a wider phone and the signal comes back.
    expect(hudBarPlan(480, 800, RICH).showMineBar).toBe(true);
  });

  it('promotes a compact/full league chip and SOL only when there is room', () => {
    // Progressive disclosure, SOLVED rather than breakpointed — which is why a
    // rich player and a poor player get different answers at the same width.
    expect(hudBarPlan(320, 568, TYPICAL).leagueForm).toBeNull();
    expect(hudBarPlan(360, 800, TYPICAL).leagueForm).toBe('compact');
    expect(hudBarPlan(390, 844, TYPICAL).showTrophies).toBe(true);
    expect(hudBarPlan(390, 844, RICH).showTrophies).toBe(false);
    expect(hudBarPlan(320, 568, RICH).leagueForm).toBeNull();
    expect(hudBarPlan(412, 915, TYPICAL).leagueForm).toBe('compact');
    expect(hudBarPlan(768, 1024, TYPICAL).leagueForm).toBe('full');
    expect(hudBarPlan(390, 844, TYPICAL).showSol).toBe(false);
    expect(hudBarPlan(480, 900, TYPICAL).showSol).toBe(true);
    // Landscape has width to spare once the nav is a rail — everything shows,
    // however rich the player is.
    const land = hudBarPlan(915, 311, RICH);
    expect(land.showTrophies).toBe(true);
    expect(land.showSol).toBe(true);
  });

  it('budgets floating resource clusters without a reserved navigation column', () => {
    expect(hudBarPlan(480, 320, TYPICAL).inner)
      .toBe(480 - CHROME.clusterPad * 2 - CHROME.barBorderX * 2 - CHROME.hudPad * 2);
    expect(hudBarPlan(915, 311, TYPICAL).inner)
      .toBe(720 - CHROME.barBorderX * 2 - CHROME.hudPad * 2);
    // Width alone never creates a rail: a taller viewport keeps the bottom deck
    // and the full floating-cluster budget.
    expect(hudBarPlan(915, 768, TYPICAL).inner)
      .toBe(720 - CHROME.barBorderX * 2 - CHROME.hudPad * 2);
  });

  it('grows monotonically — a wider phone never shows less', () => {
    for (const values of [TYPICAL, RICH]) {
      let prev = 0;
      for (let w = 300; w <= 1024; w += 1) {
        const plan = hudBarPlan(w, 900, values); // portrait at every width
        const shown = Number(plan.showMineBar) + Number(plan.showTrophies) + Number(plan.showSol);
        expect(shown).toBeGreaterThanOrEqual(prev);
        prev = shown;
      }
    }
  });

  it('degrades instead of exploding when the viewport is not measured yet', () => {
    // useWindowSize() reports 0×0 before its first measure and during SSR. The
    // bar must still be renderable: floor only, nothing promoted.
    const plan = hudBarPlan(0, 0, TYPICAL);
    expect(plan.showMineBar).toBe(false);
    expect(plan.showTrophies).toBe(false);
    expect(plan.showSol).toBe(false);
  });
});

// ===========================================================================
// THE BADGE RULE — the correctness requirement of moving controls off the bar
// ===========================================================================

describe('the overflow control announces anything time-sensitive inside it', () => {
  const idle = { claimAvailable: false, mailUnread: 0, mailPendingRewards: 0 };

  it('is silent when nothing inside needs the player', () => {
    expect(hudOverflowAlert(idle)).toBe(false);
  });

  it('badges a CLAIMABLE DAILY CACHE — the cache expires, so a hidden CLAIM is a lost reward', () => {
    expect(hudOverflowAlert({ ...idle, claimAvailable: true })).toBe(true);
  });

  it('badges UNREAD MAIL', () => {
    expect(hudOverflowAlert({ ...idle, mailUnread: 1 })).toBe(true);
  });

  it('badges MAIL REWARDS STILL IN ESCROW', () => {
    expect(hudOverflowAlert({ ...idle, mailPendingRewards: 1 })).toBe(true);
  });

  it('badges on ANY of them, not all — this is the whole point of moving them', () => {
    // The three states are independent and each is enough on its own. An `&&`
    // slipped in here would hide a claimable cache from every player whose mail
    // happens to be read, which is most of them.
    for (const hot of [
      { ...idle, claimAvailable: true },
      { ...idle, mailUnread: 3 },
      { ...idle, mailPendingRewards: 2 },
      { claimAvailable: true, mailUnread: 3, mailPendingRewards: 2 },
    ]) {
      expect(hudOverflowAlert(hot)).toBe(true);
    }
  });
});

describe('the responsive HUD contract', () => {
  it('separates width tier from the short-landscape rail', () => {
    expect(hudTier(559, 900)).toEqual({ tier: 'compact', rail: false });
    expect(hudTier(560, 900)).toEqual({ tier: 'mid', rail: false });
    expect(hudTier(979, 900).tier).toBe('mid');
    expect(hudTier(980, 900).tier).toBe('wide');
    expect(hudTier(915, 412)).toEqual({ tier: 'mid', rail: true });
    expect(hudTier(1024, 768)).toEqual({ tier: 'wide', rail: false });
  });

  it('collapses the queue on phones and short landscape, but cards it on wider tall views', () => {
    expect(hudQueuePlan(412, 915, 2, 3)).toEqual({ cards: 0, collapsed: true });
    expect(hudQueuePlan(915, 412, 2, 3)).toEqual({ cards: 0, collapsed: true });
    expect(hudQueuePlan(768, 1024, 2, 3)).toEqual({ cards: 2, collapsed: false });
  });

  it('calls an elapsed server row verifying, never collectible READY', () => {
    expect(hudAttention({
      verifyingJobs: 1, idleBuilders: 1, bufferFull: true, overflow: true,
    })).toBe('verifying');
    expect(hudAttention({
      verifyingJobs: 0, idleBuilders: 1, bufferFull: true, overflow: true,
    })).toBe('idle');
    expect(hudAttention({
      verifyingJobs: 0, idleBuilders: 0, bufferFull: false, overflow: false,
    })).toBe(null);
  });

  it('keeps the scene rectangle whole at every tier', () => {
    expect(playArea(412, 915)).toEqual({
      top: 0, bottom: 0, right: 0, width: 412, height: 915,
    });
    expect(playArea(915, 412)).toEqual({
      top: 0, bottom: 0, right: 0, width: 915, height: 412,
    });
    expect(playArea(1440, 900)).toEqual({
      top: 0, bottom: 0, right: 0, width: 1440, height: 900,
    });
  });
});

// ===========================================================================
// BASE CHAT — the launcher shares the responsive HUD's placement decision
//
// The shipped launcher used isPortrait() while the navigation used hudTier().
// At 909×780 that meant "landscape rail" to chat and "bottom deck" to the HUD,
// placing the 48px chat target directly over RAID. True short landscape had a
// second collision: the horizontal task rail occupied chat's bottom-right slot.
// These tests include the launcher's shadow ring and unread badge, plus the task
// buttons' badge overhang, so merely separating the nominal 48px boxes is not
// enough to pass.
// ===========================================================================

const CHAT_TARGET = 48;
const CHAT_RING = 2;
const CHAT_UNREAD_TOP = 8;
const CHAT_UNREAD_RIGHT = 6;

/** QUESTS · CACHE · MAIL · BAG · ARMY · FOUNDING — five since D-096 (owner
 *  2026-09-02: the base-wide troop count is a primary surface, so it lives in
 *  the persistent rail rather than three taps deep), six since D-103 (today's
 *  tester points and streak, same reasoning). The count is what stretches
 *  the rail — horizontally in short landscape, vertically elsewhere — so the
 *  launcher's clearance below is checked against the rail's real extent. */
const TASK_BUTTONS = 6;
interface SafeEdges { right: number; bottom: number }
const NO_SAFE_AREA: SafeEdges = { right: 0, bottom: 0 };

const baseChatTarget = (vw: number, vh: number, safe = NO_SAFE_AREA): Slot => {
  const { right, bottom } = baseChatPlacement(vw, vh);
  return {
    left: vw - safe.right - right - CHAT_TARGET,
    top: vh - safe.bottom - bottom - CHAT_TARGET,
    width: CHAT_TARGET,
    height: CHAT_TARGET,
  };
};

/** Full painted bounds: 2px ink ring, plus the unread badge's −8px top / −6px right. */
const baseChatVisual = (vw: number, vh: number, safe = NO_SAFE_AREA): Slot => {
  const target = baseChatTarget(vw, vh, safe);
  const left = target.left - CHAT_RING;
  const top = target.top - Math.max(CHAT_RING, CHAT_UNREAD_TOP);
  const right = slotRight(target) + Math.max(CHAT_RING, CHAT_UNREAD_RIGHT);
  const bottom = slotBottom(target) + CHAT_RING;
  return { left, top, width: right - left, height: bottom - top };
};

// Actual floating primary group: three 64px targets and two 8px gaps.
const baseNavVisual = (vw: number, vh: number, safe = NO_SAFE_AREA): Slot => ({
  left: vw - safe.right - 8 - 208, top: vh - safe.bottom - 8 - 56, width: 208, height: 56,
});
// Secondary actions live in the modal menu. Only its closed 48px trigger remains.
const baseTaskVisual = (_vw: number, _vh: number, _safe = NO_SAFE_AREA): Slot => ({
  left: 8, top: 8, width: 48, height: 48,
});

const baseSlotsOverlap = (a: Slot, b: Slot): boolean =>
  a.left < slotRight(b) && b.left < slotRight(a) && a.top < slotBottom(b) && b.top < slotBottom(a);

describe('base chat follows the same responsive contract as navigation and tasks', () => {
  const VIEWPORTS: Array<[string, number, number, number, number]> = [
    ['320×568', 320, 568, 10, 72],
    ['375×812', 375, 812, 10, 72],
    ['412×915', 412, 915, 10, 72],
    ['559×900 (last compact px)', 559, 900, 10, 72],
    ['560×900 (first mid px)', 560, 900, 10, 72],
    ['909×780 (reported RAID collision)', 909, 780, 10, 72],
    ['979×768 (last mid px)', 979, 768, 10, 72],
    ['980×768 (first wide px)', 980, 768, 10, 72],
    ['915×499 (last rail px)', 915, 499, 10, 72],
    // REWRITTEN for D-096 (owner 2026-09-02): the fifth task button (ARMY)
    // makes the column reach the corner slot at heights just above the rail
    // cutoff, so the launcher steps left of the column (10 + 44 + 8) there and
    // returns to the corner once the column clears it by CHROME.clusterPad.
    // REWRITTEN AGAIN for D-103 (owner 2026-09-04): the sixth button (FOUNDING)
    // adds one 44px slot and one 6px gap, so the corner returns 50px later —
    // 578 in the mid tier, 564 in compact — and the step-left band grows by
    // exactly that much. The launcher must never paint over a task control.
    ['915×500 (first non-rail px)', 915, 500, 10, 72],
    ['915×577 (last step-left px, mid)', 915, 577, 10, 72],
    ['915×578 (first corner px, mid)', 915, 578, 10, 72],
    ['559×563 (last step-left px, compact)', 559, 563, 10, 72],
    ['559×564 (first corner px, compact)', 559, 564, 10, 72],
    ['568×320', 568, 320, 10, 72],
    ['915×311', 915, 311, 10, 72],
    ['915×412', 915, 412, 10, 72],
    ['1024×768', 1024, 768, 10, 72],
    ['1440×900', 1440, 900, 10, 72],
    ['2560×1440', 2560, 1440, 10, 72],
  ];

  it.each(VIEWPORTS)('%s uses the canonical right/bottom offsets', (_label, vw, vh, right, bottom) => {
    expect(baseChatPlacement(vw, vh)).toEqual({ right, bottom });
  });

  it.each(VIEWPORTS)('%s keeps the target, ink ring and unread badge on screen', (label, vw, vh) => {
    const target = baseChatTarget(vw, vh);
    const visual = baseChatVisual(vw, vh);
    expect(target.width, label).toBe(CHAT_TARGET);
    expect(target.height, label).toBe(CHAT_TARGET);
    expect(visual.left, label).toBeGreaterThanOrEqual(0);
    expect(visual.top, label).toBeGreaterThanOrEqual(0);
    expect(slotRight(visual), label).toBeLessThanOrEqual(vw);
    expect(slotBottom(visual), label).toBeLessThanOrEqual(vh);
  });

  it.each(VIEWPORTS)('%s never paints over navigation or a task control', (label, vw, vh) => {
    const chat = baseChatVisual(vw, vh);
    expect(baseSlotsOverlap(chat, baseNavVisual(vw, vh)), `${label}: chat ∩ navigation`).toBe(false);
    expect(baseSlotsOverlap(chat, baseTaskVisual(vw, vh)), `${label}: chat ∩ tasks`).toBe(false);
  });

  it('preserves visible breathing room after both controls paint outside their target boxes', () => {
    for (const [w, h] of [[320, 640], [915, 311], [1280, 800]] as const) {
      expect(baseNavVisual(w, h).top - slotBottom(baseChatVisual(w, h))).toBeGreaterThanOrEqual(6);
      expect(baseSlotsOverlap(baseChatVisual(w, h), baseTaskVisual(w, h))).toBe(false);
    }
  });

  it('models the rail with the button count the chrome renders', () => {
    // The geometry above is derived independently on purpose, but the one
    // input it cannot re-derive is how many buttons Overlay mounts; the
    // solver's constant and this model must name the same rail.
    expect(CHROME.taskButtons).toBe(TASK_BUTTONS);
  });

  it('safe-area offsets can move the painted launcher inward without being applied by the solver twice', () => {
    const safe = { right: 24, bottom: 34 };
    for (const [vw, vh] of [[375, 812], [915, 412]] as const) {
      const target = baseChatTarget(vw, vh, safe);
      const visual = baseChatVisual(vw, vh, safe);
      const placement = baseChatPlacement(vw, vh);
      expect(vw - safe.right - slotRight(target)).toBe(placement.right);
      expect(vh - safe.bottom - slotBottom(target)).toBe(placement.bottom);
      expect(slotRight(visual)).toBeLessThanOrEqual(vw - safe.right);
      expect(slotBottom(visual)).toBeLessThanOrEqual(vh - safe.bottom);
      expect(baseSlotsOverlap(visual, baseNavVisual(vw, vh, safe))).toBe(false);
      expect(baseSlotsOverlap(visual, baseTaskVisual(vw, vh, safe))).toBe(false);
    }
  });
});

// ===========================================================================
// MAP CHROME — the WORLD / CAMPAIGN boards (added with the P0 layout fix)
//
// The bug these pin: both boards placed every control with a bare literal and
// no shared stacking discipline, so on a 375×812 phone the region banner sat
// BEHIND the mode tabs, HIDE SHIELDED was cut in half at the right edge, the
// search box bled across the map, and at the owner's measured landscape window
// the zoom rail's `+` pill landed at y −11 — off-screen. A slot solver can be
// asserted; a pile of literals can only be eyeballed on a device.
// ===========================================================================

/** The viewports the boards are DESIGNED to, smallest first. The two measured
 *  device windows above are included so the map is held to the same evidence
 *  the base view is. */
const MAP_VIEWPORTS: Array<[string, number, number]> = [
  ['320×568 (smallest phone still in the wild)', 320, 568],
  ['390×844 (iPhone 14/15)', 390, 844],
  ['412×914 (large Android portrait)', 412, 914],
  ['915×412 (phone landscape)', 915, 412],
  ['915×311 (owner measured landscape viewport)', ...LAND],
  ['412×814 (owner measured portrait viewport)', ...PORT],
  // SMALL LANDSCAPE — the two viewports that broke, added 2026-08-09. Both sit
  // just at/above MAPCHROME.labelMinW (480) yet have far too little WIDTH for a
  // labelled rail laid out as a landscape ROW, which is the case the solver used
  // to get wrong: see the dedicated describe block below for the numbers.
  ['568×320 (small phone landscape)', 568, 320],
  ['480×320 (labelMinW exactly, in landscape)', 480, 320],
];

const overlaps = (a: Slot, b: Slot): boolean =>
  a.left < slotRight(b) && b.left < slotRight(a) && a.top < slotBottom(b) && b.top < slotBottom(a);

describe('map chrome: no two slots may overlap, at any viewport, in any sheet state', () => {
  for (const [label, vw, vh] of MAP_VIEWPORTS) {
    // Both ends of the sheet's travel: at rest (peek) and fully expanded. The
    // expanded case is the one the old literals got wrong, because the zoom
    // rail's offset was a constant tuned to ONE board's ONE sheet height.
    for (const state of ['peek', 'expanded'] as const) {
      const probe = mapChrome(vw, vh, state === 'peek' ? MAPCHROME.peek : Number.MAX_SAFE_INTEGER);
      const L = mapChrome(vw, vh, state === 'peek' ? MAPCHROME.peek : probe.sheetMax);
      const named: Array<[string, Slot]> = [
        ['bar', L.bar], ['chat', L.chat], ['underBar', L.underBar], ['rail', L.rail], ['sheet', L.sheet],
        ...(L.zoom ? ([['zoom', L.zoom]] as Array<[string, Slot]>) : []),
      ];

      it(`${label} · ${state}: every slot is inside the viewport`, () => {
        for (const [name, s] of named) {
          expect(s.left, `${name}.left`).toBeGreaterThanOrEqual(0);
          expect(s.top, `${name}.top`).toBeGreaterThanOrEqual(0);
          expect(slotRight(s), `${name}.right vs vw`).toBeLessThanOrEqual(vw);
          expect(slotBottom(s), `${name}.bottom vs vh`).toBeLessThanOrEqual(vh);
        }
      });

      it(`${label} · ${state}: no pair of slots intersects`, () => {
        for (let i = 0; i < named.length; i++) {
          for (let j = i + 1; j < named.length; j++) {
            const [an, a] = named[i]!, [bn, b] = named[j]!;
            expect(overlaps(a, b), `${an} ∩ ${bn}`).toBe(false);
          }
        }
      });

      it(`${label} · ${state}: every interactive slot clears 44px on its short axis`, () => {
        for (const [name, s] of named) {
          if (name === 'sheet' || name === 'bar') continue; // bar IS 44; sheet is a surface
          expect(Math.min(s.width, s.height), `${name} short axis`).toBeGreaterThanOrEqual(MAPCHROME.tap);
        }
        expect(L.bar.height).toBe(MAPCHROME.tap);
        // A peek sheet must still be able to hold one 44px row of controls.
        expect(MAPCHROME.peek).toBeGreaterThanOrEqual(MAPCHROME.tap);
      });

      it(`${label} · ${state}: the search list never runs under the sheet`, () => {
        expect(L.searchMax).toBeGreaterThanOrEqual(0);
        expect(slotBottom(L.underBar) + MAPCHROME.pad + L.searchMax).toBeLessThanOrEqual(L.sheet.top);
      });
    }
  }
});

describe('map chrome: the specific collisions reported on a 375×812 phone', () => {
  const L = mapChrome(375, 812);

  it('uses the same exported chat slot consumed by the launcher', () => {
    expect(L.chat).toEqual(mapChatSlot());
  });

  it('gives the top bar ONE full-width 44px row — nothing else may enter it', () => {
    expect(L.bar).toEqual({ left: 0, top: 0, width: 375, height: 44 });
    // Everything else starts BELOW it, so a banner sprite can no longer be
    // clipped behind the mode tabs: they are the same row by construction.
    for (const s of [L.chat, L.underBar, L.rail]) expect(s.top).toBeGreaterThanOrEqual(slotBottom(L.bar));
  });

  it('keeps the right-hand toggle rail on screen (HIDE SHIELDED was cut in half)', () => {
    expect(slotRight(L.rail)).toBe(375 - MAPCHROME.pad);
    expect(L.rail.width).toBe(MAPCHROME.tap); // icon-only below labelMinW
    expect(L.showLabels).toBe(false); // 375 < 480 → icons, which is why it fits
  });

  it('never lets the search field span the viewport as a fixed 230px box', () => {
    // It is derived from the viewport, starts after chat, and stops short of
    // the rail instead of rendering beneath either control.
    expect(L.underBar.width).toBe(
      375 - 2 * MAPCHROME.tap - 3 * MAPCHROME.pad - MAPCHROME.gap,
    );
    expect(slotRight(L.chat)).toBeLessThanOrEqual(L.underBar.left);
    expect(slotRight(L.underBar)).toBeLessThan(L.rail.left);
  });

  it('keeps the labelled desktop rail (today\'s look) once there is width for it', () => {
    expect(mapChrome(MAPCHROME.labelMinW - 1, 900).showLabels).toBe(false);
    const tablet = mapChrome(768, 1024); // portrait ⇒ labelled COLUMN
    expect(tablet.showLabels).toBe(true);
    expect(tablet.rail.width).toBe(MAPCHROME.railLabelW);
    expect(slotRight(tablet.rail)).toBe(768 - MAPCHROME.pad);
    expect(slotRight(tablet.underBar)).toBeLessThan(tablet.rail.left);

    const desktop = mapChrome(1280, 900); // landscape ⇒ labelled ROW
    expect(desktop.rail.height).toBe(MAPCHROME.tap);
    expect(desktop.rail.width).toBe(3 * MAPCHROME.railLabelW + 2 * MAPCHROME.gap);
    expect(slotRight(desktop.rail)).toBe(1280 - MAPCHROME.pad);
    expect(slotRight(desktop.underBar)).toBeLessThan(desktop.rail.left);
  });
});

describe('map chrome: the zoom rail is derived from the sheet, not a magic 210', () => {
  it('the old constant put the + pill OFF-SCREEN at the measured landscape window', () => {
    // What shipped: `bottom: 210` with a 34px-tall pill column of 3 → the top
    // pill sat at y = 311 − 210 − (34*3 + 5*2) = −11.
    expect(LAND[1] - 210 - (34 * 3 + 5 * 2)).toBeLessThan(0);
    // What the solver does: on screen, or not rendered at all.
    const L = mapChrome(...LAND, MAPCHROME.peek);
    expect(L.zoom).not.toBeNull();
    expect(L.zoom!.top).toBeGreaterThan(0);
    expect(slotBottom(L.zoom!)).toBeLessThanOrEqual(L.sheet.top);
  });

  it('rides above the sheet at whatever height the sheet published', () => {
    const peek = mapChrome(390, 844, MAPCHROME.peek);
    const open = mapChrome(390, 844, 300);
    expect(slotBottom(peek.zoom!)).toBeLessThanOrEqual(peek.sheet.top);
    expect(slotBottom(open.zoom!)).toBeLessThanOrEqual(open.sheet.top);
    expect(open.zoom!.top).toBeLessThan(peek.zoom!.top); // it moved up with the sheet
  });

  it('is dropped rather than overlapped when the band is too short', () => {
    // A fully expanded sheet in the measured landscape window leaves ~44px of
    // map between the rail and the sheet — not enough for a 44px cluster plus
    // its gaps. Pinch / wheel / double-tap still zoom, so dropping it is safe.
    const L = mapChrome(...LAND, mapChrome(...LAND, Number.MAX_SAFE_INTEGER).sheetMax);
    expect(L.zoom).toBeNull();
  });
});

describe('map chrome: the sheet can never bury the rail or lose its own ✕', () => {
  it('caps an expanded sheet short of the rail at every viewport', () => {
    for (const [label, vw, vh] of MAP_VIEWPORTS) {
      const L = mapChrome(vw, vh, Number.MAX_SAFE_INTEGER);
      expect(L.sheet.height, label).toBe(L.sheetMax);
      expect(L.sheet.top, label).toBeGreaterThanOrEqual(slotBottom(L.rail) + MAPCHROME.pad);
      // …and the header (with the ✕) is inside the viewport, which the campaign
      // stage sheet was not: it had no maxHeight, so a tall body pushed Phead
      // above y=0 and the sheet became unclosable.
      expect(L.sheet.top, label).toBeGreaterThan(0);
    }
  });

  it('still leaves the majority of a portrait board visible', () => {
    const L = mapChrome(390, 844, Number.MAX_SAFE_INTEGER);
    expect(L.sheetMax).toBeLessThanOrEqual(Math.round(844 * (MAPCHROME.sheetPct / 100)));
    expect(844 - L.sheetMax).toBeGreaterThan(844 * 0.4);
  });
});

describe('map chrome: landscape collapses the rail the way the base HUD does', () => {
  it('is a 44px COLUMN in portrait and a 44px ROW in landscape', () => {
    const p = mapChrome(390, 844);
    const l = mapChrome(...LAND);
    expect(p.portrait).toBe(true);
    expect(p.rail.width).toBe(MAPCHROME.tap);
    expect(p.rail.height).toBeGreaterThan(MAPCHROME.tap); // stacked
    expect(l.portrait).toBe(false);
    expect(l.rail.height).toBe(MAPCHROME.tap); // height is the scarce axis
    expect(l.rail.width).toBeGreaterThan(MAPCHROME.tap);
  });

  it('fits the rail inside the measured landscape height with room for a sheet', () => {
    const l = mapChrome(...LAND);
    expect(slotBottom(l.rail)).toBeLessThan(LAND[1] - MAPCHROME.peek);
  });
});

// ---------------------------------------------------------------------------
// SMALL LANDSCAPE — the defect the globe's extra rail row made reachable.
//
// In landscape the rail is a ROW, so its horizontal extent is railRows·itemW +
// gaps. At vw ≥ labelMinW (480) itemW was unconditionally the 148px LABELLED
// item, so a 4-row rail wanted 4·148 + 3·6 = 610px — wider than a 568px or a
// 480px landscape phone. There was no lower clamp on `rail.left` (contrast the
// zoom slot, which IS rejected on left < 0), so the rail was placed at a
// negative left, off the left edge, and `underBar.width = vw − rail.width − 3·pad`
// went to 0: the search field / ACT strip vanished. Worst with the globe flag ON
// because that is the 4th row.
//
// These assert the fix in NUMBERS, at both rail counts, so a future control
// added to the rail fails here rather than on a device.
// ---------------------------------------------------------------------------
describe('map chrome: small landscape viewports, with and without the globe rail row', () => {
  const SMALL_LAND: Array<[string, number, number]> = [
    ['568×320', 568, 320],
    ['480×320', 480, 320],
  ];
  // 3 = the pre-globe WORLD board (war room / hide shielded / legend);
  // 4 = the same board with the GLOBE button (railRowsForWorld(true)).
  const RAIL_ROWS = [3, 4];

  for (const [label, vw, vh] of SMALL_LAND) {
    for (const rows of RAIL_ROWS) {
      const solve = (sheetH: number): ReturnType<typeof mapChrome> => mapChrome(vw, vh, sheetH, rows, 3);
      const states: Array<[string, number]> = [
        ['peek', MAPCHROME.peek],
        ['expanded', solve(Number.MAX_SAFE_INTEGER).sheetMax],
      ];

      for (const [state, sheetH] of states) {
        const L = solve(sheetH);
        const named: Array<[string, Slot]> = [
          ['bar', L.bar], ['chat', L.chat], ['underBar', L.underBar], ['rail', L.rail], ['sheet', L.sheet],
          ...(L.zoom ? ([['zoom', L.zoom]] as Array<[string, Slot]>) : []),
        ];

        it(`${label} · ${rows} rail rows · ${state}: no slot leaves the viewport`, () => {
          for (const [name, s] of named) {
            expect(s.left, `${name}.left`).toBeGreaterThanOrEqual(0);
            expect(s.top, `${name}.top`).toBeGreaterThanOrEqual(0);
            expect(slotRight(s), `${name}.right vs ${vw}`).toBeLessThanOrEqual(vw);
            expect(slotBottom(s), `${name}.bottom vs ${vh}`).toBeLessThanOrEqual(vh);
          }
        });

        it(`${label} · ${rows} rail rows · ${state}: no slot pair intersects`, () => {
          for (let i = 0; i < named.length; i++) {
            for (let j = i + 1; j < named.length; j++) {
              const [an, a] = named[i]!, [bn, b] = named[j]!;
              expect(overlaps(a, b), `${an} ∩ ${bn}`).toBe(false);
            }
          }
        });

        it(`${label} · ${rows} rail rows · ${state}: the under-bar row survives the rail`, () => {
          // The collapse-to-zero defect, stated as the thing it destroyed: the
          // search field and the campaign ACT strip live in this row, and a row
          // narrower than one touch target cannot hold either.
          expect(L.underBar.width).toBeGreaterThanOrEqual(MAPCHROME.tap);
          expect(slotRight(L.chat)).toBeLessThanOrEqual(L.underBar.left);
          expect(slotRight(L.underBar)).toBeLessThanOrEqual(L.rail.left);
        });
      }

      it(`${label} · ${rows} rail rows: the rail is the widest shape that FITS`, () => {
        const L = solve(MAPCHROME.peek);
        const itemW = L.showLabels ? MAPCHROME.railLabelW : MAPCHROME.tap;
        expect(L.rail.height).toBe(MAPCHROME.tap); // landscape ⇒ a ROW
        expect(L.rail.width).toBe(rows * itemW + (rows - 1) * MAPCHROME.gap);
        expect(slotRight(L.rail)).toBe(vw - MAPCHROME.pad);
        // The labels are dropped IF AND ONLY IF the labelled rail could not have
        // been placed on screen with a usable under-bar row beside it — the
        // fallback is driven by fit, not by a second breakpoint. And `showLabels`
        // has to follow the shape that fits, because a labelled button rendered
        // into a 44px slot is the same overflow one layer down.
        const labelled = rows * MAPCHROME.railLabelW + (rows - 1) * MAPCHROME.gap;
        const labelledFits = vw >= MAPCHROME.labelMinW
          && vw - MAPCHROME.pad - labelled >= 0
          && vw - labelled - 3 * MAPCHROME.pad - MAPCHROME.tap - MAPCHROME.gap >= MAPCHROME.tap;
        expect(L.showLabels).toBe(labelledFits);
      });
    }
  }

  it('568×320 + the GLOBE row: the labelled rail was placed at left −50 with a 0px under-bar', () => {
    const labelled = 4 * MAPCHROME.railLabelW + 3 * MAPCHROME.gap;
    expect(labelled).toBe(610);
    expect(568 - MAPCHROME.pad - labelled).toBe(-50); // what shipped: off the left edge
    expect(Math.max(0, 568 - labelled - 3 * MAPCHROME.pad)).toBe(0); // and the row vanished
    const L = mapChrome(568, 320, MAPCHROME.peek, 4, 3);
    expect(L.showLabels).toBe(false);
    expect(L.rail.left).toBeGreaterThan(0);
    expect(L.underBar.width).toBeGreaterThanOrEqual(MAPCHROME.tap);
  });

  it('480×320 loses the labels at THREE rows too — that rail starves the under-bar row', () => {
    // 456px: it would have fitted on screen, which is why an edge-only clamp is
    // not enough. It leaves the search field / ACT strip exactly 0px.
    const labelled = 3 * MAPCHROME.railLabelW + 2 * MAPCHROME.gap;
    expect(480 - MAPCHROME.pad - labelled).toBeGreaterThanOrEqual(0);
    expect(480 - labelled - 3 * MAPCHROME.pad).toBeLessThan(MAPCHROME.tap);
    const L = mapChrome(480, 320, MAPCHROME.peek, 3, 3);
    expect(L.showLabels).toBe(false);
    expect(L.underBar.width).toBeGreaterThanOrEqual(MAPCHROME.tap);
  });

  it('still keeps labels where there IS width for them (no blanket regression)', () => {
    // The fallback must be driven by FIT, not by orientation or by a new
    // breakpoint: a 915px landscape phone keeps the labelled rail at both rail
    // counts, which is the look the owner has already accepted.
    for (const rows of RAIL_ROWS) {
      const L = mapChrome(...LAND, MAPCHROME.peek, rows, 3);
      expect(L.showLabels, `${rows} rows @915`).toBe(true);
      expect(L.rail.width).toBe(rows * MAPCHROME.railLabelW + (rows - 1) * MAPCHROME.gap);
      expect(L.underBar.width).toBeGreaterThanOrEqual(MAPCHROME.tap);
    }
    // …and a labelled PORTRAIT column is unaffected: only one item is wide there.
    expect(mapChrome(768, 1024, MAPCHROME.peek, 4, 3).showLabels).toBe(true);
  });
});

describe('map chrome: zoom-invariant tap targets inside the scaled layer', () => {
  it('a stage node hit rect is 44 ON SCREEN at every zoom the board allows', () => {
    // ZOOM = { min: 0.7, max: 1.6 } in map.tsx; the hit rect is authored in
    // layer units, so its on-screen size is size*z and must stay 44.
    for (const z of [0.7, 1, 1.3, 1.6]) {
      expect(hitSizeAt(z) * z).toBeCloseTo(MAPCHROME.tap, 6);
    }
    // The defect this replaces: a 43px node sprite at min zoom measured 30px.
    expect(43 * 0.7).toBeLessThan(MAPCHROME.tap);
  });
});

/**
 * Owner 2026-08-30, from a screenshot: the base-tools dock was clipped in half
 * whenever a destination was refused.
 *
 * MECHANISM: the nav deck had no explicit height, so it sized to its tallest
 * item. A refused BUILD renders "READ ONLY", which wrapped to two lines, grew
 * the deck past CHROME.navBar, and pushed it up through the dock -- which is
 * positioned at `bottom: navBar` and has no way to notice. Measured before the
 * fix at 360x800: dock y=664 h=44 (ends 708), nav y=708 -- a ZERO-pixel gap, so
 * a single pixel of growth was already a visible defect.
 *
 * This pins the contract rather than the symptom: CHROME.navBar is subtracted
 * by playArea() and depended on by every bottom sheet, so a deck that can
 * exceed it makes all of those silently wrong, not just the dock.
 */
describe('the nav deck cannot grow into the base-tools dock', () => {
  it('pins its own height to CHROME.navBar in portrait', () => {
    const deck = hudDeckStyle(true) as Record<string, unknown>;
    expect(deck['height']).toBeUndefined();
    expect(deck['pointerEvents']).toBe('none');
  });

  it('leaves the landscape rail free-height, because it is a column not a row', () => {
    // The rail spans top:0 to bottom:0 and scrolls its items; pinning a height
    // there would be meaningless and would fight the 311px landscape case.
    const rail = hudDeckStyle(false) as Record<string, unknown>;
    expect(rail['height']).toBeUndefined();
    expect(rail['width']).toBeUndefined();
    expect(rail['top']).toBeUndefined();
  });
});


it('native Gems chip width is budgeted without clipping currency values on narrow viewports', () => {
  const values = { shards: '7,038,871', keep: '1,204,880', trophies: '4,120', leagueRail: 'TOP TIER', sol: '12.500' };
  const legacy = hudBarPlan(320, 568, values), gems = hudBarPlan(320, 568, { ...values, currencyIconSize: 24 });
  expect(gems.used).toBe(legacy.used + 4);
  for (const width of [320, 360, 390, 412, 480, 768, 915]) {
    const plan = hudBarPlan(width, 568, { ...values, currencyIconSize: 24 });
    expect(plan.used).toBeLessThanOrEqual(plan.inner);
  }
});
