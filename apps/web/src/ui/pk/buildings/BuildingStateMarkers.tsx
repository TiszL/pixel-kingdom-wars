import { PkIcon } from '../Icon';
import { PkPlate } from '../Plate';
import { PkTimerPlate } from '../TimerPlate';
import type { BuildingMarkerUi } from '../types';
import { visibleMarkers } from './buildingsLogic';
import type { ConstructionSiteUi } from './ConstructionSite';
import './BuildingStateMarkers.css';

export interface BuildingMarkersUi {
  /** When construction sites are also present, pass only this layer's globally admitted winners. */
  markers: readonly BuildingMarkerUi[];
  /** False during selection, placement or editing. The original controller owns this state. */
  visible: boolean;
}

export interface BuildingMarkerActions {
  /** Collect through the original controller without selecting the building. */
  onCollect: (buildingId: string) => void;
  onOpen: (buildingId: string) => void;
}

export interface BuildingMarkerLayerProps {
  ui: BuildingMarkersUi;
  on: BuildingMarkerActions;
  /** Overlay bounds in CSS pixels, in the same coordinate space as every sprite anchor. */
  overlayWidth: number;
  overlayHeight: number;
}

/**
 * One shared nearest-camera budget, before either layer renders. The mapper must offer each world marker once.
 * A site's tappable construction plate replaces any ordinary construction/upgrade timer for the same building.
 * This helper retains
 * candidate identity and server values, and does not change scene/controller state. Both layers must receive the
 * returned lists; independent caps cannot enforce a joint limit. No gameplay cap is introduced here.
 */
export function selectBuildingMarkerBudget(
  markers: readonly BuildingMarkerUi[], sites: readonly ConstructionSiteUi[], centerX: number, centerY: number,
): { markers: BuildingMarkerUi[]; sites: ConstructionSiteUi[] } {
  const siteByMarker = new Map<BuildingMarkerUi, ConstructionSiteUi>();
  const siteMarkers = sites.map(site => {
    const marker: BuildingMarkerUi = {
      buildingId: site.buildingId, anchor: site.anchor, kind: 'CONSTRUCTION', icon: site.builderIcon,
      text: site.timeLeft, progress: site.progress, description: site.description,
    };
    siteByMarker.set(marker, site);
    return marker;
  });
  const siteIds = new Set(sites.map(site => site.buildingId));
  const ordinary = markers.filter(marker => !siteIds.has(marker.buildingId)
    || (marker.kind !== 'CONSTRUCTION' && marker.kind !== 'UPGRADING'));
  const shown = visibleMarkers([...ordinary, ...siteMarkers], centerX, centerY);
  const admitted: { markers: BuildingMarkerUi[]; sites: ConstructionSiteUi[] } = { markers: [], sites: [] };
  for (const marker of shown) {
    const site = siteByMarker.get(marker);
    if (site) admitted.sites.push(site);
    else admitted.markers.push(marker);
  }
  return admitted;
}

/** Android BuildingStateMarkers.kt: transparent root; only READY/NOTICE faces take taps. */
export default function BuildingMarkerLayer({ ui, on, overlayWidth, overlayHeight }: BuildingMarkerLayerProps): React.JSX.Element | null {
  if (!ui.visible || ui.markers.length === 0) return null;
  const shown = visibleMarkers(ui.markers, overlayWidth / 2, overlayHeight / 2);
  return (
    <div className="pk-building-markers pk-pass" data-pk-world-markers>
      {shown.map(marker => marker.kind === 'READY' || marker.kind === 'NOTICE'
        ? <WorldBubble key={`${marker.buildingId}:${marker.kind}`} ui={marker}
          onClick={() => marker.kind === 'READY' ? on.onCollect(marker.buildingId) : on.onOpen(marker.buildingId)} />
        : <PkTimerPlate key={`${marker.buildingId}:${marker.kind}`} ui={marker} />)}
    </div>
  );
}

/** The native 48 px cream/green bubble and 12 × 8 tail; the optional count is already server-formatted. */
export function WorldBubble({ ui, onClick }: { ui: BuildingMarkerUi; onClick: () => void }): React.JSX.Element {
  const ready = ui.kind === 'READY';
  return (
    <div className="pk-building-bubble" data-ready={ready}
      style={{ left: (ui.anchor.left + ui.anchor.right) / 2, top: ui.anchor.top }}>
      <div className="pk-building-bubble__body">
        <button type="button" className="pk-building-bubble__target interactive pk-focusable" aria-label={ui.description} onClick={onClick}>
          <PkPlate kind="CREAM" tint={ready ? 'green-hi' : null} blocksScene={false} className="pk-building-bubble__plate">
            <span className="pk-building-bubble__content" aria-hidden="true">
              <PkIcon name={ui.icon} size={32} />
              {ui.text != null ? <span className="pk-t-small">{ui.text}</span> : null}
            </span>
          </PkPlate>
        </button>
        <span className="pk-building-bubble__tail" aria-hidden="true" />
      </div>
    </div>
  );
}
