/**
 * <PkCommandBar>: the selected building's command bar (Android AND:K/ui/command/CommandBar.kt `CommandBar` +
 * `CommandMedallion`; DESIGN-SYSTEM §6 CommandBar/CommandButton; buildings/SPEC.md §1.3, §1.7; frames selected.png,
 * buildings/commands-1…5.png, buildings/states.png).
 *
 * State in, callbacks out: `ui: CommandBarUi` (Android field names), the selected sprite's `anchor`, and
 * `onCommand(id, route)`. Geometry is the 1:1 port in p2Logic.ts (`commandBarPlacement`); this file draws and animates.
 *
 * Rules kept here:
 * - Max commands: 4 portrait / 5 landscape (Android `commandBarLimit`), 3 below 360 px wide (WEB-ONLY amendment 4).
 *   INFO first, the one primary last under the right thumb (`orderCommands`). A dropped secondary is reported by
 *   `onOverflow` (fail loud) so the INFO sheet can carry it as a stone row (buildings/SPEC:238).
 * - Price semantics: CHECKING "…" = enabled navigation; UNAVAILABLE = disabled; SHORT routes NEED_MORE (the caller opens
 *   <PkNeedMoreSheet>); "0" only for SERVER_ZERO. Nothing here spends.
 * - BUSY never calls back. A DISABLED tap answers itself (2 px shake + the reason pill for --pk-dur-toast-hold) and is
 *   still reported, as on Android.
 * - Pointer rule: the root, shelf, hint/reason pill are paint only (pointer-events:none), so a pan can start on the
 *   shelf. Only the command buttons are `.interactive`.
 * - The bar is a fixed overlay: it never touches document flow, so the Phaser canvas never reflows.
 *
 * Coverage (transient, not the permanent HUD; TOK budgetOverlay "transient"; the permanent ≤ 12 % budget is P1's):
 *   phone-portrait 412×915: shelf 412×163 = 67,156 / 376,980 = 17.8 % while a building is selected (deck hidden).
 *   tablet-portrait 768×1024: 768×163 = 11.9 %.
 *   phone-landscape 844×390, compact 5 commands: band 492×143 = 70,356 / 329,160 = 21.4 % (bottom-right only).
 *   tablet-landscape 1024×768: band 516×163 = 10.7 %.  desktop 1440×900: band 516×163 = 6.5 %; 1920×1080: 4.1 %.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PkBadge, PkBusyDots } from './Button';
import { PkIcon } from './Icon';
import { PkPriceChip } from './PriceChip';
import { PkP2Icon } from './p2Kit';
import {
  barDocked, commandBarPlacement, commandDescription, commandDrawState, commandRoute, dockedBandLeft, metricsFor,
  orderCommands, tokenMs, webCommandLimit, type BarSide, type CommandBarMetrics, type CommandBarPlacement,
} from './p2Logic';
import type { CommandBarUi, CommandRoute, CommandUi, FeatureId, PkViewport, PxInsets, PxRect, Verb } from './p2Types';
import { usePkViewport } from './usePkViewport';
import './CommandBar.css';

export const NO_INSETS: PxInsets = { left: 0, top: 0, right: 0, bottom: 0 };

/** The bar as placed for one frame: the ordered commands, the placement and the metrics it used. */
export interface PlacedBar {
  commands: CommandUi[];
  placement: CommandBarPlacement;
  metrics: CommandBarMetrics;
  docked: boolean;
}

/**
 * Android `rememberPlacedBar`: orders and places the bar, keeping the previous side for the same building while it
 * still clears the anchor (no jump during a pan).
 */
export function usePlacedBar(ui: CommandBarUi, anchor: PxRect | null, insets: PxInsets, viewport: PkViewport): PlacedBar {
  const sticky = useRef<{ buildingId: string; side: BarSide } | null>(null);
  const previous = sticky.current?.buildingId === ui.buildingId ? sticky.current.side : null;
  const placed = useMemo(() => {
    const m = metricsFor(viewport.vp);
    const docked = barDocked(viewport.vp);
    const commands = orderCommands(ui.commands, webCommandLimit(viewport.w, viewport.h));
    const specs = commands.map((c) => ({ primary: c.primary, priced: c.price !== null }));
    const bandLeft = docked ? dockedBandLeft(viewport.w, insets, specs, m) : 0;
    const placement = commandBarPlacement(viewport.w, viewport.h, insets, specs, anchor, !!ui.hint, previous, m, bandLeft);
    return { commands, placement, metrics: m, docked };
  }, [ui, anchor, insets, viewport, previous]);
  useEffect(() => { sticky.current = { buildingId: ui.buildingId, side: placed.placement.side }; });
  return placed;
}

/** enter = rise + fade with stagger; swap = another building, 120 ms cross-fade; exit = sink + fade; still = none. */
export type BarMotion = 'enter' | 'swap' | 'exit' | 'still';

