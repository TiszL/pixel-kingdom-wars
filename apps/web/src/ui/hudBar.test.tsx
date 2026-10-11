/** @vitest-environment happy-dom */
/**
 * THE SINGLE-ROW HUD — what the rebuild is allowed to move, and what it is not
 * allowed to lose.
 *
 * The owner reported the same defect from production three times: "top black
 * bars are ugly also not aligned well for mobile first ... there are many black
 * bar things ... you should arrange this many things optimally also not to have
 * problem with seeing game world". The base HUD carried 16–18 always-visible
 * chips; in portrait its flex-wrap rows broke into FIVE visual rows over the
 * play field, and in landscape the tail of the row was reachable only by an
 * unadvertised horizontal drag. The fix moves controls off the bar — and the
 * moment you move a control, two things can silently break:
 *
 *   1. A TIME-SENSITIVE action becomes invisible. That is the badge rule, and
 *      it is the single most important assertion in this lane.
 *   2. A control becomes UNREACHABLE, or reachable only at some screen widths.
 *
 * Both are pinned below. The geometry that decides which chips the row can hold
 * lives in layout.test.ts (hudBarPlan); this file is about the DOM those
 * decisions produce.
 *
 * Most contracts use static markup. The responsive deck also needs a live DOM:
 * React's updates can lose padding even when each individual style is correct.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { CHROME, navBtnPad } from './layout';
import {
  HudChip, HudChromeStyle, HudLevelRail, HudNavButton, HudPlayerMenuButton,
  HudPrimaryButton, HudQueueCard, HudQueueSummary, HudSheetHead, HudStatDelta,
  HudTaskButton, HudTaskRail, hudBarRowStyle, hudBarStyle, hudChipStyle, hudDeckRim,
  hudDeckStyle, HudOverflowButton, hudStripStyle, hudTabStyle,
} from './hudChrome';
import { HudBaseDock, HudOverflowPanel, type HudOverflowProps } from './hudOverflow';
import { shieldChipView } from './baseDefences';
import { COLORS as C, Toast } from './primitives';

/**
 * Everything after the chrome's `<style>` block — i.e. the button itself.
 *
 * The stylesheet names the pressed sprite (it is what `:active` swaps to), so a
 * bare substring match on the whole markup would report "the open state uses the
 * pressed plate" even when the button is shut. Every sprite assertion below is
 * made against the element, never against the stylesheet that mentions it.
 */
const el = (html: string): string => html.slice(html.lastIndexOf('</style>'));

/** A plain landowning player on a narrow phone: nothing promoted into the bar,
 *  so the panel is carrying every displaced control. */
const IDLE: HudOverflowProps = {
  portrait: true,
  barHasTrophies: false,
  barHasSol: false,
  sol: 1.25,
  trophies: 412,
  energy: { free: 3, max: 5 },
  shield: {
    label: '1D 23H', ariaLabel: 'Shield · 1D 23H — open raid log',
    color: '#7ec8f2', accent: undefined, go: 'raidlog',
  },
  quests: { done: 1, total: 3 },
  claim: { available: false, day: 4, enabled: true },
  mail: { unread: 0, pending: 0 },
  isAdmin: false,
  selectorEnabled: false,
  needsBaseSelect: false,
  onGo: vi.fn(),
  onClose: vi.fn(),
};

const panel = (over: Partial<HudOverflowProps> = {}): string =>
  renderToStaticMarkup(<HudOverflowPanel {...IDLE} {...over} />);

/** A landowner with one builder free — the dock's ordinary state. */
const dockMarkup = (over: Partial<Parameters<typeof HudBaseDock>[0]> = {}): string =>
  renderToStaticMarkup(
    <HudBaseDock enabled free={2} total={3} onGo={vi.fn()} onFit={vi.fn()} {...over} />,
  );

// ===========================================================================
// 1. THE BADGE RULE
// ===========================================================================

describe('the overflow control cannot hide a time-sensitive action', () => {
  it('carries a badge when the daily cache is claimable', () => {
    // THE REGRESSION THIS CATCHES: someone moves CLAIM into the panel (correct)
    // and drops the badge (fatal). The daily cache expires, so a player who
    // cannot see that it is ready simply loses it — the reward is gone, not
    // deferred. If this test fails, the bar is lying about the game state.
    const html = renderToStaticMarkup(
      <HudOverflowButton open={false} alert onToggle={vi.fn()} />,
    );
    // The class, not the substring: the keyframes live in a <style> block that
    // is always emitted, so a bare 'hud-badge' match would pass with no bead.
    expect(html).toContain('class="hud-badge"');
    expect(el(html)).toContain('hudchrome-hud_alert_tag');
    // The colour cue alone is not the whole promise — the same fact has to
    // reach a screen reader.
    expect(html).toContain('ACTION NEEDED');
  });

  it('carries no badge when nothing inside needs the player', () => {
    // A badge that is always on is the same defect as no badge at all.
    const html = renderToStaticMarkup(
      <HudOverflowButton open={false} alert={false} onToggle={vi.fn()} />,
    );
    expect(html).not.toContain('class="hud-badge"');
    expect(html).not.toContain('hudchrome-hud_alert_tag');
    expect(html).not.toContain('ACTION NEEDED');
  });

  it('is a real button that announces its panel', () => {
    const shut = renderToStaticMarkup(<HudOverflowButton open={false} alert={false} onToggle={vi.fn()} />);
    const open = renderToStaticMarkup(<HudOverflowButton open alert={false} onToggle={vi.fn()} />);
    expect(shut).toContain('aria-expanded="false"');
    expect(open).toContain('aria-expanded="true"');
    expect(shut).toContain('aria-haspopup="dialog"');
    expect(shut).toContain('aria-label="More"');
    // The plate changes with the state; both masters must be wired. Asserted on
    // the BUTTON, not the markup: the stylesheet names the pressed sprite too.
    expect(el(shut)).toContain('hudchrome-hud_btn_overflow_idle');
    expect(el(shut)).not.toContain('hudchrome-hud_btn_overflow_press');
    expect(el(open)).toContain('hudchrome-hud_btn_overflow_press');
    expect(el(open)).not.toContain('hudchrome-hud_btn_overflow_idle');
  });

  it('has a pressed state for a finger, not only for the open panel', () => {
    // The owner's critique #2: the shipped control was a generic square whose
    // "active" look was a hue swap. A player who taps and holds must see the
    // plate go into its socket BEFORE the panel opens, or the button does not
    // feel like a physical thing. :active cannot be expressed as an inline
    // style, and an inline background outranks a stylesheet rule, so the
    // !important here is load-bearing rather than lazy.
    const shut = renderToStaticMarkup(<HudOverflowButton open={false} alert={false} onToggle={vi.fn()} />);
    expect(shut).toContain('.hud-overflow:active{background-image:url(');
    expect(shut).toContain('hud_btn_overflow_press.png) !important}');
    expect(shut).toContain('class="interactive hud-overflow"');
  });

  it('keeps the whole bead on screen where the plate has no top edge', () => {
    // LANDSCAPE ONLY. The bar drops its 6px top chamfer there to clear the
    // Seeker's 311px webview, so the badge's usual -3px overhang would be cut
    // off by the viewport itself — clipping the one signal the panel cannot
    // afford to lose, in the orientation that is hardest to lay out.
    const portrait = renderToStaticMarkup(<HudOverflowButton open={false} alert onToggle={vi.fn()} />);
    const landscape = renderToStaticMarkup(<HudOverflowButton open={false} alert flushTop onToggle={vi.fn()} />);
    expect(portrait).toContain('top:-3px');
    expect(landscape).toContain('top:0');
    expect(landscape).not.toContain('top:-3px');
    // The horizontal overhang survives in both: it lands in the plate's inner
    // padding, which is what that padding is for.
    expect(landscape).toContain('right:-3px');
  });

  it('is a full tap target and never shrinks out of the row', () => {
    const html = renderToStaticMarkup(<HudOverflowButton open={false} alert onToggle={vi.fn()} />);
    expect(html).toContain(`width:${CHROME.tapRow}px`);
    expect(html).toContain(`height:${CHROME.tapRow}px`);
    // flex:0 0 auto — the way OUT of the bar must not be the thing that gives
    // way when a currency value gets long. That was the landscape defect.
    expect(html).toContain('flex:0 0 auto');
  });
});

