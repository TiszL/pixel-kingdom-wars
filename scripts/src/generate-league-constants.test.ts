import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';
import {
  LEAGUE_CONSTANTS_FILE,
  generateLeagueConstants,
  type LeagueConstantsInput,
} from './generate-league-constants';

// G01: these tests require Cedar3 to compose the accepted M1 rewards/window
// inputs first. They deliberately do not substitute a private policy fixture.
function sharedInput(): LeagueConstantsInput {
  const skr = PHASE_E_LEAGUE_REWARDS.v1.skr;
  return {
    maxPlaces: skr.maxPlaces,
    claimWindowSec: skr.claimWindowSec,
    claimWindowMaxSec: skr.claimWindowMaxSec,
    settlementDelayMs: LEAGUES.settlementDelayMs,
  };
}

function changed(field: keyof LeagueConstantsInput, value: unknown): LeagueConstantsInput {
  return { ...sharedInput(), [field]: value } as LeagueConstantsInput;
}

describe('league constants projection / G01', () => {
  it('matches the checked-in Rust projection byte for byte', async () => {
    expect(await readFile(LEAGUE_CONSTANTS_FILE, 'utf8')).toBe(generateLeagueConstants());
  });

  it('projects precisely the accepted shared policy and a mechanical bitmap size', () => {
    const input = sharedInput();
    const rows = generateLeagueConstants().split('\n').filter((line) => line.startsWith('pub const '));
    expect(rows).toEqual([
      `pub const LEAGUE_SKR_MAX_PLACES: u16 = ${input.maxPlaces};`,
      `pub const LEAGUE_BITMAP_BYTES: usize = ${Math.ceil(input.maxPlaces / 8)};`,
      `pub const LEAGUE_SETTLEMENT_DELAY_SEC: i64 = ${input.settlementDelayMs / 1_000};`,
      `pub const LEAGUE_CLAIM_WINDOW_SEC: i64 = ${input.claimWindowSec};`,
      `pub const LEAGUE_CLAIM_WINDOW_MAX_SEC: i64 = ${input.claimWindowMaxSec};`,
    ]);
    // Week/Monday alignment, hash domains, and proof depth are local protocol
    // constants. This generator must never invent a shared source for them.
    expect(generateLeagueConstants()).not.toMatch(/pub const (?:LEAGUE_WEEK_SEC|MONDAY_OFFSET_SEC|.*DOMAIN.*|.*PROOF_DEPTH.*)/);
  });

  const fields = [
    ['maxPlaces', 'LEAGUE_SKR_MAX_PLACES'],
    ['claimWindowSec', 'LEAGUE_CLAIM_WINDOW_SEC'],
    ['claimWindowMaxSec', 'LEAGUE_CLAIM_WINDOW_MAX_SEC'],
    ['settlementDelayMs', 'LEAGUE_SETTLEMENT_DELAY_MS'],
  ] as const;

  for (const [field, constant] of fields) {
    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, undefined, null, '1', 1n])(
      `rejects an invalid ${field}: %s instead of emitting a Rust policy`,
      (value) => {
        expect(() => generateLeagueConstants(changed(field, value)))
          .toThrow(`Invalid shared positive integer for ${constant}`);
      },
    );
  }

  it('fails closed when the supplied policy object is missing', () => {
    expect(() => generateLeagueConstants(null as unknown as LeagueConstantsInput))
      .toThrow('Invalid league constants input');
    expect(() => generateLeagueConstants({} as LeagueConstantsInput))
      .toThrow('Invalid shared positive integer for LEAGUE_SKR_MAX_PLACES');
  });

  it('rejects maxPlaces outside u16 before rendering any output', () => {
    expect(() => generateLeagueConstants(changed('maxPlaces', 0x1_0000)))
      .toThrow('League maximum places exceeds u16');
  });

  it('refuses a tree requiring more than the local depth-ten proof limit', () => {
    expect(() => generateLeagueConstants(changed('maxPlaces', (2 ** 10) + 1)))
      .toThrow('League maximum places exceeds the supported proof depth');
  });

  it('accepts the depth-ten capacity boundary and derives its bitmap', () => {
    const output = generateLeagueConstants(changed('maxPlaces', 2 ** 10));
    expect(output).toContain('pub const LEAGUE_SKR_MAX_PLACES: u16 = 1024;\n');
    expect(output).toContain('pub const LEAGUE_BITMAP_BYTES: usize = 128;\n');
  });

  it.each([1, 7, 8, 9])('derives ceil(maxPlaces / 8) at the %s-place boundary', (maxPlaces) => {
    expect(generateLeagueConstants(changed('maxPlaces', maxPlaces)))
      .toContain(`pub const LEAGUE_BITMAP_BYTES: usize = ${Math.ceil(maxPlaces / 8)};\n`);
  });

  it('refuses millisecond truncation', () => {
    expect(() => generateLeagueConstants(changed('settlementDelayMs', 1_001)))
      .toThrow('League settlement delay must be an exact number of seconds');
  });

  it('rejects a claim window beyond the configured ceiling', () => {
    const input = sharedInput();
    expect(() => generateLeagueConstants({ ...input, claimWindowSec: input.claimWindowMaxSec + 1 }))
      .toThrow('League claim window exceeds its ceiling');
  });

  it('accepts equality with the configured claim-window ceiling', () => {
    const input = sharedInput();
    expect(generateLeagueConstants({ ...input, claimWindowSec: input.claimWindowMaxSec }))
      .toContain(`pub const LEAGUE_CLAIM_WINDOW_SEC: i64 = ${input.claimWindowMaxSec};\n`);
  });

  it.each(['claimWindowSec', 'claimWindowMaxSec'] as const)(
    'rejects an unsafe-number %s at the safe-integer guard before the defensive i64 check',
    (field) => {
      // Number(2^63) fails Number.isSafeInteger first. This does not exercise
      // the later i64 guard, which is unreachable for accepted safe integers.
      expect(() => generateLeagueConstants(changed(field, Number(1n << 63n))))
        .toThrow('Invalid shared positive integer');
    },
  );
});
