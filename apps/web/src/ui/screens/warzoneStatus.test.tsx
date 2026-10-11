/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WARZONE } from '@shardkeep/shared';
import { api } from '../../lib/api';
import { WarzoneDetails, warzoneHeading, warzoneRemaining, type WarzoneStatusDto } from './warzoneStatus';

const now = Date.parse('2026-08-13T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('player-facing warzone clock', () => {
  it('shows the scheduled next start while protection still works', () => {
    const start = '2026-08-15T00:00:00.000Z';
    const status: WarzoneStatusDto = {
      mode: 'scheduled', active: false, startsAt: start,
      endsAt: '2026-08-17T00:00:00.000Z', nextStartsAt: start, remainingMs: 0,
    };
    expect(warzoneHeading(status, now)).toEqual({
      title: 'NEXT WARZONE', timer: 'STARTS IN 1D 12H', boundary: start,
    });
  });

  it('shows an active scheduled end but never invents a purge start', () => {
    const end = '2026-08-15T00:00:00.000Z';
    expect(warzoneHeading({
      mode: 'scheduled', active: true, startsAt: '2026-08-13T00:00:00.000Z',
      endsAt: end, nextStartsAt: '2026-08-20T00:00:00.000Z', remainingMs: 0,
    }, now)).toEqual({ title: 'WARZONE ACTIVE', timer: '1D 12H REMAINING', boundary: end });
    expect(warzoneHeading({
      mode: 'purge', active: false, startsAt: null, endsAt: null,
      nextStartsAt: null, remainingMs: null,
    }, now)).toEqual({ title: 'NO WARZONE ACTIVE', timer: 'PURGES ARE UNANNOUNCED', boundary: null });
  });

  it('ceils to the live second so a running warzone never reads zero, and never shows a negative clock', () => {
    expect(warzoneRemaining(new Date(now + 1).toISOString(), now)).toBe('1S');
    expect(warzoneRemaining(new Date(now - 1).toISOString(), now)).toBeNull();
  });

  it('renders the previous inactive economy response shape as safely off', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ warzone: { active: false } });
    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => root.render(<WarzoneDetails onShop={() => {}} />));
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('WARZONES OFF');
    expect(host.textContent).toContain('NO ACTIVE WINDOW');
    expect(host.textContent).not.toContain('WARZONE SHIELD OPTIONS');
    await act(async () => root.unmount());
  });

  it('renders the previous active economy response without inventing an end time', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce({ warzone: { active: true } });
    const host = document.createElement('div');
    const root = createRoot(host);

    await act(async () => root.render(<WarzoneDetails onShop={() => {}} />));
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('WARZONE ACTIVE');
    expect(host.textContent).toContain('END TIME UNAVAILABLE');
    expect(host.textContent).toContain('WARZONE SHIELD OPTIONS');
    expect(host.textContent).not.toContain('ENDING NOW');
    await act(async () => root.unmount());
  });

  it('refreshes authoritative rules as soon as a displayed boundary passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({
        warzone: {
          mode: 'scheduled', active: false,
          startsAt: new Date(now + 500).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
          nextStartsAt: new Date(now + 500).toISOString(), remainingMs: 500,
        },
      })
      .mockResolvedValueOnce({
        warzone: {
          mode: 'scheduled', active: true,
          startsAt: new Date(now + 500).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
          nextStartsAt: new Date(now + 604_800_000).toISOString(), remainingMs: 86_399_250,
        },
      });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<WarzoneDetails onShop={() => {}} />));
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('NEXT WARZONE');

    await act(async () => { await vi.advanceTimersByTimeAsync(751); });
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('WARZONE ACTIVE');
    await act(async () => root.unmount());
  });

  it('polls all phases through scheduled -> active purge -> off without duplicate requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({
        warzone: {
          mode: 'scheduled', active: false,
          startsAt: new Date(now + 3_600_000).toISOString(),
          endsAt: new Date(now + 172_800_000).toISOString(),
          nextStartsAt: new Date(now + 3_600_000).toISOString(),
          remainingMs: 3_600_000,
        },
      })
      .mockResolvedValueOnce({
        warzone: {
          mode: 'purge', active: true, startsAt: null,
          endsAt: new Date(now + 86_400_000).toISOString(),
          nextStartsAt: null, remainingMs: 86_400_000,
        },
      })
      .mockResolvedValueOnce({
        warzone: {
          mode: 'off', active: false, startsAt: null, endsAt: null,
          nextStartsAt: null, remainingMs: null,
        },
      });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<WarzoneDetails onShop={() => {}} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('NEXT WARZONE');
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARZONE.currentPhasePollSec * 1_000);
    });
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('PURGE WARZONE ACTIVE');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARZONE.currentPhasePollSec * 1_000);
    });
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain('WARZONES OFF');
    expect(host.textContent).not.toContain('STARTS');
    await act(async () => root.unmount());
  });
});
