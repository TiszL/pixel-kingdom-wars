/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMapAtlas } from './mapAtlas';

afterEach(() => vi.unstubAllGlobals());

describe('map atlas recovery', () => {
  it('does not cache a transient failure as the permanent square fallback', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        json: async () => ({ textures: [{ frames: [{ filename: 'map_keep_t1', frame: { x: 0, y: 0, w: 8, h: 8 } }] }] }),
      });
    class ReadyImage {
      naturalWidth = 8;
      naturalHeight = 8;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Image', ReadyImage);

    expect(await loadMapAtlas()).toBeNull();
    const recovered = await loadMapAtlas();
    expect(recovered?.frame('map_keep_t1')).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
