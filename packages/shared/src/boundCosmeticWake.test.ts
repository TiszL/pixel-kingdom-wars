import { describe, expect, it } from 'vitest';
import {
  BoundCosmeticWakeVisualV1Schema, BoundCosmeticWakeReadSchema,
  BoundCosmeticWakePreferenceRequestSchema, BoundCosmeticWakePreferenceResponseSchema,
  matchBoundCosmeticWakeRead,
} from './boundCosmeticWake';
import type { BoundCosmeticAppearance } from './boundCosmeticApi';

const appearance: BoundCosmeticAppearance = {
  version: 1, outputId: 'aurora_wake', sourceId: 'auroraWake',
  sourceManifestSha256: 'a'.repeat(64), sourceIndexSha256: 'b'.repeat(64), bindingSha256: 'c'.repeat(64),
};
const available = { state: 'available' as const, visual: { version: 1 as const, wake: appearance } };
const off = { state: 'available' as const, visual: { version: 1 as const, wake: null } };
const unavailable = { state: 'unavailable' as const, visual: null };

describe('bound cosmetic Wake wire', () => {
  it('preserves exact Aurora source terms without asserting delivery or changing the input', () => {
    const raw = { ...available, visual: { ...available.visual, wake: { ...appearance } } };
    expect(matchBoundCosmeticWakeRead(raw)).toEqual(available);
    expect(raw).toEqual(available);
    const parsed = BoundCosmeticWakeVisualV1Schema.parse(available.visual);
    expect(parsed.wake).toEqual(appearance);
    expect(parsed.wake).not.toBe(appearance);
  });

  it('keeps legacy absence, observed off/default and unavailable as distinct frozen reads', () => {
    expect(matchBoundCosmeticWakeRead(undefined)).toBeUndefined();
    expect(matchBoundCosmeticWakeRead(off)).toEqual(off);
    expect(matchBoundCosmeticWakeRead(unavailable)).toEqual(unavailable);
    expect(() => matchBoundCosmeticWakeRead(null)).toThrow();
    expect(off).not.toEqual(unavailable);
  });

  it('refuses an Awning even when that appearance has a valid source binding shape', () => {
    for (const tier of [1, 2, 3, 4] as const) {
      const awning = { ...appearance, outputId: `artisan_market_awning_t${tier}`, sourceId: `artisan-market-t${tier}` };
      expect(BoundCosmeticWakeVisualV1Schema.safeParse({ version: 1, wake: awning }).success).toBe(false);
    }
  });

  it('rejects extended, mismatched and coerced visual grammar without silently dropping terms', () => {
    for (const raw of [
      { version: '1', wake: appearance }, { version: 2, wake: appearance }, { version: 1 },
      { ...available.visual, ready: true }, { version: 1, wake: { ...appearance, sourceId: 'artisan-market-t1' } },
      { version: 1, wake: { ...appearance, bindingSha256: 'C'.repeat(64) } },
      { version: 1, wake: { ...appearance, delivered: true } },
    ]) expect(BoundCosmeticWakeVisualV1Schema.safeParse(raw).success).toBe(false);
  });

  it('refuses contradictory availability and owner or trip authority appended to a projection', () => {
    for (const raw of [
      { state: 'available', visual: null }, { state: 'unavailable', visual: available.visual },
      { ...available, wallet: 'owner' }, { ...off, tripId: 'trip' }, { ...unavailable, frozen: true },
      { state: 'future', visual: null },
    ]) expect(BoundCosmeticWakeReadSchema.safeParse(raw).success).toBe(false);
  });

  it('accepts a free account preference without accepting caller supplied account or kingdom identity', () => {
    for (const enabled of [true, false])
      expect(BoundCosmeticWakePreferenceRequestSchema.parse({ enabled, expectedRevision: '0' })).toEqual({ enabled, expectedRevision: '0' });
    for (const extra of [{ baseId: 'base' }, { wallet: 'owner' }, { account: 'owner' }, { fee: '0' }, { currency: 'KEEP' }])
      expect(BoundCosmeticWakePreferenceRequestSchema.safeParse({ enabled: true, expectedRevision: '0', ...extra }).success).toBe(false);
    expect(BoundCosmeticWakePreferenceRequestSchema.safeParse({ enabled: 'false', expectedRevision: '0' }).success).toBe(false);
  });

  it('keeps request revisions below signed maximum and preserves large decimal precision', () => {
    for (const expectedRevision of ['0', '1', '9007199254740993', '9223372036854775806'])
      expect(BoundCosmeticWakePreferenceRequestSchema.parse({ enabled: false, expectedRevision }).expectedRevision).toBe(expectedRevision);
    for (const expectedRevision of ['9223372036854775807', '9223372036854775808'])
      expect(BoundCosmeticWakePreferenceRequestSchema.safeParse({ enabled: true, expectedRevision }).success).toBe(false);
  });

  it('keeps response revisions positive through signed maximum without implying source availability', () => {
    for (const revision of ['1', '9007199254740993', '9223372036854775807']) {
      const reply = { enabled: false, revision, visual: unavailable };
      expect(BoundCosmeticWakePreferenceResponseSchema.parse(reply)).toEqual(reply);
    }
    for (const revision of ['0', '9223372036854775808'])
      expect(BoundCosmeticWakePreferenceResponseSchema.safeParse({ enabled: false, revision, visual: off }).success).toBe(false);
  });

  it('refuses malformed decimal strings and nonstrings without throwing from safeParse', () => {
    for (const invalid of ['', '-1', '+1', '01', ' 1', '1 ', '1.0', '1e3', 'NaN', 'Infinity', '1\n', '9'.repeat(20), 1, null, true]) {
      expect(BoundCosmeticWakePreferenceRequestSchema.safeParse({ enabled: true, expectedRevision: invalid }).success).toBe(false);
      expect(BoundCosmeticWakePreferenceResponseSchema.safeParse({ enabled: false, revision: invalid, visual: off }).success).toBe(false);
    }
  });

  it('requires exact response shape and a valid frozen visual rather than rebuilding it from enabled', () => {
    for (const visual of [available, off, unavailable]) {
      const reply = { enabled: true, revision: '1', visual };
      expect(BoundCosmeticWakePreferenceResponseSchema.parse(reply)).toEqual(reply);
    }
    for (const raw of [
      { enabled: false, revision: '1' }, { enabled: 1, revision: '1', visual: off },
      { enabled: false, revision: '1', visual: off, baseId: 'base' },
      { enabled: false, revision: '1', visual: { state: 'available', visual: null } },
    ]) expect(BoundCosmeticWakePreferenceResponseSchema.safeParse(raw).success).toBe(false);
  });
});
