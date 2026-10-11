import { withPhaseEWebHold } from './webHold';
import { lazy, Suspense, useEffect, useState } from 'react';
import { MiningClaimStatusViewSchema } from '@shardkeep/shared/miningClaimsApi';
import { authCookies } from '../../auth/authCookieCoordinator';
import { api } from '../../lib/api';
import { miningClaimIdentity } from '../../lib/miningClaims/browser';
import { MiningClaimJournalStore } from '../../lib/miningClaims/journal';
import { useApp } from '../../state/store';
import { PhaseEEntryButton as Btn } from './PhaseEActionDock';
const MiningClaimsScreen = lazy(() => import('./MiningClaimsScreen').then(m => ({ default: m.MiningClaimsScreen })));

function MiningClaimsEntryEnabled({ actionsEnabled }: { actionsEnabled: boolean }): React.JSX.Element | null {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed);
  const [found, setFound] = useState<{ wallet: string; local: boolean } | null>(null), [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true;
    const generation = authCookies.captureGeneration(), current = () => active && authCookies.current(generation) && useApp.getState().authed && useApp.getState().wallet === wallet;
    const store = new MiningClaimJournalStore(miningClaimIdentity(wallet));
    void store.read().then(j => { if (current() && (j.operation || j.archives.length)) setFound({ wallet, local: true }); })
      .catch(() => { if (current()) setFound({ wallet, local: true }); }).finally(() => store.close().catch(() => undefined));
    const abort = new AbortController();
    void api.get('/claims/mining/status', { signal: abort.signal, isCurrent: current }).then(raw => {
      const status = MiningClaimStatusViewSchema.parse(raw);
      if (current() && status.wallet === wallet && status.state !== 'unavailable') setFound(old => old?.wallet === wallet && old.local ? old : { wallet, local: false });
    }).catch(() => undefined);
    return () => { active = false; abort.abort(); };
  }, [wallet, authed]);
  if (!authed || !wallet || found?.wallet !== wallet) return null;
  return <>
    <Btn variant="sec" style={{ minHeight: 44, position: 'absolute', right: 12, bottom: 'calc(var(--safe-bottom, 0px) + 400px)', zIndex: 20 }}
      onClick={() => setOpen(wallet)}>{found.local ? 'MINING CLAIMS & HISTORY' : 'MINING CLAIMS'}</Btn>
    {open === wallet && <Suspense fallback={<p role="status">Opening saved mining claims…</p>}><MiningClaimsScreen actionsEnabled={actionsEnabled} onClose={() => setOpen(null)} /></Suspense>}
  </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const MiningClaimsEntry = withPhaseEWebHold(MiningClaimsEntryEnabled);
