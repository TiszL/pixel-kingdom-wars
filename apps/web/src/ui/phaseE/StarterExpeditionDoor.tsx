import { withPhaseEWebHold } from './webHold';
import { launchBuildingActivity, launchHistoryActivity } from '../../lib/phaseEActivity/access';
import { useUserCommand } from '../pk/useUserCommand';
import { useEffect, useState } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { createStarterExpeditionBrowserPorts, starterExpeditionIdentity } from '../../lib/starterExpedition/browser';
import { StarterExpeditionJournalStore } from '../../lib/starterExpedition/journal';
import { refreshStarterExpeditionSnapshot } from '../../lib/starterExpedition/snapshot';
import { PhaseEEntryButton as Btn } from './PhaseEActionDock';

/** Saved or unreadable history remains reachable even when new starter expedition is unavailable. */
function StarterExpeditionDoorEnabled({ discover = false, floating = false, buildingId }: { discover?: boolean; floating?: boolean; buildingId?: string }): React.JSX.Element | null {
  const requestCommand = useUserCommand(() => useApp.getState().authed);
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), epoch = useApp(s => s.baseSelectionEpoch);
  const [found, setFound] = useState<{ wallet: string; baseId: string | null; local: boolean } | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true; const scope = captureBaseSnapshotGuard(), identity = starterExpeditionIdentity(wallet), store = new StarterExpeditionJournalStore(identity);
    void store.read().then(journal => {
      if (active && (journal.operation || journal.archives.length)) setFound({ wallet, baseId: null, local: true });
    }).catch(() => { if (active) setFound({ wallet, baseId: null, local: true }); }).finally(() => store.close().catch(() => undefined));
    if (discover) {
      const ports = createStarterExpeditionBrowserPorts({ identity, lifecycle: () => ({ active, visible: document.visibilityState !== 'hidden', epoch: 0, actionsEnabled: false }) });
      void refreshStarterExpeditionSnapshot(identity, ports).then(snapshot => {
        if (active && isBaseSnapshotGuardCurrent(scope) && snapshot && (snapshot.enabled || snapshot.view.flight))
          setFound(old => old?.wallet === wallet && old.local ? old : { wallet, baseId, local: false });
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [wallet, authed, baseId, epoch, discover]);
  if (!authed || found?.wallet !== wallet || !found.local && found.baseId !== baseId) return null;
  return <Btn variant="sec" style={{ minHeight: 44, ...(floating ? { position: 'absolute', right: 12, bottom: 'calc(var(--safe-bottom, 0px) + 260px)', zIndex: 20, maxWidth: 'calc(100% - 24px)' } : { width: '100%', marginBottom: 8 }) }}
    onClick={() => requestCommand(() => { if (discover && buildingId) launchBuildingActivity('starter-expeditions', buildingId); else launchHistoryActivity('starter-expeditions'); })}>{found.local ? 'EXPEDITIONS & SAVED RECEIPTS' : 'STARTER EXPEDITIONS'}</Btn>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const StarterExpeditionDoor = withPhaseEWebHold(StarterExpeditionDoorEnabled);
