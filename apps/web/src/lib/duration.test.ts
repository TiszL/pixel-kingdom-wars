/**
 * Client duration labels (owner 2026-08-23): the chip must read "6d 2h", not
 * "8796:31". The full fmtDur contract is pinned in @shardkeep/shared; here we
 * pin the client clock and that the client uses the shared definition.
 */
import { describe, expect, it } from 'vitest';
import { fmtDur as sharedFmtDur } from '@shardkeep/shared';
import { fmtClock, fmtDur } from './duration';

describe('fmtDur (client re-export)', () => {
  it('is the shared formatter — one vocabulary across chips, sheets and API copy', () => {
    expect(fmtDur).toBe(sharedFmtDur);
    expect(fmtDur(8_796 * 60 + 31)).toBe('6d 2h');
  });
});

describe('fmtClock', () => {
  it('is a hh:mm:ss clock below a day and falls back to days above it', () => {
    expect(fmtClock(0)).toBe('00:00:00');
    expect(fmtClock(3_661)).toBe('01:01:01');
    expect(fmtClock(86_399)).toBe('23:59:59');
    expect(fmtClock(86_400 + 3_600)).toBe('1d 1h');
    expect(fmtClock(-1)).toBe('00:00:00');
  });
});
