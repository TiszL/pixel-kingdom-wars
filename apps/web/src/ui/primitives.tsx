/**
 * Shared game chrome: pixel headings, actions AND body text — one face
 * (owner 2026-09-17; the system sans the body used to wear read as "font not
 * loaded" next to the pixel headings).
 * Palette and bevels retain the reference App's visual identity (D-136).
 * Icons import the master SVGs (icons.ts) and render pixelated.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import { visibleParentInsets, subscribeGameViewport } from '../lib/gameViewport';
import { hudStripStyle } from './hudChrome';
import { ICONS, type IconName, sprite } from './icons';

const C = {
  bg: '#100E14', surface: '#1A171E', card: '#14121A', panel: '#3D3833',
  border: '#3D3833', borderLt: '#6B6354', ink: '#1A171E',
  text: '#EFE8D6', textDim: '#C4BBA4', textFaint: '#9C937F', stoneDark: '#6B6354',
  gold: '#E3AE3C', goldHi: '#F4D77B', goldDp: '#9C6F1E',
  danger: '#C75A2E', blood: '#8F2C2C', success: '#8CB36E', slate: '#54677A', sky: '#BBD0D6',
  pine: '#567A4B', // Highland Green — world-map grass bg
} as const;
export { C as COLORS };
export const GAME_FONT = "'VT323', monospace";
// 16px, not the sans' 14: VT323 draws smaller on its em box, and 16px is also
// the floor below which iOS Safari zooms the page into a focused text field —
// and never zooms back out (the inherited 14px inputs were such a trigger).
export const BODY_TEXT_STYLE: CSSProperties = {
  fontFamily: GAME_FONT,
  fontSize: 16, lineHeight: 1.35, letterSpacing: 'normal',
};

// --- Icon (master SVG, pixelated) -------------------------------------------

export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }): React.JSX.Element {
  return <img src={ICONS[name]} width={size} height={size} alt="" style={{ imageRendering: 'pixelated', ...style }} />;
}

/** Any master sprite resolved by bare name (codex portraits, shop skins, etc). */
export function Sprite({ name, w, h, style }: { name: string; w: number; h: number; style?: CSSProperties }): React.JSX.Element {
  const url = sprite(name);
  if (!url) return <span style={{ display: 'inline-block', width: w, height: h }} />;
  return <img src={url} width={w} height={h} alt="" style={{
    imageRendering: 'pixelated', objectFit: name.startsWith('wall5_') ? 'contain' : undefined, ...style,
  }} />;
}

// --- Button (.btn / .sec / .ghost / .dis) -----------------------------------

export type BtnVariant = 'gold' | 'sec' | 'ghost';

/** The button look as a plain style object, so an ANCHOR can wear it (LinkBtn)
 *  without the two drifting apart. Btn is the only other consumer. */
export function btnStyle(variant: BtnVariant = 'gold', fontSize = 22, disabled = false): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: GAME_FONT, fontSize, letterSpacing: '1px', padding: '10px 18px 13px',
    minWidth: 48, minHeight: 48, flexShrink: 0,
    cursor: disabled ? 'default' : 'pointer', border: `2px solid ${C.ink}`,
  };
  const variants: Record<BtnVariant, CSSProperties> = {
    gold: { color: C.ink, background: C.gold, boxShadow: `inset 0 3px 0 ${C.goldHi}, inset 0 -4px 0 ${C.goldDp}` },
    sec: { color: C.ink, background: C.textFaint, boxShadow: `inset 0 3px 0 ${C.textDim}, inset 0 -4px 0 ${C.stoneDark}` },
    ghost: { color: C.textFaint, background: 'transparent', border: `2px solid ${C.border}`, boxShadow: 'none' },
  };
  // A disabled control still occupies its painted hit area above the battlefield.
  const dis: CSSProperties = disabled ? { opacity: 0.5 } : {};
  return { ...base, ...variants[variant], ...dis };
}

export function Btn({
  children, onClick, variant = 'gold', disabled, style, fontSize = 22,
  'data-tutorial-target': tutorialTarget, 'aria-busy': ariaBusy, 'aria-expanded': ariaExpanded,
}: {
  children: ReactNode; onClick?: () => void; variant?: BtnVariant;
  disabled?: boolean; style?: CSSProperties; fontSize?: number;
  'data-tutorial-target'?: string; 'aria-busy'?: boolean; 'aria-expanded'?: boolean;
}): React.JSX.Element {
  return (
    <button className="interactive" onClick={onClick} disabled={disabled} data-tutorial-target={tutorialTarget} aria-busy={ariaBusy} aria-expanded={ariaExpanded} style={{ ...btnStyle(variant, fontSize, disabled), ...style }}>
      {children}
    </button>
  );
}

