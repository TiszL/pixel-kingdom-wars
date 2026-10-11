/**
 * Duration labels (owner 2026-08-23): a six-day upgrade must read "6d 2h", not
 * "8796:31" — players cannot reason about thousands of minutes. The two most
 * significant units carry the meaning; seconds only matter under an hour. The
 * API error copy and every client surface share this one definition.
 */
import { describe, expect, it } from 'vitest';
import { fmtDur } from './duration';

describe('fmtDur', () => {
  it('shows days + hours for multi-day upgrades (the 8796:31 chip)', () => {
    expect(fmtDur(8_796 * 60 + 31)).toBe('6d 2h');
    expect(fmtDur(5 * 86_400)).toBe('5d');
    expect(fmtDur(14 * 86_400)).toBe('14d');
    expect(fmtDur(86_400)).toBe('1d');
    expect(fmtDur(86_399)).toBe('23h 59m');
  });
  it('shows hours + minutes under a day, minutes + seconds under an hour', () => {
    expect(fmtDur(2 * 3_600 + 36 * 60 + 5)).toBe('2h 36m');
    expect(fmtDur(3_600)).toBe('1h');
    expect(fmtDur(3_599)).toBe('59m 59s');
    expect(fmtDur(36 * 60)).toBe('36m');
    expect(fmtDur(45)).toBe('45s');
    expect(fmtDur(0)).toBe('0s');
  });
  it('never renders negative, fractional or NaN input', () => {
    expect(fmtDur(-5)).toBe('0s');
    expect(fmtDur(61.9)).toBe('1m 1s');
    expect(fmtDur(Number.NaN)).toBe('0s');
  });
});
