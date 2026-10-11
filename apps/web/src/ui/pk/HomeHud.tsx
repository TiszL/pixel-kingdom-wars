/**
 * <HomeHud> — the web twin of AND:K/ui/hud/HomeHud.kt (DESIGN-SYSTEM §6 HUD; design/final/home.png, selected.png;
 * UX-ARCHITECTURE §2 zones TL / TR / LE / RE / HB / BD; owner addenda 5 and 6). Same signature as the approved code:
 * `HomeHud(ui, on, drawer = null, sealShown = false, stackLifted = false)`.
 *
 * - TL: the 40 px blue level badge (Profile) and one 30 px status chip (league + trophies → Leagues, builders →
 *   Builders, shield → Defence log), which is P0's <PkStatusChip>; every corner badge is P0's <PkBadge> (parity verdict
 *   B3). On phone-landscape the left edge tabs join this row's right end (lane §4).
 * - TR: the resource stack, ≤ 4 readouts (SHARDS, GEMS, KEEP only with a wallet, SKR + gold drawer caret), one hit
 *   region; a tap opens the drawer at the tapped row (`openDrawerAt(row.id)`; the registry row is always hud.resources).
 * - RE: edge buttons only while badged, as many as the 12 % budget allows (homeHudPlan), the rest fold as "+n", whose
 *   own 48 px door opens `rightEdgeOverflow`. LE: MAIL (while unread) / CHAT tabs, no caption.
 * - HB: the transient herald. BD: ATTACK + ARMY left, MAP + BUILD right (mirrored for left-handed), the transient
 *   context chip between them; BUILD's long-press (contextmenu) toggles the transient tools shelf.
 * - A selection (`deckVisible` false) fades TL / edges out and slides the deck down; the stack stays (costs are read
 *   against it). An open drawer hides the deck too.
 *
 * Pointer rule (lane §6): the root and every zone are `pointer-events:none` (the overlay root's rule); only painted
 * pieces carry `.interactive`, so empty HUD space lets pans and taps reach the Phaser scene. Everything is absolutely
 * positioned over the canvas: opening the drawer or a sheet never reflows the canvas.
 *
 * Pure: a function of props. Callers own every state (drawer open, focus, tools open) and route every id.
 */
import { lazy, Suspense, useState, type MouseEvent } from 'react';
import { PkBadge } from './Button';
import { ChunkyFace, HudIcon } from './HudArt';
import { PkStatusChip, type StatusChipUi } from './StatusChip';
import { featureId, type ChipUi as P0ChipUi } from './types';
import {
  HudIds, openDrawerAt, shown, type ChipUi, type ContextChipUi, type DeckToolUi, type EdgeButtonUi, type FeatureId, type HeraldUi,
  type HomeHudActions, type HomeHudUi, type ProfileMedallionUi, type ResourceChipUi, type ResourceDrawerUi,
} from './hudModel';
import { edgeOverflowTarget, hasDeckTools, homeHudPlan, hudIconDp, type DeckSlot } from './homeHudLogic';
import { usePkViewportClass } from './pkViewport';
import './HomeHud.css';

// review 88814cdb M5: the drawer must not enter Home's eager first-paint graph.
const LazyResourceDrawer = lazy(() => import('./ResourceDrawer').then(({ ResourceDrawer }) => ({ default: ResourceDrawer })));

export interface HomeHudProps {
  ui: HomeHudUi;
  on: HomeHudActions;
  /** The open drawer, or null (it animates out by itself). */
  drawer?: ResourceDrawerUi | null;
  /** A money Seal is shown: the stack stays readable but is not a target. */
  sealShown?: boolean;
  /** The host draws the stack itself above the sheet / Seal scrims with <HomeResourceStack>; leave it out here. */
  stackLifted?: boolean;
  /** The 320-class floor (lane §9 Q3): the shell sets it from layout.ts hudTier, never a CSS width breakpoint.
   * Collapses to the packed deck, an icon-only status chip and no edge caption pills (HomeHud.css "floor"). */
  floor?: boolean;
  className?: string;
}

