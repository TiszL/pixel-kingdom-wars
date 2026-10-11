/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBE, WARZONE } from '@shardkeep/shared';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', () => ({
  API_URL: '/api',
  api: { get },
}));

import {
  compactRemaining, deedFallbackImageUrl, deedImageUrl, loadParcelDetail,
  nextParcelRuleRefreshMs, parcelActionBlockText, parcelShieldText, recoverDeedImage,
  useParcelDetail,
  type ParcelDetail,
} from './parcelDetail';

function detail(cell: number): ParcelDetail {
  return {
    parcel: {
      earthCell: cell, x: 4, y: 5, valleyId: 'v1', valleyName: 'Ash Vale',
      siteId: 7, planetId: 0, country: { a3: 'GEO', name: 'Georgia' },
    },
    player: {
      wallet: 'wallet', name: 'KEEPER', avatarUrl: null, clanTag: 'SK', seeker: false,
      keepLevel: 8, trophies: 1200,
    },
    deed: {
      assetId: 'asset', status: 'minted',
      metadata: {
        name: 'Land Deed', symbol: 'DEED', description: 'A base',
        external_url: '/deed/asset.json', image: '/deed/wallet.png',
        attributes: [{ trait_type: 'Tile', value: `Earth · ${cell}` }],
      },
    },
    base: { completedStructures: 22, defenses: 6, walls: 30, landWidth: 18 },
    shield: { active: false, source: null, expiresAt: null, remainingMs: 0, suppressedByWarzone: false },
    warzone: { active: false, boundaryAt: null, remainingMs: null },
    shielded: false,
    actions: {
      scout: { allowed: true, blockedBy: null },
      attack: { allowed: true, blockedBy: null },
    },
    availableLootRanges: {
      oneStar: { min: '100', max: '299' },
      twoStars: { min: '250', max: '599' },
      threeStars: { min: '500', max: '999' },
    },
  };
}

beforeEach(() => get.mockReset());
afterEach(() => vi.useRealTimers());

