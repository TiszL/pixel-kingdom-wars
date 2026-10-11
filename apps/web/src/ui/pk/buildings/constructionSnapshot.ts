/**
 * Pure counterparts of native LiveBuildingFactsReader.readConstructionJobs and LivePlacementMapper's construction
 * functions. Inputs belong to one coherent current-base snapshot; this module reads no store, clock, API or world.
 * An elapsed display timer does not complete a job or authorize collection. Only the server can remove the job.
 */
import { fmtDur } from '../../../lib/duration';
import type { BaseStateDto } from '../../../state/store';
import { UNKNOWN } from '../kitLogic';
import type { BuildingMarkerUi, PxRect } from '../types';
import type { BuildingMarkersUi } from './BuildingStateMarkers';
import type { ConstructionLayerUi, ConstructionSiteUi } from './ConstructionSite';
import { visibleMarkers } from './buildingsLogic';

/** The pinned BaseStateDto fields the native fact reader also uses. Null dates preserve unknown legacy input. */
export interface ConstructionBaseFacts {
  buildings: readonly Pick<BaseStateDto['buildings'][number], 'id' | 'type'>[];
  jobs: readonly (Pick<BaseStateDto['jobs'][number], 'id' | 'kind' | 'buildingId'> & {
    startedAt: string | null;
    finishesAt: string | null;
  })[];
}

export interface ConstructionSnapshotVisibility {
  /** Host is actually showing Home; the mapper does not navigate or inspect application state. */
  homeVisible: boolean;
  /** Includes an obstacle selection: all markers hide while anything is selected. */
  selected: boolean;
  placing: boolean;
  buildTrayOpen: boolean;
  layoutEditorOpen: boolean;
}

export interface ConstructionSnapshotInput {
  base: ConstructionBaseFacts | null;
  /** Existing owner's current clock observation in epoch milliseconds; null remains unknown. Never read a new clock. */
  nowMs: number | null;
  /** Current-base building id -> resolved display label (`trayLabel` in the native reader). */
  names: ReadonlyMap<string, string>;
  /** Current-base building id -> visible sprite bounds, in the same CSS-pixel space as cameraCenter. */
  anchors: ReadonlyMap<string, PxRect>;
  /** Authoritative presentation facts only. No native live READY/NOTICE reader is available to infer these here.
   * The caller supplies each ordinary marker once; amounts, icons and descriptions are retained verbatim. */
  markerFacts: readonly Omit<BuildingMarkerUi, 'anchor'>[];
  visibility: ConstructionSnapshotVisibility;
  cameraCenter: { x: number; y: number };
}

export interface ConstructionSnapshot {
  markers: BuildingMarkersUi;
  construction: ConstructionLayerUi;
}

export type UnanchoredConstructionSite = Omit<ConstructionSiteUi, 'anchor'>;

/** Milliseconds per second is a unit conversion, not a game duration or tuning value. */
const MS_PER_SECOND = 1000;

/** Server timestamps must be instants, like native Instant.parse: no local-time or numeric-string guesses.
 * The round trip also rejects impossible calendar dates that JavaScript Date.parse otherwise normalizes. */
