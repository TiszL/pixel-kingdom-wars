import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { layoutClient } from './api';

afterEach(() => vi.restoreAllMocks());

describe('layout API client', () => {
  it('uses only the authoritative HOME/FARM routes and carries optimistic ETags', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({});
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    const baseId = '00000000-0000-4000-8000-000000000099';
    await layoutClient.read(baseId);
    await layoutClient.unlockFarm(baseId, 'unlock-key');
    await layoutClient.save(baseId, 'HOME', {
      geometryVersion: 1,
      mode: 'save_apply',
      expectedSlotEtag: `sha256:${'a'.repeat(64)}`,
      expectedActiveEtag: `sha256:${'b'.repeat(64)}`,
      positions: [{ buildingId: baseId, tx: 8, ty: 8 }],
    });
    expect(get).toHaveBeenCalledWith(`/base/layouts?baseId=${encodeURIComponent(baseId)}`);
    expect(post).toHaveBeenCalledWith('/base/layouts/FARM/unlock', {
      baseId, idempotencyKey: 'unlock-key',
    });
    expect(put).toHaveBeenCalledWith('/base/layouts/HOME', expect.objectContaining({
      baseId, mode: 'save_apply',
      expectedSlotEtag: `sha256:${'a'.repeat(64)}`,
      expectedActiveEtag: `sha256:${'b'.repeat(64)}`,
    }));
  });
});
