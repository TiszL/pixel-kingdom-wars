import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type {
  LayoutClient, LayoutSlot, LayoutsDto, SaveLayoutDto, UnlockFarmDto,
} from './types';

export const layoutClient: LayoutClient = {
  read: (baseId) => api.get<LayoutsDto>(`/base/layouts?baseId=${encodeURIComponent(baseId)}`),
  unlockFarm: (baseId, idempotencyKey) => api.post<UnlockFarmDto>(
    '/base/layouts/FARM/unlock', { baseId, idempotencyKey },
  ),
  save: (baseId, slot: LayoutSlot, input) => api.put<SaveLayoutDto>(
    `/base/layouts/${slot}`, { baseId, ...input },
  ),
};

interface LayoutResource {
  data: LayoutsDto | null;
  loading: boolean;
  error: Error | null;
  reload(): Promise<LayoutsDto | null>;
}

/** Latest-request-wins resource hook. A deed switch/unmount cannot install an
 * older layout response into the editor for the new base. */
export function useLayouts(baseId: string, client: LayoutClient = layoutClient): LayoutResource {
  const [data, setData] = useState<LayoutsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const request = useRef(0);

  const reload = useCallback(async (): Promise<LayoutsDto | null> => {
    const generation = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const next = await client.read(baseId);
      if (generation !== request.current) return null;
      setData(next);
      return next;
    } catch (cause) {
      if (generation !== request.current) return null;
      setError(cause instanceof Error ? cause : new Error('Unable to load layouts'));
      return null;
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, [baseId, client]);

  useEffect(() => {
    setData(null);
    void reload();
    return () => { request.current++; };
  }, [reload]);

  return { data, loading, error, reload };
}
