/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useFetch, type FetchState } from './useFetch';

describe('useFetch lifecycle', () => {
  it('rejects refresh after unmount without starting an orphaned request', async () => {
    // WHY: a mutation may settle after its screen closes. Starting refresh at
    // that point creates a waiter no response can apply, leaving the mutation
    // chain pending forever and issuing a read whose result has no owner.
    const fetcher = vi.fn().mockResolvedValue('snapshot');
    let state!: FetchState<string>;
    const Harness = (): null => {
      state = useFetch(fetcher);
      return null;
    };
    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());

    await expect(state.refresh()).rejects.toThrow('fetch view unmounted');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
