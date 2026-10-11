import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RealmPassportExpeditionsResponse, RealmPassportInclusionsResponse, RealmPassportCurrentResponse } from '@shardkeep/shared/realmPassportApi';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { readPassportExpeditions, readPassportInclusions, readPassportCurrent } from './transport';

export type PassportSection = 'starter' | 'advanced' | 'mining';
type Page<T> = { response: T | null; busy: boolean; error: string | null };
const empty = <T,>(): Page<T> => ({ response: null, busy: false, error: null });
const failed = 'History could not be refreshed. Please try again.';
/** Memory is scoped to one authenticated screen/filter lifetime. No wallet history goes into shared storage. */
export function useRealmPassport() {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen);
  const [section, setSection] = useState<PassportSection>('starter');
  const scope = useMemo(() => ({ active: false, generation: authCookies.captureGeneration(), requests: new Map<string, AbortController>() }), [wallet, authed, screen, section]);
  const [history, setHistory] = useState<{ scope: typeof scope; page: Page<RealmPassportExpeditionsResponse | RealmPassportInclusionsResponse> }>({ scope, page: empty() });
  const [current, setCurrent] = useState<{ scope: typeof scope; page: Page<RealmPassportCurrentResponse> }>({ scope, page: empty() });
  const isCurrent = useCallback(() => scope.active && !!wallet && authed && authCookies.current(scope.generation) && useApp.getState().authed && useApp.getState().wallet === wallet && useApp.getState().screen === screen, [scope, wallet, authed, screen]);
  const load = useCallback(async (cursor?: string) => {
    if (!wallet || !isCurrent()) return;
    scope.requests.get('history')?.abort();
    const abort = new AbortController(); scope.requests.set('history', abort);
    const valid = () => isCurrent() && scope.requests.get('history') === abort && !abort.signal.aborted;
    setHistory(old => ({ scope, page: { ...(old.scope === scope ? old.page : empty()), busy: true, error: null } }));
    try {
      const input = { wallet, signal: abort.signal, isCurrent: valid };
      const response = section === 'mining' ? await readPassportInclusions(input, cursor ? { cursor } : {}) : await readPassportExpeditions(input, { kind: section, ...(cursor ? { cursor } : {}) });
      if (!valid()) return;
      setHistory(old => {
        if (cursor && response.state === 'available' && old.scope === scope && old.page.response?.state === 'available') {
          // Pages have the same frozen filter and actor; the transport validates each page independently.
          const previous = old.page.response;
          if ('kind' in response.data && 'kind' in previous.data) return { scope, page: { response: { ...response, data: { ...response.data, rows: [...previous.data.rows, ...response.data.rows] } }, busy: false, error: null } };
          if (!('kind' in response.data) && !('kind' in previous.data)) {
            const oldSource = previous.data.rows[0], newSource = response.data.rows[0];
            if (oldSource && newSource && (oldSource.genesisHash !== newSource.genesisHash || oldSource.programId !== newSource.programId || oldSource.configAddress !== newSource.configAddress)) {
              return { scope, page: { ...old.page, busy: false, error: 'The publication source changed. Refresh history from the first page.' } };
            }
            return { scope, page: { response: { ...response, data: { ...response.data, rows: [...previous.data.rows, ...response.data.rows] } }, busy: false, error: null } };
          }
        }
        return { scope, page: { response, busy: false, error: null } };
      });
    } catch {
      if (valid()) setHistory(old => ({ scope, page: { ...(old.scope === scope ? old.page : empty()), busy: false, error: failed } }));
    }
  }, [wallet, isCurrent, scope, section]);
  const loadCurrent = useCallback(async () => {
    if (!wallet || !isCurrent()) return;
    scope.requests.get('current')?.abort();
    const abort = new AbortController(); scope.requests.set('current', abort);
    const valid = () => isCurrent() && scope.requests.get('current') === abort && !abort.signal.aborted;
    setCurrent({ scope, page: { response: null, busy: true, error: null } });
    try {
      const response = await readPassportCurrent({ wallet, signal: abort.signal, isCurrent: valid });
      if (valid()) setCurrent({ scope, page: { response, busy: false, error: null } });
    } catch {
      if (valid()) setCurrent({ scope, page: { response: null, busy: false, error: 'Current on-chain participation is unavailable. Your published history is separate.' } });
    }
  }, [wallet, isCurrent, scope]);
  useEffect(() => {
    scope.active = true;
    void load(); if (section === 'mining') void loadCurrent();
    return () => { scope.active = false; for (const abort of scope.requests.values()) abort.abort(); };
  }, [scope, section, load, loadCurrent]);
  const visible = history.scope === scope && isCurrent() ? history.page : empty<RealmPassportExpeditionsResponse | RealmPassportInclusionsResponse>();
  const present = current.scope === scope && isCurrent() ? current.page : empty<RealmPassportCurrentResponse>();
  const nextCursor = visible.response?.state === 'available' ? visible.response.data.nextCursor : null;
  return { section, setSection, history: visible, current: present,
    refresh: () => { void load(); if (section === 'mining') void loadCurrent(); },
    more: () => nextCursor && !visible.busy ? load(nextCursor) : Promise.resolve(), nextCursor };
}