/**
 * A link that LOOKS like a Btn, for wallet universal links and store links.
 *
 * These must be real `<a href>`: `window.open()` / `location.href = …` from a
 * click handler loses the user-gesture association as soon as ANY async work
 * (even a microtask) runs first, and iOS Safari then drops the navigation
 * silently — the player taps and nothing happens. No preventDefault, no
 * interception, no analytics await.
 *
 * `target` is the caller's decision and it matters: a universal link uses
 * '_self' because the app takeover REPLACES the navigation (with '_blank' a
 * FAILED takeover strands a blank tab on iOS), while a store link uses '_blank'
 * so the game tab survives.
 */
export function LinkBtn({
  children, href, target = '_self', variant = 'gold', style, fontSize = 22,
}: {
  children: ReactNode; href: string; target?: '_self' | '_blank';
  variant?: BtnVariant; style?: CSSProperties; fontSize?: number;
}): React.JSX.Element {
  return (
    <a
      className="interactive"
      href={href}
      target={target}
      {...(target === '_blank' ? { rel: 'noopener noreferrer' } : {})}
      style={{ textDecoration: 'none', ...btnStyle(variant, fontSize), ...style }}>
      {children}
    </a>
  );
}

// --- Pill (.pill) -----------------------------------------------------------

export function Pill({
  children, onClick, accent, style, 'aria-label': ariaLabel, 'aria-expanded': ariaExpanded,
}: { children: ReactNode; onClick?: () => void; accent?: string | undefined; style?: CSSProperties | undefined; 'aria-label'?: string | undefined; 'aria-expanded'?: boolean }): React.JSX.Element {
  return (
    <span
      className="interactive"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      // Forwarded since M23 a11 — callers had been passing aria-label for a
      // while and this component silently swallowed it.
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      // A clickable pill is a button to the keyboard and to assistive tech:
      // focusable, announced as a button, Enter/Space activate it (review
      // 2026-08-21 — the TESTER pill was mouse-only).
      {...(onClick ? {
        role: 'button', tabIndex: 0,
        onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
        },
      } : {})}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: 'rgba(20,18,26,.92)', border: `2px solid ${accent ?? C.border}`,
        // Bevel depth (owner 2026-08-15, M23 a14 "improve HUD bars visuals"):
        // a 1px light top / dark bottom inset reads as pixel-art relief at every
        // pill size without changing any measured box dimension.
        boxShadow: 'inset 0 1px 0 rgba(244,215,123,.14), inset 0 -1px 0 rgba(0,0,0,.45)',
        padding: '2px 8px 2px 4px', fontFamily: GAME_FONT, fontSize: 18, lineHeight: 1,
        ...(onClick ? { minWidth: 48, minHeight: 48 } : {}),
        cursor: onClick ? 'pointer' : 'default', ...style,
      }}>
      {children}
    </span>
  );
}
export function PillVal({ children, color }: { children: ReactNode; color?: string }): React.JSX.Element {
  return <span style={{ color: color ?? C.text }}>{children}</span>;
}
export function PillSub({ children, style }: { children: ReactNode; style?: CSSProperties | undefined }): React.JSX.Element {
  return <span style={{ color: C.textFaint, fontSize: 14, ...style }}>{children}</span>;
}

/** .barmini 52×6 — used in the shard HUD pill. */
export function BarMini({ pct }: { pct: number }): React.JSX.Element {
  return (
    <span style={{ width: 52, height: 6, background: C.border, border: `1px solid ${C.ink}`, display: 'inline-block' }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: C.text }} />
    </span>
  );
}

// --- Panel9 (.panel9) — two 6×6 gold rivets top corners ---------------------

export function Panel9({ children, style, className }: { children: ReactNode; style?: CSSProperties; className?: string }): React.JSX.Element {
  const rivet: CSSProperties = { position: 'absolute', top: 6, width: 6, height: 6, background: C.gold, zIndex: 1 };
  return (
    <div className={className} style={{ background: C.panel, border: `2px solid ${C.borderLt}`, outline: `2px solid ${C.ink}`, position: 'relative', ...style }}>
      <span style={{ ...rivet, left: 6 }} />
      <span style={{ ...rivet, right: 6 }} />
      {children}
    </div>
  );
}

