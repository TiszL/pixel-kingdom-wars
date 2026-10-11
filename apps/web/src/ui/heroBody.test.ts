import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HeroKey } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { heroBodyArt } from './heroBody';

interface ManifestMaster {
  key: string;
  actualPath: string;
  sha256: string;
}

const manifest = JSON.parse(readFileSync(
  new URL('../../../../art/game-v4/manifest.json', import.meta.url), 'utf8',
)) as { masters: ManifestMaster[] };

const EXPECTED: Readonly<Record<HeroKey, {
  runtimeKey: string;
  selectedPath: string;
  sha256: string;
}>> = {
  vex: {
    runtimeKey: 'hero_vex_idle_f1',
    // This legacy-flat PATH contains the approved red-armoured Vex identity.
    // The rejected black-horned body is the assets-v3 SVG, not this PNG.
    selectedPath: 'actors/legacy-hero_vex_idle_f1.png',
    sha256: '88efa3f8f6c8685459e29a01158077225cdc557999d0509b6ed628496e51d7b9',
  },
  theodor: {
    runtimeKey: 'hero_theo_idle_f1',
    selectedPath: 'actors/theo/idle/f1.png',
    sha256: 'a5dd42e865c479a8817f0170254c9ca65b0e4741c187cbd6d24ea3ccbcca79ec',
  },
};

describe('heroBodyArt', () => {
  it.each(Object.entries(EXPECTED) as Array<[HeroKey, (typeof EXPECTED)[HeroKey]]>)(
    'routes %s to the exact current runtime master, never the broad legacy SVG glob',
    (hero, expected) => {
      const master = manifest.masters.find((candidate) => candidate.key === expected.runtimeKey);
      const selectedUrl = new URL(
        `../../../../art/game-v4/${expected.selectedPath}`, import.meta.url,
      );
      const selectedHash = createHash('sha256')
        .update(readFileSync(selectedUrl))
        .digest('hex');

      // WHY: Phaser consumes the overlay-selected PNG while Inventory used to
      // consume assets-v3 directly. Both surfaces must now share exact bytes.
      expect(master).toMatchObject({
        actualPath: expected.selectedPath,
        sha256: expected.sha256,
      });
      expect(selectedHash).toBe(expected.sha256);
      expect(heroBodyArt(hero)).toContain(`art/game-v4/${expected.selectedPath}`);
      expect(heroBodyArt(hero)).not.toContain('assets-v3');
    },
  );

  it('keeps the Inventory paper doll on the body resolver, not raw legacy keys', () => {
    const inventory = readFileSync(new URL('./screens/inventory.tsx', import.meta.url), 'utf8');

    // WHY: correct resolver tests alone do not protect the consumer. The old
    // ternary silently bypassed the game-v4 selection through Sprite/icons.ts.
    expect(inventory).toContain('heroBodyArt(props.selectedHero)');
    expect(inventory).not.toMatch(
      /selectedHero\s*===\s*['"]vex['"]\s*\?\s*['"]hero_vex_idle_f1['"]/,
    );
  });
});
