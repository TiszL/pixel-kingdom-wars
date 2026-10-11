import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { readPassportCurrent, readPassportExpeditions, readPassportInclusions } from './transport';
import { current, deferred, expeditions, id, inclusions, otherWallet, unavailable, wallet } from './fixtures.test-support';
const input = () => ({ wallet, isCurrent: () => true });
beforeEach(() => { vi.spyOn(api, 'getPrivate'); });
afterEach(() => vi.restoreAllMocks());
it('uses private authenticated GETs without caller wallet or authority parameters', async () => {
  vi.mocked(api.getPrivate).mockResolvedValueOnce(expeditions()).mockResolvedValueOnce(inclusions(['2'])).mockResolvedValueOnce(current());
  await readPassportExpeditions(input(), { kind: 'starter' });
  await readPassportInclusions(input(), { cursor: '1' }); await readPassportCurrent(input());
  expect(vi.mocked(api.getPrivate).mock.calls.map(([path]) => path)).toEqual(['/realm-passport/expeditions?kind=starter', '/realm-passport/mining/inclusions?cursor=1', '/realm-passport/mining/current']);
});
it('rejects foreign actors, extra response authority and mismatched filters through strict shared schemas', async () => {
  for (const value of [{ ...expeditions(), wallet: otherWallet }, { ...expeditions(), eligibilityAuthorized: true }, expeditions('advanced')]) {
    vi.mocked(api.getPrivate).mockResolvedValue(value);
    await expect(readPassportExpeditions(input(), { kind: 'starter' })).rejects.toThrow();
  }
  vi.mocked(api.getPrivate).mockResolvedValue({ ...current(), signingAuthorized: true });
  await expect(readPassportCurrent(input())).rejects.toThrow();
});
it('rejects repeated, reversed and falsely advanced expedition cursors', async () => {
  for (const value of [expeditions('starter', [1]), expeditions('starter', [3, 2]), expeditions('starter', [2], id(9)), expeditions('starter', [], id(2))]) {
    vi.mocked(api.getPrivate).mockResolvedValue(value);
    await expect(readPassportExpeditions(input(), { kind: 'starter', cursor: id(1) })).rejects.toThrow();
  }
});
it('rejects repeated mining pages and foreign leaves even when the outer wallet matches', async () => {
  const foreign = inclusions(['2']); if (foreign.state === 'available') foreign.data.rows[0]!.leaf.wallet = otherWallet;
  for (const value of [inclusions(['1']), inclusions(['3', '2']), inclusions(['2'], '3'), foreign]) {
    vi.mocked(api.getPrivate).mockResolvedValue(value);
    await expect(readPassportInclusions(input(), { cursor: '1' })).rejects.toThrow();
  }
});
it('rejects unknown query keys before transport rather than accepting caller authority', async () => {
  await expect(readPassportExpeditions(input(), { kind: 'starter', wallet: otherWallet } as never)).rejects.toThrow();
  await expect(readPassportInclusions(input(), { cursor: '01' })).rejects.toThrow();
  expect(api.getPrivate).not.toHaveBeenCalled();
});
it('keeps unavailable distinct from an empty history and discards late session responses', async () => {
  vi.mocked(api.getPrivate).mockResolvedValue(unavailable);
  expect(await readPassportExpeditions(input(), { kind: 'starter' })).toEqual(unavailable);
  const pending = deferred<unknown>(); let active = true;
  vi.mocked(api.getPrivate).mockReturnValue(pending.promise);
  const request = readPassportCurrent({ wallet, isCurrent: () => active });
  active = false; pending.resolve(current()); await expect(request).rejects.toThrow('Sign-in changed');
});
