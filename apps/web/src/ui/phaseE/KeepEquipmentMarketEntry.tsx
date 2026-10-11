import { withPhaseEWebHold } from './webHold';
import { MarketHistoryRecovery } from '../../lib/keepEquipmentMarket/recoveryAccess';
import { lazy, Suspense, useState } from 'react';
import { useUserCommand } from '../pk/useUserCommand';
import { useApp } from '../../state/store';
import { hasBuildingActivityAccess, launchBuildingActivity, launchHistoryActivity } from '../../lib/phaseEActivity/access';
import { PhaseEEntryButton } from './PhaseEActionDock';
import type { KeepEquipmentSigningTrust } from '../../lib/keepEquipmentMarket/signing';
const Screen = lazy(() => import('./KeepEquipmentMarketScreen').then(m => ({ default: m.KeepEquipmentMarketScreen })));
/** Installed trust stays independent of API replies; history keeps recovery. */
function KeepEquipmentMarketEntryEnabled({ actionsEnabled, trust = null, buildingId }: {
  actionsEnabled: boolean; trust?: KeepEquipmentSigningTrust | null; buildingId?: string;
}) {
  const requestCommand = useUserCommand(() => useApp.getState().authed);
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId);
  const epoch = useApp(s => s.baseSelectionEpoch), base = useApp(s => s.base), selected = useApp(s => s.selectedBuildingId);
  const [open, setOpen] = useState<{ wallet: string; baseId: string | null; epoch: number } | null>(null);
  if (!wallet || !authed) return null;
  const world = buildingId !== undefined;
  const building = world ? base?.buildings.find(row => row.id === buildingId && row.type === 'market') : undefined;
  const doorReady = !!building && selected === buildingId && base?.baseId === baseId && building.level > 0 && !building.underConstruction;
  const current = open?.wallet === wallet && open.epoch === epoch && (!world || open.baseId === baseId);
  const allowed = world && hasBuildingActivityAccess('market');
  const close = () => { setOpen(null); launchHistoryActivity('market'); };
  return <><PhaseEEntryButton variant="sec" disabled={world && !doorReady} onClick={() => requestCommand(() => {
    if (world) { if (!launchBuildingActivity('market', buildingId)) return; }
    else launchHistoryActivity('market');
    setOpen({ wallet, baseId, epoch });
  })}>{world ? 'KEEP MARKET' : 'MARKET HISTORY'}</PhaseEEntryButton>
    {current && (!world || allowed) && <Suspense fallback={<p role="status">Opening your KEEP market…</p>}>
      <MarketHistoryRecovery.Provider value={actionsEnabled && !world}><Screen actionsEnabled={actionsEnabled && allowed} historyOnly={!world} trust={trust} onClose={close} /></MarketHistoryRecovery.Provider>
    </Suspense>}
  </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const KeepEquipmentMarketEntry = withPhaseEWebHold(KeepEquipmentMarketEntryEnabled);