function instantMillis(value: string | null): number | null {
  if (value == null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) return null;
  const zone = match[2]!;
  const offsetMinutes = zone.toUpperCase() === 'Z' ? 0
    : (zone[0] === '+' ? 1 : -1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const wallTime = new Date(parsed + offsetMinutes * 60 * MS_PER_SECOND).toISOString().slice(0, 19);
  return wallTime === match[1]!.toUpperCase() ? parsed : null;
}

/** Native titleCase, for already resolved UI labels; no local catalogue or building-type vocabulary. */
function displayName(name: string | undefined): string {
  if (name == null || name.trim() === '') return UNKNOWN;
  return name.toLowerCase().split(' ').map(word => word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

/** Source-backed construction facts, soonest known deadline first and unknown last. Builds/upgrades only.
 * Conflicting duplicate job rows cannot produce duplicate targets: retain the first in that stable priority order.
 * This is display deduplication only; no row is removed from the authoritative input. */
export function constructionSitesFromBase(
  base: ConstructionBaseFacts | null, nowMs: number | null, names: ReadonlyMap<string, string>,
): UnanchoredConstructionSite[] {
  if (base == null) return [];
  const buildingIds = new Set(base.buildings.map(building => building.id));
  const now = nowMs != null && Number.isSafeInteger(nowMs) ? nowMs : null;
  const candidates: UnanchoredConstructionSite[] = [];
  for (const job of base.jobs) {
    if (job.buildingId == null || !buildingIds.has(job.buildingId) || (job.kind !== 'build' && job.kind !== 'upgrade')) continue;
    const finish = instantMillis(job.finishesAt);
    const start = instantMillis(job.startedAt);
    const secondsLeft = now != null && finish != null ? Math.max(0, Math.ceil((finish - now) / MS_PER_SECOND)) : null;
    const timeLeft = secondsLeft == null ? null : fmtDur(secondsLeft);
    // Native BaseJobProgress fraction only. Its private label formatter is intentionally not copied.
    const progress = now == null || start == null || finish == null || finish < start ? null
      : finish === start ? (now >= finish ? 1 : 0)
        : Math.fround(Math.min(1, Math.max(0, (now - start) / (finish - start))));
    const doing = job.kind === 'build' ? 'being built' : 'upgrading';
    candidates.push({
      buildingId: job.buildingId, builderIcon: 'builder', timeLeft, secondsLeft, progress,
      description: `${displayName(names.get(job.buildingId))}: ${doing}, ${timeLeft == null ? 'time unknown' : `${timeLeft} left`}`,
    });
  }
  candidates.sort((a, b) => a.secondsLeft == null ? (b.secondsLeft == null ? 0 : 1)
    : b.secondsLeft == null ? -1 : a.secondsLeft - b.secondsLeft);
  const seen = new Set<string>();
  return candidates.filter(site => {
    if (seen.has(site.buildingId)) return false;
    seen.add(site.buildingId);
    return true;
  });
}

function usableAnchor(anchor: PxRect | undefined): anchor is PxRect {
  return anchor != null && Number.isFinite(anchor.left) && Number.isFinite(anchor.top)
    && Number.isFinite(anchor.right) && Number.isFinite(anchor.bottom)
    && anchor.right >= anchor.left && anchor.bottom >= anchor.top;
}

/**
 * Attach only real world anchors, then select one combined nearest-camera budget using the accepted pure port.
 * This repeats the small adapter in selectBuildingMarkerBudget without importing its React/CSS module by value.
 * The outputs are already joint winners; pass both to their matching frozen layers with the same overlay geometry.
 * Actual anchor publication, lazy mounting, callbacks and the web hold remain the existing owners' responsibilities.
 */
export function constructionSnapshot(input: ConstructionSnapshotInput): ConstructionSnapshot {
  const { base, visibility, cameraCenter } = input;
  if (base == null || !Number.isFinite(cameraCenter.x) || !Number.isFinite(cameraCenter.y)) {
    return { markers: { markers: [], visible: false }, construction: { sites: [], visible: false } };
  }
  const visible = visibility.homeVisible && !visibility.selected && !visibility.placing
    && !visibility.buildTrayOpen && !visibility.layoutEditorOpen;
  const buildingIds = new Set(base.buildings.map(building => building.id));
  const sites = constructionSitesFromBase(base, input.nowMs, input.names).flatMap(site => {
    const anchor = input.anchors.get(site.buildingId);
    return usableAnchor(anchor) ? [{ ...site, anchor }] : [];
  });
  const siteIds = new Set(sites.map(site => site.buildingId));
  const markers: BuildingMarkerUi[] = input.markerFacts.flatMap(fact => {
    const anchor = input.anchors.get(fact.buildingId);
    if (!buildingIds.has(fact.buildingId) || !usableAnchor(anchor)
      || (siteIds.has(fact.buildingId) && (fact.kind === 'CONSTRUCTION' || fact.kind === 'UPGRADING'))) return [];
    return [{ ...fact, anchor }];
  });
  const siteByMarker = new Map<BuildingMarkerUi, ConstructionSiteUi>();
  const siteMarkers: BuildingMarkerUi[] = sites.map(site => {
    const marker: BuildingMarkerUi = {
      buildingId: site.buildingId, anchor: site.anchor, kind: 'CONSTRUCTION', icon: site.builderIcon,
      text: site.timeLeft, progress: site.progress, description: site.description,
    };
    siteByMarker.set(marker, site);
    return marker;
  });
  const admittedMarkers: BuildingMarkerUi[] = [];
  const admittedSites: ConstructionSiteUi[] = [];
  for (const marker of visibleMarkers([...markers, ...siteMarkers], cameraCenter.x, cameraCenter.y)) {
    const site = siteByMarker.get(marker);
    if (site) admittedSites.push(site);
    else admittedMarkers.push(marker);
  }
  return { markers: { markers: admittedMarkers, visible }, construction: { sites: admittedSites, visible } };
}
