/**
 * Tiny fetch-on-mount hook for the menu screens. The HUD-critical state
 * (base, balances) lives in the zustand store; these screens pull their own
 * read-only snapshots (map, quests, army, raid log, referral code) on open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';

interface AppliedWaiter<T> {
  minimumRequest: number;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
}

function fetchErrorMessage(cause: unknown): string {
  return cause instanceof ApiError
    ? cause.message : cause instanceof Error ? cause.message : 'failed to load';
}

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Refetch now and settle only after the authoritative snapshot is applied. */
  refresh: () => Promise<T>;
}

export function useFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const appliedWaitersRef = useRef(new Set<AppliedWaiter<T>>());
  fetcherRef.current = fetcher;

  const applySuccess = useCallback((request: number, next: T): void => {
    if (!mountedRef.current || request !== requestRef.current) return;
    setData(next);
    setLoading(false);
    for (const waiter of appliedWaitersRef.current) {
      if (waiter.minimumRequest > request) continue;
      appliedWaitersRef.current.delete(waiter);
      waiter.resolve(next);
    }
  }, []);

  const applyFailure = useCallback((request: number, cause: unknown): void => {
    if (!mountedRef.current || request !== requestRef.current) return;
    setError(fetchErrorMessage(cause));
    setLoading(false);
    for (const waiter of appliedWaitersRef.current) {
      if (waiter.minimumRequest > request) continue;
      appliedWaitersRef.current.delete(waiter);
      waiter.reject(cause);
    }
  }, []);

  const reload = useCallback(() => {
    // Invalidate synchronously. A reload can be requested from a promise
    // callback before React starts the replacement effect; without this fence,
    // the older request can still apply and release a mutation lock.
    requestRef.current++;
    setNonce((n) => n + 1);
  }, []);
  const refresh = useCallback((): Promise<T> => {
    if (!mountedRef.current) return Promise.reject(new Error('fetch view unmounted'));
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    const applied = new Promise<T>((resolve, reject) => {
      appliedWaitersRef.current.add({ minimumRequest: request, resolve, reject });
    });
    void Promise.resolve()
      .then(() => fetcherRef.current())
      .then(
        (next) => applySuccess(request, next),
        (cause: unknown) => applyFailure(request, cause),
      );
    return applied;
  }, [applyFailure, applySuccess]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current++;
      const cause = new Error('fetch view unmounted');
      for (const waiter of appliedWaitersRef.current) waiter.reject(cause);
      appliedWaitersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let live = true;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => { if (live) applySuccess(request, d); })
      .catch((e: unknown) => {
        if (live) applyFailure(request, e);
      })
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  return { data, error, loading, reload, refresh };
}
