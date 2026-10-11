import { describe, expect, it } from 'vitest';
import { fmtN } from './primitives';

describe('fmtN', () => {
  it('formats exact decimal loot ranges without 32-bit or Number overflow', () => {
    expect(fmtN('12345')).toBe('12,345');
    expect(fmtN('90071992547409931')).toBe('90,071,992,547,409,931');
    expect(fmtN('-0005000')).toBe('-5,000');
  });

  it('truncates ordinary numeric UI values without bitwise wrapping', () => {
    expect(fmtN(4_294_967_296)).toBe('4,294,967,296');
    expect(fmtN(12.9)).toBe('12');
  });
});
