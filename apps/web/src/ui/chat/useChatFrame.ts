import { useEffect, useState } from 'react';
import { hasFocusedTextInput, readGameUiViewport } from '../../lib/gameViewport';

function readFrame(frameHeight: number): { top: number; height: number } {
  const viewport = window.visualViewport;
  const visual = viewport && Math.abs(viewport.scale - 1) < 0.01 && hasFocusedTextInput() ? viewport : null;
  // The shared root already ends at the keyboard's layout-coordinate bottom.
  // WebKit can also pan its client rect upward while focusing the composer;
  // adding that negative rect.top would subtract the keyboard scroll twice.
  // A fixed focused surface uses the visual viewport's layout coordinates.
  // Unfocused surfaces keep measured bounds and ignore stale keyboard metrics.
  const element = document.getElementById('root');
  const rect = element?.getBoundingClientRect();
  const root = rect && rect.height > 0
    ? { top: visual ? 0 : rect.top, bottom: (visual ? 0 : rect.top) + readGameUiViewport().h }
    : { top: 0, bottom: frameHeight };
  const top = Math.max(0, root.top, visual?.offsetTop ?? 0);
  const bottom = Math.min(root.bottom, visual ? visual.offsetTop + visual.height : root.bottom);
  return { top: Math.round(top), height: Math.max(0, Math.round(bottom - top)) };
}

/** Fixed chat surfaces must stay inside the game's already-corrected frame.
 * Intersect keyboard scrolling once; raw visualViewport alone includes the
 * Phantom toolbar, and pinch zoom must not reflow the composer. */
export function useChatFrame(frameHeight: number): { top: number; height: number } {
  const [frame, setFrame] = useState(() => readFrame(frameHeight));
  useEffect(() => {
    const viewport = window.visualViewport;
    const sync = (): void => { setFrame(readFrame(frameHeight)); };
    const syncVisual = (): void => {
      if (!viewport || Math.abs(viewport.scale - 1) < 0.01) sync();
    };
    sync();
    viewport?.addEventListener('resize', syncVisual);
    viewport?.addEventListener('scroll', syncVisual);
    window.addEventListener('scroll', syncVisual, { passive: true });
    document.addEventListener('focusin', syncVisual);
    document.addEventListener('focusout', sync);
    // Root changes include real rotation during zoom. Native pinch alone does
    // not publish a new root frame and must not reflow the composer.
    window.addEventListener('pkw:game-viewport', sync);
    return () => {
      viewport?.removeEventListener('resize', syncVisual);
      viewport?.removeEventListener('scroll', syncVisual);
      window.removeEventListener('scroll', syncVisual);
      document.removeEventListener('focusin', syncVisual);
      document.removeEventListener('focusout', sync);
      window.removeEventListener('pkw:game-viewport', sync);
    };
  }, [frameHeight]);
  return frame;
}