/** .phead — panel header bar (gold title, 24px ls-2). */
export function Phead({
  title, onClose, right, fontSize = 24, center, color,
}: { title: ReactNode; onClose?: () => void; right?: ReactNode; fontSize?: number; center?: boolean; color?: string }): React.JSX.Element {
  return (
    <div style={{
      background: C.ink, borderBottom: `2px solid ${C.borderLt}`, padding: '8px 14px',
      fontFamily: GAME_FONT, fontSize, lineHeight: 1.15, letterSpacing: center ? '6px' : '2px', color: color ?? (center ? C.goldHi : C.gold), display: 'flex',
      justifyContent: center ? 'center' : 'space-between', alignItems: 'center',
    }}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{title}</span>
      <span style={{ display: 'flex', flexShrink: 0, gap: 8, alignItems: 'center' }}>
        {right}
        {onClose && (
          <button className="interactive" type="button" onClick={onClose} aria-label="Close"
            style={{
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 48, height: 48, padding: 0, border: 0, background: 'transparent', color: 'inherit',
            }}>
            <Icon name="close" size={22} />
          </button>
        )}
      </span>
    </div>
  );
}

// --- Chip (.chip) -----------------------------------------------------------

export function Chip({
  children, onClick, accent, style,
}: { children: ReactNode; onClick?: () => void; accent?: string | undefined; style?: CSSProperties | undefined }): React.JSX.Element {
  return (
    <div
      className={onClick ? 'interactive' : undefined}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, background: C.card,
        border: `2px solid ${accent ?? C.border}`, padding: '6px 10px',
        cursor: onClick ? 'pointer' : 'default', ...style,
      }}>
      {children}
    </div>
  );
}
/** flex-spacer used between chip label and value (.sp). */
export function Sp(): React.JSX.Element {
  return <span style={{ flex: 1 }} />;
}

// --- Switch (.switch 46×24) -------------------------------------------------

export function Switch({ on, onClick }: { on: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <span
      className="interactive"
      onClick={onClick}
      style={{
        width: 46, height: 24, background: on ? '#567A4B' : C.border,
        border: `2px solid ${C.ink}`, position: 'relative', flex: 'none', cursor: 'pointer',
      }}>
      <i style={{
        position: 'absolute', top: 1, width: 18, height: 18,
        ...(on
          ? { right: 1, background: C.text, boxShadow: `inset -2px -2px 0 ${C.textDim}` }
          : { left: 1, background: C.textFaint, boxShadow: `inset -2px -2px 0 ${C.stoneDark}` }),
      }} />
    </span>
  );
}

// --- Card (.card) — shop grid item ------------------------------------------

export function Card({
  children, owned, accent, onClick, style,
}: {
  children: ReactNode; owned?: boolean | undefined; accent?: string | undefined;
  onClick?: () => void; style?: CSSProperties | undefined;
}): React.JSX.Element {
  return (
    <div
      className={onClick ? 'interactive' : undefined}
      onClick={onClick}
      style={{
        background: C.card, border: `2px solid ${accent ?? C.border}`, display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 6px',
        position: 'relative', cursor: onClick ? 'pointer' : 'default', ...style,
      }}>
      {owned && <span style={{ position: 'absolute', top: 4, right: 4, fontSize: 12, color: C.success }}>OWNED</span>}
      {children}
    </div>
  );
}

// --- Modal scrim + centred panel (.modalwrap / .modal) ----------------------

