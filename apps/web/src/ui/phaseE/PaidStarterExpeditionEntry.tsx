import { withPhaseEWebHold } from './webHold';
import { lazy, Suspense, useEffect, useState } from 'react';
import { PhaseECatalogueResponseSchema } from '@shardkeep/shared/phaseE';
import { authCookies } from '../../auth/authCookieCoordinator';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { PhaseEEntryButton as Btn } from './PhaseEActionDock';

const Screen = lazy(() => import('./PaidStarterExpeditionScreen').then(module => ({ default: module.PaidStarterExpeditionScreen })));
/** Reuses the starter journal; paid recovery remains reachable while admission is off. */
function PaidStarterExpeditionEntryEnabled({ actionsEnabled }: { actionsEnabled: boolean }): React.JSX.Element | null {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed);
  const [found, setFound] = useState<{ wallet: string; local: boolean } | null>(null), [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true; const abort = new AbortController(), generation = authCookies.captureGeneration();
    const current = () => active && authCookies.current(generation) && useApp.getState().authed && useApp.getState().wallet === wallet;
    void Promise.all([import('../../lib/starterExpedition/journal'), import('../../lib/starterExpedition/browser')]).then(async ([journal, browser]) => {
      if (!current()) return;
      const store = new journal.StarterExpeditionJournalStore(browser.starterExpeditionIdentity(wallet));
      try {
        const row = await store.read(), paid = (operation: typeof row.operation) => !!operation && 'access' in operation.command.route && operation.command.route.access.kind === 'paid_realm';
        if (current() && (paid(row.operation) || row.archives.some(archive => paid(archive.operation)))) setFound({ wallet, local: true });
      } catch { if (current()) setFound({ wallet, local: true }); }
      finally { await store.close().catch(() => undefined); }
    }).catch(() => { if (current()) setFound({ wallet, local: true }); });
    void api.getPrivate('/game/phase-e/catalogue', { signal: abort.signal, isCurrent: current }).then(raw => {
      PhaseECatalogueResponseSchema.parse(raw);
      if (current()) setFound(old => old?.wallet === wallet && old.local ? old : { wallet, local: false });
    }).catch(() => undefined);
    return () => { active = false; abort.abort(); };
  }, [wallet, authed]);
  if (!wallet || !authed || found?.wallet !== wallet) return null;
  return <><Btn variant="sec" style={{ minHeight: 44, position: 'absolute', right: 12, bottom: 'calc(var(--safe-bottom, 0px) + 496px)', zIndex: 20, maxWidth: 'calc(100% - 24px)' }} onClick={() => setOpen(wallet)}>
    {found.local ? 'PAID EXPEDITIONS & HISTORY' : 'PAID REALM EXPEDITIONS'}</Btn>
    {open === wallet && <Suspense fallback={<p role="status">Opening saved expeditions…</p>}><Screen actionsEnabled={actionsEnabled} onClose={() => setOpen(null)} /></Suspense>}
  </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const PaidStarterExpeditionEntry = withPhaseEWebHold(PaidStarterExpeditionEntryEnabled);
