/**
 * <PkNamePlate>: the plate over a selected building (AND:K/ui/command/CommandBar.kt NamePlate, DESIGN-SYSTEM §6
 * NamePlate). CHARCOAL, 58 tall (72 with the job meter), 160-280 wide, a 4 x 20 ink stem to the roof.
 * Line 1: the name (title, gold-hi, 1 px outline) + the level tag (blue "LV 3", gold "NEW"). Line 2: the live state line
 * tinted by `stateLineRuns` (muted words, counts in text colour, times gold-hi, "Ready" green-hi, "Spent" danger).
 * Unknown values arrive as "…" and are shown as such. Never repeated in the command bar.
 *
 * Placement (`namePlatePlacement`, pure): centred over the sprite, clamped 8 px from the overlay edges, and FLIPPED below
 * the sprite when there is no room above (landscape phones, LANE §4 "flips below when no room"). The component measures
 * only its own width (one layout read, overlay-only; the Phaser canvas never reflows).
 *
 * Pointer rule: paint only (`.pk-pass`): a pan may start on it.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { PkTag } from './Button';
import { PkPlate } from './Plate';
import { stateLineRuns } from './kitLogic';
import type { NamePlateUi, PxRect } from './types';
import './NamePlate.css';

/** DS sizes the placement math needs (the same values as --pk-size-name-plate-*, --pk-gutter). */
const GUTTER = 8;
const STEM_H = 20;
const PLATE_H = 58;
const PLATE_WITH_METER_H = 72;

export interface NamePlatePlacement {
  /** Plate left edge in overlay CSS px. */
  left: number;
  /** Plate top edge in overlay CSS px. */
  top: number;
  /** True when the plate sits under the sprite (stem points up). */
  below: boolean;
  /** Stem x inside the plate (follows the sprite when the plate is clamped). */
  stemX: number;
}

/** Where the plate goes for a sprite rect, its own size and the overlay box. Pure; unit-testable. */
export function namePlatePlacement(anchor: PxRect, plateW: number, plateH: number, overlayW: number, topInset = GUTTER): NamePlatePlacement {
  const cx = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(GUTTER, overlayW - GUTTER - plateW);
  const left = Math.min(maxLeft, Math.max(GUTTER, cx - plateW / 2));
  const aboveTop = anchor.top - STEM_H - plateH;
  const below = aboveTop < topInset;
  const top = below ? anchor.bottom + STEM_H : aboveTop;
  const stemX = Math.min(plateW - GUTTER, Math.max(GUTTER, cx - left));
  return { left, top, below, stemX };
}

export interface PkNamePlateProps {
  ui: NamePlateUi;
  /** The selected sprite's rect in overlay CSS px (`base:selectionAnchor`). */
  anchor: PxRect;
  /** The overlay's width in CSS px. */
  overlayWidth: number;
  /** The lowest y the plate may start at (under the HUD top band). Default 8. */
  topInset?: number;
}

export function PkNamePlate({ ui, anchor, overlayWidth, topInset = GUTTER }: PkNamePlateProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(160);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth;
    if (w && w !== width) setWidth(w);
  });
  const progress = ui.progress == null ? null : Math.min(1, Math.max(0, ui.progress));
  const h = progress == null ? PLATE_H : PLATE_WITH_METER_H;
  const place = namePlatePlacement(anchor, width, h, overlayWidth, topInset);
  const level = ui.level.trim();
  const spoken = [ui.name, level || null, ui.stateLine?.trim() || null,
    progress == null ? null : `${Math.trunc(progress * 100)} percent done`].filter(Boolean).join(', ');
  return (
    <div ref={ref} className={`pk-nameplate${place.below ? ' pk-nameplate--below' : ''}`} role="img" aria-label={spoken}
      style={{ left: place.left, top: place.top, ['--pk-stem-x' as string]: `${place.stemX}px` }}>
      <PkPlate kind="CHARCOAL" blocksScene={false} className="pk-nameplate__plate">
        <span className="pk-nameplate__l1">
          <span className="pk-t-title pk-ol1 pk-nameplate__name">{ui.name}</span>
          {level ? <PkTag text={level} verb={level.toUpperCase() === 'NEW' ? 'GOLD' : 'BLUE'} /> : null}
        </span>
        {ui.stateLine && ui.stateLine.trim() !== '' ? (
          <span className="pk-t-body pk-nameplate__state">
            {stateLineRuns(ui.stateLine).map((r, i) => <span key={i} className={`pk-run--${r.tone.toLowerCase()}`}>{r.text}</span>)}
          </span>
        ) : null}
        {progress != null ? (
          <span className="pk-nameplate__meter"><i style={{ width: `${progress * 100}%` }} /></span>
        ) : null}
      </PkPlate>
      <span className="pk-nameplate__stem" aria-hidden="true" />
    </div>
  );
}
