/** Selected-deed defender interlock for D-036.
 *
 * The server owns the lock. Live snapshots mirror it into the stable-mode UI
 * so an owner cannot keep using stale base controls while the deed is frozen.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { readRaidEvents, parseRaidSnapshot } from '../lib/raidEvents';
import type { ActiveBaseRaid } from '@shardkeep/shared/raidEvents';
export type { ActiveBaseRaid } from '@shardkeep/shared/raidEvents';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type Screen } from '../state/store';
import { Btn, COLORS as C, Icon, ModalWrap, Phead } from './primitives';

export const ACTIVE_RAID_MESSAGE = 'You are being raided, please wait to continue playing or watch it live';

interface ActiveRaidResponse { activeRaid: ActiveBaseRaid | null }

// A UI freshness cadence, not a game rule. Recursive timeout avoids overlapping
// requests on a slow connection and stays well below the live-read rate limit.
const ACTIVE_RAID_POLL_MS = 2_000;
const STREAM_WATCHDOG_MS = 30_000;

export function activeBaseRaidPath(baseId: string): string {
  return `/bases/${encodeURIComponent(baseId)}/active-raid`;
}

export function deedActionsAllowed(
  baseMutationsEnabled: boolean, activeRaid: ActiveBaseRaid | null | undefined,
): boolean {
  return baseMutationsEnabled && activeRaid === null;
}

/** The lock notice covers every selected-deed gameplay surface, including a
 * modal that was already open when the raid began. Only the three explicit
 * read/navigation exits remain unobstructed. */
export function raidInterlockVisible(
  screen: Screen,
  activeRaid: ActiveBaseRaid | null | undefined,
  selectedBaseId: string | null,
): boolean {
  return activeRaid !== null && activeRaid !== undefined
    && selectedBaseId !== null
    && screen !== 'battle'
    && screen !== 'raidlog'
    && screen !== 'bases';
}

