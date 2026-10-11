import { hudChipStyle } from './hudChrome';
import { COLORS as C, Icon, PillSub } from './primitives';

/** A semantic button rather than the former unlabeled layout-icon span. The
 * handout's dedicated backpack makes inventory distinct from base Layout. It is
 * the one tiny HUD asset kept eager; the full inventory screen/art stays lazy.
 *
 * Cut from the same recessed chip well as every other player-menu row
 * (owner 2026-09-17: the one flat-bordered box in a grid of forged plates was
 * the "degraded" cell). `hud-chip` + role=button is what the chrome stylesheet
 * keys its press, hover and focus rules on; a <button> keeps the semantics. */
export function InventoryHudButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="button"
      className="interactive hud-chip"
      aria-label="Open inventory"
      onClick={onOpen}
      style={{
        ...hudChipStyle('shard'),
        display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start', gap: 5,
        padding: '0 8px', fontFamily: 'inherit', fontSize: 18,
        minWidth: 44, minHeight: 44, lineHeight: 1, color: C.textFaint, cursor: 'pointer', position: 'relative',
      }}
    >
      <span className="hud-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Icon name="backpack" size={24} /><PillSub>INVENTORY</PillSub>
      </span>
    </button>
  );
}
