/**
 * <PkTimerPlate>: the world-anchored job timer (AND:K/ui/sheets/buildings/BuildingStateMarkers.kt TimerPlate,
 * DESIGN-SYSTEM §6 WorldBubble / TimerPlate). A 114 x 34 VEIL plate 6 px above the building's sprite: builder 30,
 * outlined caption time, an 8 px job meter (diagonal stripes while under CONSTRUCTION, solid while UPGRADING).
 * Unknown progress draws an EMPTY meter, never "0% done"; unknown time is "…".
 *
 * <PkTimerChip>: the KIT TimerChip (Chips.kt): VEIL 30 tall, 24 px icon + caption, optional 3 px meter. It is the sheet
 * header's live chip and the kit's inline timer.
 *
 * Pointer rule: both are paint only (`blocksScene=false`, `.pk-pass`): a pan may start on a world marker (KIT:125).
 * Placement: the marker layer (P1/P3) passes the sprite rect in overlay CSS px from `base:selectionAnchor`; this
 * component only offsets itself from it (no measuring, no reflow). Max 3 on screen and hidden while something is
 * selected are the LAYER's rules, not this component's.
 */
import { PkIcon } from './Icon';
import { PkPlate } from './Plate';
import { UNKNOWN } from './kitLogic';
import type { BuildingMarkerUi, TimerUi } from './types';
import './TimerPlate.css';

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The 8 px job meter. */
function JobMeter({ progress, striped }: { progress: number | null; striped: boolean }): React.JSX.Element {
  const done = progress == null ? 0 : clamp01(progress);
  return (
    <span className="pk-meter8" aria-hidden="true">
      {done > 0 ? <i className={striped ? 'pk-meter8__fill pk-meter8__fill--stripe' : 'pk-meter8__fill'} style={{ width: `${done * 100}%` }} /> : null}
    </span>
  );
}

export function PkTimerPlate({ ui }: { ui: BuildingMarkerUi }): React.JSX.Element {
  const centerX = (ui.anchor.left + ui.anchor.right) / 2;
  return (
    <div className="pk-timer-plate" style={{ left: centerX, top: ui.anchor.top }} role="img" aria-label={ui.description}>
      <PkPlate kind="VEIL" blocksScene={false} className="pk-timer-plate__plate">
        <span className="pk-timer-plate__row">
          <PkIcon name="builder" size={30} />
          <span className="pk-timer-plate__col">
            <span className="pk-t-caption pk-ol1 pk-timer-plate__time">{ui.text ?? UNKNOWN}</span>
            <JobMeter progress={ui.progress} striped={ui.kind === 'CONSTRUCTION'} />
          </span>
        </span>
      </PkPlate>
    </div>
  );
}

export function PkTimerChip({ ui }: { ui: TimerUi }): React.JSX.Element {
  const progress = ui.progress ?? null;
  return (
    <span className="pk-timer-chip" role="img" aria-label={ui.description}>
      <PkPlate kind="VEIL" blocksScene={false} className="pk-timer-chip__plate">
        <span className="pk-timer-chip__row">
          <PkIcon name={ui.icon ?? 'timer'} size={24} />
          <span className="pk-t-caption pk-ol1 pk-timer-chip__text">{ui.text.trim() === '' ? UNKNOWN : ui.text}</span>
        </span>
        {progress != null ? <span className="pk-timer-chip__bar"><i style={{ width: `${clamp01(progress) * 100}%` }} /></span> : null}
      </PkPlate>
    </span>
  );
}
