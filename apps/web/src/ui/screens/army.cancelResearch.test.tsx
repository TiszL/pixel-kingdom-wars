/** @vitest-environment happy-dom */
/**
 * Cancelling the running research from the Forge tray (tester request
 * 2026-09-04). Unlike the tap-tap-tap troop −1 (D-096) this throws away a
 * running hours-long timer, so a confirmation stands between the tap and the
 * POST. These pin: the control exists only where the server says the research
 * is refundable (a pre-update row says why instead), KEEP GOING posts
 * nothing, the quoted refund is the server's `refundShards`, and CONFIRM
 * posts exactly one troop-pinned cancel then toasts the server's refund.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { ResearchTray } from './army';

let host: HTMLDivElement;
let root: Root;
let toasts: string[];
let offToast: () => void;

const REFUND = '400';
const armyState = (research: Array<Record<string, unknown>>) => ({
  counts: {}, levels: { giant: 1 }, research, queue: [],
  rosterPts: 0, campCapacityPts: 200, barracksQueuePts: 200,
  eliteUnlocks: {}, features: {},
});
const running = (extra: Record<string, unknown>) => ({
  troop: 'giant', toLevel: 2, finishesAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra,
});
const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
};
const dialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]');
const buttons = (scope: ParentNode): HTMLButtonElement[] => [...scope.querySelectorAll('button')];
const cancelControl = (): HTMLButtonElement | undefined =>
  buttons(host).find((b) => b.textContent?.includes('✕ CANCEL'));
function dialogBtn(label: string): HTMLButtonElement {
  const found = buttons(dialog()!).find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no ${label} button in the cancel confirmation`);
  return found;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue({ refundShards: REFUND });
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

describe('Forge ✕ CANCEL on the running research (tester request 2026-09-04)', () => {
  it('offers the control only where the server says the research is refundable', async () => {
    mocks.get.mockResolvedValue(armyState([running({ canCancel: false, refundShards: null })]));
    await act(async () => root.render(<ResearchTray />)); await flush();
    expect(cancelControl()).toBeUndefined();
    expect(host.textContent).toContain('PRE-UPDATE RESEARCH FINISHES NORMALLY');
    expect(buttons(host).some((b) => b.textContent?.includes('FINISH ·'))).toBe(true); // FINISH stays
  });

  it('asks first with the server refund, and KEEP GOING posts nothing', async () => {
    mocks.get.mockResolvedValue(armyState([running({ canCancel: true, refundShards: REFUND })]));
    await act(async () => root.render(<ResearchTray />)); await flush();
    expect(cancelControl()!.textContent).toContain(`+${REFUND}`);

    await act(async () => cancelControl()!.click());
    expect(mocks.post).not.toHaveBeenCalled();
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('CANCEL RESEARCH?');
    expect(text).toContain('L1→L2');
    expect(text).toContain(`+${REFUND}`);

    await act(async () => dialogBtn('KEEP GOING').click());
    expect(dialog()).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('CONFIRM posts exactly one troop-pinned cancel and toasts the refund the server returned', async () => {
    mocks.get.mockResolvedValue(armyState([running({ canCancel: true, refundShards: REFUND })]));
    await act(async () => root.render(<ResearchTray />)); await flush();
    await act(async () => cancelControl()!.click());
    await act(async () => dialogBtn('CANCEL RESEARCH ·').click());
    await flush();
    expect(dialog()).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/army/research/giant/cancel', {});
    expect(toasts).toEqual([`GIANT RESEARCH CANCELLED · +${REFUND} SHARDS`]);
    expect(mocks.get.mock.calls.length).toBeGreaterThan(1); // the lane is re-read from the server
  });

  it('a refused cancel says why and changes nothing', async () => {
    mocks.get.mockResolvedValue(armyState([running({ canCancel: true, refundShards: REFUND })]));
    mocks.post.mockRejectedValue(new Error('research already finished or was cancelled'));
    await act(async () => root.render(<ResearchTray />)); await flush();
    await act(async () => cancelControl()!.click());
    await act(async () => dialogBtn('CANCEL RESEARCH ·').click());
    await flush();
    expect(toasts).toEqual(['research already finished or was cancelled']);
  });
});
