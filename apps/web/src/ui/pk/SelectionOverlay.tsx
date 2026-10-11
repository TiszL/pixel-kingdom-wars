/**
 * <PkSelectionOverlay>: the DOM half of a building selection (Android AND:K/ui/command/CommandBar.kt `SelectionOverlay`
 * + `NamePlate`; DESIGN-SYSTEM §6 Selection; buildings/SPEC.md §1.3, §1.5, §1.7; frames selected.png, buildings/states.png).
 * The selection ring/outline is drawn by Phaser (DS:294-296); this draws only the name plate (+ stem) and the command
 * bar, both anchored to the sprite's screen rect from `base:selectionAnchor`.
 *
 * - `selection` null → the last selection animates out (commands sink 12, plate lifts 8, both fade, 120 ms) and is
 *   dropped; taps during that hold are ignored. A new building cross-fades the commands (no slide).
 * - The plate sits 16 px above the sprite, clamped 8 px from the edges; it moves left of the resource stack, then
 *   below the ring, never over the sprite, the stack or the bar (`namePlatePlacement`, ported 1:1).
 * - Pointer rule: the plate and stem are paint only (a pan may start on them). Only command buttons take taps.
 * - Fixed overlay, absolutely positioned: opening/closing never touches document flow or the canvas size.
 * - Deselect itself is the scene's (`base:emptyTap`) and the back chain's; `onDeselect` is registered with the Back
 *   registry below sheets (priority 110 < sheets 220, X:src/ui/sheets.tsx:989), so Back walks sheet → selection.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import { NO_INSETS, PkCommandBarBody, usePlacedBar, type BarMotion } from './CommandBar';
import { PkPlate } from './Plate';
import { namePlatePlacement, resourceStackRect, stateLineRuns, tokenMs, type NamePlatePlacement } from './p2Logic';
import type { CommandRoute, FeatureId, NamePlateUi, PkViewport, PxInsets, SelectionUi } from './p2Types';
import { usePkViewport } from './usePkViewport';
import './SelectionOverlay.css';

export interface PkSelectionOverlayProps {
  selection: SelectionUi | null;
  onCommand: (id: FeatureId, route: CommandRoute) => void;
  onDeselect: () => void;
  onDisabledTap?: (id: FeatureId, reason: string) => void;
  onOverflow?: (ids: FeatureId[]) => void;
  insets?: PxInsets;
  viewport?: PkViewport;
}

/** Back-registry priority: below every sheet (220) and modal (300), above scroll pages (100). */
export const SELECTION_BACK_PRIORITY = 110;

