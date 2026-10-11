import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { WORLD_COPY } from '../copy';

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
const portraitNow = (): boolean => typeof window !== 'undefined' && window.innerWidth <= window.innerHeight;
/** Portrait = the panel is a bottom sheet; landscape = a side panel (concept main.js `isLandscape`). */
export function usePortrait(override?: boolean): boolean {
  const live = useSyncExternalStore(subscribe, portraitNow, () => false);
  return override ?? live;
}

/**
 * The world's one panel frame (HUD-STYLE §4): right side in landscape, bottom sheet in portrait with the forged gold
 * rim and a grip that folds it to its foot (peek). The accent lights the top edge. [foot] is the CTA bar: first in
 * portrait so the peeking sheet still shows it, last in landscape (native GlobeHud.kt).
 */
export function HudPanel({ accent, label, portrait, onClose, foot, children, className }: {
  accent: string; label: string; portrait?: boolean | undefined; onClose: () => void;
  foot?: ReactNode; children: ReactNode; className?: string | undefined;
}): React.JSX.Element {
  const sheet = usePortrait(portrait);
  const [peek, setPeek] = useState(false);
  const style = { '--hud-acc': accent } as CSSProperties;
  const footBar = foot ? <div className="hud-foot wv2-foot">{foot}</div> : null;
  return <section role="dialog" aria-label={label} style={style} data-layout={sheet ? 'sheet' : 'side'} data-peek={sheet && peek ? '1' : undefined}
    className={`hud hud-panel wv2-panel${sheet ? ' hud-panel--sheet' : ''}${className ? ` ${className}` : ''}`}>
    {sheet && <button type="button" className="wv2-grip" aria-expanded={!peek} aria-label={peek ? WORLD_COPY.panel.expand : WORLD_COPY.panel.collapse}
      onClick={() => setPeek(!peek)}><i className="hud-grip" /></button>}
    <button type="button" className="hud-x wv2-x" aria-label={WORLD_COPY.card.close} onClick={onClose} />
    {sheet && footBar}
    {!(sheet && peek) && <div className="wv2-scroll hud-enter">{children}</div>}
    {!sheet && footBar}
  </section>;
}

/** `.hud-i`: one of the game's icon masters, styled by hud.css. */
export const HudIcon = ({ name }: { name: 'map' | 'locate' | 'scout' | 'attack' | 'shield' | 'prev' | 'next' | 'plus' | 'minus' }): React.JSX.Element =>
  <i className={`hud-i hud-i--${name}`} aria-hidden="true" />;