export function ModalWrap({ children, onBackdrop, width = 342 }: { children: ReactNode; onBackdrop?: () => void; width?: number }): React.JSX.Element {
  useMobileBackHandler(() => { onBackdrop?.(); return !!onBackdrop; }, !!onBackdrop, 300);
  return (
    <div
      className="interactive"
      onClick={(e) => { if (e.target === e.currentTarget) onBackdrop?.(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 1500, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(16,14,20,.82)',
        // Safe-area padding on the SCRIM, not the panel: it shrinks the box the
        // 94% below resolves against, so a notch or gesture bar (a SIDE inset in
        // landscape) can never sit over the modal. env() is 0 without insets.
        padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
      }}>
      {/* maxHeight 94% + overflowY already keep a tall modal inside a short
          landscape viewport (verified: 94% of ~311px, then it scrolls). The
          width did NOT: a flat 342px overflows sideways on a ≤342px-wide phone. */}
      <Panel9 style={{ ...BODY_TEXT_STYLE, width, maxWidth: '100%', maxHeight: '94%', overflowY: 'auto' }}>{children}</Panel9>
    </div>
  );
}

/** Full-screen scroll page (.scroll) with a fixed phead — profile/raidlog/shop. */
export function scrollPageFrameStyle(
  viewportSafe: boolean, viewport: { top: number; bottom: number },
): CSSProperties {
  return {
    position: 'absolute',
    top: viewportSafe ? `calc(${viewport.top}px + env(safe-area-inset-top))` : 'env(safe-area-inset-top)',
    right: 'env(safe-area-inset-right)',
    bottom: viewportSafe ? `calc(${viewport.bottom}px + env(safe-area-inset-bottom))` : 'env(safe-area-inset-bottom)',
    left: 'env(safe-area-inset-left)',
    background: C.card, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };
}

export function ScrollPage({
  title, onClose, children, tabs, viewportSafe = false,
}: {
  title: ReactNode; onClose: () => void; children: ReactNode; tabs?: ReactNode;
  /** Also follow the visual viewport while the mobile keyboard is open.
   * Every page keeps its controls inside the device's safe area. */
  viewportSafe?: boolean;
}): React.JSX.Element {
  useMobileBackHandler(onClose, true, 100);
  const frameRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, bottom: 0 });
  useEffect(() => {
    if (!viewportSafe) return undefined;
    const visual = window.visualViewport;
    const sync = (): void => {
      if (!visual) {
        setViewport({ top: 0, bottom: 0 });
        return;
      }
      const parent = frameRef.current?.parentElement?.getBoundingClientRect();
      setViewport(visibleParentInsets(
        parent && parent.height > 0 ? parent : { top: 0, bottom: window.innerHeight },
        visual,
      ));
    };
    sync();
    const unsubscribe = subscribeGameViewport(sync);
    visual?.addEventListener('resize', sync);
    visual?.addEventListener('scroll', sync);
    return () => {
      unsubscribe();
      visual?.removeEventListener('resize', sync);
      visual?.removeEventListener('scroll', sync);
    };
  }, [viewportSafe]);
  return (
    <div ref={frameRef} className="interactive" data-viewport-safe={viewportSafe || undefined}
      data-viewport-top={viewportSafe ? viewport.top : undefined}
      data-viewport-bottom={viewportSafe ? viewport.bottom : undefined}
      style={scrollPageFrameStyle(viewportSafe, viewport)}>
      <div style={{ flexShrink: 0, zIndex: 10 }}>
        <Phead title={title} onClose={onClose} />
        {tabs}
      </div>
      <div style={{
        ...BODY_TEXT_STYLE, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', padding: 14,
      }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Toast renderer target colour/format (App #toast: top 14%, gold text).
 *
 * A FORGED STRIP, not a bordered box. Every message the game ever says to a
 * player lands here — "BASE CLAIMED", "SESSION EXPIRED", "NOT ENOUGH SHARDS" —
 * and while the top bar was forged art this was still a rectangle with a 2px
 * border and a 2px outline, which is exactly the "black bar thing" the owner
 * named. It now wears the BAR'S OWN plate (hudStripStyle): the lit stone crown,
 * the shadowed field, the riveted end straps and the gold rim underneath.
 *
 * The padding shrank by 6px each way because the plate's border-image now
 * supplies that inset itself — the strip is the same size on screen, it is just
 * made of chrome instead of CSS.
 */
export function Toast({ msg, top }: { msg: string; top?: CSSProperties['top'] }): React.JSX.Element {
  return (
    <div style={{
      ...hudStripStyle(),
      position: 'absolute', left: '50%', top: top ?? '14%', transform: 'translateX(-50%)',
      zIndex: 3000, color: C.goldHi, fontSize: 19, padding: '2px 10px 4px',
      maxWidth: 'calc(100vw - 32px)', width: 'max-content', textAlign: 'center',
      whiteSpace: 'normal', overflowWrap: 'anywhere', pointerEvents: 'none',
    }}>
      {msg}
    </div>
  );
}

/** Bottom-sheet minimise chevron (App minBtn). */
export function MinBtn({ min, onToggle }: { min: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button" aria-label={min ? 'Expand sheet' : 'Minimise sheet'} aria-expanded={!min}
      className="interactive"
      onClick={onToggle}
      style={{ cursor: 'pointer', color: C.textDim, fontFamily: GAME_FONT, fontSize: 20, lineHeight: 1,
        display: 'grid', placeItems: 'center', width: 48, height: 48, flexShrink: 0, border: 0, background: 'transparent', padding: 0 }}>
      {min ? '▴' : '▾'}
    </button>
  );
}

/** Common number formatter (App fmtN). */
export function fmtN(n: number | string): string {
  if (typeof n === 'string' && /^-?\d+$/.test(n)) {
    const sign = n.startsWith('-') ? '-' : '';
    const digits = (sign ? n.slice(1) : n).replace(/^0+(?=\d)/, '');
    return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }
  if (!Number.isFinite(Number(n))) return '0';
  return Math.trunc(Number(n)).toLocaleString('en-US');
}

/** Duration formatter m:ss (App fmtT). */
export function fmtT(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${`0${s % 60}`.slice(-2)}`;
}

/** Duration label ("6d 2h" / "2h 36m" / "36m 5s") — shared with the Phaser world chips. */
export { fmtDur } from '../lib/duration';
