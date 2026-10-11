import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
/** Both private lists use the same cursor contract; scope changes discard old
 * account/filter pages immediately, including late responses from aborted reads. */
export function useFeedbackPages<T extends { id: string }>(wallet: string, path: string, preservePages = false): {
  data: { feedback: T[] } | null; error: string | null; loading: boolean;
  nextCursor: string | null; reload: () => void; more: () => void;
} {
  const currentWallet = useApp(s => s.wallet), scope = JSON.stringify([wallet, path]);
  const [state, setState] = useState<{ scope: string; rows: T[] | null; cursor: string | null; loading: boolean; error: string | null }>({ scope, rows: null, cursor: null, loading: true, error: null });
  const current = useRef(state); current.current = state;
  const epoch = useRef(0), controller = useRef<AbortController | null>(null), live = useRef(false);
  const loadedPages = useRef({ scope, count: 1 });
  const load = useCallback(async (cursor?: string): Promise<void> => {
    if (useApp.getState().wallet !== wallet) return;
    controller.current?.abort(); const ctrl = new AbortController(); controller.current = ctrl; const request = ++epoch.current;
    setState(old => ({ scope, rows: old.scope === scope ? old.rows : null, cursor: cursor ?? null, loading: true, error: null }));
    try {
      const wanted = !cursor && preservePages && loadedPages.current.scope === scope ? loadedPages.current.count : 1;
      let next = cursor, result: { feedback: T[]; nextCursor: string | null } = { feedback: [], nextCursor: null }, pages = 0;
      do {
        const page = await api.get<{ feedback: T[]; nextCursor: string | null }>(`${path}${next ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}` : ''}`, { signal: ctrl.signal });
        if (ctrl.signal.aborted || epoch.current !== request || useApp.getState().wallet !== wallet) return;
        result = { feedback: [...new Map([...result.feedback, ...page.feedback].map(r => [r.id, r])).values()], nextCursor: page.nextCursor };
        pages++; next = page.nextCursor ?? undefined;
      } while (next && pages < wanted);
      if (!live.current || ctrl.signal.aborted || epoch.current !== request || useApp.getState().wallet !== wallet) return;
      loadedPages.current = { scope, count: cursor && loadedPages.current.scope === scope ? loadedPages.current.count + 1 : pages };
      setState(old => ({ scope, rows: cursor && old.scope === scope ? [...new Map([...(old.rows ?? []), ...result.feedback].map(r => [r.id, r])).values()] : result.feedback, cursor: result.nextCursor, loading: false, error: null }));
    } catch (e) { if (live.current && !ctrl.signal.aborted && epoch.current === request && useApp.getState().wallet === wallet) setState(old => ({ ...old, loading: false, error: e instanceof Error ? e.message : 'Could not load reports.' })); }
    finally { if (controller.current === ctrl) controller.current = null; }
  }, [wallet, path, scope, preservePages]);
  useEffect(() => { live.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet) { epoch.current++; controller.current?.abort(); } }); void load(); return () => { live.current = false; epoch.current++; controller.current?.abort(); off(); }; }, [wallet, load]);
  const reload = useCallback(() => { void load(); }, [load]);
  const more = useCallback(() => { const s = current.current; if (s.scope === scope && s.cursor && !controller.current) void load(s.cursor); }, [scope, load]);
  const visible = state.scope === scope && currentWallet === wallet;
  return { data: visible && state.rows ? { feedback: state.rows } : null, error: visible ? state.error : null, loading: visible ? state.loading : true, nextCursor: visible ? state.cursor : null, reload, more };
}