export interface PkCommandBarProps {
  ui: CommandBarUi;
  /** Every tap except BUSY, with its route (OPEN / NEED_MORE / EXPLAIN). SHORT → open <PkNeedMoreSheet>. */
  onCommand: (id: FeatureId, route: CommandRoute) => void;
  /** Optional: a DISABLED tap (the bar already shook and showed the reason). */
  onDisabledTap?: (id: FeatureId, reason: string) => void;
  /** Optional: commands the bar could not fit (fail loud); the INFO sheet lists them as stone rows. */
  onOverflow?: (ids: FeatureId[]) => void;
  /** The selected sprite's visible bounds (CSS px, overlay space) from `base:selectionAnchor`; null = bottom. */
  anchor?: PxRect | null;
  insets?: PxInsets;
  viewport?: PkViewport;
}

export function PkCommandBar({ ui, onCommand, onDisabledTap, onOverflow, anchor = null, insets = NO_INSETS, viewport }: PkCommandBarProps): React.JSX.Element {
  const live = usePkViewport();
  const vp = viewport ?? live;
  const placed = usePlacedBar(ui, anchor, insets, vp);
  return <PkCommandBarBody ui={ui} placed={placed} viewport={vp} motion="enter" onCommand={onCommand}
    {...(onDisabledTap ? { onDisabledTap } : {})} {...(onOverflow ? { onOverflow } : {})} />;
}

export interface PkCommandBarBodyProps {
  ui: CommandBarUi;
  placed: PlacedBar;
  viewport: PkViewport;
  motion: BarMotion;
  onCommand: (id: FeatureId, route: CommandRoute) => void;
  onDisabledTap?: (id: FeatureId, reason: string) => void;
  onOverflow?: (ids: FeatureId[]) => void;
}

