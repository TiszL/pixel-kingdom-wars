/**
 * P2's icon adapter over P0. The other P2 stand-ins (cost pill, badge, busy dots, plates, glyphs) are gone: P2 renders
 * P0's <PkPriceChip>, <PkBadge>, <PkBusyDots>, <PkPlate>, <PkPrimaryButton> / <PkSecondaryButton> / <PkCloseSquare> and
 * <PkIcon> (Rule 7; parity verdict B3 + M5). What stays is the command bar's art sizing (the WEB-ONLY `maxCss` cap of
 * p2Logic.artCssSize) on top of P0's resolver.
 */
import { createContext, useContext } from 'react';
import { PkIcon, pkArt } from './Icon';
import { artCssSize } from './p2Logic';
import './kitBase.css';
import './p2Kit.css';

/**
 * Resolves a kit icon name (`ui:<id>`, a GameArt name, `shards`, `gem`, …) to an image URL and its art size in px: the
 * SAME `{ src, artPx }` shape as P0 `pkArt` and P1 `PkArtResolver`, so one host function can feed every context.
 * `artPx` 0 = a master sprite with no fixed art size (drawn at the box size).
 * DEFAULT = P0's own table (`pkArt`, Icon.tsx), so NO provider is required. A provider is an optional override; a name it
 * returns null/undefined for falls back to P0's <PkIcon> (its glyph, or the visible "?" with `data-pk-missing`).
 */
export type PkIconResolver = (name: string) => { src: string; artPx: number } | null | undefined;
export const PkIconContext = createContext<PkIconResolver>(pkArt);

/**
 * A kit icon at an integer art scale for the live DPR (LANE §4). `target` is the design size in CSS px (24/36 for 24 px
 * art, 32/64 for 64 px art); `maxCss` caps the scale where the next step would overflow its slot. `shape:` glyphs and
 * names with no art are drawn by P0's <PkIcon>.
 */
export function PkP2Icon({ name, target, dpr, maxCss, dim }: {
  name: string; target: number; dpr: number; maxCss?: number; dim?: boolean;
}): React.JSX.Element {
  const resolve = useContext(PkIconContext);
  const alpha = dim ? 0.5 : 1;
  const art = name.startsWith('shape:') ? null : resolve(name);
  if (!art) return <PkIcon name={name} size={target} dpr={dpr} alpha={alpha} />;
  const size = art.artPx > 0 ? artCssSize(target, art.artPx, dpr, maxCss) : Math.min(target, maxCss ?? target);
  return <img className="pk-icon__img pk-pixel" src={art.src} width={size} height={size} alt="" draggable={false}
    style={dim ? { opacity: alpha } : undefined} />;
}
