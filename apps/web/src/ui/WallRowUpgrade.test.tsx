/** @vitest-environment happy-dom */
import type { WallRowUpgradeQuote } from '@shardkeep/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { reloadBase } from '../state/baseSnapshot';
import { useApp } from '../state/store';
import { WallRowUpgrade } from './WallRowUpgrade';
vi.mock('../state/baseSnapshot', () => ({ reloadBase: vi.fn() }));
let root: Root; let host: HTMLDivElement;
const quote = (quoteId = 'quote-one', canAfford = true): WallRowUpgradeQuote => ({
  baseId: 'base-a', selectedWallId: 'wall', quoteId, keepLevel: 5,
  walls: [
    { id: 'wall', tx: 1, ty: 1, level: 1, targetLevel: 2, costShards: 20, excluded: null },
    { id: 'max', tx: 2, ty: 1, level: 20, targetLevel: null, costShards: 0, excluded: 'max_level' },
  ], totalCostShards: 20, balanceShards: canAfford ? '100' : '10', canAfford,
});
const button = (text: string): HTMLButtonElement => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button absent: ${text}`); return btn;
};
const click = async (text: string) => { await act(async () => button(text).click()); };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.getState().setAuth('wallet-a'); useApp.getState().setSelectedBaseId('base-a');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(reloadBase).mockReset().mockResolvedValue();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); useApp.getState().setAuth(null); });
async function open() { await act(async () => root.render(<WallRowUpgrade wallId="wall" />)); await click('UPGRADE ROW'); }
describe('whole-row purchase confirmation', () => {
  it('keeps busy walls at different levels separate so each excluded group shows its actual tier', async () => {
    const preview = quote();
    preview.walls.push(
      { id: 'busy-timber', tx: 3, ty: 1, level: 1, targetLevel: null, costShards: 0, excluded: 'busy' },
      { id: 'busy-shard', tx: 4, ty: 1, level: 17, targetLevel: null, costShards: 0, excluded: 'busy' },
    );
    const post = vi.spyOn(api, 'postRaw').mockResolvedValueOnce(preview);
    await open();
    expect(document.body.textContent).toContain('1 × LEVEL 1 · BUSY — UNCHANGED');
    expect(document.body.textContent).toContain('1 × LEVEL 17 · BUSY — UNCHANGED');
    expect(document.body.textContent).toContain('1 OF 4 WALLS');
    expect(document.body.textContent).toContain('TOTAL 20 SHARDS');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('shows excluded walls and total before any charge; submits only the exact quoted purchase', async () => {
    const post = vi.spyOn(api, 'postRaw').mockResolvedValueOnce(quote()).mockResolvedValueOnce({});
    await open();
    expect(post).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('1 OF 2 WALLS');
    expect(document.body.textContent).toContain('MAXED — UNCHANGED');
    expect(document.body.textContent).toContain('TOTAL 20 SHARDS');
    await click('UPGRADE 1 WALLS');
    expect(post).toHaveBeenNthCalledWith(2, '/base/walls/wall/upgrade-row', {
      baseId: 'base-a', quoteId: 'quote-one', idempotencyKey: expect.any(String),
    });
    expect(reloadBase).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it('retries a lost response with exactly the same durable key, then refreshes selection once', async () => {
    const post = vi.spyOn(api, 'postRaw').mockResolvedValueOnce(quote())
      .mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ duplicate: true });
    await open(); await click('UPGRADE 1 WALLS'); await click('RETRY SAME UPGRADE');
    expect(post.mock.calls[2]).toEqual(post.mock.calls[1]);
    expect(reloadBase).toHaveBeenCalledOnce();
  });
  it('requires another explicit confirmation after eligibility changes and never silently purchases a partial row', async () => {
    const next = { ...quote('quote-two'), totalCostShards: 30 };
    const post = vi.spyOn(api, 'postRaw').mockResolvedValueOnce(quote())
      .mockRejectedValueOnce(new ApiError(409, 'Review updated row', 'WALL_ROW_QUOTE_CHANGED', { quote: next }))
      .mockResolvedValueOnce({});
    await open(); await click('UPGRADE 1 WALLS');
    expect(post).toHaveBeenCalledTimes(2); expect(document.body.textContent).toContain('TOTAL 30 SHARDS');
    await click('UPGRADE 1 WALLS');
    expect(post.mock.calls[2]?.[1]).toMatchObject({ quoteId: 'quote-two' });
    expect(post.mock.calls[2]?.[1]).not.toMatchObject({ idempotencyKey: (post.mock.calls[1]?.[1] as { idempotencyKey: string }).idempotencyKey });
  });
  it('does not enable a smaller purchase when the whole quote is unaffordable', async () => {
    const post = vi.spyOn(api, 'postRaw').mockResolvedValueOnce(quote('quote-one', false));
    await open(); expect(button('UPGRADE 1 WALLS').disabled).toBe(true);
    await click('UPGRADE 1 WALLS'); expect(post).toHaveBeenCalledTimes(1);
  });
  it('ignores a completed purchase response after wallet/base switch instead of refreshing another base', async () => {
    let done!: (value: unknown) => void;
    const post = vi.spyOn(api, 'postRaw').mockResolvedValueOnce(quote())
      .mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
    await open(); await click('UPGRADE 1 WALLS');
    await act(async () => { useApp.getState().setAuth('wallet-b'); done({}); });
    expect(post).toHaveBeenCalledTimes(2); expect(reloadBase).not.toHaveBeenCalled();
  });
});
