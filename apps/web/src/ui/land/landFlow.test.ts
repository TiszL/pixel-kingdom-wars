/**
 * The land screen's stage rule and its two shape-detected outcomes (D-103).
 *
 * WHY: the rail, the parcel card and the analytics all read `landStage`, so a
 * wrong stage would light PAY before the server has frozen a cell (the exact
 * thing the owner forbade: no wallet prompt until the land is visible) or
 * leave PICK lit while SOL is in flight. And `landFlowEvent` is the only way
 * an expired intent or a failed grant reaches telemetry — usePayEntry reports
 * both by state shape, never by callback.
 */
import { describe, expect, it } from 'vitest';
import type { LandReservation } from '../../auth/useEntry';
import { LAND_STAGES, landFlowEvent, landStage } from './landFlow';

const RES: LandReservation = {
  id: 'd1', reference: 'ref', kind: 'entry', baseId: 'b1', earthCell: 4321, amountLamports: 200_000_000,
  countryA3: 'GEO', countryName: 'Georgia',
};

describe('landStage', () => {
  it('separates confirmed payment from minting and a ready deed', () => {
    expect(LAND_STAGES.map((s) => s.id)).toEqual(['pick', 'reserve', 'pay', 'confirmed', 'minting', 'deed']);
    expect(LAND_STAGES[3]!.label).toBe('PAYMENT CONFIRMED');
  });

  it('is PICK with nothing chosen, RESERVE once a globe cell is drafted or the server is freezing one', () => {
    expect(landStage({ phase: 'idle', reservation: null, drafted: false, paymentCredited: false })).toBe('pick');
    expect(landStage({ phase: 'idle', reservation: null, drafted: true, paymentCredited: false })).toBe('reserve');
    expect(landStage({ phase: 'reserving', reservation: null, drafted: false, paymentCredited: false })).toBe('reserve');
  });

  it('is PAY only once the server holds a reservation, and stays PAY through paying, confirming and a failed grant', () => {
    expect(landStage({ phase: 'ready', reservation: RES, drafted: false, paymentCredited: false })).toBe('pay');
    expect(landStage({ phase: 'paying', reservation: RES, drafted: true, paymentCredited: false })).toBe('pay');
    expect(landStage({ phase: 'confirming', reservation: RES, drafted: false, paymentCredited: false })).toBe('pay');
    // Money moved but land was not granted: the player is still AT the money
    // step, with the error under it — not back at PICK as if nothing happened.
    expect(landStage({ phase: 'failed', reservation: RES, drafted: false, paymentCredited: false })).toBe('pay');
  });

  it('never claims a ready deed from payment credit alone', () => {
    expect(landStage({ phase: 'idle', reservation: RES, drafted: false, paymentCredited: true })).toBe('minting');
    expect(landStage({ phase: 'credited', reservation: RES, drafted: false, paymentCredited: true, deedReady: true })).toBe('deed');
  });
});

describe('landFlowEvent', () => {
  it('reports an expiry only for confirming → idle with the reservation cleared and an error', () => {
    expect(landFlowEvent('confirming', { phase: 'idle', reservation: null, error: 'payment intent expired — reserve a cell again' }))
      .toBe('land_expired');
    // A CREDIT also returns to idle but keeps the reservation: not an expiry.
    expect(landFlowEvent('confirming', { phase: 'idle', reservation: RES, error: null })).toBeNull();
  });

  it('reports a failure for confirming → failed', () => {
    expect(landFlowEvent('confirming', { phase: 'failed', reservation: RES, error: 'payment was seen but land could not be granted' }))
      .toBe('land_failed');
  });

  it('ignores every transition that did not start at confirming', () => {
    // A reserve error (idle → idle with an error) is not an expired payment.
    expect(landFlowEvent('idle', { phase: 'idle', reservation: null, error: 'could not reserve land' })).toBeNull();
    expect(landFlowEvent('reserving', { phase: 'idle', reservation: null, error: 'Earth cell is already occupied' })).toBeNull();
    expect(landFlowEvent('paying', { phase: 'ready', reservation: RES, error: 'User rejected the request' })).toBeNull();
  });
});
