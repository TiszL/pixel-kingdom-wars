/** @vitest-environment happy-dom */
/**
 * One-troop cancellation is tap-tap-tap (D-096, owner 2026-09-02): ONE −1
 * chip per troop type over the whole queue, and every tap is one exact refund
 * with nothing in between. These rendered tests pin the seams that would
 * quietly bring the friction back or bend the money path: no confirmation
 * stands between the tap and the POST; a burst posts N DISTINCT ids one at a
 * time, latest-first, with the count falling under the finger; a refusal rolls
 * back exactly its own tap and says why; pre-update rows still explain their
 * missing refund; and the head troop never grows a second −1.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TROOPS } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { haptic } from '../../lib/juice';
import { useApp } from '../../state/store';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { TrainTray } from './army';

let host: HTMLDivElement;
let root: Root;
let toasts: string[];
let offToast: () => void;

const REFUND = String(TROOPS.bowman.costKeep);
const armyState = (queue: Array<Record<string, unknown>>) => ({
  counts: {}, levels: { bowman: 1 }, research: [], queue,
  rosterPts: 0, campCapacityPts: 200, barracksQueuePts: 200,
  eliteUnlocks: {}, features: {},
});
const queued = (id: string, finishMs: number, canCancel = true) => ({
  id, troop: 'bowman', startedAt: new Date(Date.now() - 1_000).toISOString(),
  finishesAt: new Date(Date.now() + finishMs).toISOString(),
  canCancel, refundShards: canCancel ? REFUND : null,
});
// A serialized chain settles through several microtask hops per link, so the
// flush drains a generous number rather than the exact count of one design.
const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
};
const chip = (): HTMLButtonElement => host.querySelector('button[aria-label^="Cancel one BOWMAN"]') as HTMLButtonElement;
/** The ×N badge text of the one BOWMAN chip (the −1 badge is aria-hidden). */
const shown = (): string => chip().textContent?.match(/×\d+/)?.[0] ?? '';

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue({ refundShards: REFUND });
  vi.mocked(haptic).mockReset();
  toasts = [];
  offToast = bus.on('ui:toast', ({ msg }) => { toasts.push(msg); });
  useApp.setState({ selectedBaseId: null, balances: { shards: '1000', keep: '1000', keepRate: 0 } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});

afterEach(async () => {
  offToast();
  await act(async () => root.unmount());
  host.remove();
  useApp.setState({ selectedBaseId: null, balances: null, base: null });
});

