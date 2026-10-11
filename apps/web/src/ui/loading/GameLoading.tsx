import { useRef, type ReactNode } from 'react';
import { useWindowSize } from '../layout';
import { LoadingTips } from './LoadingTips';
import './gameLoading.css';

/** The loading strip's fixed box (D-193). Every state renders into it: the
 * head line, the meter row and the tip line are always present, so a title,
 * percent, reason or button change never moves or resizes the strip. */
export const LOADING_STRIP = {
  maxWidth: 560,
  height: { regular: 88, compact: 66 },
} as const;

export function isCompactLoading(viewport: { w: number; h: number }): boolean {
  return viewport.h < 500 || viewport.w < 360;
}

/** A percentage is admitted only by a caller with measured transfer bytes.
 * Preparation and cached entry stay indeterminate; they are not downloads.
 * `detail` is a notice for the tip line (a failure reason, a paused download);
 * `tips` puts the rotating advice and its sprite in the strip (the loading
 * screen and the scene-preparation cover; the map's opening shells stay plain). */
export function GameLoading({ title, transferPercent, detail, failed = false, reduceMotion = false, tips = false, children }: {
  title: string; transferPercent?: number | null; detail?: string | undefined; failed?: boolean;
  reduceMotion?: boolean; tips?: boolean; children?: ReactNode;
}): React.JSX.Element {
  const compact = isCompactLoading(useWindowSize());
  const measured = typeof transferPercent === 'number' && Number.isFinite(transferPercent)
    ? Math.max(0, Math.min(100, Math.floor(transferPercent))) : null;
  // A measured percent never decreases while the transfer stays measured; a
  // transfer that ends (null) releases the hold so the next one starts fresh.
  const held = useRef<number | null>(null);
  held.current = measured === null ? null : Math.max(held.current ?? 0, measured);
  const percent = held.current;
  const reserved = percent === null;
  return <section className="sk-game-loading" role={failed ? 'alert' : 'status'} aria-live="polite"
    data-compact={compact || undefined} data-tips={tips || undefined} data-notice={detail ? 'true' : undefined}
    data-failed={failed || undefined}
    data-reduced-motion={reduceMotion || undefined}>
    {tips && <LoadingTips compact={compact} reduceMotion={reduceMotion} text={!detail} />}
    <div className="sk-game-loading-head">
      <h2>{title}</h2>
      {/* Reserved while progress is unknown: showing it only for measured
          bytes resized the old centred card, so every mode change moved it. */}
      <p className="sk-game-loading-detail" data-reserved={reserved || undefined} aria-hidden={reserved || undefined}>
        {reserved ? '\u00a0' : <><span>Downloading · </span>{percent}%</>}
      </p>
    </div>
    {!failed && <div className="sk-game-loading-meter" role="progressbar" aria-label={title.replace(/…$/, '')}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
      data-indeterminate={percent === null ? 'true' : undefined}>
      <span style={{ width: `${percent ?? 22}%` }} />
    </div>}
    {/* The tip line: the rotating tip, or a notice in its place. It is
        reserved when there is neither, so the strip's box never depends on it. */}
    {detail
      ? <p className="sk-game-loading-tip" data-notice="true" role={failed ? undefined : 'alert'}>
        <span className="sk-game-loading-tiptext">{detail}</span>
      </p>
      : !tips && <p className="sk-game-loading-tip" data-reserved="true" aria-hidden="true">
        <span className="sk-game-loading-tiptext">{'\u00a0'}</span>
      </p>}
    {children && <div className="sk-game-loading-actions">{children}</div>}
  </section>;
}
