/**
 * <PkSheetHost>: owns where a sheet sits, its slide, its scrim and its one inset publication (KIT-API.md "SheetHost
 * (Codex) owns position and the slide"; DESIGN-SYSTEM:329-331; LANE §4, §6, §10). It draws no frame: the sheet it hosts
 * (<PkNeedMoreSheet>, P0/P3's <PkSheet>) paints its own wood.
 *
 * Geometry per viewport class (LANE §4/§10.1; class from --pk-vp-class, never a pixel breakpoint):
 *   phone-portrait, tablet-portrait    bottom sheet. HALF ≤ 50 % tall, content-sized; TALL from y 104 to the bottom;
 *                                      FULL from y 60 to 14 above the bottom (KIT SheetGeometry).
 *   desktop, tablet-landscape          HALF / TALL = right side panel min(480, 50 %); FULL = centred card ≤ 720.
 *   phone-landscape 844×390            HALF / TALL right panel min(480, 50 %) = 422; FULL centred card; header 96.
 *   phone-landscape `land` (viewport.short: 915×311 / 844×311, bridge `--pk-vp-height: short`)
 *                                      HALF / TALL / FULL all in the right panel; Compact header 60 (LANE §4).
 * Header: the host publishes the living-header height for the hosted frame as `--pk-sheet-header-h` on the panel and
 *   `data-header` on the root (Android SheetFrame(headerHeight)): 136 default, 96 on 844×390, 60 on `land`.
 * Scrim: HALF none (outside tap closes); TALL 40 % on bottom sheets (on a side panel the scrim would sit only under the
 *   panel column, so none is drawn); FULL 60 %. A scrim tap closes. No scrim ⇒ an empty-ground tap closes
 *   (`subscribeEmptyTap`, the scene's `base:emptyTap`), so the tap is never swallowed and never only starts a pan.
 * Motion: HALF in 180 / out 140, TALL and FULL in 220 / out 160, from the --pk-dur-* tokens (reduced motion: 120 ms
 *   cross-fade). The last sheet stays painted through its exit.
 * Canvas: the host is a fixed, pointer-events:none overlay and the sheet is absolutely positioned and moved with
 *   transforms only, so opening a sheet never reflows the document or resizes the Phaser canvas.
 * Insets: one publication per snap change (open, size change, layout change) via `onInset`; null on close. The mount
 *   merges it with the HUD rectangles into the single `base:insets` emitter (LANE §6 (e)); nothing here emits it.
 * Back: registered with the existing Back registry at the sheet priority 220 (X:src/ui/sheets.tsx:989).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import { tokenMs } from './p2Logic';
import type { PkViewport, SheetHostUi, SheetInset, SheetSize } from './p2Types';
import { usePkViewport } from './usePkViewport';
import './kitBase.css';
import './SheetHost.css';

export type SheetLayout = 'bottom' | 'side' | 'center';

/** Where a sheet of `size` sits on viewport class `vp` (pure; the CSS reads the result as data-layout). */
export function sheetLayout(vp: PkViewport['vp'], size: SheetSize, short = false): SheetLayout {
  const wide = vp === 'desktop' || vp === 'tablet-landscape' || vp === 'phone-landscape';
  if (!wide) return 'bottom';
  if (size === 'FULL') return vp === 'phone-landscape' && short ? 'side' : 'center';
  return 'side';
}

export type SheetHeader = 'regular' | 'medium' | 'compact';

/** Living-header height class for the hosted frame (LANE §4 "Living header" row): 136 / 96 (844×390) / 60 (`land`). */
export function sheetHeader(vp: PkViewport['vp'], short = false): SheetHeader {
  if (vp !== 'phone-landscape') return 'regular';
  return short ? 'compact' : 'medium';
}

/** Which scrim is drawn (null = none). TALL draws its 40 % only over the world on bottom sheets. */
export function sheetScrim(size: SheetSize, layout: SheetLayout): 'tall' | 'full' | null {
  if (size === 'FULL') return 'full';
  if (size === 'TALL' && layout === 'bottom') return 'tall';
  return null;
}

export const SHEET_BACK_PRIORITY = 220;

export interface PkSheetHostProps {
  /** The open sheet, or null. A different `key` replaces the sheet (it slides in fresh). */
  sheet: SheetHostUi | null;
  /** The hosted sheet's content for `sheet`. Kept painted through the exit after `sheet` turns null. */
  children: ReactNode;
  /** Scrim tap, outside tap (no scrim), Back. */
  onClose: () => void;
  /** Subscribe to the scene's empty-ground tap, e.g. `(l) => bus.on('base:emptyTap', l)`; returns the unsubscribe. */
  subscribeEmptyTap: (listener: () => void) => () => void;
  /** One publication per snap change; null when the sheet closes or covers nothing the camera should avoid. */
  onInset?: (inset: SheetInset | null) => void;
  viewport?: PkViewport;
}