describe('Barracks cancel one troop (D-096 tap-tap-tap)', () => {
  it('a tap cancels the latest exact row immediately — no dialog stands between the tap and the refund (D-096)', async () => {
    mocks.get.mockResolvedValue(armyState([queued('old-row', 30_000), queued('new-row', 90_000)]));
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(host.querySelectorAll('button[aria-label^="Cancel one BOWMAN"]')).toHaveLength(1);
    expect(shown()).toBe('×2');

    await act(async () => chip().click()); await flush();
    // The confirmation D-096 removed must not come back: the tap IS the decision.
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // Exactly one exact-id POST, and it is the latest-finishing row (D-094).
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/army/train/new-row/cancel', {});
    expect(toasts).toEqual([`1 BOWMAN CANCELLED · +${REFUND} SHARDS`]);
  });

  it('N rapid taps post N exact ids in order, one in flight at a time', async () => {
    mocks.get.mockResolvedValue(armyState([queued('r1', 30_000), queued('r2', 60_000), queued('r3', 90_000)]));
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.post.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    await act(async () => root.render(<TrainTray />)); await flush();
    const button = chip();

    await act(async () => { button.click(); button.click(); button.click(); }); await flush();
    // Optimistic: the count reaches 0 under the finger, before any round-trip.
    expect(shown()).toBe('×0');
    // Serialized: the second POST waits for the first to resolve — the server
    // locks per row, but a client that fires a backlog could outrun a refusal.
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenNthCalledWith(1, '/army/train/r3/cancel', {});
    // Never disabled, never swapped: the same element takes every tap of the burst.
    expect(button.disabled).toBe(false);
    expect(chip()).toBe(button);

    await act(async () => { resolvers[0]!({ refundShards: REFUND }); }); await flush();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenNthCalledWith(2, '/army/train/r2/cancel', {});
    expect(toasts).toEqual([]); // no per-tap toast — one per burst, when it drains

    await act(async () => { resolvers[1]!({ refundShards: REFUND }); }); await flush();
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.post).toHaveBeenNthCalledWith(3, '/army/train/r1/cancel', {}); // the head row, no dialog

    await act(async () => { resolvers[2]!({ refundShards: REFUND }); }); await flush();
    expect(vi.mocked(haptic)).toHaveBeenCalledTimes(3); // one 'light' per landed tap
    expect(toasts).toEqual([`3 BOWMAN CANCELLED · +${3 * Number(REFUND)} SHARDS`]);
  });

  it('a refused cancel rolls the chip back and says why', async () => {
    mocks.get.mockResolvedValue(armyState([queued('only-row', 30_000)]));
    const rejecters: Array<(reason: Error) => void> = [];
    mocks.post.mockImplementation(() => new Promise((_resolve, reject) => { rejecters.push(reject); }));
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(shown()).toBe('×1');

    await act(async () => chip().click()); await flush();
    expect(shown()).toBe('×0'); // optimistic decrement, in flight

    await act(async () => { rejecters[0]!(new Error('TRAINING ALREADY FINISHED')); }); await flush();
    // The row was never refunded, so the chip must not keep claiming it was;
    // the server's reason is the toast, not a generic failure.
    expect(shown()).toBe('×1');
    expect(toasts).toEqual(['TRAINING ALREADY FINISHED']);
    expect(vi.mocked(haptic)).not.toHaveBeenCalled();
  });

  it('explains why pre-update rows have no estimated refund', async () => {
    mocks.get.mockResolvedValue(armyState([queued('v1-row', 30_000, false)]));
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(host.textContent).toContain('PRE-UPDATE TRAINING FINISHES NORMALLY');
    expect(host.querySelector('button[aria-label^="Cancel one BOWMAN"]')).toBeNull();
  });

  it('the head troop has exactly one −1 control', async () => {
    // Pre-D-096 the in-progress card AND the waiting chip each drew a −1 that
    // resolved to the SAME row; the owner saw "two −1 buttons". The head is
    // now grouped into its troop's single chip, which counts it.
    mocks.get.mockResolvedValue(armyState([queued('head', 30_000), queued('q1', 60_000), queued('q2', 90_000)]));
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(host.querySelectorAll('button[aria-label^="Cancel one BOWMAN"]')).toHaveLength(1);
    expect(shown()).toBe('×3');
  });
});

