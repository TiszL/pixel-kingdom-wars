/**
 * <PkStatusChip>: the Home top-left status chip (AND:K/ui/hud/HomeHud.kt StatusChip/StatusSegment, DESIGN-SYSTEM §6
 * TopBar / BuilderChip). One 30 px VEIL chip, at most 238 wide, holding 2-3 segments split by 2 px dividers:
 * trophies (league crest 20 + caption gold-hi), builders (builder 30 + "1/2", gold dot when one is free), shield
 * (shield 24 + VT "4h"). Each segment is its own >= 48 x 48 target (the touch row is 48 tall around the 30 px veil)
 * that opens its registry row (Leagues, Builders, Defence log) via `onOpen(featureId)`.
 *
 * Compact (icon-only, LANE §4: 844x390 / 844x311 / 320x640): values hide, icons + dot stay, every segment keeps its
 * 48 px door and its spoken description. It is automatic on the phone-landscape class (CSS, from --pk-vp-class) and
 * forced by `compact` for the 320 floor, which the shell decides from layout.ts hudTier (no CSS width breakpoint).
 * Field names are the HomeHudUi ones (`trophies`, `builders`, `shield`), so the P1 mapper ports 1:1.
 */
import { PkIcon } from './Icon';
import { UNKNOWN } from './kitLogic';
import type { ChipUi, FeatureId } from './types';
import './StatusChip.css';

export interface StatusChipUi {
  /** League crest + trophies; null hides the segment. */
  trophies: ChipUi | null;
  builders: ChipUi;
  shield: ChipUi;
}

export interface PkStatusChipProps {
  ui: StatusChipUi;
  onOpen: (id: FeatureId) => void;
  /** Icon-only (the 320 px floor). The phone-landscape class gets it from CSS without this prop. */
  compact?: boolean;
}

interface Segment { chip: ChipUi; iconPx: number; body: boolean; gold: boolean }

export function PkStatusChip({ ui, onOpen, compact = false }: PkStatusChipProps): React.JSX.Element {
  const segments: Segment[] = [
    ...(ui.trophies ? [{ chip: ui.trophies, iconPx: 20, body: false, gold: true }] : []),
    { chip: ui.builders, iconPx: 30, body: false, gold: false },
    { chip: ui.shield, iconPx: 24, body: true, gold: false },
  ];
  return (
    <div className={`pk-status${compact ? ' pk-status--compact' : ''}`} role="group" aria-label="Status">
      <span className="pk-status__veil" aria-hidden="true" />
      {segments.map((s, i) => {
        const tone = (s.chip.tone ?? 'NORMAL').toLowerCase();
        const value = s.chip.value.trim() === '' ? UNKNOWN : s.chip.value;
        return (
          <span key={s.chip.id} className="pk-status__cell">
            {i > 0 ? <span className="pk-status__sep" aria-hidden="true" /> : null}
            <button type="button" className={`pk-status__seg interactive pk-focusable pk-status__seg--${tone}${s.gold ? ' pk-status__seg--gold' : ''}`}
              aria-label={s.chip.description} title={s.chip.description} onClick={() => onOpen(s.chip.id)}>
              <span className="pk-status__icon">
                <PkIcon name={s.chip.icon} size={s.iconPx} />
                {s.chip.dot ? <i className="pk-status__dot" /> : null}
              </span>
              <span className={`${s.body ? 'pk-t-body' : 'pk-t-caption pk-ol1'} pk-status__value`}>{value}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
