/**
 * The small painted pieces P1 still owns: art at an integer scale over P0's resolver, the four CSS-drawn HUD shapes
 * (envelope, speech, caret, up: design home.html) and the chunky face of the HUD buttons. The corner badge is P0's
 * <PkBadge> (Button.tsx) and the status chip P0's <PkStatusChip> (parity verdict B3, Rule 7: one source).
 *
 * Icons are strings exactly as on Android (KIT-API.md rule 4): `ui:<id>`, `shape:<name>`, currency names, GameArt
 * names. Resolution goes through P0 BY DEFAULT: `PkArtContext` defaults to P0 `pkArt` (Icon.tsx), and any name that is
 * not art there (the other `shape:` glyphs such as `shape:close` / `shape:hammer`, unknown names) is drawn by P0's
 * <PkIcon>: its glyph, or the visible "?" with `data-pk-missing`, never an empty box. No provider is required; a
 * provider is an optional override with the same `{ src, artPx }` shape as P0 `pkArt` and P2 `PkIconContext`.
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { PkIcon, pkArt } from './Icon';
import type { Verb } from './hudModel';
import { artCssSize } from './homeHudLogic';
import { useDevicePixelRatio } from './pkViewport';
import './kitBase.css';
import './HudKit.css';

/** A resolved piece of pixel art: its URL and its native width in art px (24, 32, 56, 64 …; 0 = no fixed size). */
export interface PkArt { src: string; artPx: number }
export type PkArtResolver = (icon: string) => PkArt | null;

/** Default: P0's table (Icon.tsx `pkArt`). An app MAY provide an override at the overlay root; it is never required. */
export const PkArtContext = createContext<PkArtResolver>(pkArt);

/** The drawn glyphs P1 paints in CSS (design home.html), with the registry aliases. Every other shape is P0's. */
const SHAPES: Record<string, string> = { envelope: 'mail', mail: 'mail', speech: 'chat', chat: 'chat', caret: 'caret', 'chevron-up': 'up', up: 'up' };

/**
 * One icon at [size] CSS px, snapped to an integer device scale at the live DPR (lane §4 "Pixel art"). Decorative by
 * default (`alt=""`): the owning button carries the spoken label.
 */
export function HudIcon({ icon, size, alpha, className }: { icon: string; size: number; alpha?: number; className?: string }): React.JSX.Element {
  const resolve = useContext(PkArtContext);
  const dpr = useDevicePixelRatio();
  const style: CSSProperties | undefined = alpha != null && alpha < 1 ? { opacity: alpha } : undefined;
  const isShape = icon.startsWith('shape:');
  if (isShape) {
    const shape = SHAPES[icon.slice('shape:'.length)];
    if (shape) return <span className={`pk-shape pk-shape--${shape}${className ? ` ${className}` : ''}`} style={style} aria-hidden="true"><i /><i /><i /></span>;
  }
  const art = isShape ? null : resolve(icon);
  if (!art) {
    // P0 draws it (its glyph, or the "?"), inside the same P1 box so positional classes keep working.
    return (
      <span className={`pk-art${className ? ` ${className}` : ''}`} style={{ width: size, height: size, ...style }} aria-hidden="true">
        <PkIcon name={icon} size={size} dpr={dpr} />
      </span>
    );
  }
  const css = art.artPx > 0 ? artCssSize(art.artPx, size, dpr) : size;
  return (
    <span className={`pk-art${className ? ` ${className}` : ''}`} style={{ width: size, height: size, ...style }} aria-hidden="true">
      <img src={art.src} alt="" width={css} height={css} draggable={false} data-art-px={art.artPx} />
    </span>
  );
}

const VERB_CLASS: Record<Verb, string> = { GOLD: 'gold', GREEN: 'green', BLUE: 'blue', RED: 'red', STONE: 'stone', CHARCOAL: 'char', OFF: 'off', MOSS: 'moss' };

/**
 * A chunky stepped button face (ink shell + stepped face + lip). The <button> itself is NOT clipped, so its
 * `:focus-visible` outline stays visible; only the inner shell is. Hover = the first 1 px of press travel (lane §4).
 */
export function ChunkyFace({ verb, children, className }: { verb: Verb; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className={`pk-chunky pk-chunky--${VERB_CLASS[verb]}${className ? ` ${className}` : ''}`}>
      <span className="pk-chunky__face">{children}</span>
    </span>
  );
}
