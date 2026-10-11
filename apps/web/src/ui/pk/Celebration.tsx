/**
 * <PkCelebration>: the receipt-gated celebration and its overlay root (AND:K/ui/kit/Feedback.kt Celebration,
 * DESIGN-SYSTEM §6 Celebration). A CHARCOAL panel with stepped gold sunrays turning 8°/s, the 48 px token, a gold
 * ribbon that drops in (pop) and the VT line. Sparks capped at 9.
 *
 * RECEIPT RULE: it renders ONLY with a non-empty `ui.receiptId` (the server receipt that proves the money moved). A
 * `ui` without one draws nothing: nothing celebrates on a guess.
 *
 * Timing (tokens): auto-dismiss `onDone` after --pk-dur-celebrate (900 ms) via the end of a CSS clock animation (no JS
 * timer to leak), or on a tap; ribbon drop over --pk-dur-plate-in (160 ms = KIT RIBBON_DROP, see Celebration.md);
 * exit fade --pk-dur-crossfade (120 ms = KIT SEAL_OUT) then `onExitFinished`. Reduced motion: no turning rays, no
 * drop, no sparks.
 *
 * Overlay root: `.pk-celebration-root` fills the overlay at --z-celebrate (the top kit layer, LANE §3 P0) but is
 * `pointer-events: none` with NO scrim; only the panel takes a tap (dismiss).
 */
import { PkIcon } from './Icon';
import { PkPlate } from './Plate';
import { usePresence } from './presence';
import { prefersReducedMotion } from './viewport';
import type { CelebrationUi } from './types';
import './Celebration.css';

export interface PkCelebrationProps {
  ui: CelebrationUi | null;
  onDone: () => void;
  onExitFinished?: () => void;
}

const SPARKS = 9;

export function PkCelebration({ ui, onDone, onExitFinished }: PkCelebrationProps): React.JSX.Element | null {
  const receipted = ui != null && ui.receiptId.trim() !== '' ? ui : null;
  const { shown: party, leaving, gone } = usePresence(receipted, onExitFinished);
  if (!party) return null;
  const still = prefersReducedMotion();
  const done = () => { if (!leaving) onDone(); };
  return (
    <div className={`pk-celebration-root${leaving ? ' pk-celebration-root--leaving' : ''}${still ? ' pk-celebration-root--still' : ''}`}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) gone(); }}>
      <button type="button" key={party.receiptId} className="pk-celebration interactive pk-focusable"
        aria-label={`${party.ribbon}. ${party.line}. Dismiss`} aria-live="polite" onClick={done}>
        <PkPlate kind="CHARCOAL" blocksScene={false} className="pk-celebration__plate">
          <span className="pk-celebration__rays" aria-hidden="true" />
          {still ? null : (
            <span className="pk-celebration__sparks" aria-hidden="true">
              {Array.from({ length: SPARKS }, (_, k) => <i key={k} style={{ ['--k' as string]: k, ['--r' as string]: k % 4 }} />)}
            </span>
          )}
          <span className="pk-celebration__col">
            <PkIcon name={party.icon} size={48} />
            <span className="pk-celebration__ribbon"><span className="pk-t-label">{party.ribbon}</span></span>
            <span className="pk-t-body pk-t-wrap pk-celebration__line">{party.line}</span>
          </span>
        </PkPlate>
        {/* The 900 ms clock: its animationend is the auto-dismiss. */}
        <i className="pk-celebration__clock" aria-hidden="true"
          onAnimationEnd={(e) => { e.stopPropagation(); done(); }} />
      </button>
    </div>
  );
}
