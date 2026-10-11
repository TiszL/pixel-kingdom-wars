import { expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { custodyRefusal, deedRequiredRefusal, refreshCustodyRefusal } from './phaseERefusals';
it.each([['KEEP_CUSTODY_FROZEN', 'frozen'], ['KEEP_CUSTODY_CLOSING', 'closing']] as const)('maps 423 %s by code so wording changes do not enable a retry', (code, phase) => {
  expect(custodyRefusal(new ApiError(423, 'changed server message', code))).toBe(phase);
});
it.each([new ApiError(423, 'KEEP_CUSTODY_FROZEN'), new ApiError(409, 'locked', 'KEEP_CUSTODY_FROZEN'), new ApiError(423, 'other', 'OTHER'), Error('KEEP_CUSTODY_CLOSING'), null])('ignores non-authoritative custody errors because messages are not codes (%s)', error => {
  expect(custodyRefusal(error)).toBeNull();
});
it.each(['KEEP_EQUIPMENT_MARKET_DEED_REQUIRED', 'DEED_REQUIRED_TO_TRADE'])('maps %s only with its definitive 409 status', code => {
  expect(deedRequiredRefusal(new ApiError(409, 'deed needed', code))).toBe(true);
  expect(deedRequiredRefusal(new ApiError(503, 'outage', code))).toBe(false);
});
it('does not classify ownership changes as a deed requirement or fire a second global handler', () => {
  expect(deedRequiredRefusal(new ApiError(409, 'changed', 'DEED_OWNERSHIP_CHANGED'))).toBe(false);
});
it('a frozen contribution disables its action and refreshes the base once without resubmitting', async () => {
  const disable = vi.fn(), refresh = vi.fn().mockResolvedValue(undefined);
  expect(await refreshCustodyRefusal(new ApiError(423, 'frozen', 'KEEP_CUSTODY_FROZEN'), disable, refresh)).toBe(true);
  expect(disable).toHaveBeenCalledExactlyOnceWith('frozen'); expect(refresh).toHaveBeenCalledOnce();
});
it('a closing withdrawal invalidates its action before refreshing status even when that read fails', async () => {
  const order: string[] = [];
  expect(await refreshCustodyRefusal(new ApiError(423, 'closing', 'KEEP_CUSTODY_CLOSING'), () => order.push('disable'), async () => { order.push('refresh'); throw Error('offline'); })).toBe(true);
  expect(order).toEqual(['disable', 'refresh']);
});
it('an unrelated failure does not refresh or disable a custody action', async () => {
  const disable = vi.fn(), refresh = vi.fn(); expect(await refreshCustodyRefusal(Error('offline'), disable, refresh)).toBe(false);
  expect(disable).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
