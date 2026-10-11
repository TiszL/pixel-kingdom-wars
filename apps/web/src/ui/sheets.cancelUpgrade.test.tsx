/** @vitest-environment happy-dom */
/**
 * Cancelling a running building upgrade from the building sheet (tester
 * request 2026-09-04: "a cancel option could free the builder … refund …
 * show a confirmation before cancelling to prevent mistakes"). These pin the
 * seams that would quietly bend the money path or bring the accident back:
 * the control exists ONLY where the server says the job is refundable (a
 * pre-update job or a SOL-priced step carries no button), a confirmation
 * stands between the tap and the POST, KEEP GOING posts nothing, the quoted
 * refund is the server's `refundShards` verbatim, and CONFIRM posts exactly
 * one exact-id cancel then toasts the refund the server returned.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../lib/events';
import { useApp } from '../state/store';

const mocks = vi.hoisted(() => ({ post: vi.fn(), reload: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: mocks.post },
  idemKey: () => 'test-intent-key',
  // The sheet's error path asks whether the global land-gate handler already
  // owns the refusal; a cancel refusal is never that.
  isLandNotOwned: () => false,
}));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: mocks.reload, reloadCurrentBaseSnapshot: mocks.reload }));
vi.mock('../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));
vi.mock('../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));
import { ActionSheet } from './sheets';

let host: HTMLDivElement;
let root: Root;
let toasts: string[];
let offToast: () => void;

const REFUND = '49';
const jobBase = (job: Record<string, unknown>) => ({
  player: {
    wallet: 'wallet', name: 'Keeper', keepLevel: 10, trophies: 0,
    league: 'Bronze', builders: 1, expansions: 0,
  },
  claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
  buildings: [{ id: 'vault-1', type: 'vault', level: 3, tx: 10, ty: 10, underConstruction: false }],
  obstacles: [], army: [], heroes: [], freeBuilders: 0,
  jobs: [{
    id: 'job-1', kind: 'upgrade', buildingId: 'vault-1', obstacleId: null,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    finishesAt: new Date(Date.now() + 85_000).toISOString(),
    ...job,
  }],
});

const dialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]');
const buttons = (scope: ParentNode): HTMLButtonElement[] => [...scope.querySelectorAll('button')];
const cancelControl = (): HTMLButtonElement | undefined =>
  buttons(host).find((b) => b.textContent?.includes('✕ CANCEL'));
function dialogBtn(label: string): HTMLButtonElement {
  const found = buttons(dialog()!).find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no ${label} button in the cancel confirmation`);
  return found;
}
async function renderSheet(job: Record<string, unknown>): Promise<void> {
  useApp.setState({
    screen: 'base', selectedBuildingId: 'vault-1', selectedBaseId: null,
    base: jobBase(job) as never,
  });
  await act(async () => root.render(<ActionSheet />));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.post.mockReset().mockResolvedValue({ refundShards: REFUND });
  mocks.reload.mockReset().mockResolvedValue(true);
  toasts = [];
  offToast = bus.on('ui:toast', ({ msg }) => { toasts.push(msg); });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  offToast();
  await act(async () => root.unmount());
  host.remove();
  useApp.setState({ base: null, selectedBuildingId: null, selectedBaseId: null, screen: 'base' });
});

describe('✕ CANCEL on a running upgrade (tester request 2026-09-04)', () => {
  it('shows the control only when the server says the job is refundable', async () => {
    await renderSheet({ canCancel: false, refundShards: null }); // SOL-priced or pre-update
    expect(cancelControl()).toBeUndefined();
    // Paid Finish remains separate from refund eligibility, but now requires
    // the server-priced payment review introduced in M41. This isolated cancel
    // fixture has no payment provider, so it must never regain a direct POST.
    const finish = buttons(host).find((b) => b.textContent?.includes('REVIEW FINISH PAYMENT'));
    expect(finish).toBeDefined();
    expect(finish!.disabled).toBe(true);
    await act(async () => finish!.click());
    expect(mocks.post).not.toHaveBeenCalled();

    await renderSheet({}); // an older API cut without the verdict: nothing to offer
    expect(cancelControl()).toBeUndefined();

    await renderSheet({ kind: 'build', canCancel: false, refundShards: null });
    expect(cancelControl()).toBeUndefined();

    await renderSheet({ canCancel: true, refundShards: REFUND });
    expect(cancelControl()).toBeDefined();
  });

  it('asks first, quotes the server refund, and KEEP GOING posts nothing', async () => {
    await renderSheet({ canCancel: true, refundShards: REFUND });
    await act(async () => cancelControl()!.click());
    expect(mocks.post).not.toHaveBeenCalled();
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('CANCEL UPGRADE?');
    expect(text).toContain('LEVEL 3→4');
    // The number is the server's own receipt, never a client cost lookup.
    expect(text).toContain(`+${REFUND}`);

    await act(async () => dialogBtn('KEEP GOING').click());
    expect(dialog()).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it('CONFIRM posts exactly one exact-id cancel, then toasts the refund the server returned', async () => {
    await renderSheet({ canCancel: true, refundShards: REFUND });
    await act(async () => cancelControl()!.click());
    await act(async () => dialogBtn('CANCEL UPGRADE ·').click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dialog()).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/base/jobs/job-1/cancel', {});
    expect(toasts).toEqual([`UPGRADE CANCELLED · +${REFUND} SHARDS`]);
    // The base is re-read from the server: the freed builder and the unchanged
    // level are the authoritative state, not a client guess.
    expect(mocks.reload).toHaveBeenCalled();
  });

  it('a refused cancel keeps the job on screen and says why', async () => {
    mocks.post.mockRejectedValue(new Error('SOL-paid upgrades cannot be cancelled; it will finish normally'));
    await renderSheet({ canCancel: true, refundShards: REFUND });
    await act(async () => cancelControl()!.click());
    await act(async () => dialogBtn('CANCEL UPGRADE ·').click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(toasts).toEqual([]);
    expect(host.textContent).toContain('SOL-paid upgrades cannot be cancelled');
    expect(cancelControl()).toBeDefined();
  });
});
