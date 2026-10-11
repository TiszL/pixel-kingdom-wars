/** @vitest-environment happy-dom */
/**
 * The saved-purchase line must report the SERVER outcome (tester report
 * 24b9184d, 2026-09-16): a buyer whose wallet approval never produced a
 * signature was told to "check the original payment" for hours after the
 * reservation ended. An absent browser signature is not proof of nonpayment. The receipt's terminal
 * state, not the local attempt flag, decides what the buyer reads — and a
 * saved signature on a dead generation is routed to support, never re-paid.
 */
import { describe, expect, it } from 'vitest';
import { purchase, receipt } from '../../lib/market/fixtures.test-support';
import type { MarketPurchase } from '../../lib/market/journal';
import { purchaseNotice } from './marketRecovery';

const ended = (state: 'superseded' | 'cancelled', extra: Partial<MarketPurchase> = {}): MarketPurchase => ({
  ...purchase(), ...extra,
  receipt: { ...receipt(), state, payable: false, resolvedAt: '2026-09-16T05:21:32.942Z' },
});

describe('saved purchase notice', () => {
  it('does not claim an absent browser signature proves nonpayment when a reservation ended', () => {
    const text = purchaseNotice(ended('superseded', { attempted: true }));
    expect(text).toContain('released at 2026-09-16T05:21:32.942Z');
    expect(text).toContain('does not prove no payment was made');
    expect(text).not.toContain('no SOL left');
    expect(text).toContain('check your wallet history before making a new purchase');
    expect(text).not.toContain('Check this original payment');
  });
  it('routes a saved signature on a dead generation to support instead of a pending check', () => {
    const text = purchaseNotice(ended('cancelled', { attempted: true, signature: '2'.repeat(88) }));
    expect(text).toContain('was cancelled at 2026-09-16T05:21:32.942Z');
    expect(text).toContain('support@pixelkingdomwars.com');
    expect(text).toContain('before sending anything again');
  });
  it('states a never-attempted terminal reservation plainly', () => {
    expect(purchaseNotice(ended('superseded'))).toBe('This reservation was released at 2026-09-16T05:21:32.942Z and can no longer deliver the item. No wallet approval was recorded in this browser.');
  });
  it('keeps the uncertainty wording only while the server still holds the generation', () => {
    expect(purchaseNotice({ ...purchase(), attempted: true })).toContain('Check this original payment');
    expect(purchaseNotice({ ...purchase(), attempted: true, receipt: { ...receipt(), state: 'committed', payable: false, paymentSignature: '2'.repeat(88) } })).toContain('Check this original payment');
  });
});