export function useActiveBaseRaid(
  baseId: string | null, enabled: boolean,
): ActiveBaseRaid | null | undefined {
  const wallet = useApp((s) => s.wallet);
  const epoch = useApp((s) => s.baseSelectionEpoch);
  const scope = `${wallet}/${baseId}/${epoch}`;
  const [observed, setObserved] = useState<{
    scope: string; value: ActiveBaseRaid | null | undefined;
  }>({ scope, value: undefined });

  useEffect(() => {
    if (!enabled || !baseId) return;
    const guard = captureBaseSnapshotGuard();
    let disposed = false;
    let phase = 0;
    let healthy = false;
    let snapshotRevision = 0;
    let reconnects = 0;
    let stream: AbortController | null = null;
    let pollRequest: AbortController | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollDeadline: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const available = (): boolean => navigator.onLine && document.visibilityState !== 'hidden';
    const current = (generation: number): boolean => !disposed && phase === generation
      && isBaseSnapshotGuardCurrent(guard) && available();
    const uncertain = (): void => {
      // A known lock survives lost transport. A previously unlocked deed needs
      // a fresh canonical snapshot before its controls can become usable again.
      setObserved((previous) => ({ scope, value: previous.scope === scope && previous.value
        ? previous.value : undefined }));
    };
    const stopPollTimer = (): void => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
    };
    const schedulePoll = (generation: number): void => {
      if (!current(generation) || healthy) return;
      stopPollTimer();
      pollTimer = setTimeout(() => { void poll(generation); }, ACTIVE_RAID_POLL_MS);
    };
    const poll = async (generation: number): Promise<void> => {
      if (!current(generation) || healthy) return;
      if (pollRequest) { schedulePoll(generation); return; }
      const controller = new AbortController();
      pollRequest = controller;
      pollDeadline = setTimeout(() => controller.abort(), 10_000);
      const revision = snapshotRevision;
      try {
        const next = await api.get<ActiveRaidResponse>(activeBaseRaidPath(baseId), {
          signal: controller.signal, isCurrent: () => current(generation) && !healthy && revision === snapshotRevision,
        });
        if (current(generation) && !healthy && revision === snapshotRevision && !controller.signal.aborted) {
          const snapshot = parseRaidSnapshot({ baseId, activeRaid: next.activeRaid }, baseId);
          setObserved({ scope, value: snapshot.activeRaid });
        }
      } catch { /* Keep the known lock or unknown state until a canonical read succeeds. */ }
      finally {
        if (pollRequest === controller) {
          pollRequest = null;
          if (pollDeadline !== null) clearTimeout(pollDeadline);
          pollDeadline = null;
        }
        schedulePoll(generation);
      }
    };
    const connect = async (generation: number): Promise<void> => {
      if (!current(generation)) return;
      const controller = new AbortController();
      stream = controller;
      let receivedSnapshot = false;
      const armWatchdog = (): void => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), STREAM_WATCHDOG_MS);
      };
      armWatchdog();
      let disabled = false;
      try {
        const response = await api.openStream(`/bases/${encodeURIComponent(baseId)}/raid-events`, {
          signal: controller.signal, isCurrent: () => current(generation),
        });
        await readRaidEvents(response, {
          baseId, signal: controller.signal,
          onSnapshot: (snapshot) => {
            if (!current(generation) || controller.signal.aborted) return;
            snapshotRevision += 1;
            receivedSnapshot = true;
            healthy = true;
            reconnects = 0;
            stopPollTimer();
            pollRequest?.abort();
            setObserved({ scope, value: snapshot.activeRaid });
          },
          onActivity: () => {
            // Heartbeats cannot indefinitely hide a missing initial snapshot.
            if (receivedSnapshot && current(generation)) armWatchdog();
          },
        });
      } catch (error) {
        disabled = error instanceof ApiError && (error.code === 'RAID_EVENTS_DISABLED' || error.status === 404);
      } finally {
        if (stream === controller) {
          stream = null;
          if (watchdog !== null) clearTimeout(watchdog);
          watchdog = null;
        }
        controller.abort();
        if (current(generation)) {
          healthy = false;
          uncertain();
          // This canonical GET also applies current session/ownership error
          // handlers when an established stream closes with an error event.
          void poll(generation);
          const delay = disabled ? 60_000 : Math.min(30_000, 1_000 * 2 ** Math.min(reconnects++, 5));
          reconnectTimer = setTimeout(() => { void connect(generation); }, delay);
        }
      }
    };
    const stop = (): void => {
      phase += 1;
      healthy = false;
      stream?.abort();
      stream = null;
      pollRequest?.abort();
      if (pollDeadline !== null) clearTimeout(pollDeadline);
      pollDeadline = null;
      stopPollTimer();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (watchdog !== null) clearTimeout(watchdog);
      reconnectTimer = null; watchdog = null;
    };
    const resume = (): void => {
      stop();
      uncertain();
      if (!available()) return;
      const generation = phase;
      schedulePoll(generation);
      void connect(generation);
    };
    const visibility = (): void => { resume(); };
    window.addEventListener('online', resume);
    window.addEventListener('offline', resume);
    document.addEventListener('visibilitychange', visibility);
    resume();
    return () => {
      disposed = true;
      stop();
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', resume);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [baseId, enabled, wallet, epoch, scope]);

  // Reject the prior selection synchronously, before effect cleanup runs.
  return !enabled || !baseId ? null : observed.scope === scope ? observed.value : undefined;
}

export function BaseRaidInterlockView({
  raid, onWatch, onHistory, onSwitchBase,
}: {
  raid: ActiveBaseRaid;
  onWatch(): void;
  onHistory(): void;
  onSwitchBase(): void;
}): React.JSX.Element {
  return (
    <ModalWrap>
      <div role="alertdialog" aria-modal="true" aria-label="Base under raid"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Phead title="BASE UNDER RAID" color={C.danger} center />
        <Icon name="shield" size={54} style={{ alignSelf: 'center' }} />
        <p style={{ margin: 0, color: C.text, textAlign: 'center', fontSize: 19, lineHeight: 1.3 }}>
          {ACTIVE_RAID_MESSAGE}
        </p>
        <div style={{ color: C.textFaint, textAlign: 'center', fontSize: 13 }}>
          {raid.state === 'reserved' ? 'ATTACKER IS PREPARING' : raid.state === 'live' ? 'BATTLE IN PROGRESS' : 'SETTLING BATTLE'}
        </div>
        <Btn onClick={onWatch}><Icon name="replay" size={20} />WATCH LIVE</Btn>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="sec" style={{ flex: 1 }} onClick={onHistory}>BATTLE HISTORY</Btn>
          <Btn variant="sec" style={{ flex: 1 }} onClick={onSwitchBase}>SWITCH DEED</Btn>
        </div>
      </div>
    </ModalWrap>
  );
}