export function HomeHud({ ui, on, drawer = null, sealShown = false, stackLifted = false, floor = false, className }: HomeHudProps): React.JSX.Element {
  const vp = usePkViewportClass();
  // Load only on the first open, then retain the component: ResourceDrawer owns
  // its null-on-close exit animation. Never retain a payload or callbacks here.
  const [drawerHasOpened, setDrawerHasOpened] = useState(drawer != null);
  if (drawer != null && !drawerHasOpened) setDrawerHasOpened(true);
  // Planned as if at rest, so zones that hide on a selection keep their content while they fade out (HomeHud.kt:146).
  const rest = homeHudPlan({ ...ui, deckVisible: true });
  const shelf = homeHudPlan({ ...ui, deckVisible: true, toolsOpen: true });
  const atRest = ui.deckVisible;
  const overflow = edgeOverflowTarget(rest, ui);
  const deckShown = atRest && drawer == null;
  const toolsShown = deckShown && (ui.toolsOpen ?? false) && shelf.tools.length > 0;
  const buildLongPress = hasDeckTools(ui) ? () => on.toggleTools?.(!(ui.toolsOpen ?? false)) : undefined;
  // phone-landscape packs the deck to stay inside the 12 % budget (HomeHud.css header): 48-tall primaries carry a
  // 20 px icon + caption, the 44 px small faces a 24 px icon only.
  const compact = vp === 'phone-landscape' || floor;

  return (
    <div className={`pk-hud${className ? ` ${className}` : ''}`} data-vp={vp} data-floor={floor || undefined}>
      <div className="pk-hud__safe">
        {/* TL (+ LE, which is laid out bottom-left on portrait and joins this row on phone-landscape) */}
        <div className="pk-hud__tl" data-hidden={!atRest || undefined} aria-hidden={!atRest || undefined}>
          <div className="pk-hud__tlrow">
            <LevelBadge ui={ui.profile} onOpen={on.openFeature} />
            {/* P0's chip (parity verdict B3): icon-only on phone-landscape and the floor via `compact`. */}
            <div className="pk-hud__status">
              <PkStatusChip ui={statusChipUi(ui)} onOpen={on.openFeature} compact={compact} />
            </div>
            {rest.leftEdge.length > 0 && (
              <div className="pk-hud__tabs">
                {rest.leftEdge.map((tab) => <EdgeTab key={tab.id} ui={tab} onOpen={on.openFeature} />)}
              </div>
            )}
          </div>
        </div>

        {/* TR — always shown, also while something is selected */}
        {!stackLifted && <ResourceStack rows={rest.resources} onOpen={(id) => openDrawerAt(on, id)} enabled={!sealShown} />}

        {/* RE — the side rail under the stack */}
        {rest.rightEdge.length > 0 && (
          <div className="pk-hud__re" data-hidden={!atRest || undefined} aria-hidden={!atRest || undefined}>
            {rest.rightEdge.map((button, index) =>
              index === 0 && overflow != null ? (
                <div className="pk-edge-row" key={button.id}>
                  <OverflowDoor folded={rest.rightEdgeFolded} target={overflow} onOpen={on.openFeature} />
                  <EdgeButton ui={button} folded={0} onOpen={on.openFeature} />
                </div>
              ) : (
                <EdgeButton key={button.id} ui={button} folded={index === 0 ? rest.rightEdgeFolded : 0} onOpen={on.openFeature} />
              ),
            )}
          </div>
        )}

        {/* HB — transient, beside the stack so it never covers a readout */}
        {ui.herald && <Herald ui={ui.herald} onOpen={on.openFeature} />}

        {/* BD */}
        <div className="pk-hud__deck" data-hidden={!deckShown || undefined} aria-hidden={!deckShown || undefined}>
          <div className="pk-deck__corner pk-deck__corner--l">
            {rest.deck.filter((s) => s.leftCorner).map((s) => (
              <DeckButton key={s.button.id} slot={s} compact={compact} onOpen={on.openFeature} onLongPress={s.button.id === HudIds.BUILD ? buildLongPress : undefined} />
            ))}
          </div>
          {ui.context && <ContextChip key={ui.context.id} ui={ui.context} onOpen={on.openFeature} />}
          <div className="pk-deck__corner pk-deck__corner--r">
            {rest.deck.filter((s) => !s.leftCorner).map((s) => (
              <DeckButton key={s.button.id} slot={s} compact={compact} onOpen={on.openFeature} onLongPress={s.button.id === HudIds.BUILD ? buildLongPress : undefined} />
            ))}
          </div>
        </div>

        {/* BD tools shelf — transient, over BUILD's corner, after a long-press on BUILD */}
        {toolsShown && (
          <div className={`pk-tools pk-tools--${shelf.toolsLeft ? 'l' : 'r'}`}>
            {shelf.tools.map((t) => <ToolButton key={t.id} ui={t} onOpen={on.openFeature} />)}
          </div>
        )}
      </div>
      {drawerHasOpened && <Suspense fallback={null}><LazyResourceDrawer ui={drawer} on={on} /></Suspense>}
    </div>
  );
}