// ===========================================================================
// 2. THE CURRENCY HIERARCHY
// ===========================================================================

describe('KEEP never looks like an ordinary resource', () => {
  /**
   * THE REGRESSION THIS CATCHES, and why it is not a taste test. The first thing
   * production reported was a player spending KEEP by accident because it
   * carried the same visual weight as shards. Shards are mined and refunded;
   * KEEP is bought. So "the two currencies are told apart at a glance" is a
   * correctness requirement wearing a visual costume, and the way it dies is
   * quietly: someone factors the two plates back into one master, or makes the
   * difference a shade of the same one, and nothing fails.
   *
   * The assertion is therefore on the ASSET, not on a colour value — two plates
   * that differ by a tint would still pass a colour check and still lose the
   * distinction in peripheral vision.
   */
  it('is cut from a different plate than every other readout', () => {
    const keep = hudChipStyle('keep').borderImageSource as string;
    const shard = hudChipStyle('shard').borderImageSource as string;
    expect(keep).not.toBe(shard);
    expect(keep).toContain('hud_plate_keep_9slice');
    expect(shard).toContain('hud_plate_shard_9slice');
  });

  it('leaves the plain plate as the default, so only KEEP is precious', () => {
    // Every panel row and every dock button calls hudChipStyle() with no
    // argument. If the default ever became the gold plate, "precious" would mean
    // nothing because everything would be it.
    expect(hudChipStyle().borderImageSource).toBe(hudChipStyle('shard').borderImageSource);
  });

  it('carries the hierarchy into the rendered chip, not just the helper', () => {
    const keep = renderToStaticMarkup(<HudChip plate="keep">12,450</HudChip>);
    const plain = renderToStaticMarkup(<HudChip>7,038,871</HudChip>);
    expect(keep).toContain('hud_plate_keep_9slice');
    expect(keep).not.toContain('hud_plate_shard_9slice');
    expect(plain).toContain('hud_plate_shard_9slice');
    expect(plain).not.toContain('hud_plate_keep_9slice');
  });

  it('keeps both plates on the measured 3px inset', () => {
    // HUD_CHIP.base (43) was measured in headless Chromium and INCLUDES this
    // border on both sides. A richer 4px KEEP bezel would silently widen exactly
    // one chip and perturb the solver that stops a 7-digit shard count rendering
    // clipped on a 320px phone. The plates differ by material, never by size.
    expect(hudChipStyle('keep').borderWidth).toBe(CHROME.chipBorder);
    expect(hudChipStyle('shard').borderWidth).toBe(CHROME.chipBorder);
    expect(hudChipStyle('keep').borderImageSlice).toBe(hudChipStyle('shard').borderImageSlice);
  });
});

// ===========================================================================
// 3. ONE ROW, STRUCTURALLY
// ===========================================================================

describe('floating resource groups retain readable targets', () => {
  it('wraps long balances without clipping digits', () => {
    // The old portrait HUD used flexWrap:'wrap' on three rows, so a narrow
    // phone silently turned 3 rows into 5. Budgeting cannot prevent that;
    // nowrap can. A chip clips inside its own well instead.
    expect(hudBarRowStyle().flexWrap).toBe('wrap');
  });

  it('is exactly one tap row tall', () => {
    // Not content-driven: a fixed row cannot grow back into a second one when
    // someone adds a chip with taller content.
    expect(hudBarRowStyle().minHeight).toBe(CHROME.tapRow);
  });

  it('stretches its chips to the tap floor instead of centring short pills in it', () => {
    // The chips ARE the tap targets now, so alignItems must stretch — centring
    // 26px readouts in a 44px row is how the sub-44px targets got there before.
    expect(hudBarRowStyle().alignItems).toBe('stretch');
  });
});

// ===========================================================================
// 4. NOTHING BECAME UNREACHABLE
// ===========================================================================

