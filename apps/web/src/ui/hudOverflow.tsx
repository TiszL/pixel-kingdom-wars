import { useUserCommand } from './pk/useUserCommand';
/**
 * THE OVERFLOW PANEL and THE BASE-TOOLS DOCK — where the thirteen controls that
 * used to sit permanently on top of the board now live.
 *
 * WHY THEY MOVED. The base HUD rendered 16–18 always-visible opaque chips. In
 * portrait (375×812) its three flex-wrap rows wrapped into FIVE visual rows,
 * 200px of chrome — 25% of the phone — sitting over the play field. In
 * landscape (915×311) the same controls needed 987px of a 915px row and the
 * tail was reachable only by a horizontal drag nothing advertised. The defect
 * was the COUNT of permanently-visible controls, not their styling, so no
 * restyle could fix it.
 *
 * The split follows what the code itself says about each control (hud-audit):
 *  - PERSISTENT: shards and KEEP are the two currencies every build and train
 *    action debits, and the player checks them before every tap in the build
 *    tray. They stay in the bar with the mine-buffer bar that rides shards.
 *  - ACTIONABLE-WHEN-HOT: claim, mail, shield and builders each already carry a
 *    colour change in code that fires ONLY in the hot state — which is the
 *    evidence that they are normally idle. They may move, provided the hot
 *    state still reaches the player: hudOverflowAlert() badges the overflow
 *    control for the two that are time-sensitive.
 *  - ON-DEMAND: everything else. Trophies and energy have no onClick at all.
 *
 * Both components here are PURE: every value arrives as a prop, so the panel's
 * contents can be asserted without mounting the overlay's fetch graph. The one
 * exception is the FOUNDING KINGDOMS row, which reads the shared /tester/me
 * snapshot (foundingKingdoms.tsx) and renders a bare destination without one.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Screen } from '../state/store';
import { CHROME } from './layout';
import { HudChip, HudChromeStyle, hudPlateStyle, hudTabStyle } from './hudChrome';
import { FoundingRow } from './foundingKingdoms';
import type { IconName } from './icons';
import { InventoryHudButton } from './InventoryHudButton';
import { COLORS as C, fmtN, Icon, PillSub, PillVal } from './primitives';

export interface HudOverflowProps {
  portrait: boolean;
  baseActionsEnabled?: boolean;
  resources?: { shards: string; keep: string };
  armyStatus?: { readyTroopCount: number; trainingTroopCount: number } | undefined;
  onFit?: () => void;
  /** Chips the BAR is already showing, so the panel does not duplicate them.
   *  Union, never intersection: every control is in exactly one of the two. */
  barHasTrophies: boolean;
  barHasSol: boolean;
  sol: number | null;
  trophies: number;
  energy: { free: number; max: number };
  /** Permanent Raid Log shortcut; unread state changes only its copy/accent. */
  shield: {
    label: string; ariaLabel: string; color: string;
    accent?: string | undefined; go: 'raidlog';
  };
  quests: { done: number; total: number };
  claim: { available: boolean; day: number; enabled: boolean };
  mail: { unread: number; pending: number };
  isAdmin: boolean;
  selectorEnabled: boolean;
  /** BASES · SELECT — no base chosen yet on this device. */
  needsBaseSelect: boolean;
  /** The game's own REDUCE MOTION setting, forwarded to the rows that breathe.
   *  Optional so the panel stays renderable in isolation; absent means motion. */
  reduceMotion?: boolean | undefined;
  onGo: (screen: Screen) => void;
  onClose: () => void;
}

/**
 * A full-width row in the panel grid. Every row clears the 44px tap floor.
 *
 * THREE KINDS OF ROW, told apart on purpose (2026-08-29). A row with `onClick`
 * is a control and answers a press; a row without one is a READOUT (energy,
 * trophies, a shield you cannot touch) and deliberately answers nothing, so
 * "looks pressable" keeps meaning "is pressable"; and `off` is the third case —
 * a control that exists but is currently refused, which used to render
 * byte-identical to a readout and so told the player nothing about why their
 * tap did nothing.
 */
