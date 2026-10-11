/**
 * <PkPlate>: the plate materials of DESIGN-SYSTEM §5 (AND:K/ui/kit/Plate.kt): VEIL (HUD chip), CHARCOAL (name plate,
 * toast, title plate), PARCHMENT (sheet body), CREAM (cards, tiles, bubbles), WOOD (sheet frame). Hard bands, stepped
 * corners, no blur, no radius.
 *
 * <PkSheetTitlePlate> (KIT SheetTitlePlate) and <PkPlateFrame>: the parchment-in-wood chrome every sheet, card and the
 * Seal share: a wood frame, a charcoal title plate (+ blue LV tag, optional "LV 2 → LV 3" transition) with the stone
 * History and red Close squares, a parchment body, and a pinned footer for the one primary. It is chrome only: size
 * (HALF/TALL/FULL), position, scrim, slide and the living header belong to the P2 sheet host / `<PkSheet>`.
 *
 * Pointer rule: a plate is painted, so by default it is `.interactive` (a tap on it never reaches the kingdom).
 * `blocksScene={false}` is ONLY for world-anchored markers (NamePlate, TimerPlate) that must let a pan start on them.
 */
import type { CSSProperties, ReactNode } from 'react';
import { PkCloseSquare, PkIconSquare, PkTag } from './Button';
import './Plate.css';

export type PlateKind = 'VEIL' | 'CHARCOAL' | 'PARCHMENT' | 'CREAM' | 'WOOD';

/** A face colour that replaces the plate's own (selected / blood / divine), as a bridge colour name. */
export type PlateTint = 'selected' | 'blood' | 'res-divine' | 'gold' | 'green-hi';

export interface PkPlateProps {
  kind: PlateKind;
  /** Replaces the face colour. Default none. */
  tint?: PlateTint | null;
  /** Default true. False = paint only (`.pk-pass`), for world markers. */
  blocksScene?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function PkPlate({ kind, tint = null, blocksScene = true, className, style, children }: PkPlateProps): React.JSX.Element {
  const k = kind.toLowerCase();
  const cls = ['pk-plate', `pk-plate--${k}`, blocksScene ? 'interactive' : 'pk-pass', className].filter(Boolean).join(' ');
  const face = tint ? { ['--pk-plate-face' as string]: `var(--pk-${tint})` } : null;
  // PARCHMENT has no ink rim (DS §5), so it is one layer; every other material is an ink shell + a stepped face.
  if (kind === 'PARCHMENT') {
    return <div className={cls} style={{ ...style, ...face }}>{children}</div>;
  }
  return (
    <div className={cls} style={style}>
      <div className="pk-plate__face" style={face ?? undefined}>{children}</div>
    </div>
  );
}

export interface SheetTitleUi {
  /** "GOLD FORGE". */
  title: string;
  /** Level tag ("LV 3"); null draws none. */
  titleTag?: string | null;
  /** Turns the tag into a level transition: "LV 2 → LV 3" (SheetFrameUi.titleTagTo). */
  titleTagTo?: string | null;
}

/** The charcoal title plate (KIT SheetTitlePlate): gold-hi outlined title + blue LV tag. */
export function PkSheetTitlePlate({ ui }: { ui: SheetTitleUi }): React.JSX.Element {
  return (
    <PkPlate kind="CHARCOAL" className="pk-title-plate">
      <span className="pk-title-plate__row">
        <span className="pk-t-title pk-ol1 pk-title-plate__name">{ui.title}</span>
        {ui.titleTag ? (
          ui.titleTagTo
            ? <span className="pk-title-plate__to"><PkTag text={ui.titleTag} verb="BLUE" /><span className="pk-t-caption pk-ol1" aria-label="to">→</span><PkTag text={ui.titleTagTo} verb="GREEN" /></span>
            : <PkTag text={ui.titleTag} verb="BLUE" />
        ) : null}
      </span>
    </PkPlate>
  );
}

export interface PkPlateFrameProps {
  ui: SheetTitleUi & {
    /** Draws the stone History square (receipts one tap away). Default false. */
    history?: boolean;
  };
  /** Draws the red Close square when given. */
  onClose?: () => void;
  onHistory?: () => void;
  /** The pinned footer (the surface's ONE primary). */
  footer?: ReactNode;
  /** The parchment body (scrolls inside the frame when the host bounds the height). */
  children?: ReactNode;
  className?: string;
  /** Accessible name of the region; defaults to the title. */
  label?: string;
}

/** Wood frame > title row > parchment body > footer. Fills the box the host gives it. */
export function PkPlateFrame({ ui, onClose, onHistory, footer, children, className, label }: PkPlateFrameProps): React.JSX.Element {
  return (
    <section className={['pk-frame', className].filter(Boolean).join(' ')} aria-label={label ?? ui.title}>
      <PkPlate kind="WOOD" className="pk-frame__wood">
        <header className="pk-frame__head">
          <PkSheetTitlePlate ui={ui} />
          <span className="pk-frame__tools">
            {ui.history ? <PkIconSquare icon="replay" verb="STONE" onClick={onHistory ?? (() => {})} contentDescription="History" /> : null}
            {onClose ? <PkCloseSquare onClick={onClose} /> : null}
          </span>
        </header>
        <PkPlate kind="PARCHMENT" className="pk-frame__body">{children}</PkPlate>
        {footer ? <footer className="pk-frame__foot">{footer}</footer> : null}
      </PkPlate>
    </section>
  );
}
