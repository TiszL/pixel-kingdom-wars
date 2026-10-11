import { describe, expect, it } from 'vitest';
import type { PriceUi } from '../types';
import { quotePresentation, quoteTotalLine, wallRowHint, wallUnitPrice } from './quotePresentation';

const price: PriceUi = { currency: 'SHARDS', amount: 'server amount', status: 'OK' };
describe('wall and removal quote presentation', () => {
  it('keeps uncertain orders inert even with an earlier payable quote, per fd63a9ae', () => {
    expect(quotePresentation('VERIFYING', price, null)).toEqual({ kind: 'VERIFYING', sends: false, reason: 'Being checked' });
    expect(quotePresentation('VERIFYING', price, 'Checking the original request').reason).toBe('Checking the original request');
  });
  it('lets empty rows override quote states with the supplied level reason', () => {
    expect(quotePresentation('VERIFYING', price, null, true, 'All walls are LV supplied')).toEqual({ kind: 'OFF', sends: false, reason: 'All walls are LV supplied' });
  });
  it('retains authoritative-refusal retry admission and never treats an unknown price as payable', () => {
    expect(quotePresentation('ERROR', price, 'Authoritative refusal').sends).toBe(true);
    expect(quotePresentation('ERROR', { ...price, amount: null }, null).sends).toBe(false);
  });
  it('formats the count and unit price without calculating the total', () => {
    expect(wallUnitPrice(7, price, { ...price, amount: 'server total' }, false)).toEqual({ ...price, amount: '7 × server amount', description: '7 walls at server amount Shards each' });
  });
  it('masks unknown unit amounts and normalizes blank OK to CHECKING', () => {
    expect(wallUnitPrice(7, { ...price, status: 'CHECKING' }, price, false).amount).toBeNull();
    expect(wallUnitPrice(7, { ...price, amount: ' ' }, price, false).status).toBe('CHECKING');
    expect(wallUnitPrice(7, { ...price, status: 'UNAVAILABLE' }, price, false).status).toBe('UNAVAILABLE');
  });
  it('uses the authoritative total for a short pill and preserves the source price', () => {
    const total = { ...price, amount: 'server total' };
    expect(wallUnitPrice(7, price, total, true)).toEqual({ ...total, status: 'SHORT' });
    expect(total.status).toBe('OK');
  });
  it('renders a zero only through the server-zero price contract', () => {
    expect(quoteTotalLine({ ...price, status: 'SERVER_ZERO', amount: null })).toBe('0 Shards in all');
    expect(quoteTotalLine({ ...price, status: 'CHECKING', amount: 'stale' })).toBe('… Shards in all');
  });
  it('does not promise that walls remain active without the supplied server flag', () => {
    expect(wallRowHint(false)).toBe('Tap a wall in the row to leave it out.');
    expect(wallRowHint(true)).toBe('Tap a wall in the row to leave it out. Walls stay up while they upgrade.');
  });
});