function Row({ children, onClick, ariaLabel, accent, hot, reduceMotion, off }: {
  children: ReactNode; onClick?: (() => void) | undefined;
  ariaLabel?: string | undefined; accent?: string | undefined;
  hot?: boolean | undefined; reduceMotion?: boolean | undefined;
  /** Gated, not absent. Grayscale rather than a lower opacity alone: this row's
   *  whole hot vocabulary is gold, and removing the colour is what says the
   *  colour no longer applies. */
  off?: boolean | undefined;
}): React.JSX.Element {
  return (
    <HudChip
      {...(onClick ? { onClick } : {})}
      {...(ariaLabel ? { ariaLabel } : {})}
      {...(ariaLabel === 'Daily quests' ? { tutorialTarget: 'daily-quests' } : {})}
      {...(accent ? { accent } : {})}
      {...(hot ? { hot } : {})}
      {...(reduceMotion ? { reduceMotion } : {})}
      style={{
        minHeight: CHROME.tapRow, minWidth: 0, justifyContent: 'flex-start', padding: '8px', whiteSpace: 'normal', overflow: 'visible', flex: '1 1 auto',
        ...(off ? { filter: 'grayscale(1)', opacity: 0.55 } : {}),
      }}>
      {children}
    </HudChip>
  );
}

/**
 * Every route row carries a glyph (owner 2026-09-17: "some things do not have
 * icons"). ARMY borrows the rally horn and EXPAND the build-tray plus; SHOP,
 * MARKET, MAIL and ADMIN are the inline pixel glyphs in icons.ts.
 */
const ROUTE_ICON: Record<'shop' | 'market' | 'army' | 'builders' | 'layout' | 'expand', IconName> = {
  shop: 'shop', market: 'market', army: 'warhorn', builders: 'builder', layout: 'layout', expand: 'plus',
};

/** The bar formats balances with fmtN, whose string path groups digits without
 *  ever going through a Number — so a 2^53+ balance keeps every digit. Anything
 *  that is not a digit string (the '…' placeholder before the balance loads)
 *  is shown as-is rather than as fmtN's '0'. */
function money(value: string): string {
  return /^\d+$/.test(value) ? fmtN(value) : value;
}

/**
 * Sheet in portrait, popover in landscape — the same grid either way, because
 * the constraint that decides the shape is width, and `auto-fill` reads it
 * without a breakpoint. It scrolls internally rather than growing: in the
 * 311px-tall Seeker webview a twelve-row list does not fit whatever we do, and
 * a panel that grew past the viewport would put SETTINGS off the bottom edge —
 * the exact defect this whole lane exists to remove.
 */
