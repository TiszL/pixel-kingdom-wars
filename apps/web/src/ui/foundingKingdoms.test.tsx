/** @vitest-environment happy-dom */
/**
 * FOUNDING KINGDOMS on the HUD (D-103) — what the chip may show and, above all,
 * how often it may ask.
 *
 * The persistent HUD is the one surface that mounts on every base visit, so
 * the read behind it has two hard rules: it must never poll faster than the
 * server's recompute gate (a faster read cannot return new points, only
 * traffic), and the one-shot `justEarned` in that read must reach the player
 * exactly once — from whichever reader happened to fetch. Both are pinned here
 * against the shared store, not against a component's private state.
 */
import { act } from 'react';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../lib/events';
import { useApp } from '../state/store';

const apiGet = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, get: (...a: unknown[]) => apiGet(...a) } };
});
vi.mock('../lib/analytics', async (orig) => ({ ...(await orig<typeof import('../lib/analytics')>()), track: vi.fn() }));

import { FoundingRow, FoundingTaskButton, foundingAria, foundingView } from './foundingKingdoms';
import { readTesterMe, resetTesterMeForTests, TESTER_ME_MIN_INTERVAL_MS, useTesterMe } from './testerDaily';

const WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const me = (over: Record<string, unknown> = {}) => ({
  wallet: 'AAAA…AAAA', name: null, points: 42, rank: 3, milestonePoints: 30, feedbackPoints: 0, feedbackCount: 0,
  milestones: [{ key: 'signed_in', category: 'first_steps', title: 'Sign in', hint: 'h', points: 5, achievedAt: '2026-09-04T00:00:00Z' }],
  justEarned: [],
  listed: true,
  daily: {
    todayPoints: 12, streakDays: 3,
    byKey: [{ key: 'played', count: 1, points: 2 }, { key: 'pvp_win', count: 5, points: 10 }],
    catalog: {
      sources: [{ key: 'played', category: 'daily', title: 'Play today', hint: 'h', points: 2, cap: 1 },
        { key: 'pvp_win', category: 'daily', title: 'Win a PvP raid', hint: 'h', points: 2, cap: 20 }],
      streaks: [{ key: 'streak_3', days: 3, title: '3-day streak', hint: 'h', points: 5 }],
    },
  },
  referrals: { invited: 2, qualified: 1, activeToday: 1 },
  ...over,
});

describe('founding chip view', () => {
  it('shows no number until the server has answered, then today\'s points and the streak', () => {
    // WHY: a "+0" invented while the read is in flight is the fake HUD figure
    // the BAG/ARMY rule forbids; the chip is a plain destination until then.
    expect(foundingView(null)).toBeNull();
    expect(foundingView({})).toBeNull();
    expect(foundingView({ daily: { todayPoints: 7, streakDays: 2 } })).toEqual({ today: 7, streak: 2 });
    expect(foundingAria(null)).toBe('Founding Kingdoms');
    expect(foundingAria({ today: 7, streak: 0 })).toBe('Founding Kingdoms');
    expect(foundingAria({ today: 7, streak: 2 })).toBe('Founding Kingdoms · 2-day streak');
  });

  it('renders both forms as bare destinations with no snapshot (static markup, no fetch graph)', () => {
    resetTesterMeForTests();
    const button = renderToStaticMarkup(<FoundingTaskButton onOpen={vi.fn()} />);
    expect(button).toContain('aria-label="Founding Kingdoms"');
    expect(button).toContain('FOUNDING');
    expect(button).not.toMatch(/min-width:17px/);
    const row = renderToStaticMarkup(<FoundingRow onOpen={vi.fn()} />);
    expect(row).toContain('aria-label="Founding Kingdoms"');
    expect(row).toContain('FOUNDING KINGDOMS');
    expect(row).not.toContain('TODAY');
  });
});

describe('the shared /tester/me read', () => {
  beforeEach(() => {
    apiGet.mockReset();
    resetTesterMeForTests();
    useApp.setState({ wallet: WALLET, authed: true });
  });
  afterEach(() => {
    resetTesterMeForTests();
    useApp.setState({ wallet: null, authed: false });
    vi.useRealTimers();
  });

  it('mirrors the server\'s recompute gate exactly', () => {
    // WHY: the interval is copied rather than imported so the eager HUD never
    // pulls the shared catalog into first paint; this pin is what keeps the
    // copy honest when the constant is retuned.
    expect(TESTER_ME_MIN_INTERVAL_MS).toBe(TESTER_PROGRAM.recomputeMinIntervalMs);
  });

  it('fetches once for two mounted readers, toasts justEarned exactly once, and shows the numbers on both', async () => {
    apiGet.mockResolvedValue(me({ justEarned: [{ key: 'pvp_win', points: 2 }, { key: 'streak_3', points: 5 }] }));
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => { toasts.push(t.msg); });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<><FoundingTaskButton onOpen={vi.fn()} /><FoundingRow onOpen={vi.fn()} /></>));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/tester/me');
    // Daily keys toast through the same "+N TESTER POINTS" wording as
    // milestones; the daily catalog supplies titles the milestone table lacks.
    expect(toasts).toEqual(['+7 TESTER POINTS — WIN A PVP RAID +1 MORE']);
    expect(host.querySelector('[aria-label="Founding Kingdoms · 3-day streak — +12"]')).not.toBeNull();
    expect(host.textContent).toContain('🔥3');
    expect(host.textContent).toContain('+12 TODAY · 🔥3');

    off();
    await act(async () => root.unmount());
    host.remove();
  });

  it('never re-reads inside the gate, and re-reads once it has passed', async () => {
    vi.useFakeTimers();
    apiGet.mockResolvedValue(me());
    await readTesterMe();
    await readTesterMe();
    await readTesterMe();
    expect(apiGet).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TESTER_ME_MIN_INTERVAL_MS - 1);
    await readTesterMe();
    expect(apiGet).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await readTesterMe();
    expect(apiGet).toHaveBeenCalledTimes(2);
    // RETRY / a screen that needs the latest rows may force a read, but it
    // still joins an in-flight one rather than doubling it.
    const a = readTesterMe({ force: true });
    const b = readTesterMe({ force: true });
    await Promise.all([a, b]);
    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it('drops a result that arrives after a sign-out and reads nothing without a wallet', async () => {
    // WHY: the snapshot is keyed by wallet. A read that resolves after the
    // player signed out (or another wallet signed in) is someone else's
    // progress and must neither render nor toast.
    let resolve!: (v: unknown) => void;
    apiGet.mockReturnValue(new Promise((r) => { resolve = r; }));
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => { toasts.push(t.msg); });
    const pending = readTesterMe();
    useApp.setState({ wallet: null, authed: false });
    resolve(me({ justEarned: [{ key: 'played', points: 2 }] }));
    expect(await pending).toBeNull();
    expect(toasts).toEqual([]);
    expect(await readTesterMe()).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
    off();
  });

  it('exposes the error and lets reload force a fresh read', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(me());
    let latest: ReturnType<typeof useTesterMe> | null = null;
    function Probe(): null { latest = useTesterMe(); return null; }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(latest!.error).toBe('boom');
    expect(latest!.data).toBeNull();
    await act(async () => { latest!.reload(); await Promise.resolve(); await Promise.resolve(); });
    expect(latest!.error).toBeNull();
    expect(latest!.data?.daily?.todayPoints).toBe(12);
    expect(apiGet).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});
