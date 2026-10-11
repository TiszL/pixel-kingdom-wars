import { fmtDur } from '../../../lib/duration';
import { PkIcon } from '../Icon';
import { PkPlate } from '../Plate';
import { UNKNOWN } from '../kitLogic';
import type { PxRect } from '../types';
import { MAX_WORLD_MARKERS } from './buildingsLogic';
import '../TimerPlate.css';
import './ConstructionSite.css';

export interface ConstructionSiteUi {
  buildingId: string;
  builderIcon: string;
  /** Shared fmtDur output supplied by the mapper; retain its last known value while loading. */
  timeLeft: string | null;
  /** Server-derived whole seconds, never a local countdown or a construction-completion trigger. */
  secondsLeft: number | null;
  progress: number | null;
  /** Visible sprite bounds in overlay CSS px. The existing world renderer owns the sprite and idle swap. */
  anchor: PxRect;
  description: string;
}

export interface ConstructionLayerUi {
  /** Only globally admitted winners, in camera order, from selectBuildingMarkerBudget or an equivalent mapper.
   * They share one budget with BuildingMarkerLayer; this layer's defensive cap alone is not a joint limit. */
  sites: readonly ConstructionSiteUi[];
  visible: boolean;
}

export interface ConstructionActions {
  /** Select/open the existing building (INFO / FINISH); never start, finish, cancel or resend an order here. */
  onSelect: (buildingId: string) => void;
}

/** Android BuildingsR2Logic.kt FINISHING_SECONDS: a display-only tone threshold, not a gameplay timer. */
const FINISHING_DISPLAY_SECONDS = 10;

/** Mirrors constructionPlateLook using shared fmtDur for its known finishing seconds (review fd63a9ae).
 * Other durations are supplied already formatted; null and invalid seconds never enter the formatter. */
export function constructionPlateLook(secondsLeft: number | null, formatted: string | null): { text: string; tone: 'STRIPE' | 'SOLID' } {
  const finishing = secondsLeft != null && Number.isInteger(secondsLeft) && secondsLeft >= 0 && secondsLeft <= FINISHING_DISPLAY_SECONDS;
  return {
    text: finishing ? fmtDur(secondsLeft) : formatted != null && formatted.trim() !== '' ? formatted : UNKNOWN,
    tone: finishing ? 'SOLID' : 'STRIPE',
  };
}

/** Native ConstructionSite.kt: still builders are paint-only; each plate selects through one local 48 px target. */
export default function ConstructionLayer({ ui, on }: { ui: ConstructionLayerUi; on: ConstructionActions }): React.JSX.Element | null {
  if (!ui.visible || ui.sites.length === 0) return null;
  return (
    <div className="pk-construction-layer pk-pass" data-pk-construction-sites>
      {ui.sites.slice(0, MAX_WORLD_MARKERS).map(site => (
        <ConstructionSite key={site.buildingId} site={site} onSelect={on.onSelect} />
      ))}
    </div>
  );
}

function ConstructionSite({ site, onSelect }: { site: ConstructionSiteUi; onSelect: (buildingId: string) => void }): React.JSX.Element {
  return <>
    <span className="pk-construction-builder" style={{ left: site.anchor.right, top: site.anchor.bottom }} aria-hidden="true">
      <PkIcon name={site.builderIcon} size={30} />
    </span>
    <ConstructionPlate site={site} onClick={() => onSelect(site.buildingId)} />
  </>;
}

export function ConstructionPlate({ site, onClick }: { site: ConstructionSiteUi; onClick: () => void }): React.JSX.Element {
  const look = constructionPlateLook(site.secondsLeft, site.timeLeft);
  const done = site.progress == null ? 0 : Math.min(1, Math.max(0, site.progress));
  return (
    <button type="button" className="pk-construction-plate interactive pk-focusable" data-tone={look.tone}
      style={{ left: (site.anchor.left + site.anchor.right) / 2, top: site.anchor.top }}
      aria-label={site.description} onClick={onClick}>
      <PkPlate kind="VEIL" blocksScene={false} className="pk-construction-plate__face">
        <span className="pk-construction-plate__row" aria-hidden="true">
          <PkIcon name={site.builderIcon} size={30} />
          <span className="pk-construction-plate__column">
            <span className="pk-t-caption pk-ol1">{look.text}</span>
            <span className="pk-meter8">
              {done > 0 ? <i className={`pk-meter8__fill${look.tone === 'STRIPE' ? ' pk-meter8__fill--stripe' : ''}`}
                style={{ width: `${done * 100}%` }} /> : null}
            </span>
          </span>
        </span>
      </PkPlate>
    </button>
  );
}
