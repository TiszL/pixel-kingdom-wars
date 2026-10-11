/** Refresh server mining snapshots for both the Mine sheet and HUD. */
import { useEffect } from 'react';
import { api } from '../lib/api';
import { selectedBasePath } from '../lib/baseSelection';
import { bus } from '../lib/events';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../state/store';
import type { MineStatusDto } from './screens/menu';
import { useFetch } from './useFetch';

export function useMineStatus() {
  const wallet = useApp((state) => state.wallet);
  const baseId = useApp((state) => state.selectedBaseId);
  const selectionEpoch = useApp((state) => state.baseSelectionEpoch);
  const base = useApp((state) => state.base);
  const { data: snapshot, error, loading, reload } = useFetch(async () => {
    const guard = captureBaseSnapshotGuard();
    const data = await api.get<MineStatusDto>(selectedBasePath('/mine/status'));
    return { guard, data };
  }, [wallet, baseId, selectionEpoch, base]);

  useEffect(() => {
    const refreshVisible = (): void => {
      if (document.visibilityState !== 'hidden') reload();
    };
    const off = bus.on('base:refresh', refreshVisible);
    // Presentation freshness only: always read the server's integer balance;
    // never simulate SHARDS or keep polling a background mobile tab.
    const timer = setInterval(refreshVisible, 15_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [reload]);

  // A previous deed's successful result is not a placeholder for the next
  // deed while its request is pending or fails. Late responses stay hidden.
  const data = snapshot && isBaseSnapshotGuardCurrent(snapshot.guard) ? snapshot.data : null;
  return { data, error, loading, reload };
}
