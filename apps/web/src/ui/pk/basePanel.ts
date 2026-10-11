/** The one live-base sheet request. Presentation groups follow the accepted
 * F2 lanes; feature IDs bind concrete frozen registry entries at intake. */
export type BasePanelKind = 'info' | 'build' | 'obstacle' | 'army' | 'craft' | 'voyage'
  | 'goldforge' | 'account' | 'map' | 'hub' | 'need-more';
export interface BasePanel {
  kind: BasePanelKind;
  featureId: string;
  buildingId?: string | undefined;
  obstacleId?: string | undefined;
}

/** Keep M48's selection contract without carrying its retired panel vocabulary. */
export function basePanelAfterSelect(
  panel: BasePanel | null, target: { buildingId: string } | { obstacleId: string } | null,
): BasePanel | null {
  if (!panel) return null;
  if (!target) return panel.buildingId !== undefined || panel.obstacleId !== undefined ? null : panel;
  if ('buildingId' in target) {
    if (panel.kind === 'info') return { ...panel, buildingId: target.buildingId, obstacleId: undefined };
    return panel.buildingId === target.buildingId ? panel : null;
  }
  if (panel.kind === 'obstacle') return { ...panel, obstacleId: target.obstacleId, buildingId: undefined };
  return panel.obstacleId === target.obstacleId ? panel : null;
}
