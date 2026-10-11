import { describe, expect, it } from 'vitest';
import {
  BoundCosmeticBaseReadSchema, BoundCosmeticBaseVisualV1Schema,
  boundCosmeticAwningForCompletedLevel, matchBoundCosmeticBaseRead, matchBoundCosmeticBaseVisual,
} from './boundCosmeticVisual';
import type { BoundCosmeticAppearance } from './boundCosmeticApi';

const buildingId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const market = { id: buildingId, type: 'market', level: 1, underConstruction: false };
function appearance(tier: 1 | 2 | 3 | 4 = 1): BoundCosmeticAppearance {
  return {
    version: 1, outputId: `artisan_market_awning_t${tier}`, sourceId: `artisan-market-t${tier}`,
    sourceManifestSha256: 'a'.repeat(64), sourceIndexSha256: 'b'.repeat(64), bindingSha256: 'c'.repeat(64),
  };
}
function visual(tier: 1 | 2 | 3 | 4 = 1) {
  return { version: 1, marketAwnings: [{ buildingId, appearance: appearance(tier) }] };
}

describe('bound cosmetic base visual grammar', () => {
  it.each([
    [1, 5, 'artisan_market_awning_t1'], [6, 10, 'artisan_market_awning_t2'],
    [11, 15, 'artisan_market_awning_t3'], [16, 20, 'artisan_market_awning_t4'],
  ] as const)('keeps completed levels %i–%i on %s', (first, last, output) => {
    for (let level = first; level <= last; level++)
      expect(boundCosmeticAwningForCompletedLevel(level)).toBe(output);
  });

  it.each([0, -1, 1.5, 21, NaN, Infinity])('refuses invalid completed level %s instead of clamping', (level) => {
    expect(() => boundCosmeticAwningForCompletedLevel(level)).toThrow('completed level');
  });

  it('retains exact appearance terms without claiming the hashes are delivered pixels', () => {
    const input = visual();
    expect(matchBoundCosmeticBaseVisual(input, [market])).toEqual(input);
    expect(input).toEqual(visual());
  });

  it('refuses loose or extended base grammar rather than dropping unknown visual terms', () => {
    const entry = visual().marketAwnings[0]!;
    for (const raw of [
      { ...visual(), version: '1' }, { ...visual(), extra: true },
      { version: 1, marketAwnings: [{ ...entry, buildingId: 'not-a-uuid' }] },
      { version: 1, marketAwnings: [{ ...entry, selected: true }] },
      { version: 1, marketAwnings: [{ ...entry, appearance: { ...appearance(), sourceId: 'artisan-market-t2' } }] },
    ]) expect(BoundCosmeticBaseVisualV1Schema.safeParse(raw).success).toBe(false);
  });

  it('refuses Aurora even when its own source identity is well formed', () => {
    const wake = { ...appearance(), outputId: 'aurora_wake', sourceId: 'auroraWake' };
    expect(BoundCosmeticBaseVisualV1Schema.safeParse({
      version: 1, marketAwnings: [{ buildingId, appearance: wake }],
    }).success).toBe(false);
  });

  it('refuses two appearances for one Market even when identical', () => {
    const entry = visual().marketAwnings[0]!;
    expect(BoundCosmeticBaseVisualV1Schema.safeParse({ version: 1, marketAwnings: [entry, entry] }).success).toBe(false);
  });

  it('requires the named structure to be a Market in this authoritative base', () => {
    expect(() => matchBoundCosmeticBaseVisual(visual(), [{ ...market, id: otherId }])).toThrow('completed Market');
    expect(() => matchBoundCosmeticBaseVisual(visual(), [{ ...market, type: 'workshop' }])).toThrow('completed Market');
    expect(() => matchBoundCosmeticBaseVisual(visual(), [market, market])).toThrow('ambiguous');
  });

  it('refuses the level-1 row created for an unfinished initial build', () => {
    expect(() => matchBoundCosmeticBaseVisual(visual(), [{ ...market, underConstruction: true }])).toThrow('completed Market');
    expect(() => matchBoundCosmeticBaseVisual(visual(), [{ ...market, level: 0 }])).toThrow('completed level');
  });

  it('keeps the current tier during an upgrade and changes only after completion', () => {
    // base.ts retains level 5 and underConstruction=false while a 5→6 upgrade runs.
    const upgrading = { ...market, level: 5 };
    expect(matchBoundCosmeticBaseVisual(visual(1), [upgrading])).toEqual(visual(1));
    expect(() => matchBoundCosmeticBaseVisual(visual(2), [upgrading])).toThrow('completed Market tier');
    const completed = { ...market, level: 6 };
    expect(() => matchBoundCosmeticBaseVisual(visual(1), [completed])).toThrow('completed Market tier');
    expect(matchBoundCosmeticBaseVisual(visual(2), [completed])).toEqual(visual(2));
  });

  it('preserves legacy absence, unavailable and verified-empty as three different reads', () => {
    const unavailable = { state: 'unavailable', visual: null };
    const empty = { state: 'available', visual: { version: 1, marketAwnings: [] } };
    expect(matchBoundCosmeticBaseRead(undefined, [market])).toBeUndefined();
    expect(matchBoundCosmeticBaseRead(unavailable, [market])).toEqual(unavailable);
    expect(matchBoundCosmeticBaseRead(empty, [market])).toEqual(empty);
    // No named appearance requires a building match in these reads.
    expect(matchBoundCosmeticBaseRead(unavailable, [market, market])).toEqual(unavailable);
    expect(matchBoundCosmeticBaseRead(empty, [market, market])).toEqual(empty);
    expect(() => matchBoundCosmeticBaseRead(null, [market])).toThrow();
  });

  it('matches available reads against their buildings and refuses contradictory availability', () => {
    const available = { state: 'available', visual: visual() };
    expect(matchBoundCosmeticBaseRead(available, [market])).toEqual(available);
    expect(() => matchBoundCosmeticBaseRead(available, [])).toThrow('completed Market');
    for (const raw of [
      { state: 'available', visual: null }, { state: 'unavailable', visual: visual() },
      { state: 'unavailable', visual: null, verifiedOff: true },
    ]) expect(BoundCosmeticBaseReadSchema.safeParse(raw).success).toBe(false);
  });
});
