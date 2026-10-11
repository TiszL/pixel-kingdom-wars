import { withPhaseEWebHold } from './webHold';
import { lazy, Suspense, useEffect, useState } from 'react';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { Btn, Icon } from '../primitives';
const Screen = lazy(() => import('./MiningContributionScreen').then(module => ({ default: module.MiningContributionScreen })));

/** Mounted by the Gold Forge host. The resource catalogue and journal stay
 * behind this lazy entry, with local receipt discovery even during a pause. */
function MiningContributionEntryEnabled({ actionsEnabled = true, discover = true }: { actionsEnabled?: boolean; discover?: boolean }) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const [found, setFound] = useState<{ wallet: string; baseId: string | null; baseEpoch: number; local: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true; const abort = new AbortController(), generation = authCookies.captureGeneration();
    const identityCurrent = () => active && authCookies.current(generation) && useApp.getState().authed && useApp.getState().wallet === wallet;
    const selectedCurrent = () => identityCurrent() && useApp.getState().selectedBaseId === baseId && useApp.getState().baseSelectionEpoch === baseEpoch;
    void Promise.all([import('../../lib/miningContribution/journal'), import('../../lib/miningContribution/browser')]).then(async ([journal, browser]) => {
      if (!identityCurrent()) return;
      const store = new journal.MiningContributionJournalStore(browser.miningContributionIdentity(wallet));
      try { const saved = await store.read(); if (identityCurrent() && (saved.operation || saved.archives.length)) setFound({ wallet, baseId, baseEpoch, local: true }); }
      catch { if (identityCurrent()) setFound({ wallet, baseId, baseEpoch, local: true }); }
      finally { await store.close().catch(() => undefined); }
    }).catch(() => undefined);
    if (discover && baseId) void Promise.all([import('../../lib/api'), import('@shardkeep/shared/miningContributionApi')]).then(async ([client, schema]) => {
      if (!selectedCurrent()) return;
      const raw = await client.api.get(`/mining/contributions?baseId=${encodeURIComponent(baseId)}`, { signal: abort.signal, isCurrent: selectedCurrent });
      const view = schema.MiningContributionViewSchema.parse(raw);
      if (selectedCurrent() && view.wallet === wallet && view.baseId === baseId)
        setFound(old => old?.wallet === wallet && old.local ? old : { wallet, baseId, baseEpoch, local: false });
    }).catch(() => undefined);
    return () => { active = false; abort.abort(); };
  }, [wallet, authed, baseId, baseEpoch, discover]);
  if (!authed || !wallet || found?.wallet !== wallet || !found.local && (found.baseId !== baseId || found.baseEpoch !== baseEpoch)) return null;
  return <><Btn variant="sec" style={{ minHeight: 48, width: '100%' }} onClick={() => setOpen(wallet)}><Icon name="keep" />{found.local ? 'MINING & SAVED CONTRIBUTIONS' : 'CONTRIBUTE TO KEEP MINING'}</Btn>
    {open === wallet && <Suspense fallback={<p role="status">Opening your mining contributions…</p>}><Screen actionsEnabled={actionsEnabled} onClose={() => setOpen(null)} /></Suspense>}
  </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const MiningContributionEntry = withPhaseEWebHold(MiningContributionEntryEnabled);