/**
 * The stack alone, positioned as <HomeHud> draws it, for a host that lifts it above the sheet and Seal scrims
 * (HomeHud.kt:208 HomeResourceStack; KIT-API Z.RESOURCE_STACK 8.5). Pass `stackLifted` to <HomeHud> as well.
 */
export function HomeResourceStack({ ui, on, sealShown = false }: { ui: HomeHudUi; on: HomeHudActions; sealShown?: boolean }): React.JSX.Element {
  const vp = usePkViewportClass();
  return (
    <div className="pk-hud pk-hud--stack-only" data-vp={vp}>
      <div className="pk-hud__safe">
        <ResourceStack rows={homeHudPlan({ ...ui, deckVisible: true }).resources} onOpen={(id) => openDrawerAt(on, id)} enabled={!sealShown} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function LevelBadge({ ui, onOpen }: { ui: ProfileMedallionUi; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  const spoken = [ui.description, ui.badge?.description].filter(Boolean).join('. ');
  return (
    <button type="button" className="pk-tap pk-level interactive" aria-label={spoken} onClick={() => onOpen(ui.id)}>
      <span className="pk-level__face" data-pk-hud="level">
        <ChunkyFace verb="BLUE"><span className="pk-disp pk-disp--primary pk-ol2">{shown(ui.level)}</span></ChunkyFace>
      </span>
      {ui.badge && <PkBadge ui={ui.badge} className="pk-badge--tr" />}
    </button>
  );
}

/**
 * HomeHudUi → P0 StatusChipUi (trophies / builders / shield, same field names). P0 brands FeatureId; P1 keeps the plain
 * Android string (verdict MINOR 7 is still open), so the ids cross the boundary here, typed, with no cast.
 */
function statusChipUi(ui: HomeHudUi): StatusChipUi {
  const chip = (c: ChipUi): P0ChipUi => ({ ...c, id: featureId(c.id) });
  return { trophies: ui.trophies ? chip(ui.trophies) : null, builders: chip(ui.builders), shield: chip(ui.shield) };
}

/** One hit region; a row button opens at its row; a tap in a 2 px gap resolves to the row by y (Chips.kt:170). */
function ResourceStack({ rows, onOpen, enabled }: { rows: ResourceChipUi[]; onOpen: (id: FeatureId) => void; enabled: boolean }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  const onGap = (e: MouseEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const index = Math.min(rows.length - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * rows.length)));
    onOpen(rows[index]!.id);
  };
  return (
    <div className={`pk-stack${enabled ? ' interactive' : ''}`} data-pk-hud="stack" role="group" aria-label="Resources" onClick={enabled ? onGap : undefined}>
      {rows.map((row) => (
        <button key={row.id} type="button" className="pk-tap pk-rrow" data-accent={row.accent ?? 'PLAIN'} disabled={!enabled}
          aria-label={row.exactDescription || `${row.name || row.id} ${shown(row.value)}`}
          onClick={(e) => { e.stopPropagation(); onOpen(row.id); }}>
          <span className="pk-veil"><span className="pk-veil__in">
            <HudIcon icon={row.icon} size={24} className="pk-rrow__ic" />
            <span className="pk-rrow__v pk-disp pk-disp--label pk-ol1">{shown(row.value)}</span>
            {row.drawerHandle && <span className="pk-caret" aria-hidden="true"><i /><HudIcon icon="shape:caret" size={12} /></span>}
            {row.fill != null && (
              <span className="pk-rrow__bar" data-full={row.fill >= 1 || undefined}><i style={{ width: `${Math.min(1, Math.max(0, row.fill)) * 100}%` }} /></span>
            )}
          </span></span>
          {row.badge && <PkBadge ui={row.badge} className="pk-rrow__badge" />}
          {row.gain && <span key={row.gain} className="pk-rrow__gain pk-disp pk-ol1" aria-hidden="true">{row.gain}</span>}
        </button>
      ))}
    </div>
  );
}

function OverflowDoor({ folded, target, onOpen }: { folded: number; target: FeatureId; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  const spoken = `${folded} more notices`;
  return (
    <button type="button" className="pk-tap pk-overflow interactive" aria-label={spoken} onClick={() => onOpen(target)}>
      <PkBadge ui={{ text: `+${folded}`, tone: 'INFO', description: spoken }} className="pk-overflow__badge" />
    </button>
  );
}

function EdgeButton({ ui, folded, onOpen }: { ui: EdgeButtonUi; folded: number; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  const spoken = [ui.label, ui.badge?.description, folded > 0 ? `and ${folded} more` : null].filter(Boolean).join('. ');
  return (
    <div className="pk-edge">
      <button type="button" className="pk-tap pk-edge__btn interactive" aria-label={spoken} title={ui.label} onClick={() => onOpen(ui.id)}>
        {ui.glow && <span className="pk-edge__glow" aria-hidden="true" />}
        <span className="pk-edge__face" data-pk-hud="edge">
          <ChunkyFace verb="CHARCOAL"><HudIcon icon={ui.icon} size={hudIconDp(ui.icon, true)} /></ChunkyFace>
        </span>
        {ui.badge && <PkBadge ui={ui.badge} className="pk-badge--tr" />}
        {folded > 0 && <PkBadge ui={{ text: `+${folded}`, tone: 'INFO', description: `${folded} more` }} className="pk-badge--tl" />}
      </button>
      <span className="pk-edge__label pk-disp pk-ol1" data-pk-hud="edge-label" aria-hidden="true">{ui.label}</span>
    </div>
  );
}

function EdgeTab({ ui, onOpen }: { ui: EdgeButtonUi; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  const spoken = [ui.label, ui.badge?.description].filter(Boolean).join('. ');
  return (
    <button type="button" className="pk-tap pk-tab interactive" aria-label={spoken} title={ui.label} onClick={() => onOpen(ui.id)}>
      <span className="pk-tab__face" data-pk-hud="tab"><span className="pk-tab__in"><HudIcon icon={ui.icon} size={hudIconDp(ui.icon, false)} /></span></span>
      {ui.badge && <PkBadge ui={ui.badge} className="pk-badge--tr" />}
    </button>
  );
}

function DeckButton({ slot, compact, onOpen, onLongPress }: { slot: DeckSlot; compact: boolean; onOpen: (id: FeatureId) => void; onLongPress?: (() => void) | undefined }): React.JSX.Element {
  const ui = slot.button;
  const size = !ui.primary ? 'small' : slot.width > slot.height ? 'first' : 'primary';
  const spoken = [ui.label, ui.pips ? `${ui.pips[0]} of ${ui.pips[1]}` : null, ui.badge?.description,
    onLongPress ? TOOLS_LONG_PRESS_LABEL : null].filter(Boolean).join('. ');
  const verb = ui.verb ?? (ui.primary ? 'GOLD' : 'STONE');
  const pips = ui.pips && ui.pips[1] > 0 ? Math.min(1, Math.max(0, ui.pips[0] / ui.pips[1])) : null;
  return (
    <button type="button" className={`pk-tap pk-deck__btn pk-deck__btn--${size} interactive`} aria-label={spoken}
      onClick={() => onOpen(ui.id)}
      onContextMenu={onLongPress ? (e) => { e.preventDefault(); onLongPress(); } : undefined}>
      <span className="pk-deck__face" data-pk-hud="deck">
        <ChunkyFace verb={verb}>
          <HudIcon icon={ui.icon} size={compact ? Math.min(ui.primary ? 20 : 24, hudIconDp(ui.icon, ui.primary)) : hudIconDp(ui.icon, ui.primary)} className="pk-deck__ic" />
          {pips != null && <span className="pk-deck__pips" aria-hidden="true"><i style={{ width: `${pips * 100}%` }} /></span>}
          <span className="pk-deck__cap pk-disp pk-ol1">{ui.label}</span>
        </ChunkyFace>
      </span>
      {ui.badge && <PkBadge ui={ui.badge} className="pk-badge--tr" />}
    </button>
  );
}

/** HomeHud.kt TOOLS_LONG_PRESS_LABEL; on the web a long-press arrives as `contextmenu` (also right-click, Shift+F10). */
const TOOLS_LONG_PRESS_LABEL = 'Long-press for base tools: layout, expand, fit';

function ToolButton({ ui, onOpen }: { ui: DeckToolUi; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  return (
    <button type="button" className="pk-tap pk-deck__btn pk-deck__btn--small interactive" aria-label={ui.description} aria-disabled={!ui.enabled || undefined}
      onClick={() => { if (ui.enabled) onOpen(ui.id); }}>
      <span className="pk-deck__face">
        <ChunkyFace verb={ui.enabled ? 'STONE' : 'OFF'}>
          <HudIcon icon={ui.icon} size={hudIconDp(ui.icon, false)} />
          <span className="pk-deck__cap pk-disp pk-ol1">{ui.label}</span>
        </ChunkyFace>
      </span>
    </button>
  );
}

function ContextChip({ ui, onOpen }: { ui: ContextChipUi; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  return (
    <button type="button" className="pk-tap pk-context interactive" aria-label={`${ui.what}, ${ui.where}`} onClick={() => onOpen(ui.id)}>
      <span className="pk-context__card" data-pk-wm="context">
        <span className="pk-context__in">
          <span className="pk-context__what pk-body">{ui.what}</span>
          <span className="pk-context__where pk-body">{ui.where} <span className="pk-shape pk-shape--caret pk-context__arrow" /></span>
        </span>
      </span>
      <HudIcon icon={ui.icon} size={32} className="pk-context__ic" />
    </button>
  );
}

function Herald({ ui, onOpen }: { ui: HeraldUi; onOpen: (id: FeatureId) => void }): React.JSX.Element {
  const body = (
    <span className="pk-veil pk-herald__veil" data-pk-wm="herald">
      <span className="pk-veil__in"><HudIcon icon={ui.icon} size={32} /><span className="pk-herald__t pk-body">{ui.text}</span></span>
    </span>
  );
  const target = ui.target;
  return target != null ? (
    <button key={ui.key} type="button" className="pk-tap pk-herald interactive" onClick={() => onOpen(target)}>{body}</button>
  ) : (
    <div key={ui.key} className="pk-herald" role="status">{body}</div>
  );
}