/** The drawing half (Android `CommandBarBody`), shared with <PkSelectionOverlay>. */
export function PkCommandBarBody({ ui, placed, viewport, motion, onCommand, onDisabledTap, onOverflow }: PkCommandBarBodyProps): React.JSX.Element {
  const { commands, placement, metrics, docked } = placed;
  const [reason, setReason] = useState<{ text: string; id: FeatureId; tick: number } | null>(null);

  useEffect(() => { setReason(null); }, [ui.buildingId]);
  useEffect(() => {
    if (!reason) return undefined;
    const t = window.setTimeout(() => setReason(null), tokenMs('--pk-dur-toast-hold', 4000));
    return () => window.clearTimeout(t);
  }, [reason]);

  const droppedIds = useMemo(() => placement.dropped.map((i) => commands[i]?.id).filter((x): x is string => !!x)
    .concat(ui.commands.filter((c) => !commands.some((k) => k.id === c.id)).map((c) => c.id)),
  [placement.dropped, commands, ui.commands]);
  const droppedKey = droppedIds.join('|');
  useEffect(() => { if (droppedIds.length > 0) onOverflow?.(droppedIds); }, [droppedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const tap = (c: CommandUi): void => {
    if (motion === 'exit') return; // taps during the exit hold are dropped
    const route = commandRoute(c);
    if (route === 'IGNORE') return;
    if (commandDrawState(c) === 'DISABLED' && c.reason && c.reason.trim() !== '') {
      setReason((r) => ({ text: c.reason!, id: c.id, tick: (r?.tick ?? 0) + 1 }));
      onDisabledTap?.(c.id, c.reason);
    }
    onCommand(c.id, route);
  };

  const { band, step } = placement;
  const pillText = reason?.text ?? ui.hint ?? null;
  const pillTop = reason ? placement.pillTop : placement.hintTop;
  const pillCentre = (band.left + band.right) / 2;
  const box = (r: PxRect): React.CSSProperties => ({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top });
  const hidden = placement.dropped;

  return (
    <div className="pk-cbar" data-pk-vp={viewport.vp} data-side={placement.side} data-docked={docked ? 'true' : 'false'}
      data-motion={motion} data-compact={metrics.BUTTON < 68 ? 'true' : 'false'}>
      <div className="pk-cbar__step" style={box(step)} />
      <div className="pk-cbar__band" style={box(band)} />
      {pillText !== null && pillTop !== null ? (
        <div key={reason ? `r${reason.tick}` : 'hint'} className="pk-cbar__pill pk-body" data-kind={reason ? 'reason' : 'hint'}
          role="status" aria-live="polite" style={{ top: pillTop, left: pillCentre }}>{pillText}</div>
      ) : null}
      <div key={`${ui.buildingId}:${motion === 'exit' ? 'live' : motion}`} className="pk-cbar__slots">
        {placement.slots.map((slot, order) => {
          const c = commands[slot.index];
          if (!c || hidden.includes(slot.index)) return null;
          return (
            <PkCommandButton key={c.id} ui={c} column={slot.column} button={slot.button} order={order}
              dpr={viewport.dpr} compact={metrics.BUTTON < 68} live={motion !== 'exit'}
              shakeTick={reason && reason.id === c.id ? reason.tick : 0} onTap={tap} />
          );
        })}
      </div>
    </div>
  );
}

/** GameButton.kt `stateRamp` (= P0 Button.tsx `stateVerb`): BUSY draws stone, so a busy primary never reads as tappable. */
const STATE_VERB: Partial<Record<string, Verb>> = { DISABLED: 'OFF', LOCKED: 'CHARCOAL', BUSY: 'STONE' };

/**
 * Android `CommandMedallion`: one column (cost pill, chunky face, caption) at the placed rectangle. The face is P0's
 * chunky shell + face (Button.css `.pk-btn__shell` / `.pk-btn__face` + `.pk-verb--*`), the pill P0's <PkPriceChip>, the
 * badge P0's <PkBadge>, the dots P0's <PkBusyDots>. `live` false (the exit hold) drops `.interactive` so the host's
 * `#overlay-root .interactive` rule cannot keep a leaving button tappable.
 */
export function PkCommandButton({ ui, column, button, order, dpr, compact, shakeTick, onTap, live = true }: {
  ui: CommandUi; column: PxRect; button: PxRect; order: number; dpr: number; compact: boolean; shakeTick: number;
  onTap: (c: CommandUi) => void; live?: boolean;
}): React.JSX.Element {
  const state = commandDrawState(ui);
  const baseVerb: Verb = ui.primary && (ui.verb ?? 'STONE') === 'STONE' ? 'GOLD' : (ui.verb ?? 'STONE');
  const verb = STATE_VERB[state] ?? baseVerb;
  const price = ui.price && state === 'SHORT' && ui.price.status === 'OK' ? { ...ui.price, status: 'SHORT' as const } : ui.price;
  const lockedReason = ui.primary && state === 'LOCKED' && ui.reason && ui.reason.trim() !== '' ? ui.reason : null;
  const faceW = button.right - button.left;
  const faceH = button.bottom - button.top;
  const iconTarget = ui.primary ? 40 : compact ? 32 : 36;
  const iconMax = ui.primary ? (compact ? 32 : 40) : ui.sub ? (compact ? 24 : 32) : iconTarget;

  return (
    <div className="pk-cmd" data-primary={ui.primary ? 'true' : 'false'} data-state={state}
      style={{ left: column.left, top: column.top, width: column.right - column.left, ['--pk-cmd-i' as string]: order }}>
      <button type="button" className={`pk-press${live ? ' interactive' : ''} pk-cmd__press`} aria-label={commandDescription(ui)}
        aria-disabled={state === 'DISABLED' || state === 'BUSY' ? 'true' : undefined}
        title={ui.caption} onClick={() => onTap(ui)}>
        {price ? <span className="pk-cmd__price"><PkPriceChip ui={price} /></span> : null}
        <span key={shakeTick} className="pk-cmd__faceWrap" data-shake={shakeTick > 0 ? 'true' : 'false'} style={{ width: faceW, height: faceH }}>
          <span className={`pk-btn__shell pk-cmd__shell pk-verb--${verb.toLowerCase()}`} style={{ width: faceW, height: faceH }}>
            <span className="pk-btn__face"><span className="pk-cmd__content">
              {state === 'BUSY' ? <PkBusyDots /> : state === 'LOCKED' ? (
                lockedReason ? (
                  <>
                    <span className="pk-cmd__lockRow"><PkIcon name="shape:lock" size={24} tint="gold" dpr={dpr} />
                      <span className="pk-t-primary pk-ol2 pk-cmd__label">{ui.caption}</span></span>
                    <span className="pk-small pk-cmd__lockReason">{lockedReason}</span>
                  </>
                ) : (
                  <span className="pk-cmd__lockIcon"><PkP2Icon name={ui.icon} target={iconTarget} dpr={dpr} maxCss={iconMax} dim />
                    <span className="pk-cmd__padlock"><PkIcon name="shape:lock" size={24} tint="gold" dpr={dpr} /></span></span>
                )
              ) : (
                <>
                  <span className="pk-cmd__icons" data-dim={state === 'DISABLED' ? 'true' : 'false'}>
                    <PkP2Icon name={ui.icon} target={iconTarget} dpr={dpr} maxCss={iconMax} />
                    {ui.primary && ui.iconSecondary ? <PkP2Icon name={ui.iconSecondary} target={40} dpr={dpr} maxCss={iconMax} /> : null}
                  </span>
                  {ui.sub ? <span className="pk-small pk-ol1 pk-cmd__sub">{ui.sub}</span> : null}
                  {ui.primary ? <span className="pk-t-primary pk-ol2 pk-cmd__label">{ui.caption}</span> : null}
                </>
              )}
            </span></span>
          </span>
          {ui.badge ? <PkBadge ui={ui.badge} className="pk-cmd__badge" /> : null}
        </span>
        {!ui.primary ? <span className="pk-t-caption pk-ol1 pk-cmd__caption">{ui.caption}</span> : null}
      </button>
    </div>
  );
}
