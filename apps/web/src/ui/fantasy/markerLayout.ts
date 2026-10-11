import type { FantasyWorldMarker } from './types';

export interface ProjectedMarker extends FantasyWorldMarker {
  x: number; y: number; z: number; realmId: string;
  parcelWidth?: number; parcelHeight?: number;
}
export interface MarkerBounds { left: number; top: number; right: number; bottom: number }
export interface MarkerGroup {
  marker: ProjectedMarker;
  x: number; y: number; width: number; height: number;
  count: number; selected: boolean; owned: boolean;
  showName: boolean; members: readonly ProjectedMarker[];
}

// CSS touch geometry, independent of world tiles. Reserve a count badge's width
// before grouping so acquiring a neighbour cannot collide with another button.
const TOUCH = 44, GROUP_WIDTH = 72, SELECTED_WIDTH = 176, GAP = 6;

/** Stable tile order chooses anchors, never an API response's ordering or a
 * moving centroid. Only presentation is grouped: every native tile stays pickable. */
export function layoutWorldMarkers(markers: readonly ProjectedMarker[], bounds: MarkerBounds, selectedTileId: number | null): MarkerGroup[] {
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  if (width < TOUCH || height < TOUCH) return [];
  const candidates = markers.filter(m => m.z > .15 && Number.isFinite(m.x) && Number.isFinite(m.y)
    && m.x >= bounds.left && m.x <= bounds.right && m.y >= bounds.top && m.y <= bounds.bottom)
    .sort((a,b) => Number(b.tileId === selectedTileId) - Number(a.tileId === selectedTileId)
      || Number(!!b.owned) - Number(!!a.owned) || a.tileId - b.tileId);
  const groups: Array<Omit<MarkerGroup,'members'> & { members: ProjectedMarker[]; reserved: number }> = [];
  const seen = new Set<number>();
  for (const marker of candidates) {
    if (seen.has(marker.tileId)) continue;
    seen.add(marker.tileId);
    const selected = marker.tileId === selectedTileId;
    const reserved = Math.min(width, selected ? SELECTED_WIDTH : GROUP_WIDTH);
    const x = Math.max(bounds.left + reserved / 2, Math.min(bounds.right - reserved / 2, marker.x));
    const y = Math.max(bounds.top + TOUCH / 2, Math.min(bounds.bottom - TOUCH / 2, marker.y));
    const overlap = groups.filter(g => Math.abs(g.x - x) < (g.reserved + reserved) / 2 + GAP
      && Math.abs(g.y - y) < TOUCH + GAP)
      .sort((a,b) => (a.x-x)**2 + (a.y-y)**2 - ((b.x-x)**2 + (b.y-y)**2) || a.marker.tileId-b.marker.tileId)[0];
    if (overlap) { overlap.members.push(marker); overlap.owned ||= !!marker.owned; }
    else groups.push({ marker, x, y, width: reserved, reserved, height: TOUCH, count: 1, selected,
      owned: !!marker.owned, showName: selected, members: [marker] });
  }
  const result = groups.map(({ members, reserved, ...group }) => {
    // Realm totals already include the viewer's own deeds. Do not add those
    // individually to the same server summary at overview zoom.
    const summaries = new Map<string,number>();
    for (const member of members) if (member.cluster) summaries.set(member.cluster.realmId,
      Math.max(summaries.get(member.cluster.realmId) ?? 0, member.cluster.count));
    const count = [...summaries.values()].reduce((sum,n) => sum+n, 0)
      + members.filter(m => !m.cluster && !summaries.has(m.realmId)).length;
    return { ...group, members, count, width: group.selected || count > 1 ? reserved : TOUCH };
  });
  // Labels never create more clusters. Expand solitary keeps only when their
  // projected parcel and the surrounding touch targets both leave enough room.
  for (const group of result) {
    if (group.selected || group.count !== 1 || group.marker.cluster
      || (group.marker.parcelWidth ?? 0) < SELECTED_WIDTH
      || (group.marker.parcelHeight ?? 0) < TOUCH
      || group.x - SELECTED_WIDTH / 2 < bounds.left || group.x + SELECTED_WIDTH / 2 > bounds.right) continue;
    if (result.some(other => other !== group && Math.abs(other.x-group.x) < (other.width+SELECTED_WIDTH)/2+GAP
      && Math.abs(other.y-group.y) < TOUCH+GAP)) continue;
    group.width = SELECTED_WIDTH; group.showName = true;
  }
  return result;
}