describe('training queue and Camp capacity', () => {
  const card = (troop: string): HTMLButtonElement => host.querySelector(`[data-train-troop="${troop}"]`)!;
  it('caps manual selection at queue capacity without issuing a purchase', async () => {
    mocks.get.mockResolvedValue({ ...armyState(Array.from({ length: 10 }, (_, i) => queued(`q${i}`, 90_000))),
      campCapacityPts: 20, barracksQueuePts: 10 });
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(card('bowman').disabled).toBe(true);
    expect(card('highlander').disabled).toBe(true);
    expect(card('bowman').title).toBe('TRAINING QUEUE CAPACITY LIMIT');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('uses population costs so a smaller troop can fit when a larger one cannot', async () => {
    mocks.get.mockResolvedValue({ ...armyState(Array.from({ length: 9 }, (_, i) => queued(`q${i}`, 90_000))),
      campCapacityPts: 20, barracksQueuePts: 10 });
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(card('bowman').disabled).toBe(false);
    expect(card('giant').disabled).toBe(true);
  });
  it('a held manual selection stops at available room and submits no units', async () => {
    vi.useFakeTimers();
    try {
      const queue = Array.from({ length: 9 }, (_, i) => queued(`q${i}`, 90_000));
      mocks.get.mockImplementation(async () => ({ ...armyState([...queue]), campCapacityPts: 20, barracksQueuePts: 10 }));
      mocks.post.mockImplementation(async () => { queue.push(queued('last-room', 90_000)); return {}; });
      await act(async () => root.render(<TrainTray />)); await flush();
      await act(async () => { card('bowman').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(350); }); await flush();
      expect(card('bowman').disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); await flush();
      expect(Number(card('bowman').dataset.selectedCount)).toBe(1);
      expect(mocks.post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('a full Camp stops manual selection even when Barracks have queue room', async () => {
    mocks.get.mockResolvedValue({ ...armyState([queued('q1', 90_000)]),
      rosterPts: 19, campCapacityPts: 20, barracksQueuePts: 10 });
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(card('bowman').disabled).toBe(true);
    expect(card('bowman').title).toBe('ARMY CAPACITY LIMIT');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('a refresh that removes room preserves the reviewed draft and allows removing it', async () => {
    let current = { ...armyState([]), campCapacityPts: 20, barracksQueuePts: 10 };
    mocks.get.mockImplementation(async () => current);
    await act(async () => root.render(<TrainTray />)); await flush();
    await act(async () => card('giant').click());
    expect(card('giant').dataset.selectedCount).toBe('1');
    current = { ...current, rosterPts: 20 };
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'REFRESH CAPACITY')!.click()); await flush();
    expect(card('giant').dataset.selectedCount).toBe('1');
    expect(card('giant').disabled).toBe(true);
    await act(async () => (host.querySelector('[aria-label="Remove one selected GIANT"]') as HTMLButtonElement).click());
    expect(card('giant').dataset.selectedCount).toBe('0');
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('local training draft gestures', () => {
  const card = (): HTMLButtonElement => host.querySelector('[data-train-troop="bowman"]')!;
  it('tap and minus only adjust the draft, never the server queue or balance', async () => {
    mocks.get.mockResolvedValue(armyState([]));
    await act(async () => root.render(<TrainTray />)); await flush();
    await act(async () => {
      card().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      card().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    expect(card().dataset.selectedCount).toBe('1');
    await act(async () => (host.querySelector('[aria-label="Remove one selected BOWMAN"]') as HTMLButtonElement).click());
    expect(card().dataset.selectedCount).toBe('0');
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('dragging to scroll selects nothing, including after the hold threshold passes', async () => {
    vi.useFakeTimers();
    try {
      mocks.get.mockResolvedValue(armyState([]));
      await act(async () => root.render(<TrainTray />)); await flush();
      await act(async () => {
        card().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10 }));
        card().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40 }));
        card().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 40 }));
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(card().dataset.selectedCount).toBe('0'); expect(mocks.post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('keyboard activation selects locally and base changes clear ordinary drafts and hold timers', async () => {
    vi.useFakeTimers();
    try {
      mocks.get.mockResolvedValue(armyState([]));
      await act(async () => root.render(<TrainTray />)); await flush();
      await act(async () => card().click());
      expect(card().dataset.selectedCount).toBe('1');
      await act(async () => card().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
      await act(async () => useApp.setState({ baseSelectionEpoch: useApp.getState().baseSelectionEpoch + 1 })); await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(900); });
      expect(card().dataset.selectedCount).toBe('0'); expect(mocks.post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('shows a future head as waiting rather than incorrectly drawing active progress', async () => {
    mocks.get.mockResolvedValue(armyState([{ ...queued('future', 120_000), startedAt: new Date(Date.now() + 60_000).toISOString(), scheduleVersion: 2 }]));
    await act(async () => root.render(<TrainTray />)); await flush();
    expect(host.textContent).toContain('WAITING · BOWMAN');
    expect(host.textContent).toContain('STARTS IN');
    expect(host.textContent).toContain('ONE TRAINING LANE');
    expect(host.textContent).toContain('ALL READY IN');
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

it('StrictMode effect replay keeps local selection usable and never purchases automatically', async () => {
  mocks.get.mockResolvedValue(armyState([]));
  await act(async () => root.render(<StrictMode><TrainTray /></StrictMode>)); await flush();
  const card = host.querySelector('[data-train-troop="bowman"]') as HTMLButtonElement;
  await act(async () => card.click());
  expect(card.dataset.selectedCount).toBe('1'); expect(mocks.post).not.toHaveBeenCalled();
});
