/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReferralFromUrl, clearStoredReferralCode, readStoredReferralCode } from './referral';

afterEach(() => { vi.restoreAllMocks(); clearStoredReferralCode(); });
describe('referral capture before authentication', () => {
  it('preserves attribution in memory and removes the share parameter when storage is unavailable', () => {
    history.replaceState(null, '', '/?ref=keep-cqrpf&other=1');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    captureReferralFromUrl();
    expect(readStoredReferralCode()).toBe('KEEP-CQRPF');
    expect(new URL(location.href).search).toBe('?other=1');
  });
  it('only clears the code belonging to the completed attribution', () => {
    history.replaceState(null, '', '/?ref=KEEP-ABCDE'); captureReferralFromUrl();
    clearStoredReferralCode('KEEP-CQRPF'); expect(readStoredReferralCode()).toBe('KEEP-ABCDE');
    clearStoredReferralCode('KEEP-ABCDE'); expect(readStoredReferralCode()).toBeNull();
  });
});
