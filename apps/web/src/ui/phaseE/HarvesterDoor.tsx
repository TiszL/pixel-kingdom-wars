import { withPhaseEWebHold } from './webHold';
import { launchBuildingActivity, launchHistoryActivity } from '../../lib/phaseEActivity/access';
import { useUserCommand } from '../pk/useUserCommand';
import { useEffect, useState } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { createHarvesterBrowserPorts, harvesterIdentity } from '../../lib/harvester/browser';
import { HarvesterJournalStore } from '../../lib/harvester/journal';
import { refreshHarvesterSnapshot } from '../../lib/harvester/snapshot';
import { PhaseEEntryButton as Btn } from './PhaseEActionDock';

/** Saved or unreadable history remains reachable even when new Harvester is unavailable. */
function HarvesterDoorEnabled({ discover = false, floating = false, buildingId }: { discover?: boolean; floating?: boolean; buildingId?: string }): React.JSX.Element | null {
  const requestCommand = useUserCommand(() => useApp.getState().authed);
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), epoch = useApp(s => s.baseSelectionEpoch);
  const [found, setFound] = useState<{ wallet: string; baseId: string | null; local: boolean } | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true; const scope = captureBaseSnapshotGuard(), identity = harvesterIdentity(wallet), store = new HarvesterJournalStore(identity);
    void store.read().then(journal => {
      if (active && (journal.operation || journal.archives.length)) setFound({ wallet, baseId: null, local: true });
    }).catch(() => { if (active) setFound({ wallet, baseId: null, local: true }); }).finally(() => store.close().catch(() => undefined));
    if (discover) {
      const ports = createHarvesterBrowserPorts({ identity, lifecycle: () => ({ active, visible: document.visibilityState !== 'hidden', epoch: 0, actionsEnabled: false }) });
      void refreshHarvesterSnapshot(identity, ports).then(snapshot => {
        if (active && isBaseSnapshotGuardCurrent(scope) && snapshot && (snapshot.enabled || snapshot.view.walletSource))
          setFound(old => old?.wallet === wallet && old.local ? old : { wallet, baseId, local: false });
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [wallet, authed, baseId, epoch, discover]);
  if (!authed || found?.wallet !== wallet || !found.local && found.baseId !== baseId) return null;
  return <Btn variant="sec" style={{ minHeight: 44, ...(floating ? { position: 'absolute', right: 12, bottom: 'calc(var(--safe-bottom, 0px) + 312px)', zIndex: 20, maxWidth: 'calc(100% - 24px)' } : { width: '100%', marginBottom: 8 }) }}
    onClick={() => requestCommand(() => { if (discover && buildingId) launchBuildingActivity('harvesters', buildingId); else launchHistoryActivity('harvesters'); })}>{found.local ? 'HARVESTER & SAVED RECEIPTS' : 'REALM HARVESTER'}</Btn>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const HarvesterDoor = withPhaseEWebHold(HarvesterDoorEnabled);