export function PkSelectionOverlay({ selection, onCommand, onDeselect, onDisabledTap, onOverflow, insets = NO_INSETS, viewport }: PkSelectionOverlayProps): React.JSX.Element | null {
  const live = usePkViewport();
  const vp = viewport ?? live;
  const [retained, setRetained] = useState<SelectionUi | null>(selection);
  const [motion, setMotion] = useState<BarMotion>('enter');
  const lastId = useRef<string | null>(selection?.bar.buildingId ?? null);

  useEffect(() => {
    if (selection) {
      const id = selection.bar.buildingId;
      // First selection (or one during an exit hold) rises in; another building cross-fades; the same one keeps still.
      if (lastId.current === null) setMotion('enter');
      else if (lastId.current !== id) setMotion('swap');
      lastId.current = id;
      setRetained(selection);
      return undefined;
    }
    if (!retained) return undefined;
    setMotion('exit');
    lastId.current = null;
    const t = window.setTimeout(() => setRetained(null), tokenMs('--pk-dur-crossfade', 120));
    return () => window.clearTimeout(t);
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  useMobileBackHandler(() => { onDeselect(); }, selection !== null, SELECTION_BACK_PRIORITY);

  const shown = selection ?? retained;
  if (!shown) return null;
  return <SelectionBody shown={shown} motion={motion} vp={vp} insets={insets} onCommand={onCommand}
    {...(onDisabledTap ? { onDisabledTap } : {})} {...(onOverflow ? { onOverflow } : {})} />;
}

function SelectionBody({ shown, motion, vp, insets, onCommand, onDisabledTap, onOverflow }: {
  shown: SelectionUi; motion: BarMotion; vp: PkViewport; insets: PxInsets;
  onCommand: (id: FeatureId, route: CommandRoute) => void;
  onDisabledTap?: (id: FeatureId, reason: string) => void;
  onOverflow?: (ids: FeatureId[]) => void;
}): React.JSX.Element {
  const placed = usePlacedBar(shown.bar, shown.anchor, insets, vp);
  const plateRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = plateRef.current;
    if (!el) return;
    if (!size || size.w !== el.offsetWidth || size.h !== el.offsetHeight) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  const anchor = shown.anchor;
  const where: NamePlatePlacement | null = anchor && size
    ? namePlatePlacement(vp.w, vp.h, insets, anchor, size.w, size.h, [resourceStackRect(vp.w, insets), placed.placement.footprint])
    : null;
  return (
    <div className="pk-sel" data-pk-vp={vp.vp} data-motion={motion}>
      <PkCommandBarBody ui={shown.bar} placed={placed} viewport={vp} motion={motion} onCommand={onCommand}
        {...(onDisabledTap ? { onDisabledTap } : {})} {...(onOverflow ? { onOverflow } : {})} />
      {anchor ? (
        <>
          {where && where.stem.bottom > where.stem.top ? (
            <div className="pk-sel__stem" data-side={where.side} style={{ left: where.stem.left, top: where.stem.top, height: where.stem.bottom - where.stem.top }} />
          ) : null}
          <div ref={plateRef} className="pk-sel__plateAt" data-side={where?.side ?? 'ABOVE'}
            style={where ? { left: where.plate.left, top: where.plate.top } : { left: 0, top: 0, visibility: 'hidden' }}>
            <PkNamePlate key={shown.bar.buildingId} ui={shown.plate} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * <PkNamePlate> (Android `NamePlate`): charcoal plate 58 tall (72 with the job meter), 160-280 wide from its content.
 * Line 1: name (gold-hi, 1 px outline) + level tag ("LV 3" blue, "NEW" gold). Line 2: the live state line, tinted by
 * `stateLineRuns`. Unknown values arrive as "…" and are shown as such. Paint only: the plate is P0's
 * <PkPlate kind="CHARCOAL" blocksScene={false}> (`.pk-pass`), parity verdict B3.
 */
export function PkNamePlate({ ui }: { ui: NamePlateUi }): React.JSX.Element {
  const progress = ui.progress === null ? null : Math.min(1, Math.max(0, ui.progress));
  const spoken = [ui.name, ui.level.trim() || null, ui.stateLine?.trim() || null,
    progress !== null ? `${Math.floor(progress * 100)} percent done` : null].filter(Boolean).join(', ');
  const isNew = ui.level.trim().toUpperCase() === 'NEW';
  return (
    <div className="pk-nplate" data-meter={progress !== null ? 'true' : 'false'} role="img" aria-label={spoken}>
      <PkPlate kind="CHARCOAL" blocksScene={false} className="pk-nplate__plate">
        <div className="pk-nplate__in">
          <div className="pk-nplate__row">
            <span className="pk-t-title pk-ol1 pk-nplate__name">{ui.name}</span>
            {ui.level.trim() ? <span className="pk-nplate__tag" data-verb={isNew ? 'GOLD' : 'BLUE'}><span className="pk-t-caption">{ui.level}</span></span> : null}
          </div>
          {ui.stateLine && ui.stateLine.trim() ? (
            <div className="pk-body pk-nplate__state">
              {stateLineRuns(ui.stateLine).map((r, i) => <span key={i} data-tone={r.tone}>{r.text}</span>)}
            </div>
          ) : null}
          {progress !== null ? (
            <div className="pk-nplate__meter"><div className="pk-nplate__track"><i style={{ width: `${progress * 100}%` }} /></div></div>
          ) : null}
        </div>
      </PkPlate>
    </div>
  );
}