describe('every control displaced from the bar is still one tap away', () => {
  /** The controls the audit found in the old always-visible HUD that are not
   *  part of the new bar's floor (shards / KEEP / overflow) and are not base
   *  actions (those are the dock, below). */
  const DISPLACED = [
    ['SOL balance', 'SOL'],
    ['Ranked leagues', 'TROPHIES'],
    ['Energy', 'ENERGY'],
    ['Shield · 1D 23H — open raid log', 'RAID LOG'],
    ['Daily quests', 'QUESTS'],
    ['Daily cache', 'CACHE'],
    ['Mail', 'MAIL'],
    ['Open inventory', 'INVENTORY'],
    // D-103: the bare TESTER row became FOUNDING KINGDOMS — same destination,
    // now carrying today's points and streak once the server has answered.
    ['Founding Kingdoms', 'FOUNDING'],
    ['Settings and profile', 'SETTINGS'],
  ] as const;

  it.each(DISPLACED)('the panel carries %s', (label) => {
    expect(panel()).toContain(`aria-label="${label}"`);
  });

  it('carries the two conditional controls exactly on their conditions', () => {
    // BASES appears only for a player who holds more than one deed; ADMIN only
    // after the one-per-wallet probe. Moving them must not change either gate.
    expect(panel()).not.toContain('aria-label="Bases"');
    expect(panel()).not.toContain('aria-label="Admin"');
    const privileged = panel({ selectorEnabled: true, isAdmin: true });
    expect(privileged).toContain('aria-label="Bases"');
    expect(privileged).toContain('aria-label="Admin"');
    // BASES · SELECT — the state where no base is chosen on this device.
    expect(panel({ selectorEnabled: true })).toContain('BASES');
    expect(panel({ selectorEnabled: true, needsBaseSelect: true })).toContain('SELECT');
  });

  it('never shows a chip in BOTH the bar and the panel', () => {
    // UNION, NEVER INTERSECTION. The same hudBarPlan boolean drives the bar's
    // chip and the panel's row, so a control is in exactly one place at any
    // width — which is what makes "still reachable" independent of screen size
    // instead of a property that holds at 390px and fails at 360px.
    expect(panel({ barHasTrophies: true })).not.toContain('aria-label="Ranked leagues"');
    expect(panel({ barHasSol: true })).not.toContain('aria-label="SOL balance"');
    expect(panel({ barHasTrophies: false })).toContain('aria-label="Ranked leagues"');
    expect(panel({ barHasSol: false })).toContain('aria-label="SOL balance"');
  });

  it('keeps every panel row at the 44px tap floor', () => {
    // Solana Seeker and every notched phone: iOS HIG 44pt / WCAG 2.5.5. A panel
    // that solves the bar by making everything inside it tiny has not solved
    // anything.
    expect(panel()).toContain(`min-height:${CHROME.tapRow}px`);
  });

  it('scrolls internally rather than growing past the viewport', () => {
    // In the 311px-tall Seeker landscape webview a twelve-row list does not
    // fit whatever we do. A panel that grew would push SETTINGS off the bottom
    // edge — the exact class of defect this lane exists to remove.
    expect(panel({ portrait: false })).toContain('overflow-y:auto');
    expect(panel({ portrait: false })).toContain('max-height:calc(var(--game-viewport-height, 100dvh)');
  });

  it.each([[568, 320, 0, 0], [844, 320, 0, 21], [844, 390, 0, 21], [390, 844, 47, 34]])(
    'keeps the last scroll row above the safe bottom at %dx%d', (width, height, safeTop, safeBottom) => {
      const portrait = width <= height * 1.1;
      const html = panel({ portrait });
      const reserved = Number(html.match(/max-height:calc\(var\(--game-viewport-height, 100dvh\) - (\d+)px/)?.[1]);
      // Overlay mounts under the queue; subtracting only the bar height makes
      // the lower rows physically unreachable even at maximum scroll.
      const top = 8 + safeTop!;
      const bottom = top + height! - reserved - safeTop! - safeBottom!;
      expect(bottom).toBeLessThanOrEqual(height! - safeBottom! - CHROME.clusterPad);
    },
  );
});

// ===========================================================================
// 5. HOT STATES SURVIVED THE MOVE
// ===========================================================================

describe('the states that were signalled by colour on the old pills still are', () => {
  it('shows CLAIM! on a claimable cache, and the muted streak day otherwise', () => {
    expect(panel({ claim: { available: true, day: 4, enabled: true } })).toContain('CLAIM!');
    expect(panel()).toContain('D4');
    expect(panel()).not.toContain('CLAIM!');
  });

  it('keeps the daily cache un-actionable while base actions are locked', () => {
    // deedActionsAllowed() is false during the multi-base read cutover and while
    // the base is under live raid. The old pill dropped its onClick then; the
    // panel row must too, or the lane has changed what a control DOES.
    const locked = panel({ claim: { available: false, day: 4, enabled: false } });
    expect(locked).not.toContain('role="button" aria-label="Daily cache"');
    expect(panel()).toContain('aria-label="Daily cache"');
  });

  it('never lets a warzone-suppressed shield look protective', () => {
    const supp = panel({ shield: {
      label: 'SUPP · 4H', ariaLabel: 'Shield suppressed · 4H — open raid log',
      color: '#f4d77b', accent: '#c0392b', go: 'raidlog',
    } });
    expect(supp).toContain('SUPP');
    expect(supp).toContain('outline:2px solid #c0392b');
  });

  // D-099 (owner 2026-09-02): "no notification that you have been raided".
  // The shield chip is the RAIDED indicator while defences are unread — and
  // because it is then the one thing on the chip a player can ACT on, it must
  // be a control that opens the raid log, in the bar and in the panel alike.
  describe('a raid you were not told about cannot be avenged', () => {
    it('reads RAIDED ×N with the danger rim and opens the raid log while defences are unread', () => {
      const raided = shieldChipView(null, 3);
      expect(raided).toMatchObject({ label: 'RAIDED ×3', accent: C.danger, raided: true, go: 'raidlog' });
      const chip = renderToStaticMarkup(
        <HudChip ariaLabel={raided.ariaLabel} accent={raided.accent} onClick={vi.fn()}>{raided.label}</HudChip>,
      );
      expect(chip).toContain('RAIDED ×3');
      expect(chip).toContain('aria-label="Raided ×3 — open raid log"');
      expect(chip).toContain(`outline:2px solid ${C.danger}`);
      expect(chip).toContain('role="button"');
    });

    it('keeps plain, empty, and suppressed shield copy as permanent raid-log controls', () => {
      // WHY: dismissing unread is acknowledgement, not permission to remove
      // the player's only one-tap route back to defence history.
      const timer = shieldChipView({ activeUntil: '', hoursLeft: 47, remainingMs: 47 * 3_600_000 }, 0);
      expect(timer).toEqual({
        label: '1D 23H', ariaLabel: 'Shield · 1D 23H — open raid log',
        color: C.sky, accent: undefined, raided: false, go: 'raidlog',
      });
      for (const [view, accessibleName] of [
        [timer, 'Shield · 1D 23H — open raid log'],
        [shieldChipView(null, 0), 'No shield — open raid log'],
        [
          shieldChipView({ activeUntil: '', hoursLeft: 4, suppressedByWarzone: true }, 0),
          'Shield suppressed · 4H — open raid log',
        ],
      ] as const) {
        const chip = renderToStaticMarkup(
          <HudChip ariaLabel={view.ariaLabel} onClick={vi.fn()}>{view.label}</HudChip>,
        );
        expect(view.go).toBe('raidlog');
        expect(chip).toContain(`aria-label="${accessibleName}"`);
        expect(chip).toContain('role="button"');
      }
      // Unread defences outrank even a warzone SUPP: the timer is a fact, the
      // raid is a call to action, and the raid log clears it in one tap.
      expect(shieldChipView({ activeUntil: '', hoursLeft: 4, suppressedByWarzone: true }, 1).label)
        .toBe('RAIDED ×1');
    });

    it('carries RAIDED into the panel as a control, so it is one tap away at every width', () => {
      const raided = panel({ shield: shieldChipView(null, 2) });
      expect(raided).toContain('aria-label="Raided ×2 — open raid log"');
      expect(raided).not.toContain('aria-label="No shield — open raid log"');
      expect(raided).toContain('RAIDED ×2');
      expect(raided).toContain('RAID LOG');
      expect(raided).toContain(`outline:2px solid ${C.danger}`);
      // The panel's rows are controls only when they answer a press: the
      // Raided row's own opening tag carries the button role.
      const at = raided.indexOf('aria-label="Raided ×2 — open raid log"');
      const tag = raided.slice(raided.lastIndexOf('<', at), raided.indexOf('>', at) + 1);
      expect(tag).toContain('role="button"');
      expect(panel()).toContain('aria-label="Shield · 1D 23H — open raid log"');
      expect(panel()).toContain('RAID LOG');
    });
  });

  it('shows unread mail and escrowed rewards', () => {
    const hot = panel({ mail: { unread: 3, pending: 2 } });
    expect(hot).toContain('3');
    expect(hot).toContain('◆2');
  });
});

// ===========================================================================
// 6. THE BASE-TOOLS DOCK
// ===========================================================================

describe('base actions left the status bar without leaving the base view', () => {
  const dock = dockMarkup;

  it('carries all four, each one tap', () => {
    // BUILDERS / LAYOUT / EXPAND are contextual ACTIONS on the base in front of
    // you, not status — they are the reason the old HUD needed a third row.
    for (const label of ['Builders', 'Base layout', 'Expand base', 'Fit base to screen']) {
      expect(dock()).toContain(`aria-label="${label}"`);
    }
    expect(dock()).toContain('2/3'); // free/total builders, verbatim from the pill
  });

  it('drops the three gated actions but never FIT when base actions are locked', () => {
    // Exactly the old gating: the pills were behind baseActionsEnabled, FIT was
    // a camera op and was not. A player watching a live raid on their own base
    // must still be able to reframe the camera.
    const locked = dock({ enabled: false });
    expect(locked).not.toContain('aria-label="Builders"');
    expect(locked).not.toContain('aria-label="Base layout"');
    expect(locked).not.toContain('aria-label="Expand base"');
    expect(locked).toContain('aria-label="Fit base to screen"');
  });

  it('still rims BUILDERS gold when every builder is busy', () => {
    // The one hot state the dock inherits from the old pill.
    expect(dock({ free: 0 })).toContain('outline:2px solid');
    expect(dock({ free: 2 })).not.toContain('outline:2px solid');
  });

  it('does not reuse the navbar word BUILD for the builders button', () => {
    // BUILD is the navbar's build-tray destination and sits a tap away; two
    // controls that close together must not share a label.
    expect(dock()).toContain('BUILDERS');
  });

  it('clears the 44px tap floor on every button', () => {
    expect(dock()).toContain(`height:${CHROME.dockRow}px`);
  });

  it('is a pressable tab now, not a recessed readout well', () => {
    // WHAT THIS PINS. hudChipStyle draws a SUNKEN SEAT — the right idiom for a
    // number you read, the wrong one for a control you push. All four of these
    // open a screen. If someone factors the dock back onto the chip plate, the
    // base tools go back to looking like four more readouts parked on the
    // board, which is the shape of the original complaint.
    expect(dock()).toContain('hud_dock_idle_9slice');
    expect(dock()).not.toContain('hud_plate_shard_9slice');
    expect(dock()).toContain('class="interactive hud-tab hud-tab-dock"');
  });

  it('stays SUBORDINATE to the navigation it sits beside', () => {
    // The dock floats OVER the play field (playArea deliberately does not
    // reserve its band), so it is the one cluster that can turn into "chrome on
    // top of the game world" all by itself. Its plate is a different, quieter
    // master than the nav's — asserted on the ASSET, because a dock rebuilt
    // from the nav plate at a smaller size would still be as loud.
    expect(dock()).not.toContain('hud_tab_idle_9slice');
    expect(dock()).not.toContain('hud_tab_gold_9slice');
  });
});

// ===========================================================================
// 7. THE NAVIGATION — "you are here" is geometry
// ===========================================================================

describe('a destination reads as a plate you can push', () => {
  const nav = (over: Partial<Parameters<typeof HudNavButton>[0]> = {}): string =>
    renderToStaticMarkup(
      <HudNavButton label="BUILD" icon={<span />} onClick={vi.fn()} {...over} />,
    );

  it('sinks the CURRENT destination into its socket', () => {
    // THE DEFECT THIS FIXES. BaseHud stays mounted for screen==='build', so a
    // player with the build tray open is looking at a nav where BUILD is
    // indistinguishable from the four destinations they are NOT in. The bar
    // had no way to say "here".
    expect(nav({ sunk: true })).toContain('hud_tab_sunk_9slice');
    expect(nav({ sunk: true })).not.toContain('hud_tab_idle_9slice');
    expect(nav()).toContain('hud_tab_idle_9slice');
    expect(nav()).not.toContain('hud_tab_sunk_9slice');
  });

  it('says so with GEOMETRY, so the state survives greyscale', () => {
    // The owner's note was that RAID's "active" look is a flat gold fill — a
    // hue, which dies in greyscale, in peripheral vision and under any colour
    // filter. The two states are therefore separate MASTERS whose light is
    // inverted (lanes/hud-bottom gate G5 measures the flip in pure greyscale);
    // this is the assertion that stops them being collapsed back into one
    // plate plus a tint, which would pass any colour check and lose the state.
    const idle = hudTabStyle('nav', false).borderImageSource as string;
    const sunk = hudTabStyle('nav', true).borderImageSource as string;
    expect(idle).not.toBe(sunk);
    // Same frame, so a tab does not resize when you arrive on it.
    expect(hudTabStyle('nav', false).borderWidth).toBe(CHROME.tabBorder);
    expect(hudTabStyle('nav', true).borderWidth).toBe(CHROME.tabBorder);
    expect(hudTabStyle('nav', true).borderImageSlice)
      .toBe(hudTabStyle('nav', false).borderImageSlice);
  });

  it('keeps PRIMARY and HERE as two different things', () => {
    // RAID is the primary action and stays gold; it is not "the tab you are
    // on". Collapse the two and the nav claims you are permanently inside RAID.
    expect(nav({ tab: 'gold' })).toContain('hud_tab_gold_9slice');
    expect(nav({ tab: 'gold' })).not.toContain('hud_tab_sunk_9slice');
    expect(hudTabStyle('gold').borderImageSource)
      .not.toBe(hudTabStyle('nav').borderImageSource);
  });

  it('drives every plate into its socket under a finger, and none while disabled', () => {
    // :active cannot be an inline style and an inline plate outranks a
    // stylesheet rule, so the !important is load-bearing exactly as it is on
    // the overflow control. `:not(:disabled)` is not tidiness: BUILD and RAID
    // are disabled during a live raid on your own base, and a control that
    // sinks under a finger while refusing the tap is a control that lies.
    const css = renderToStaticMarkup(<HudChromeStyle />);
    for (const [cls, art] of [
      ['hud-tab-nav', 'hud_tab_sunk_9slice'],
      ['hud-tab-gold', 'hud_tab_gold_sunk_9slice'],
      ['hud-tab-dock', 'hud_dock_sunk_9slice'],
    ]) {
      expect(css).toMatch(
        new RegExp(`\\.${cls}:active:not\\(:disabled\\)\\{border-image-source:url\\([^)]*${art}[^)]*\\) !important\\}`),
      );
    }
    // The face goes in WITH the frame. Without this the plate sinks into its
    // socket while the glyph and the label stay floating over the hole.
    expect(css).toContain('.hud-tab:active:not(:disabled)>*,.hud-tab[data-hud-sunk]>*{transform:translateY(1px)}');
    // Somebody has to mount it. The dock and the overflow control each carry
    // their own copy so they render correctly in isolation, and BaseHud mounts
    // a third inside the <nav>; the rules are identical, so one surviving copy
    // is enough for all three.
    expect(dockMarkup()).toContain('.hud-tab-dock:active');
    expect(renderToStaticMarkup(
      <HudOverflowButton open={false} alert={false} onToggle={vi.fn()} />,
    )).toContain('.hud-tab-dock:active');
  });

  it("leaves the button's text EXACTLY the label", () => {
    // TutorialOverlay anchors its BUILD and RAID coach-marks by
    // `b.textContent?.trim() === 'BUILD'` — there is no aria-label and no test
    // id to fall back on. A screen-reader span, a decorative chevron or a
    // stray space added inside this button breaks the tutorial silently, which
    // is why the label is asserted as the whole text content and not merely as
    // "contained somewhere".
    const text = nav().replace(/<[^>]*>/g, '').trim();
    expect(text).toBe('BUILD');
    expect(nav()).not.toContain('aria-label');
  });

  it('is one tap target, whatever shape the orientation gives it', () => {
    // Portrait divides the width between five items; the landscape rail takes
    // its natural height so five fit inside a 311px Seeker webview.
    expect(nav()).toContain('flex:1');
    expect(nav({ rail: true })).toContain('flex:none');
  });
});

describe('the deck the destinations stand on', () => {
  it("bounds chrome and world with the BAR's own forged rim", () => {
    // The navigation used to fade into the board with a gradient. That was
    // right while the items were flat rectangles — a fade was the only thing
    // saying "chrome, not wall" — and wrong the moment they became forged
    // plates, because then the top of the screen was a lit stone object and
    // the bottom was a smudge. Five hard 1px rows, no blur, no spread: the
    // same outline / gold / seat the bar's bottom edge already draws.
    const port = hudDeckRim(true);
    expect(port.split(',')).toHaveLength(5);
    expect(port).toContain('inset 0 1px 0 0 #1A171E');
    expect(port).toContain('inset 0 2px 0 0 #F4D77B');
    expect(port).toContain('inset 0 5px 0 0 #1A171E');
    expect(port).not.toMatch(/gradient|blur|rgba/);
    // Landscape's board-facing edge is the LEFT one, not the top.
    expect(hudDeckRim(false)).toContain('inset 1px 0 0 0 #1A171E');
    expect(hudDeckRim(false)).toContain('inset 2px 0 0 0 #F4D77B');
  });

  it('costs the play area nothing', () => {
    // CHROME.navBar and CHROME.rail are subtracted by playArea(), offset by
    // every bottom sheet in sheets.tsx and pinned in layout.test.ts. The rim
    // is inset box-shadows and the field is a background precisely so that
    // neither can join the height arithmetic. A border here would silently
    // take 10px of board.
    for (const portrait of [true, false]) {
      const deck = hudDeckStyle(portrait) as Record<string, unknown>;
      expect(deck['border']).toBeUndefined();
      expect(deck['borderWidth']).toBeUndefined();
    }
    expect(hudDeckStyle(false).width).toBeUndefined();
    expect(hudDeckStyle(false).pointerEvents).toBe('none');
  });

  /**
   * REWRITTEN 2026-08-30. This assertion used to require the portrait deck to
   * have NO height at all, on the reasoning that anything joining the height
   * arithmetic could steal board. That was the right instinct aimed at the
   * wrong property: with no height the deck sized itself to its tallest ITEM,
   * so a refused BUILD rendering "READ ONLY" wrapped to two lines, grew the
   * deck past CHROME.navBar and pushed it up through the base-tools dock --
   * which sits at `bottom: navBar` and cannot see it. The owner caught the dock
   * clipped in half.
   *
   * A height EQUAL to CHROME.navBar costs the play area exactly nothing,
   * because playArea() already subtracts that number. The old test forbade the
   * one value that makes the contract true.
   */
  it('pins the portrait deck to CHROME.navBar so it can never grow into the dock', () => {
    const deck = hudDeckStyle(true) as Record<string, unknown>;
    expect(deck['height']).toBeUndefined();
    // The landscape rail spans top:0..bottom:0 and must stay free-height.
    expect((hudDeckStyle(false) as Record<string, unknown>)['height']).toBeUndefined();
  });

  it("respects the device's safe area on every edge it touches", () => {
    const port = JSON.stringify(hudDeckStyle(true));
    expect(port).toContain('env(safe-area-inset-bottom)');
    expect(hudDeckStyle(true).left).toBeUndefined();
    expect(port).toContain('env(safe-area-inset-right)');
    const land = JSON.stringify(hudDeckStyle(false));
    expect(land).toContain('env(safe-area-inset-right)');
    expect(land).toContain('env(safe-area-inset-bottom)');
  });

  it('pays for the forged frame out of padding, never out of the navbar', () => {
    // THE ARITHMETIC, not a restatement of it: the padding string itself is
    // parsed, so raising CHROME.tabBorder or retuning the padding without
    // re-solving the item fails here rather than on a phone. 26px icon, 4px
    // gap and a 24px line box for 16px VT323 are MEASURED in Chromium — the
    // navbar constant was 5px optimistic for years because that line box was
    // estimated at 19.
    const [top, , bottom] = navBtnPad(false).split(' ').map(Number.parseFloat);
    const item = CHROME.tabBorder * 2 + top! + bottom! + 26 + 4 + 24;
    expect(item).toBe(72);
    expect(hudDeckStyle(true).padding).toBeUndefined(); // 10px deck padding, top and bottom
  });
});

// ===========================================================================
// 8. THE FORGED STRIP
// ===========================================================================

describe('everything the game says to a player is said on chrome', () => {
  it("gives the toast the bar's own plate", () => {
    // Every message lands here — BASE CLAIMED, SESSION EXPIRED, NOT ENOUGH
    // SHARDS — and it was a 2px border and a 2px outline around a rectangle
    // while the bar above it was forged art. Reuse, not a lookalike: a
    // dedicated toast master would be one more thing to keep in sync with a
    // plate the owner has already accepted.
    const html = renderToStaticMarkup(<Toast msg="BASE CLAIMED" />);
    expect(html).toContain('hud_bar_frame_9slice');
    expect(html).toContain('BASE CLAIMED');
    // Still a passive announcement: it must never eat a tap meant for the board.
    expect(html).toContain('pointer-events:none');
  });

  it('keeps the plate on its measured 6/8 inset', () => {
    // Same border-width == border-image-slice rule the bar lives by: at 1:1
    // the corner straps and their rivets are blitted rather than resampled, so
    // a 180px toast and a 320px one carry byte-identical ends.
    expect(hudStripStyle().borderWidth).toBe(`${CHROME.barBorderY}px ${CHROME.barBorderX}px`);
    expect(hudStripStyle().borderImageSlice)
      .toBe(`${CHROME.barBorderY} ${CHROME.barBorderX} ${CHROME.barBorderY} ${CHROME.barBorderX} fill`);
  });
});

// ===========================================================================
// 9. EVERY CONTROL ANSWERS THE PLAYER
// ===========================================================================

/**
 * The owner's THIRD verdict on this HUD was that it still "looks like shit …
 * rework UI HUD again to be game like interactive". By then the layout was where
 * they had asked for it and the plates were forged, so what was left was not
 * another bevel: only the three tab plates answered a finger at all. A chip had
 * been role="button" since the bar shipped and said NOTHING when pressed, there
 * was no hover and no focus ring anywhere in the chrome, and `disabled` was
 * carried by opacity alone — which reads as "dim", not as "refused".
 *
 * These pin the answers, and each one is a way the feature could exist and still
 * be wrong.
 */
/** The kit's outline colour, sampled from the accepted masters (hudChrome's
 *  FORGE). Named here so the focus-ring assertion below reads as "the dark row
 *  of the forged ramp" rather than as a magic hex. */
const FORGE_OUTLINE = '#1A171E';

describe('a control that can be pressed says so when it is', () => {
  const css = (): string => renderToStaticMarkup(<HudChromeStyle />);

  it('drives a pressed chip further INTO its seat, geometry and all', () => {
    // A chip's idiom is a recess, so its press is the readout sinking deeper —
    // not the tab's raised plate dropping into a socket, and emphatically not a
    // hue shift, which is what the whole lane was rejected for twice.
    expect(css()).toContain('.hud-chip[role=button]:active>.hud-face{transform:translateY(1px)}');
    expect(css()).toContain('.hud-chip[role=button]:active::before{box-shadow:inset 0 2px 0 0');
  });

  it('draws every ring on a pseudo-element, because the plate covers the element', () => {
    // THE TRAP, and it cost this lane a render cycle to find. A border-image with
    // `fill` paints its middle slice over the whole PADDING BOX, and the border
    // paints ABOVE the element's own inset box-shadows — so a ring written
    // straight onto a chip or a tab is live in the DOM, reported by
    // getComputedStyle, and INVISIBLE in the photograph. Every 9-sliced surface
    // in this kit has that property, which is why `::after` has always carried
    // the value flash. Nothing here is verifiable by reading the CSS; the only
    // proof is a screenshot, and this assertion is what stops the next person
    // "simplifying" the pseudo-elements away and silently deleting the feedback.
    for (const sel of [
      '.hud-chip[role=button]:active::before',
      '.hud-chip[role=button]:hover::before',
      '.hud-chip[role=button]:focus-visible::before',
      '.hud-chip[data-hud-hot]::before',
      '.hud-tab:focus-visible::before',
      '.hud-tab[data-hud-hot]::before',
      '.hud-overflow:focus-visible::before',
    ]) {
      expect(css(), sel).toContain(sel);
    }
    // …and each one has to actually declare `content`, or the pseudo-element is
    // never generated and the rule is decoration.
    expect(css()).toMatch(/::before[^{]*\{content:''/);
  });

  it('moves the WHOLE readout, so the glyph never leaves its number behind', () => {
    // The face is one wrapper for the same reason the nav tab's is: moving the
    // children individually separates the icon from the value, and a bare text
    // child cannot be moved at all — which is what limited the flash animation
    // to whichever children happened to be elements.
    expect(renderToStaticMarkup(<HudChip ariaLabel="Shards">7,038,871</HudChip>))
      .toContain('class="hud-face"');
  });

  it('leaves a READOUT unable to answer, so "looks pressable" still means "is"', () => {
    // Energy, trophies and an untouchable shield are numbers, not buttons. Every
    // press, hover and focus rule is scoped to [role=button], which a chip only
    // gets from an onClick — so a readout cannot acquire the feedback without
    // acquiring the behaviour.
    const readout = renderToStaticMarkup(<HudChip ariaLabel="Energy">3/5</HudChip>);
    expect(readout).not.toContain('role="button"');
    for (const rule of [':active', ':hover', ':focus-visible']) {
      expect(css()).not.toContain(`.hud-chip${rule}`);
    }
  });

  it('eases only the RELEASE, and only in whole pixels', () => {
    // The press is your finger and is instant; the return is what tells you the
    // control let go. Two steps rather than a curve, because an interpolated
    // transform puts pixel art on fractional coordinates for most of its life.
    expect(css()).toContain('.hud-tab>*,.hud-chip>.hud-face{transition:transform 90ms steps(2,end)}');
    expect(css()).toContain('.hud-tab:active>*,.hud-chip[role=button]:active>.hud-face{transition:none}');
    // And it is inside the reduced-motion guard, where the press dip is not.
    const [, motion] = css().split('@media (prefers-reduced-motion: no-preference){');
    expect(motion).toContain('transition:transform 90ms steps(2,end)');
  });

  it('keeps every hover behind hover:hover', () => {
    // THE REGRESSION THIS CATCHES. A hover style on a touchscreen STICKS to the
    // last thing tapped — a permanently lit chip on the platform this HUD is
    // mostly used on. The query is the only thing preventing it, and it is one
    // careless refactor away from being flattened out.
    const [, hoverBlock] = css().split('@media (hover:hover){');
    expect(hoverBlock).toContain('.hud-chip[role=button]:hover');
    expect(hoverBlock).toContain('.hud-tab:hover:not(:disabled)');
    expect(css().split('@media (hover:hover){')[0]).not.toContain(':hover');
  });

  it('shows a keyboard user where they are', () => {
    // These are deliberately keyboard-reachable (a clickable chip is a real
    // button to assistive tech, and has been since the 2026-08-21 review). They
    // had no visible focus at all, which makes that reachability unusable.
    expect(css()).toContain('.hud-chip[role=button]:focus-visible::before,.hud-tab:focus-visible::before,.hud-overflow:focus-visible::before');
    // An INSET ring, not an outline: `outline` is already how `accent` draws the
    // hot rim, and two outlines on one element cannot both be seen.
    expect(css()).toMatch(/:focus-visible::before\{box-shadow:inset 0 0 0 1px [^,]+,inset 0 0 0 3px/);
    // TWO-TONE, because a plain gold ring VANISHES on the KEEP chip — that plate
    // is forged from the gold ramp, so a gold line inside its gold bezel is
    // invisible on the one readout that must never look ordinary. Measured in a
    // browser, not guessed: the dark row is what gives the ring an edge on every
    // plate in the kit.
    expect(css()).toContain(`inset 0 0 0 1px ${FORGE_OUTLINE},inset 0 0 0 3px`);
    // AND IT OUTRANKS THE BREATHING. A CSS animation beats an ordinary
    // declaration, so without this a focused chip that happened to be hot — a
    // claimable cache, a full mine buffer — lost its focus ring entirely, on
    // exactly the controls most worth reaching by keyboard.
    expect(css()).toMatch(/:focus-visible::before\{box-shadow:[^;]*!important/);
  });

  it('makes a refused control stop claiming to be the primary one', () => {
    // BUILD and RAID are disabled during a live raid on your own base. Opacity
    // alone left RAID unmistakably GOLD — still advertising itself as the thing
    // to do while turning down every tap. Removing the colour is what withdraws
    // the claim; the plate and the label stay, so the tab does not vanish.
    expect(css()).toContain('.hud-tab:disabled{filter:grayscale(1)');
    // …and it still must not sink under a finger, or it lies twice.
    expect(css()).toContain('.hud-tab-gold:active:not(:disabled)');
  });
});

describe('something waiting for the player breathes', () => {
  const css = (): string => renderToStaticMarkup(<HudChromeStyle />);

  it('reads the alert attribute the overflow control was already writing', () => {
    // data-hud-alert was put on this button when the bar shipped and NO RULE
    // EVER READ IT: the one control that must catch the eye carried a dead
    // attribute.
    //
    // IT LANDS ON THE BEAD, NOT THE PLATE, and that is a rendered finding rather
    // than a preference. The breathing rim was put on the button first, and it
    // paints over the plate's own chamfer — the raised iron object went back to
    // reading as an outlined rectangle, which is the "generic square" complaint
    // this kit was built to answer. The attribute keeps a real job as the badge's
    // STATIC ring, which is also the half that survives REDUCE MOTION.
    expect(css()).toContain('.hud-overflow[data-hud-alert] .hud-badge{box-shadow:0 0 0 1px');
    expect(css()).not.toContain('.hud-overflow[data-hud-alert]:not([data-hud-still]){animation');
    expect(renderToStaticMarkup(<HudOverflowButton open={false} alert onToggle={vi.fn()} />))
      .toContain('data-hud-alert="1"');
  });

  it('haloes the bead on the same slow cycle, without stopping it bobbing', () => {
    // The badge is the one signal the panel cannot afford to lose (a daily cache
    // EXPIRES), and a 1px bob alone is easy to miss on a bright board. The halo
    // rides the same animation list, so REDUCE MOTION still stops both with the
    // one `:not([data-hud-still])` guard — and the bead stays put, which is the
    // trap hudFlash.test.tsx pins.
    expect(css()).toContain('animation:hud-badge-bob 1.8s steps(1,end) infinite,hud-badge-halo');
    expect(css()).toContain('@keyframes hud-badge-halo{');
  });

  it('cycles the gold ramp instead of blinking off', () => {
    // A signal that switches off is missed at exactly the wrong moment. Every
    // keyframe carries a rim; only its place on the ramp changes — and in whole
    // steps, like every other animation in this kit.
    expect(css()).toContain('@keyframes hud-hot{');
    expect(css()).toMatch(/@keyframes hud-hot\{[^}]*box-shadow:inset 0 0 0 1px/);
    expect(css()).toContain('animation:hud-hot 2.4s steps(1,end) infinite');
    // Slow enough not to nag: a 2.4s cycle, not a strobe.
    expect(css()).not.toMatch(/animation:hud-hot 0\./);
  });

  it('marks a claimable cache hot, and keeps the static rim that says the same thing', () => {
    const hot = panel({ claim: { available: true, day: 4, enabled: true } });
    expect(hot).toContain('data-hud-hot="1"');
    // THE POINT OF KEEPING `accent`: the breathing is the thing that catches the
    // eye, but a still frame, a screenshot and REDUCE MOTION must all still show
    // that this row wants the player. The outline is that fact held still.
    expect(hot).toContain('outline:2px solid');
    // Against the ROWS, not the whole markup: the stylesheet the panel mounts
    // names every one of these attributes (they are its selectors), so a bare
    // substring match would pass on a panel with no hot row in it at all.
    expect(el(panel())).not.toContain('data-hud-hot');
  });

  it('stills the breathing without dropping the state', () => {
    // The same trap the badge has: the obvious way to honour REDUCE MOTION is to
    // stop rendering the thing that moves, which would delete the alert itself
    // and silently turn an accessibility preference into a lost daily cache.
    const still = panel({ claim: { available: true, day: 4, enabled: true }, reduceMotion: true });
    expect(still).toContain('data-hud-hot="1"');
    expect(still).toContain('data-hud-still="1"');
    expect(still).toContain('outline:2px solid');
    expect(css()).toContain('.hud-chip[data-hud-hot]:not([data-hud-still])');
  });

  it('breathes the builders button only when every builder is busy', () => {
    // The dock's one hot state. A dock that always pulsed would be four controls
    // demanding attention on top of the play field.
    expect(dockMarkup({ free: 0 })).toContain('data-hud-hot="1"');
    expect(el(dockMarkup({ free: 2 }))).not.toContain('data-hud-hot');
  });

  it('gives the panel its own copy of the rules it needs', () => {
    // Twelve controls that took a tap in silence: the panel never mounted the
    // stylesheet its rows' press, hover and focus live in. Same reason the dock
    // carries one — every piece of this chrome must be correct alone.
    expect(panel()).toContain('.hud-chip[role=button]:active');
  });

  it('shows a gated control as refused rather than as a readout', () => {
    // deedActionsAllowed() drops the daily cache's onClick during a live raid.
    // That gate is unchanged — but the row used to render byte-identical to the
    // energy readout beside it, so the player learned nothing from tapping it.
    const locked = panel({ claim: { available: false, day: 4, enabled: false } });
    expect(locked).not.toContain('role="button" aria-label="Daily cache"');
    expect(el(locked)).toContain('filter:grayscale(1)');
    // On the rows: the stylesheet greys DISABLED TABS with the same declaration,
    // so the whole markup always contains it.
    expect(el(panel())).not.toContain('filter:grayscale(1)');
  });
});

// ===========================================================================
// 10. RESPONSIVE HUD SURFACES — player plate, queue and labelled task rail
// ===========================================================================

describe('the responsive HUD is one truthful control system', () => {
  it('preserves all four padding sides when the same deck changes rail → wide → portrait → rail', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // happy-dom does not resolve env(). Supply nonzero platform insets while
    // preserving the actual style keys and React's shorthand/longhand updates.
    const insets: Record<string, number> = { top: 3, right: 5, bottom: 7, left: 11 };
    const renderDeck = (portrait: boolean, tier: 'compact' | 'wide', rail: boolean): string[] => {
      const style = Object.fromEntries(Object.entries(hudDeckStyle(portrait, tier, rail)).map(([key, value]) => {
        const inset = typeof value === 'string' && /^calc\((\d+)px \+ env\(safe-area-inset-(top|right|bottom|left)\)\)$/.exec(value);
        return [key, inset ? Number(inset[1]) + insets[inset[2]!]! : value];
      }));
      flushSync(() => root.render(<nav style={style} />));
      const computed = getComputedStyle(host.querySelector('nav')!);
      return [computed.paddingTop, computed.paddingRight, computed.paddingBottom, computed.paddingLeft];
    };
    try {
      expect(renderDeck(false, 'compact', true)).toEqual(['', '', '', '']);
      expect(renderDeck(false, 'wide', false)).toEqual(['', '', '', '']);
      expect(renderDeck(true, 'compact', false)).toEqual(['', '', '', '']);
      expect(renderDeck(false, 'compact', true)).toEqual(['', '', '', '']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      errors.mockRestore();
    }
  });

  it('keeps compact chrome full-bleed and turns wide chrome into bounded clusters', () => {
    const compact = hudBarStyle(true, 'compact', false);
    const wideBar = hudBarStyle(true, 'wide', false);
    const wideDeck = hudDeckStyle(true, 'wide', false);
    expect(compact.left).toBe('calc(8px + env(safe-area-inset-left))');
    expect(compact.right).toBeUndefined();
    expect(compact.background).toBeUndefined();
    expect(wideBar.width).toBe('max-content');
    expect(wideBar.left).toBe(compact.left);
    expect(wideDeck.right).toBe('calc(8px + env(safe-area-inset-right))');
    expect(wideDeck.transform).toBeUndefined();
  });

  it('identifies the former overflow square as the player menu and Keep level', () => {
    const player = renderToStaticMarkup(
      <HudPlayerMenuButton art={<span />} level={7} open={false} alert={false} onToggle={vi.fn()} />,
    );
    expect(player).toContain('aria-label="Player menu — Keep level 7"');
    expect(player).toContain('>7<');
    expect(player).not.toContain('aria-label="More"');
    // The first-run deck anchors on the opener while the menu is closed (FIT
    // BASE and QUESTS are rows inside it) and on the row itself once open.
    expect(player).toContain('data-tutorial-target="player-menu"');
    const opened = renderToStaticMarkup(
      <HudPlayerMenuButton art={<span />} level={7} open alert={false} onToggle={vi.fn()} />,
    );
    expect(opened).not.toContain('data-tutorial-target=');
    const alert = renderToStaticMarkup(
      <HudPlayerMenuButton art={<span />} level={7} open={false} alert onToggle={vi.fn()} />,
    );
    expect(alert).toContain('class="hud-badge"');
    expect(alert).toContain('ACTION NEEDED');
  });

  it('calls elapsed server jobs VERIFYING and never invents a collectible state', () => {
    const verifying = renderToStaticMarkup(
      <HudQueueCard
        art={<span />} title="UPGRADING KEEP" detail="3▸4" pct={100} time="0S"
        verifying onClick={vi.fn()}
      />,
    );
    expect(verifying).toContain('VERIFYING');
    expect(verifying).toContain('finishing and verifying');
    expect(verifying).not.toContain('READY');
    expect(verifying).not.toContain('COLLECT');

    const active = renderToStaticMarkup(
      <HudQueueCard
        art={<span />} title="BUILDING MINE" detail="L1" pct={50} time="2M"
        verifying={false} onClick={vi.fn()}
      />,
    );
    expect(active).toContain('2M');
    expect(active).toContain('2M remaining');
  });

  it('collapses the same queue into an accessible destination on compact screens', () => {
    const summary = renderToStaticMarkup(
      <HudQueueSummary onClick={vi.fn()}><span>2 ACTIVE · NEXT 1M · 1 IDLE</span></HudQueueSummary>,
    );
    expect(summary).toContain('aria-label="Builder queue"');
    expect(summary).toContain('2 ACTIVE');
  });

  it('labels every promoted task and never places a fake number on the bag', () => {
    // Five buttons since D-096 (owner 2026-09-02): the base-wide troop count is
    // a primary surface, so ARMY joins the rail with its ready count as the
    // badge — the same "label carries the number" contract as QUESTS and MAIL.
    const tasks = renderToStaticMarkup(
      <HudTaskRail tier="compact" rail={false}>
        <HudTaskButton ariaLabel="Daily quests" tutorialTarget="daily-quests" label="QUESTS" icon={<span />} count="1/3" onClick={vi.fn()} />
        <HudTaskButton ariaLabel="Daily cache" label="CACHE" icon={<span />} count="D4" settled onClick={vi.fn()} />
        <HudTaskButton ariaLabel="Mail" label="MAIL" icon={<span />} count="2" onClick={vi.fn()} />
        <HudTaskButton ariaLabel="Inventory" label="BAG" icon={<span />} onClick={vi.fn()} />
        <HudTaskButton ariaLabel="Army" label="ARMY" icon={<span />} count="42" settled onClick={vi.fn()} />
      </HudTaskRail>,
    );
    expect(tasks).toContain('aria-label="Daily quests — 1/3"');
    expect(tasks).toContain('data-tutorial-target="daily-quests"');
    expect(tasks).toContain('aria-label="Daily cache — D4"');
    expect(tasks).toContain('aria-label="Mail — 2"');
    expect(tasks).toContain('aria-label="Inventory"');
    expect(tasks).toContain('aria-label="Army — 42"');
    // BAG is no longer the last button, so its slice must stop where ARMY
    // starts — otherwise ARMY's real badge would be read as a fake one on BAG.
    const bag = tasks.slice(tasks.indexOf('aria-label="Inventory"'), tasks.indexOf('aria-label="Army'));
    expect(bag).toContain('BAG');
    expect(bag).not.toMatch(/min-width:17px/);
  });

  it('shows no army badge until the server readiness has arrived', () => {
    // THE REGRESSION THIS CATCHES: someone defaults the count to "0" while
    // base.armyStatus is still absent (an older API cut, or the read not yet
    // landed). The badge is the /base figure or nothing — a fabricated zero on
    // the persistent HUD is exactly the fake number the BAG rule forbids.
    const tasks = renderToStaticMarkup(
      <HudTaskRail tier="compact" rail={false}>
        <HudTaskButton ariaLabel="Army" label="ARMY" icon={<span />} onClick={vi.fn()} />
      </HudTaskRail>,
    );
    expect(tasks).toContain('aria-label="Army"');
    expect(tasks).not.toContain('aria-label="Army —');
    const army = tasks.slice(tasks.indexOf('aria-label="Army"'));
    expect(army).toContain('ARMY');
    expect(army).not.toMatch(/min-width:17px/);
  });
});

// ===========================================================================
// 11. THE BUILDING SHEET — the surface a player touches most
// ===========================================================================

describe('the sheet shows the building, not just its name', () => {
  it('carries the portrait, the level and where that level sits', () => {
    // It opened on a text header and two grey chips: the one surface a player
    // uses constantly showed them nothing of the thing they had selected, and
    // "LEVEL 4" alone cannot say whether that is nearly done or barely started —
    // L4 of a 5-level mine and L4 of a 20-level keep read identically.
    const head = renderToStaticMarkup(
      <HudSheetHead art={<span id="portrait" />} title="MINE" level={4} max={20} />,
    );
    expect(head).toContain('id="portrait"');
    expect(head).toContain('MINE');
    expect(head).toContain('LEVEL');
    expect(head).toContain('/20');
    // The portrait sits in the chip WELL — the kit's idiom for something you
    // look at — rather than in a border of its own invention.
    expect(head).toContain('hud_plate_shard_9slice');
  });

  it('fills the rail by progress, not by raw level', () => {
    // A level-1 building is at the START of its rail, not 5% along it, and a
    // maxed one is full. Off-by-one here would show a finished keep short.
    const at = (level: number, max: number): string =>
      renderToStaticMarkup(<HudLevelRail level={level} max={max} />);
    expect(at(1, 20)).toContain('width:0%');
    expect(at(20, 20)).toContain('width:100%');
    expect(at(11, 21)).toContain('width:50%');
    // A one-level building has nowhere to go and must not divide by zero.
    expect(at(1, 1)).toContain('width:100%');
  });

  it('makes the value being bought the only gold thing in its row', () => {
    // The old pill put "HP 1250 →1562" in one grey box at one weight, so the
    // comparison the sheet exists to support was the least legible thing on it.
    const row = renderToStaticMarkup(<HudStatDelta label="HP" cur="1,250" next="1,562" />);
    expect(row).toContain('1,250');
    expect(row).toContain('1,562');
    expect(row).toContain('#F4D77B');
  });

  it('shows no arrow when a stat does not move', () => {
    // RNG does not level, and at max nothing does. An arrow pointing at the same
    // number is an upgrade the sheet cannot sell.
    const flat = renderToStaticMarkup(<HudStatDelta label="RNG" cur="7" />);
    expect(flat).toContain('7');
    expect(flat).not.toContain('▸');
    expect(renderToStaticMarkup(<HudStatDelta label="HP" cur="900" next="900" />)).not.toContain('▸');
  });

  it('gives the sheet\'s primary action the plate RAID wears', () => {
    // "Primary" has one meaning in this game and it is the forged gold plate in
    // the navigation. Reusing the class is what makes the sheet's main action
    // the same OBJECT rather than a lookalike — and it inherits the gold press
    // for free instead of restating it.
    const go = renderToStaticMarkup(
      <HudPrimaryButton onClick={vi.fn()}>UPGRADE</HudPrimaryButton>,
    );
    expect(go).toContain('class="interactive hud-tab hud-tab-gold"');
    expect(go).toContain('hud_tab_gold_9slice');
    expect(go).toContain('UPGRADE');
    // It mounts the rules its own press depends on, like every other piece here.
    expect(go).toContain('.hud-tab-gold:active:not(:disabled)');
  });

  it('refuses a press while the action is in flight', () => {
    // Every call site passes `busy` — a second tap on UPGRADE while the first
    // POST is open is a duplicate the sheet must not offer, and `:not(:disabled)`
    // is what stops the plate sinking under a finger it will ignore.
    const busy = renderToStaticMarkup(
      <HudPrimaryButton disabled onClick={vi.fn()}>UPGRADE</HudPrimaryButton>,
    );
    expect(busy).toContain('disabled');
    expect(busy).toContain('cursor:default');
  });
});


describe('floating menu replaces the former secondary rail', () => {
  it('retains Shop, Market, Army and base tools with truthful stock and locked edit routes', () => {
    const html = panel({ baseActionsEnabled: false, armyStatus: { readyTroopCount: 90, trainingTroopCount: 3 },
      resources: { shards: '9007199254740993', keep: '100764' } });
    const host = document.createElement('div'); host.innerHTML = html;
    for (const name of ['SHOP', 'MARKET', 'Army', 'BUILDERS', 'LAYOUT', 'EXPAND']) {
      expect(host.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
    }
    expect(host.textContent).toContain('90 READY · 3 TRAINING');
    // Grouped like the bar, and LOSSLESS above 2^53: fmtN's string path never
    // rounds through a Number, so the last digit of this balance survives.
    expect(host.textContent).toContain('9,007,199,254,740,993');
    expect(host.textContent).toContain('100,764');
    expect(host.querySelector('[aria-label="LAYOUT"]')?.getAttribute('role')).toBeNull();
    expect(host.querySelector('[aria-label="MARKET"]')?.getAttribute('role')).toBe('button');
  });

  it('traps keyboard focus, routes through the original callback, and returns focus on close', () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
    const root = createRoot(host); const go = vi.fn(); const close = vi.fn();
    try {
      flushSync(() => root.render(<HudOverflowPanel {...IDLE} onGo={go} onClose={close} />));
      const first = host.querySelector<HTMLButtonElement>('button')!;
      expect(document.activeElement).toBe(first);
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Settings and profile');
      (host.querySelector('[aria-label="MARKET"]') as HTMLElement).click();
      expect(go).toHaveBeenCalledExactlyOnceWith('market'); expect(close).toHaveBeenCalledOnce();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(close).toHaveBeenCalledTimes(2);
      flushSync(() => root.unmount());
      expect(document.activeElement).toBe(trigger);
    } finally { host.remove(); trigger.remove(); }
  });
});
