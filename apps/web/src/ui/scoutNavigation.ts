import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { api } from '../lib/api';
import { selectedBasePath } from '../lib/baseSelection';
import { bus } from '../lib/events';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type RaidTarget } from '../state/store';

interface ScoutSnapshot {
  name: string; keepLevel: number; trophies: number; previewSec: number;
  buildings: Array<{ id: string; type: string; level: number; tx: number; ty: number }>;
  visualContext?: BaseVisualContext;
  boundCosmeticVisual?: BoundCosmeticBaseRead;
}

let latestAttempt = 0;

/** Read-only preview keeps the chosen base identity. Every later ATTACK still
 * goes through normal raid creation and the server's current eligibility gate. */
export async function openScout(
  target: RaidTarget, returnScreen: 'map' | 'raidlog', attackUnavailable?: string,
): Promise<void> {
  const identity = target.defenderBaseId || target.wallet;
  if (target.kind !== 'pvp' || !identity) return;
  const attempt = ++latestAttempt;
  const guard = captureBaseSnapshotGuard();
  const frozenTarget = { ...target };
  let abandoned = false;
  const unsubscribe = useApp.subscribe((state) => {
    if (state.screen !== returnScreen || !isBaseSnapshotGuardCurrent(guard)) abandoned = true;
  });
  const current = (): boolean => !abandoned && attempt === latestAttempt && isBaseSnapshotGuardCurrent(guard)
    && useApp.getState().screen === returnScreen;
  try {
    const snapshot = await api.get<ScoutSnapshot>(selectedBasePath(`/map/scout/${encodeURIComponent(identity)}`));
    if (!current()) return;
    const state = useApp.getState();
    state.setScoutReport({ name: snapshot.name, keepLevel: snapshot.keepLevel, trophies: snapshot.trophies,
      previewSec: snapshot.previewSec, returnScreen, attackTarget: frozenTarget,
      ...(attackUnavailable ? { attackUnavailable } : {}),
    });
    state.setScreen('scout');
    // The server's context goes through unresolved: SceneGround resolves it and,
    // first, names a ground revision newer than this bundle (the reload prompt).
    bus.emit('battle:enter', { snapshot, scout: true,
      ...('visualContext' in snapshot ? { visualContext: snapshot.visualContext } : {}),
      ...('boundCosmeticVisual' in snapshot ? { boundCosmeticVisual: snapshot.boundCosmeticVisual } : {}),
    });
  } catch (cause) {
    if (current()) bus.emit('ui:toast', { msg: cause instanceof Error ? cause.message : 'SCOUT UNAVAILABLE' });
  } finally {
    unsubscribe();
  }
}
