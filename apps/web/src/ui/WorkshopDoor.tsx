import { withPhaseEWebHold } from './phaseE/webHold';
import { useEffect, useState } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../state/store';
import { createWorkshopBrowserPorts, workshopIdentity } from '../lib/workshop/browser';
import { WorkshopJournalStore } from '../lib/workshop/journal';
import { refreshWorkshopSnapshot } from '../lib/workshop/snapshot';
import { useUserCommand } from './pk/useUserCommand';
import { Btn } from './primitives';
/** The always-mounted door reads local evidence only. A selected standing
 * Workshop can additionally discover fresh server capability/paid stock. */
function WorkshopDoorEnabled({ discover = false, floating = false }: { discover?: boolean; floating?: boolean }): React.JSX.Element | null {
  const requestCommand = useUserCommand(() => useApp.getState().authed);
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), epoch = useApp(s => s.baseSelectionEpoch);
  const [found, setFound] = useState<{ wallet: string; baseId: string | null; local: boolean } | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true; const scope = captureBaseSnapshotGuard(), identity = workshopIdentity(wallet), store = new WorkshopJournalStore(identity);
    void store.read().then(journal => {
      if (active && (journal.operation || journal.archives.length)) setFound({ wallet, baseId: null, local: true });
    }).catch(() => { if (active) setFound({ wallet, baseId: null, local: true }); }).finally(() => store.close().catch(() => undefined));
    if (discover) {
      const ports = createWorkshopBrowserPorts({ identity, lifecycle: () => ({ active, visible: document.visibilityState !== 'hidden', epoch: 0, actionsEnabled: false }) });
      void refreshWorkshopSnapshot(identity, ports).then(snapshot => {
        if (active && isBaseSnapshotGuardCurrent(scope) && snapshot && snapshot.view.level > 0
          && (snapshot.enabled || snapshot.view.inventory.held > 0 || snapshot.view.jobs.some(job => job.collectedAt === null))) setFound(old => old?.wallet === wallet && old.local ? old : { wallet, baseId, local: false });
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [wallet, authed, baseId, epoch, discover]);
  if (!authed || found?.wallet !== wallet || !found.local && found.baseId !== baseId) return null;
  return <Btn variant="sec" style={{ minHeight: 44, ...(floating ? { position: 'absolute', right: 12, bottom: 'calc(var(--safe-bottom, 0px) + 104px)', zIndex: 20, maxWidth: 'calc(100% - 24px)' } : { width: '100%', marginBottom: 8 }) }}
    onClick={() => requestCommand(() => useApp.getState().setScreen('workshop'))}>{found.local ? 'WORKSHOP & SAVED RECEIPTS' : 'OPEN WORKSHOP'}</Btn>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const WorkshopDoor = withPhaseEWebHold(WorkshopDoorEnabled);
