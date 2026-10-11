import { useEffect, useRef, useState } from 'react';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { PaidStarterExpeditionQuerySchema, PaidStarterExpeditionViewSchema, type PaidStarterExpeditionView } from '@shardkeep/shared/paidStarterExpeditionApi';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { api } from '../api';

type Observation = { scope: string; epoch: number; loading: boolean; view: PaidStarterExpeditionView | null; error: string | null };
/** Advisory selected-route read. It cannot supply the actual departure proof. */
export function usePaidStarterExpeditionView(baseId: string | null, realm: number | null, selectionEpoch: number) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const generation = authCookies.captureGeneration(), scope = JSON.stringify([wallet, authed, screen, baseId, baseEpoch, realm, selectionEpoch, generation]);
  const latest = useRef(scope); latest.current = scope;
  const lifetime = useRef({ visible: document.visibilityState !== 'hidden', epoch: 0 });
  const [revision, setRevision] = useState(0), [observation, setObservation] = useState<Observation | null>(null);
  useEffect(() => {
    const suspend = () => { lifetime.current.visible = false; lifetime.current.epoch++; setObservation(null); };
    const resume = () => { lifetime.current.visible = document.visibilityState !== 'hidden'; lifetime.current.epoch++; setObservation(null); setRevision(n => n + 1); };
    const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume();
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); document.addEventListener('resume', resume);
    window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); window.addEventListener('online', resume);
    return () => {
      lifetime.current.epoch++;
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend); document.removeEventListener('resume', resume);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const abort = new AbortController(), baseScope = captureBaseSnapshotGuard(), epoch = lifetime.current.epoch;
    const current = () => active && !abort.signal.aborted && latest.current === scope && authCookies.current(generation)
      && lifetime.current.visible && lifetime.current.epoch === epoch && document.visibilityState !== 'hidden'
      && useApp.getState().authed && useApp.getState().wallet === wallet && useApp.getState().screen === screen
      && baseScope.selectedBaseId === baseId && isBaseSnapshotGuardCurrent(baseScope);
    const empty: Observation = { scope, epoch, loading: false, view: null, error: null };
    if (!wallet || !authed || !lifetime.current.visible || document.visibilityState === 'hidden'
      || !PaidStarterExpeditionQuerySchema.safeParse({ baseId, realm: realm === null ? null : String(realm) }).success) { setObservation(empty); return; }
    setObservation({ ...empty, loading: true });
    const timeout = setTimeout(() => {
      if (current()) setObservation({ ...empty, error: 'The selected paid route is unavailable. Refresh to check again.' });
      abort.abort();
    }, LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    void api.getPrivate(`/starter-expeditions/paid-route?baseId=${encodeURIComponent(baseId!)}&realm=${realm}`, { signal: abort.signal, isCurrent: current }).then(raw => {
      const view = PaidStarterExpeditionViewSchema.parse(raw);
      if (view.wallet !== wallet || view.baseId !== baseId || view.realm !== realm) throw Error('Selected paid route scope changed.');
      if (current()) setObservation({ ...empty, view });
    }).catch(() => { if (current()) setObservation({ ...empty, error: 'The selected paid route and coverage could not be verified.' }); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); abort.abort(); };
  }, [scope, wallet, authed, screen, baseId, realm, generation, revision]);
  const current = observation?.scope === scope && observation.epoch === lifetime.current.epoch && lifetime.current.visible
    && document.visibilityState !== 'hidden' && authCookies.current(generation);
  return { view: current ? observation.view : null, error: current ? observation.error : null, loading: current ? observation.loading : realm !== null,
    refresh: () => { lifetime.current.epoch++; setObservation(null); setRevision(n => n + 1); } };
}