export function PkSheetHost({ sheet, children, onClose, subscribeEmptyTap, onInset, viewport }: PkSheetHostProps): React.JSX.Element | null {
  const measuredViewport = usePkViewport();
  const vp = viewport ?? measuredViewport;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The last open sheet stays painted through its exit (Android Presence): remember it while open, drop it when the
  // out-duration has passed. Reopening during the hold cancels the drop.
  const last = useRef<{ ui: SheetHostUi; content: ReactNode } | null>(null);
  if (sheet) last.current = { ui: sheet, content: children };
  const [, setDropped] = useState(0);
  useEffect(() => {
    const held = last.current;
    if (sheet || !held) return undefined;
    const out = held.ui.size === 'HALF' ? tokenMs('--pk-dur-half-sheet-out', 140) : tokenMs('--pk-dur-sheet-out', 160);
    const t = window.setTimeout(() => { last.current = null; setDropped((n) => n + 1); }, out);
    return () => window.clearTimeout(t);
  }, [sheet === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = sheet ? { ui: sheet, content: children } : last.current;
  const phase: 'in' | 'out' = sheet ? 'in' : 'out';

  const size = shown?.ui.size ?? 'HALF';
  const layout = sheetLayout(vp.vp, size, vp.short);
  const header = sheetHeader(vp.vp, vp.short);
  const scrim = sheetScrim(size, layout);

  // Outside tap closes a sheet that has no scrim (HALF; TALL as a side panel).
  useEffect(() => {
    if (!sheet || scrim !== null) return undefined;
    return subscribeEmptyTap(() => closeRef.current());
  }, [sheet?.key, scrim, subscribeEmptyTap]); // eslint-disable-line react-hooks/exhaustive-deps

  useMobileBackHandler(() => { closeRef.current(); }, sheet !== null, SHEET_BACK_PRIORITY);

  // The host owns focus entry, keyboard containment and return. The leaving
  // panel is paint-only, so return happens at logical close, before its animation.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!sheet || !el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus({ preventScroll: true });
    const tab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const controls = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]')]
        .filter((item) => item.tabIndex >= 0 && !item.closest('[hidden], [inert], [aria-hidden="true"]')
          && item.getAttribute('aria-disabled') !== 'true' && getComputedStyle(item).display !== 'none' && getComputedStyle(item).visibility !== 'hidden');
      const first = controls[0]; const lastControl = controls.at(-1);
      if (!first || !lastControl) { event.preventDefault(); el.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        event.preventDefault(); lastControl.focus();
      } else if (!event.shiftKey && (document.activeElement === lastControl || document.activeElement === el)) {
        event.preventDefault(); first.focus();
      }
    };
    el.addEventListener('keydown', tab);
    return () => {
      el.removeEventListener('keydown', tab);
      if (previous?.isConnected && (el.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, [sheet?.key]);

  // Layout offsets ignore slide transforms and include the gap at the covered
  // edge. Observe lazy content too: its resolved height can differ from Loading.
  useLayoutEffect(() => {
    if (!onInset) return;
    const el = panelRef.current;
    const host = el?.parentElement;
    if (!sheet || !el || !host || layout === 'center') { onInset(null); return; }
    const publish = (): void => onInset(layout === 'bottom'
      ? { bottom: Math.max(el.offsetHeight, host.clientHeight - el.offsetTop), right: 0 }
      : { bottom: 0, right: Math.max(el.offsetWidth, host.clientWidth - el.offsetLeft) });
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(el);
    observer?.observe(host);
    return () => { observer?.disconnect(); onInset(null); };
  }, [sheet?.key, size, layout, vp.w, vp.h, onInset]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;
  // Exit = paint only (Android ResourceDrawer.kt:93-94 pattern): drop `.interactive` so the host's
  // `#overlay-root .interactive { pointer-events: auto }` cannot revive the scrim or the leaving panel; SheetHost.css
  // also forces pointer-events:none on every descendant (the hosted sheet's own `.interactive` buttons) while out.
  const live = phase === 'in' ? ' interactive' : '';
  return (
    <div className="pk-sheethost" data-pk-vp={vp.vp} data-size={size} data-layout={layout} data-header={header} data-phase={phase} style={{ bottom: 'var(--game-ui-bottom-clearance, 0px)' }}>
      {scrim ? <div className={`pk-sheethost__scrim${live}`} data-scrim={scrim} aria-hidden="true" onClick={phase === 'in' ? () => closeRef.current() : undefined} /> : null}
      <div key={shown.ui.key} ref={panelRef} inert={phase === 'out'} className={`pk-sheethost__panel${live}`} role="dialog" tabIndex={-1}
        aria-label={shown.ui.label} aria-modal={scrim === 'full' ? 'true' : undefined}>
        {shown.content}
      </div>
    </div>
  );
}