export function HudOverflowPanel(p: HudOverflowProps): React.JSX.Element {
  const requestCommand = useUserCommand();
  const current = useRef(p); current.current = p;
  const go = (route: Screen): void => { requestCommand(() => {
    current.current.onGo(route); current.current.onClose();
  }, () => !['layout', 'expand', 'claim'].includes(route) || current.current.baseActionsEnabled !== false); };
  const fit = (): void => { requestCommand(() => { current.current.onFit?.(); current.current.onClose(); }); };
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const targets = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []);
      const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  // The panel is a COLUMN: a pinned title bar, the two currencies, then the
  // grid, which is the only part that scrolls. Overlay anchors the whole thing
  // below the bar AND builder queue; the 16px reserve keeps its last row above
  // the floating-cluster anchor at the bottom (asserted in hudBar.test).
  const frameStyle: CSSProperties = {
    ...hudPlateStyle(true),
    background: C.panel,
    display: 'flex', flexDirection: 'column', minHeight: 0,
    maxHeight: 'calc(var(--game-viewport-height, 100dvh) - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
  };
  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(${p.portrait ? 132 : 148}px, 1fr))`,
    gap: CHROME.hudGap,
    padding: CHROME.hudGap,
    minHeight: 0, overscrollBehavior: 'contain',
    overflowY: 'auto',
  };
  return (
    <div
      ref={panel}
      role="dialog" aria-modal="true"
      aria-label="Your Kingdom"
      className="interactive"
      style={frameStyle}>
      {/* The panel's rows are pressable chips, and their press / hover / focus
          rules live in the chrome's stylesheet. The panel used to render without
          it — twelve controls that took a tap in silence — so it mounts its own
          copy for the same reason the dock does: it must be correct alone. */}
      <HudChromeStyle />
      {/* TITLE BAR — the same ink strip with a gold title every full screen wears
          (primitives.Phead), so the menu reads as a forged screen and not as a
          label floating in a grid (owner 2026-09-17: "degraded appearance"). The
          close button stays the FIRST button in the DOM: it is what receives
          focus when the dialog opens. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none',
        background: C.ink, borderBottom: `2px solid ${C.borderLt}`, padding: '0 0 0 12px', minHeight: CHROME.tapRow,
      }}>
        <span style={{ color: C.gold, fontSize: 22, letterSpacing: '2px', lineHeight: 1 }}>YOUR KINGDOM</span>
        <button type="button" className="interactive" aria-label="Close player menu" onClick={p.onClose}
          style={{
            width: CHROME.tapRow, height: CHROME.tapRow, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 0, padding: 0, color: C.text, cursor: 'pointer',
          }}>
          <Icon name="close" size={22} />
        </button>
      </div>
      {/* CURRENCIES — the bar's own two chips, cut from the bar's own plates:
          shards on stone, KEEP on gold, for the same correctness reason the bar
          gives (hudChrome.hudChipStyle — a player once spent KEEP by accident).
          Readouts, not controls: no onClick, so no press or hover. */}
      {p.resources && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: CHROME.hudGap, padding: `${CHROME.hudGap}px ${CHROME.hudGap}px 0`, flex: 'none' }}>
          <HudChip ariaLabel="Shards" style={{ flex: '1 1 auto', justifyContent: 'flex-start', padding: '0 8px', minWidth: 0 }}>
            <Icon name="shard" size={20} /><PillVal>{money(p.resources.shards)}</PillVal><PillSub>SHARDS</PillSub>
          </HudChip>
          <HudChip ariaLabel="KEEP" plate="keep" style={{ flex: '1 1 auto', justifyContent: 'flex-start', padding: '0 8px', minWidth: 0 }}>
            <Icon name="keep" size={20} /><PillVal color={C.goldHi}>{money(p.resources.keep)}</PillVal><PillSub>KEEP</PillSub>
          </HudChip>
        </div>
      )}
      <div style={gridStyle}>
        {(['shop', 'market', 'army', 'builders', 'layout', 'expand'] as const).map((route) => {
          const enabled = !['layout', 'expand'].includes(route) || p.baseActionsEnabled !== false;
          return <Row key={route} ariaLabel={route === 'army' ? 'Army' : route.toUpperCase()} off={!enabled}
            {...(enabled ? { onClick: () => go(route) } : {})}>
            <Icon name={ROUTE_ICON[route]} size={20} />
            <PillSub>{route.toUpperCase()}</PillSub>
            {route === 'army' && p.armyStatus && <PillVal>{p.armyStatus.readyTroopCount} READY · {p.armyStatus.trainingTroopCount} TRAINING</PillVal>}
          </Row>;
        })}
        {p.onFit && <Row ariaLabel="Fit base to screen" onClick={fit}><Icon name="locate" size={20} /><PillSub>FIT BASE</PillSub></Row>}
        {/* --- readouts displaced from the bar ------------------------------- */}
        {!p.barHasSol && (
          <Row ariaLabel="SOL balance" onClick={() => go('exchange')}>
            <Icon name="sol" size={20} />
            <PillVal color={C.sky}>{p.sol == null ? '…' : p.sol.toFixed(p.sol >= 100 ? 1 : 3)}</PillVal>
            <PillSub>SOL</PillSub>
          </Row>
        )}
        {!p.barHasTrophies && (
          <Row ariaLabel="Ranked leagues" onClick={() => go('leagues')}>
            <Icon name="trophy" size={20} /><PillVal>{fmtN(p.trophies)}</PillVal><PillSub>TROPHIES</PillSub>
          </Row>
        )}
        <Row ariaLabel="Energy">
          <Icon name="energy" size={20} /><PillVal>{p.energy.free}/{p.energy.max}</PillVal><PillSub>ENERGY</PillSub>
        </Row>
        {/* A stored ordinary shield remains visible during a warzone, but it must
            never look protective while the server suppresses it — the danger rim
            and the SUPP label travel with it into the panel. So does RAIDED ×N:
            unread changes its urgency, never its permanent raid-log destination. */}
        <Row ariaLabel={p.shield.ariaLabel}
          {...(p.shield.accent ? { accent: p.shield.accent } : {})}
          onClick={() => go(p.shield.go)}>
          <Icon name="shield" size={20} />
          <PillVal color={p.shield.color}>{p.shield.label}</PillVal>
          <PillSub>RAID LOG</PillSub>
        </Row>

        {/* --- actionable ---------------------------------------------------- */}
        {/* aria-label doubles as the tutorial coach-mark anchor (M23 a6). */}
        <Row ariaLabel="Daily quests" onClick={() => go('quests')}>
          <Icon name="quest" size={20} />
          <PillVal color={C.success}>{p.quests.done}/{p.quests.total}</PillVal><PillSub>QUESTS</PillSub>
        </Row>
        {/* A claimable cache EXPIRES, so it is the one row that must be found
            without being read. It breathes; `accent` is the same fact held still
            for REDUCE MOTION and for a screenshot. */}
        {p.claim.available ? (
          <Row ariaLabel="Daily cache" accent={C.goldDp} hot reduceMotion={p.reduceMotion}
            onClick={() => go('claim')}>
            <Icon name="streak" size={20} /><PillVal color={C.goldHi}>CLAIM!</PillVal>
          </Row>
        ) : (
          <Row ariaLabel="Daily cache"
            // Locked by deedActionsAllowed() — a control that is refused, not a
            // readout. Same missing onClick as before (the gate is unchanged);
            // what is new is that the row now LOOKS refused instead of looking
            // exactly like the energy readout beside it.
            off={!p.claim.enabled}
            {...(p.claim.enabled ? { onClick: () => go('claim') } : {})}>
            <Icon name="streak" size={20} /><PillVal color={C.stoneDark}>D{p.claim.day}</PillVal><PillSub>CACHE</PillSub>
          </Row>
        )}
        {/* Escrowed rewards are the time-sensitive half of mail (they are what
            badges the overflow control), so they breathe; plain unread mail does
            not — a permanent pulse is a nag and stops meaning anything. */}
        <Row ariaLabel="Mail" accent={p.mail.pending ? C.goldDp : undefined}
          hot={!!p.mail.pending} reduceMotion={p.reduceMotion}
          onClick={() => go('mail')}>
          <Icon name="mail" size={20} />
          <PillSub>MAIL</PillSub>
          <PillVal color={p.mail.unread ? C.goldHi : C.stoneDark}>{p.mail.unread}</PillVal>
          {!!p.mail.pending && <PillSub>◆{p.mail.pending}</PillSub>}
        </Row>

        {/* --- destinations --------------------------------------------------- */}
        <InventoryHudButton onOpen={() => go('inventory')} />
        {p.selectorEnabled && (
          // "· SELECT" is a job the player has not done yet — the deed they are
          // looking at is nobody's choice until they make one — so that state
          // breathes and the ordinary multi-deed row does not.
          <Row ariaLabel="Bases" accent={C.goldDp} hot={p.needsBaseSelect} reduceMotion={p.reduceMotion}
            onClick={() => go('bases')}>
            <Icon name="keep" size={20} /><PillSub>BASES{p.needsBaseSelect ? ' · SELECT' : ''}</PillSub>
          </Row>
        )}
        {/* FOUNDING KINGDOMS (D-103) replaced the bare TESTER row: the same
            destination, now carrying today's points and the streak. The one row
            whose value is not a prop — it reads the shared, cached /tester/me
            snapshot (testerDaily.ts) so the panel does not need the overlay to
            fetch on its behalf; with no snapshot it is a plain destination. */}
        <FoundingRow onOpen={() => go('tester')} />
        {/* Owner-only, and only after the one-per-wallet probe succeeded. */}
        {p.isAdmin && (
          <Row ariaLabel="Admin" accent={C.goldDp} onClick={() => go('admin')}>
            <Icon name="admin" size={20} /><PillSub>ADMIN</PillSub>
          </Row>
        )}
        <Row ariaLabel="Settings and profile" onClick={() => go('profile')}>
          <Icon name="settings" size={24} /><PillSub>SETTINGS</PillSub>
        </Row>
      </div>
    </div>
  );
}

// ===========================================================================
// BASE-TOOLS DOCK
// ===========================================================================

/**
 * BUILDERS / LAYOUT / EXPAND / FIT are CONTEXTUAL ACTIONS on the base you are
 * looking at, not status, so they have no business in a status bar: they are
 * the reason the old portrait HUD needed a third row. They sit in the
 * bottom-LEFT corner instead — one tap each, adjacent to the navigation, and
 * diagonally opposite the play field's centre.
 *
 * Bottom-left specifically because the chat launcher has floated in the
 * bottom-RIGHT of this same band since M23 (right: 10 / bottom: 92 portrait,
 * right: rail + 10 / bottom: 10 landscape). The dock is 220px wide, so on the
 * narrowest supported phone (320px) the two clusters still miss each other.
 */
/**
 * A dock button is a SMALLER SIBLING OF A NAV TAB, deliberately one step down
 * the ramp — see hudTabStyle's 'dock' plate: dimmer crown, darker face, no gold
 * anywhere in it.
 *
 * WHY IT IS NOT THE CHIP WELL IT USED TO BE. hudChipStyle() draws a RECESSED
 * seat, which is the right idiom for a readout you look at and the wrong one
 * for a control you push — these four are actions, and the dock read as four
 * more sunken numerals sitting on the board. It is also why the plate has a
 * pressed state now: BUILDERS / LAYOUT / EXPAND / FIT each open a screen, and
 * nothing acknowledged the tap.
 *
 * AND WHY IT MUST STAY QUIET. Unlike the nav, the dock FLOATS over the play
 * field (playArea deliberately does not reserve its band). A control that is as
 * loud as the navigation while sitting on top of the board is the "chrome over
 * the game world" complaint all over again, one corner at a time.
 */
function DockBtn({ label, ariaLabel, accent, hot, reduceMotion, onClick, children }: {
  label: string; ariaLabel: string; accent?: string | undefined;
  /** Waiting on the player — today, every builder busy. Breathes; `accent` is
   *  the same fact held still. */
  hot?: boolean | undefined; reduceMotion?: boolean | undefined;
  onClick: () => void; children: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="interactive hud-tab hud-tab-dock"
      aria-label={ariaLabel}
      {...(hot ? { 'data-hud-hot': '1' } : {})}
      {...(hot && reduceMotion ? { 'data-hud-still': '1' } : {})}
      onClick={onClick}
      style={{
        ...hudTabStyle('dock'),
        width: 52, height: CHROME.dockRow, padding: 0,
        display: 'flex', alignItems: 'stretch', justifyContent: 'center',
        color: C.textDim, cursor: 'pointer', lineHeight: 1,
        ...(accent ? { outline: `2px solid ${accent}`, outlineOffset: -2 } : {}),
      }}>
      {/* One wrapper, same reason as the nav tab: a press drops the whole face
          by a pixel, and a bare text node cannot be moved. */}
      <span style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 1, flex: 1, minWidth: 0,
      }}>
        {children}
        <span style={{ fontSize: 11, letterSpacing: '.5px', color: C.textFaint }}>{label}</span>
      </span>
    </button>
  );
}

export function HudBaseDock({ enabled, free, total, reduceMotion, quiet = false, onGo, onFit }: {
  /** deedActionsAllowed(): false during the multi-base read cutover or while
   *  the base is under live raid. FIT is a camera op and stays either way —
   *  exactly the gating the pills had. */
  enabled: boolean;
  free: number; total: number;
  /** The active job is the first-run destination, not the hiring list. */
  quiet?: boolean;
  /** The game's own REDUCE MOTION setting. Optional so the dock stays
   *  renderable in isolation; absent means motion. */
  reduceMotion?: boolean | undefined;
  onGo: (screen: Screen) => void;
  onFit: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', pointerEvents: 'auto' }}>
      {/* The dock's press rules. Mounted here rather than borrowed from the bar
          so the dock renders correctly on its own — see HudChromeStyle. */}
      <HudChromeStyle />
      {enabled && (
        <>
          {/* "BUILDERS", not "BUILD" — BUILD is the navbar's build-tray
              destination and two controls one tap apart must not share a word. */}
          <DockBtn label="BUILDERS" ariaLabel="Builders" onClick={() => onGo('builders')}
            accent={free <= 0 && !quiet ? C.goldDp : undefined}
            hot={free <= 0 && !quiet} reduceMotion={reduceMotion}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="builder" size={24} />
              <span style={{ fontSize: 15, color: C.text }}>{free}/{total}</span>
            </span>
          </DockBtn>
          <DockBtn label="LAYOUT" ariaLabel="Base layout" onClick={() => onGo('layout')}>
            <Icon name="layout" size={18} />
          </DockBtn>
          <DockBtn label="EXPAND" ariaLabel="Expand base" onClick={() => onGo('expand')}>
            <Icon name="plus" size={18} />
          </DockBtn>
        </>
      )}
      {/* +/- zoom removed M23 a10: pinch, wheel and drag are the camera on every
          target platform; FIT stays as the one-tap reframe, ungated. */}
      <DockBtn label="FIT" ariaLabel="Fit base to screen" onClick={onFit}>
        <Icon name="locate" size={18} />
      </DockBtn>
    </div>
  );
}
