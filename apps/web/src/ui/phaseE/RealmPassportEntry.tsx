import { withPhaseEWebHold } from './webHold';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { authCookies } from '../../auth/authCookieCoordinator';
import { readPassportExpeditions } from '../../lib/realmPassport/transport';
import { useApp } from '../../state/store';
import { PhaseEEntryButton } from './PhaseEActionDock';
const Screen = lazy(() => import('./RealmPassportScreen').then(m => ({ default: m.RealmPassportScreen })));
/** A configured history source is independent of new-action admission. */
function RealmPassportEntryEnabled(): React.JSX.Element | null {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed);
  const actor = useMemo(() => ({ wallet, authed }), [wallet, authed]);
  const [found, setFound] = useState<{ actor: typeof actor; wallet: string; generation: number } | null>(null);
  const [open, setOpen] = useState<typeof found>(null);
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true;
    const abort = new AbortController(), generation = authCookies.captureGeneration();
    const current = () => active && authCookies.current(generation) && useApp.getState().authed && useApp.getState().wallet === wallet;
    void readPassportExpeditions({ wallet, signal: abort.signal, isCurrent: current }, { kind: 'starter' }).then(() => {
      if (current()) setFound({ actor, wallet, generation });
    }).catch(() => undefined);
    return () => { active = false; abort.abort(); };
  }, [wallet, authed, actor]);
  if (!wallet || !authed || found?.wallet !== wallet || found.actor !== actor || !authCookies.current(found.generation)) return null;
  return <><PhaseEEntryButton variant="sec" style={{ minHeight: 44 }} onClick={() => setOpen(found)}>REALM PASSPORT</PhaseEEntryButton>
    {open?.wallet === wallet && open.actor === actor && authCookies.current(open.generation) && <Suspense fallback={<p role="status">Opening your Realm Passport…</p>}><Screen onClose={() => setOpen(null)} /></Suspense>}
  </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const RealmPassportEntry = withPhaseEWebHold(RealmPassportEntryEnabled);
