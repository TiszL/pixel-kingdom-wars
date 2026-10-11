import { useEffect, useMemo, useRef, useState } from 'react';
import { AtlasClip } from './AtlasClip';
import { LOADING_TIPS, shuffleTips, type LoadingTip } from './loadingTipData';

export const TIP_ROTATE_MS = 6_000;
/** The tip TEXT crossfades on rotation; the sprite hard-switches (D-193). */
export const TIP_CROSSFADE_MS = 200;
/** The tip on the loading surface mounted right now. LoadingScreen hands off
 *  to PhaserGame's scene-preparation cover in one commit, so the cover renders
 *  while this is still set and continues the same tip instead of swapping it. */
let onScreen: string | null = null;

/** The tip's share of the loading strip (D-193): the sprite spans the strip's
 * height at the left; the category and text share the strip's last line. The
 * fonts live in gameLoading.css next to the strip's own lines. */
export const LOADING_TIP_METRICS = {
  regular: { sprite: 56 },
  compact: { sprite: 44 },
} as const;

export function LoadingTips({
  compact = false,
  reduceMotion = false,
  rng = Math.random,
  rotateMs = TIP_ROTATE_MS,
  tips = LOADING_TIPS,
  text = true,
}: {
  compact?: boolean;
  reduceMotion?: boolean;
  rng?: () => number;
  rotateMs?: number;
  tips?: readonly LoadingTip[];
  /** False keeps the sprite and lets the strip print a notice on the tip line. */
  text?: boolean;
}): React.JSX.Element | null {
  const deck = useMemo(() => shuffleTips(tips, rng), [rng, tips]);
  const [index, setIndex] = useState(() => Math.max(0, deck.findIndex((tip) => tip.id === onScreen)));
  const shown = useRef<string | null>(null);
  useEffect(() => () => { if (onScreen === shown.current) onScreen = null; }, []);

  useEffect(() => {
    if (deck.length < 2 || rotateMs <= 0) return undefined;
    const timer = setInterval(() => setIndex((current) => (current + 1) % deck.length), rotateMs);
    return () => clearInterval(timer);
  }, [deck.length, rotateMs]);

  const tip = deck[index % deck.length];
  const tipId = tip?.id ?? null;
  useEffect(() => { shown.current = tipId; onScreen = tipId; }, [tipId]);

  // The outgoing text, kept for one crossfade. It is derived DURING render
  // from the previous tip (React's adjust-state-on-change pattern), so the
  // leaving span and the entering span's fade land in ONE commit: arming the
  // fade from an effect let the browser paint the new text solid for a frame
  // and then snap it to opacity 0 — a blink on every rotation (review
  // 2026-09-28). Never set on mount: a loading surface handoff mounts a fresh
  // LoadingTips on the same tip, and an entry fade there would blink the line
  // the owner saw as flicker (2026-09-27).
  const [leaving, setLeaving] = useState<LoadingTip | null>(null);
  const [previous, setPrevious] = useState<LoadingTip | null>(tip ?? null);
  if ((previous?.id ?? null) !== tipId) {
    setPrevious(tip ?? null);
    if (previous && tip && !reduceMotion) setLeaving(previous);
  }
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => setLeaving(null), TIP_CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  if (!tip) return null;
  const metrics = compact ? LOADING_TIP_METRICS.compact : LOADING_TIP_METRICS.regular;

  return (
    <div className="sk-game-loading-tips" data-testid="loading-tip" data-tip-id={tip.id} aria-live="polite"
      data-tip-compact={compact ? 'true' : 'false'} data-tip-sprite-size={metrics.sprite}>
      <div className="sk-game-loading-sprite" data-tip-sprite>
        <AtlasClip clip={tip.clip} size={metrics.sprite} reduceMotion={reduceMotion} />
      </div>
      {text && (
        <p className="sk-game-loading-tip">
          {leaving && (
            <span key={`leave-${leaving.id}`} className="sk-game-loading-tiptext" data-leave="true" aria-hidden="true">
              <span className="sk-game-loading-tipcat">{leaving.category} TIP</span>{leaving.text}
            </span>
          )}
          <span key={tip.id} className="sk-game-loading-tiptext" data-enter={leaving ? 'true' : undefined}>
            <span className="sk-game-loading-tipcat">{tip.category} TIP</span>{tip.text}
          </span>
        </p>
      )}
    </div>
  );
}
