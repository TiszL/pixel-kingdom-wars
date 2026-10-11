import { describe, expect, it } from 'vitest';
import { assertGemsBuyAdmissionFresh, parseGemsBuyAdmission, parseGemsBuyDeposit, parseGemsBuyQuote, parseGemsBuyRecovery } from './contracts';
import { address, admission, binding, credited, disclosure, policy, quote, recovery, request, response, signature } from './fixtures.test-support';

describe('wallet Gems frozen contracts', () => {
  it('binds every payment term to original wallet/key/body, configured mint and canonical source ATA', () => {
    expect(parseGemsBuyQuote(quote(), request, binding)).toEqual(quote());
    for (const wrong of [{ wallet: address(40) }, { source: address(41) }, { mint: address(42) }, { decimals: 7 },
      { keepIn: 11 }, { gemsOut: 11 }, { idempotencyKey: 'other-key' }, { reference: quote().destination },
      { destination: quote().source }, { extra: true }, { expiresAt: '2026-02-30T10:00:00.000Z' }]) {
      expect(() => parseGemsBuyQuote({ ...quote(), ...wrong }, request, binding)).toThrow();
    }
    expect(() => parseGemsBuyQuote({ ...quote(), decimals: 19 }, request, { ...binding, decimals: 19 })).toThrow();
  });
  it('fresh signing admission requires current target/bounds and subtracts request round-trip time from the server TTL', () => {
    let time = 500; const now = () => time;
    const approved = parseGemsBuyAdmission(response(), request, binding, policy, { requestStartedAt: 100, requestStartedWall: 100, now, wall: now });
    time = 60099; expect(() => assertGemsBuyAdmissionFresh(approved)).not.toThrow();
    time = 60100; expect(() => assertGemsBuyAdmissionFresh(approved)).toThrow('no longer payable');
    for (const wrong of [{ destinationAta: address(40) }, { maxConvertKeepPerTx: 9 }, { minConvertKeep: 11 }]) {
      expect(() => parseGemsBuyAdmission(response(), request, binding, { ...policy, ...wrong }, { requestStartedAt: 0, requestStartedWall: 0, now: () => 0, wall: () => 0 })).toThrow();
    }
    expect(() => parseGemsBuyAdmission({ ...response(), status: 'credited' }, request, binding, policy, { requestStartedAt: 0, requestStartedWall: 0, now: () => 0, wall: () => 0 })).toThrow();
    expect(() => parseGemsBuyAdmission(response(), request, binding, policy, { requestStartedAt: 0, requestStartedWall: 0, now: () => 60000, wall: () => 0 })).toThrow();
  });
  it('historical and serialized responses never retain runtime permission to sign', () => {
    const historical = parseGemsBuyRecovery(recovery(), request, binding);
    expect(historical.recoveryOnly).toBe(true);
    expect(() => assertGemsBuyAdmissionFresh(historical as never)).toThrow();
    expect(() => assertGemsBuyAdmissionFresh(JSON.parse(JSON.stringify(admission())))).toThrow();
    expect(Object.isFrozen(admission().quote)).toBe(true);
  });
  it('OS sleep with a paused monotonic clock expires consent and either clock moving backward fails closed', () => {
    let elapsed = 100, wall = 100;
    const fresh = () => parseGemsBuyAdmission(response(), request, binding, policy,
      { requestStartedAt: 0, requestStartedWall: 0, now: () => elapsed, wall: () => wall });
    const sleeping = fresh(); wall = 60000;
    expect(() => assertGemsBuyAdmissionFresh(sleeping)).toThrow('no longer payable');
    wall = 100;
    const backwards = fresh(); elapsed = 99;
    expect(() => assertGemsBuyAdmissionFresh(backwards)).toThrow('no longer payable');
    elapsed = 100; const wallBackwards = fresh(); wall = 99;
    expect(() => assertGemsBuyAdmissionFresh(wallBackwards)).toThrow('no longer payable');
  });
  it('recovers a lost quote while paused and refuses changed frozen evidence or another key/account', () => {
    expect(parseGemsBuyRecovery(recovery(), request, binding).status).toBe('known');
    const unknown = { ...recovery(), status: 'unknown', deposit: null };
    expect(parseGemsBuyRecovery(unknown, request, binding).status).toBe('unknown');
    for (const wrong of [{ wallet: address(40) }, { idempotencyKey: 'other-key' }, { recoveryOnly: false }, { version: 2 }, { extra: true }]) {
      expect(() => parseGemsBuyRecovery({ ...recovery(), ...wrong }, request, binding)).toThrow();
    }
    expect(() => parseGemsBuyRecovery(recovery(), request, binding, { ...quote(), destination: address(40) })).toThrow();
  });
  it('proves observed whole overpayment and dust separately from quote; candidate signature can differ from the credited transfer', () => {
    const d = credited();
    const result = parseGemsBuyRecovery({ ...recovery(), deposit: { ...d, originalIntent: quote() } }, request, binding);
    expect(result.status === 'known' && result.deposit.keepCredited).toBe('12');
    expect(result.status === 'known' && result.deposit.dustBaseUnits).toBe('7');
    expect(result.status === 'known' && result.deposit.paymentSignature).not.toBe(d.txSignature);
    expect(parseGemsBuyDeposit({ id: quote().id, kind: 'gems_buy', reference: quote().reference, ...d }, quote()).receipt?.funding.amount).toBe('12');
  });
  it('rejects inconsistent paid ledger proof rather than substituting quoted Gems for actual credit', () => {
    const d = credited();
    for (const wrong of [{ amount: '10000000' }, { dustBaseUnits: '0' }, { keepCredited: '10' }, { gemsCredited: '10' },
      { txSignature: signature(3) }, { finalizedAt: null }, { receipt: null }, { receipt: { ...d.receipt, wallet: address(40) } },
      { receipt: { ...d.receipt, funding: { ...d.receipt.funding, currency: 'GEMS' } } },
      { receipt: { ...d.receipt, result: { ...d.receipt.result, rate: 2 } } }]) {
      expect(() => parseGemsBuyRecovery({ ...recovery(), deposit: { ...d, ...wrong, originalIntent: quote() } }, request, binding)).toThrow();
    }
  });
  it('retains sub-whole failed payments as paid evidence without fabricating a receipt or refund', () => {
    const d = { ...disclosure(), status: 'failed', amount: '7', dustBaseUnits: '7', txSignature: signature(1), finalizedAt: disclosure().createdAt };
    expect(parseGemsBuyRecovery({ ...recovery(), deposit: { ...d, originalIntent: quote() } }, request, binding).status).toBe('known');
    expect(() => parseGemsBuyRecovery({ ...recovery(), deposit: { ...d, receipt: credited().receipt, originalIntent: quote() } }, request, binding)).toThrow();
  });
});
