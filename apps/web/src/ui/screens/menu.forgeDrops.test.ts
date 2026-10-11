import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORGE_DROPS, ITEMS, LEGACY_ITEMS } from '@shardkeep/shared';

const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');

describe('Gold Forge drop table item identity', () => {
  it('resolves every forge drop through the FULL item catalog, not the legacy subset', () => {
    // WHY: FORGE_DROPS rolls gear (GEAR_ITEMS) and elite training writs
    // (UNLOCK_ITEMS). menu.tsx once imported `LEGACY_ITEMS as ITEMS`, so the
    // DAILY DROPS panel and MY LEDGER rendered raw ids ("item_troop_dragon",
    // "marchers_greaves") with blank art for every one of those rows — the
    // owner's 2026-08-21 report. The panel must read the merged `ITEMS`.
    const dropIds = Object.keys(FORGE_DROPS.independentDropBps);
    const missingFromLegacy = dropIds.filter((id) => !(id in LEGACY_ITEMS));
    expect(missingFromLegacy.length, 'the regression only exists if drops span beyond LEGACY_ITEMS').toBeGreaterThan(0);
    for (const id of dropIds) {
      const spec = (ITEMS as Record<string, { name?: string; asset?: string }>)[id];
      expect(spec?.name, `${id} needs a display name`).toBeTruthy();
      expect(spec?.asset, `${id} needs art`).toBeTruthy();
    }
    expect(source).not.toMatch(/LEGACY_ITEMS\s+as\s+ITEMS/);
    // Root or a supported subpath of the shared package are both fine; only the
    // legacy alias is the regression.
    expect(source).toMatch(/import \{[^}]*\bITEMS\b[^}]*\} from '@shardkeep\/shared(?:\/[\w-]+)?'/);
  });
});