describe('selected parcel detail', () => {
  it('deduplicates concurrent and recent reads of the exact frozen cell', async () => {
    const expected = detail(40101);
    get.mockResolvedValue(expected);

    const [a, b] = await Promise.all([
      loadParcelDetail(expected.parcel.earthCell, 'viewer-a', 'base-a'),
      loadParcelDetail(expected.parcel.earthCell, 'viewer-a', 'base-a'),
    ]);
    expect(a).toBe(expected);
    expect(b).toBe(expected);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/map/parcel/40101?baseId=base-a');

    expect(await loadParcelDetail(40101, 'viewer-a', 'base-a')).toBe(expected);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('expires a private preview with the authoritative globe snapshot window', async () => {
    const expected = detail(40105);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    get.mockResolvedValue(expected);

    try {
      await expect(loadParcelDetail(40105, 'viewer-expiry', 'base-expiry')).resolves.toBe(expected);
      now.mockReturnValue(1_000_000 + GLOBE.cacheSec * 1000);
      await expect(loadParcelDetail(40105, 'viewer-expiry', 'base-expiry')).resolves.toBe(expected);
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('forces a fresh server preview on retry', async () => {
    const first = detail(40102);
    const second = { ...first, shielded: true };
    get.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(loadParcelDetail(40102, 'viewer-a', 'base-a')).resolves.toBe(first);
    await expect(loadParcelDetail(40102, 'viewer-a', 'base-a', true)).resolves.toBe(second);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('refreshes at the earliest authoritative shield or warzone rule boundary', () => {
    const selected = detail(40108);
    selected.shield = {
      active: true, source: 'loss', expiresAt: '2026-08-16T00:00:00.000Z',
      remainingMs: 30_000, suppressedByWarzone: false,
    };
    selected.warzone = {
      active: false, boundaryAt: '2026-08-15T00:00:00.000Z', remainingMs: 5_000,
    };
    expect(nextParcelRuleRefreshMs(selected)).toBe(5_000);
    selected.warzone = { active: false, boundaryAt: null, remainingMs: null };
    expect(nextParcelRuleRefreshMs(selected)).toBe(30_000);
  });

  it('polls every open parcel so scheduled -> active purge is learned before its old boundary', async () => {
    vi.useFakeTimers();
    const inactive = detail(40109);
    inactive.warzone = {
      active: false,
      boundaryAt: new Date(Date.now() + 3_600_000).toISOString(),
      remainingMs: 3_600_000,
    };
    const active = {
      ...inactive,
      warzone: {
        active: true,
        boundaryAt: '2026-08-15T00:00:00.000Z',
        remainingMs: 86_400_000,
      },
    } satisfies ParcelDetail;
    get.mockResolvedValueOnce(inactive).mockResolvedValueOnce(active);

    function Probe(): ReturnType<typeof createElement> {
      const selected = useParcelDetail(40109, true, 'phase-viewer', 'phase-base');
      return createElement('span', null, selected.data?.warzone.active ? 'ACTIVE' : 'INACTIVE');
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toBe('INACTIVE');
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARZONE.currentPhasePollSec * 1_000);
    });
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe('ACTIVE');
    await act(async () => root.unmount());
  });

  it('rejects a response for a different deed address instead of moving selection', async () => {
    get.mockResolvedValue(detail(999));
    await expect(loadParcelDetail(40103, 'viewer-a', 'base-a')).rejects.toThrow('parcel address mismatch');
  });

  it('never shares viewer-specific eligibility across wallet sessions', async () => {
    const expected = detail(40104);
    get.mockResolvedValue(expected);
    await loadParcelDetail(40104, 'viewer-a', 'base-a');
    await loadParcelDetail(40104, 'viewer-b', 'base-a');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never shares trophy-window eligibility between two selected deeds', async () => {
    const expected = detail(40106);
    get.mockResolvedValue(expected);
    await loadParcelDetail(40106, 'viewer-same', 'base-a');
    await loadParcelDetail(40106, 'viewer-same', 'base-b');
    expect(get).toHaveBeenNthCalledWith(1, '/map/parcel/40106?baseId=base-a');
    expect(get).toHaveBeenNthCalledWith(2, '/map/parcel/40106?baseId=base-b');
  });

  it('keeps the flag-off request shape when no selected base exists', async () => {
    const expected = detail(40107);
    get.mockResolvedValue(expected);
    await loadParcelDetail(40107, 'legacy-viewer', null);
    expect(get).toHaveBeenCalledWith('/map/parcel/40107');
  });

  it('normalizes the previous API parcel shape without inventing a warzone', async () => {
    const current = detail(40110);
    current.shielded = true;
    const { shield: _shield, warzone: _warzone, ...legacy } = current;
    get.mockResolvedValue(legacy);

    const selected = await loadParcelDetail(40110, 'rollback-viewer', 'rollback-base');

    expect(selected.shield).toEqual({
      active: true, source: null, expiresAt: null, remainingMs: 0,
      suppressedByWarzone: false,
    });
    expect(selected.warzone).toEqual({ active: false, boundaryAt: null, remainingMs: null });
    expect(nextParcelRuleRefreshMs(selected)).toBeNull();
  });

  it('resolves API-relative deed art and refuses active-content protocols', () => {
    expect(deedImageUrl('/deed/wallet.png')).toBe(`${window.location.origin}/api/deed/wallet.png`);
    expect(deedImageUrl('https://cdn.example.test/deed.png')).toBe('https://cdn.example.test/deed.png');
    expect(deedImageUrl('javascript:alert(1)')).toBeNull();
    expect(deedImageUrl('data:image/png;base64,AA==')).toBeNull();
    expect(deedImageUrl('//cdn.example.test/deed.png')).toBeNull();
    expect(deedImageUrl('')).toBeNull();
  });

  it('replaces a missing canonical copy with the API deed renderer once', () => {
    const fallback = deedFallbackImageUrl('wallet/with slash');
    expect(fallback).toBe(`${window.location.origin}/api/deed/wallet%2Fwith%20slash.png`);

    const image = document.createElement('img');
    image.src = 'https://r2.example.test/missing.png';
    recoverDeedImage(image, fallback);
    expect(image.src).toBe(fallback);
    expect(image.dataset.deedFallback).toBe('1');
    expect(image.hidden).toBe(false);

    // A broken API render is a true absence: hide it instead of looping or
    // leaving the browser's broken-image glyph in the deed/player card.
    recoverDeedImage(image, fallback);
    expect(image.hidden).toBe(true);
    expect(image.hasAttribute('src')).toBe(false);
  });

  it('explains every server preview block without weakening it client-side', () => {
    expect(parcelActionBlockText('self')).toBe('THIS IS YOUR PARCEL');
    // Without a shield clock (a scout block from an older API, or no deadline)
    // the line says only that it is shut — never a made-up countdown.
    expect(parcelActionBlockText('shielded')).toBe('SHIELD ACTIVE');
    // One release of compatibility with an API that still gates by trophies.
    expect(parcelActionBlockText('outside_trophy_window')).toBe('OUTSIDE TROPHY RANGE');
    expect(parcelActionBlockText('temporarily_unavailable')).toBe('TEMPORARILY UNAVAILABLE');
    expect(parcelActionBlockText(null)).toBeNull();
  });

  it('says WHY an attack is refused in the server’s own numbers (D-099)', () => {
    // WHY: "OUTSIDE TROPHY RANGE" was a shrug. The Keep gate is a rule the player
    // can act on (upgrade, or pick someone bigger), so the line carries the two
    // levels the SERVER compared — never a client re-derivation — and the shield
    // line says when the attack opens, from the server's own clock.
    expect(parcelActionBlockText('keep_too_far_below', {
      keepReach: { attackerKeep: 11, defenderKeep: 3, minDefenderKeep: 6 },
    })).toBe('THEIR KEEP IS TOO FAR BELOW YOURS (L3 vs your L11)');
    // An API one release behind sends the code without keepReach: still honest.
    expect(parcelActionBlockText('keep_too_far_below')).toBe('THEIR KEEP IS TOO FAR BELOW YOURS');

    const now = Date.parse('2026-08-13T12:00:00.000Z');
    const shield = {
      active: true, source: 'loss' as const, expiresAt: '2026-08-15T11:21:13.000Z',
      remainingMs: 0, suppressedByWarzone: false,
    };
    expect(parcelActionBlockText('shielded', { shield, now })).toBe('SHIELDED UNTIL 1D 23H');
    expect(parcelActionBlockText('shielded', { shield: { ...shield, expiresAt: null }, now }))
      .toBe('SHIELD ACTIVE');
  });

  it('shows the selected deed shield deadline and warzone suppression truthfully', () => {
    const now = Date.parse('2026-08-13T12:00:00.000Z');
    const expiresAt = '2026-08-15T11:21:13.000Z';
    expect(compactRemaining(expiresAt, now)).toBe('1D 23H');
    expect(parcelShieldText({
      active: true, source: 'loss', expiresAt, remainingMs: 0, suppressedByWarzone: false,
    }, false, now)).toBe('SHIELD ACTIVE · 1D 23H LEFT');
    expect(parcelShieldText({
      active: false, source: 'loss', expiresAt, remainingMs: 0, suppressedByWarzone: true,
    }, false, now)).toBe('LOSS SHIELD SUPPRESSED · EXPIRES IN 1D 23H');
    expect(parcelShieldText({
      active: true, source: 'warzone', expiresAt, remainingMs: 0, suppressedByWarzone: false,
    }, false, now)).toBe('WARZONE SHIELD ACTIVE · 1D 23H LEFT');
    expect(parcelShieldText({
      active: true, source: 'loss', expiresAt, remainingMs: 0, suppressedByWarzone: false,
    }, false, Date.parse(expiresAt) + 1)).toBe('VERIFYING SHIELD STATUS…');
  });
});
