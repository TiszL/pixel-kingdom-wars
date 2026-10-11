/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { MarketPurchases } from './marketPurchases';

vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
const wallet = 'buyer';
const purchase = { listingId: 'listing-original', itemId: 'marchers_greaves', reference: 'original-reference', priceLamports: '30000000000', buyerBaseId: 'original-base' };
let host: HTMLDivElement; let root: Root; let sold: boolean;
const afterFinish = vi.fn();
async function render(): Promise<void> {
  await act(async () => root.render(<MarketPurchases wallet={wallet} itemName={() => 'Marcher’s Greaves'} afterFinish={afterFinish} />));
}
async function check(): Promise<void> {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'CHECK ORIGINAL PAYMENT');
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useApp.getState().setAuth(wallet, true);
  sold = false; afterFinish.mockReset();
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/market/purchases/pending')) return { purchases: sold ? [] : [purchase], next: null };
    if (url === '/market/trades') return { trades: sold ? [{ ...purchase, role: 'bought', txSignature: 'original-signature', settledAt: null }] : [], hasMore: false };
    throw new Error(url);
  });
  vi.spyOn(api, 'postRaw').mockResolvedValue({ settled: false });
  vi.spyOn(api, 'post').mockRejectedValue(new Error('No reserve, sign or legacy payment request is allowed in recovery'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });

it('discovers a lost legacy purchase on reload using reads only, then checks its exact original reference', async () => {
  await render(); expect(host.textContent).toContain('30 SOL'); expect(host.textContent).toContain('original-base');
  expect(api.postRaw).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(api.postRaw).not.toHaveBeenCalled(); await check();
  expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/market/purchases/listing-original/check', { reference: 'original-reference' });
  expect(api.post).not.toHaveBeenCalled(); expect(host.textContent).toContain('not finalized yet');
});

it('retains a lost-response purchase for explicit retry and refreshes history after idempotent settlement', async () => {
  vi.mocked(api.postRaw).mockRejectedValueOnce(new Error('Response lost'));
  await render(); await check(); expect(host.textContent).toContain('Response lost');
  expect(host.textContent).toContain('CHECK ORIGINAL PAYMENT');
  await act(async () => root.unmount()); root = createRoot(host); await render();
  vi.mocked(api.postRaw).mockImplementationOnce(async () => { sold = true; return { settled: true }; });
  await check(); expect(api.postRaw).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.postRaw).mock.calls[1]).toEqual(vi.mocked(api.postRaw).mock.calls[0]);
  expect(host.textContent).toContain('original receiving inventory'); expect(host.textContent).toContain('BOUGHT');
  expect(afterFinish).toHaveBeenCalledOnce(); expect(api.post).not.toHaveBeenCalled();
});

it('does not let a retained component check under a changed wallet', async () => {
  await render(); await act(async () => useApp.getState().setAuth('another-buyer', true));
  await check(); expect(api.postRaw).not.toHaveBeenCalled();
});
