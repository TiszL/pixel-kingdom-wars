import { PLAYTEST_STATS } from '@shardkeep/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';

/** Private campaign responses never survive a wallet switch, even if an aborted
 * transport resolves late. Polling shares the public snapshot freshness goal. */
export function useCampaignData<T>(path: string) {
  const wallet = useApp(s => s.wallet);
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const data = await api.get<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted && useApp.getState().wallet === wallet) setState({ data, error: null, loading: false });
    } catch (e) {
      if (!controller.signal.aborted && useApp.getState().wallet === wallet) setState(s => ({ ...s, error: e instanceof Error ? e.message : 'Could not load campaigns.', loading: false }));
    }
  }, [path, wallet]);
  useEffect(() => {
    setState({ data: null, error: null, loading: true }); void refresh();
    const unsubscribe = useApp.subscribe(s => { if (s.wallet !== wallet) request.current?.abort(); });
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, PLAYTEST_STATS.refreshEveryMs);
    return () => { request.current?.abort(); unsubscribe(); clearInterval(timer); };
  }, [refresh, wallet]);
  return { ...state, refresh };
}
