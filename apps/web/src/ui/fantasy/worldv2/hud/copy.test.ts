import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { REGIONS } from '../../runtime/renderer.mjs';
import { INTENT_HINTS, PHASE_E_ISLANDS, REALM_INFO, WORLD_COPY, islandInfo, kingdomName, worldHint } from '../copy';
import { REALM_DIVE_FAILED } from '../realm/adapter';

const here = dirname(fileURLToPath(import.meta.url));
const worldv2 = join(here, '..');
/** Every shipped file under worldv2/ (code, styles, data). Docs such as a lane's patches.md may name the removed copy
 *  to record the removal; test-only files (this one, the globe's purity test, the realm port cases and their
 *  *.test / *.cases / *.support helpers) name it to forbid it, and never reach a player. */
const TEST_ONLY = /\.(test|cases|support)\.[cm]?[jt]sx?$/;
function shippedFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return shippedFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|css|json|html|glsl)$/.test(name) && !TEST_ONLY.test(name) && path !== fileURLToPath(import.meta.url) ? [path] : [];
  });
}

describe('World v2 copy keeps pre-decision words away from players', () => {
  // Why: the concept carried copy from before the owner's calls (the "PHASE E · ISLAND" kicker, the "Proposed
  // placement" caption, the "In range" tag, the demo "prototype data" line). Any of them reaching a player is an
  // owner regression, whichever lane's file it arrives in.
  it('no file under worldv2/ carries the retired strings', () => {
    const files = shippedFiles(worldv2);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return ['PHASE E', 'Proposed placement', 'In range', 'prototype data'].filter(bad => text.includes(bad)).map(bad => `${relative(worldv2, file)}: ${bad}`);
    });
    expect(hits).toEqual([]);
  });

  it('the island panel speaks player copy: coming soon, no internal phase label', () => {
    expect(WORLD_COPY.island.kicker).toBe('ISLAND · COMING SOON');
    for (const island of PHASE_E_ISLANDS) {
      expect(`${island.title} ${island.lore} ${island.note()}`).not.toMatch(/phase\s*e/i);
    }
  });
});

describe('island notes are built from PHASE_E_POLICY', () => {
  // Why: every game number lives only in packages/shared constants. A note that restated "100 spots" by hand would
  // drift the day Codex tunes the Seeker Island policy.
  it('the Seeker Island note follows the policy figures', () => {
    const S = PHASE_E_POLICY.seekerIsland, note = islandInfo('seeker-island')!.note();
    expect(note).toBe(`${S.totalSpots} spots — ${S.kingSpots} King + ${S.regularSpots} regular · `
      + `${S.operatingTermSec / 86_400}-day ${PHASE_E_POLICY.currencies.markets.auctions} auction terms`);
  });
  it('copy.ts states no island figure of its own', () => {
    const source = readFileSync(join(worldv2, 'copy.ts'), 'utf8');
    expect(source).not.toMatch(/\d[\d,]*\s*(spots|King|regular|workshop|licen[cs]es|solo|clan|trials|citadels)\b/i);
    expect(source).not.toMatch(/\d+-day/);
  });
  it('the island notes carry the shared policy figures shown by native', () => {
    // WHY: K-204 replaces the old count-free contract now that shared policy supplies the locked figures.
    expect(islandInfo('solana-island')!.note()).toMatch(/100 workshop licences/);
    expect(islandInfo('divine-isle')!.note()).toMatch(/500 solo trials .* 50 clan citadels/);
  });
});

describe('realm copy matches the world catalogue', () => {
  // Why: the HUD restates the realm names and lore so the lazy chunk does not import the island coastlines; the
  // restatement must never disagree with the catalogue the rest of the game reads.
  it('pins name, numeral, nav, epithet, landscape and the first sentence of lore', () => {
    expect(REALM_INFO.map(r => r.id)).toEqual(REGIONS.map(r => r.id));
    for (const info of REALM_INFO) {
      const region = REGIONS.find(r => r.id === info.id)! as (typeof REGIONS)[number] & { numeral: string };
      expect({ name: info.name, numeral: info.numeral, nav: info.nav, epithet: info.epithet, landscape: info.landscape })
        .toEqual({ name: region.name, numeral: region.numeral, nav: region.nav, epithet: region.epithet, landscape: region.landscape });
      expect(region.lore.startsWith(info.lore)).toBe(true);
    }
    expect(REALM_INFO.find(r => r.id === 'seeker-reach')!.name).toBe('Solana Reach');
  });
});

describe('one naming rule and the hint pill', () => {
  it('a blank own name reads "Your kingdom", a blank rival name "Keeper"', () => {
    expect(kingdomName('', true)).toBe('Your kingdom');
    expect(kingdomName('   ', false)).toBe('Keeper');
    expect(kingdomName(null, false)).toBe('Keeper');
    expect(kingdomName(' Ada ', false)).toBe('Ada');
  });
  it('a notice beats the intent, the intent beats the gesture hint', () => {
    expect(worldHint(null)).toBe('Drag to spin · pinch to zoom · tap a realm');
    expect(worldHint('choose-land')).toBe(INTENT_HINTS['choose-land']);
    expect(worldHint('rivals')).toBe('Choose a realm to find a rival');
    expect(worldHint('my-deeds')).toBe('Your realms are marked · tap one for your bases');
    expect(worldHint('rivals', WORLD_COPY.diveFailed)).toBe(WORLD_COPY.diveFailed);
  });
});

describe('notices name a control the player can see', () => {
  // Why (round-2 review): the dive-failure and safe-mode notices told players to "tap Enter map" while the web showed
  // no such button. RealmPanel is now mounted and labels its CTA from WORLD_COPY.realmPanel.enterMap, so every notice
  // must name that exact label; renaming the button without the notices (or the reverse) fails here.
  it('the dive-failure notice (both copies) and the realm engine\'s safe-mode notice say "Enter map"', () => {
    const label = WORLD_COPY.realmPanel.enterMap;
    expect(label).toBe('Enter map');
    expect(WORLD_COPY.diveFailed).toBe(`This realm map could not load — tap ${label} to retry`);
    expect(REALM_DIVE_FAILED).toBe(WORLD_COPY.diveFailed);
    const engine = readFileSync(join(worldv2, 'realm', 'map.mjs'), 'utf8');
    expect(engine).toContain(`Safe mode is on. Tap ${label} again.`);
    expect(engine).not.toMatch(/INSPECT LAND TILES/i);
  });
});

describe('the realm-map filter chip is Unshielded, never Shielded (D-191)', () => {
  // Why (owner 2026-09-28, endorsing a player): "the purpose of viewing or searching is to raid, therefore their target
  // should be those unshielded". A Shielded chip returning here would send raiders to the kingdoms they cannot attack.
  it('long label "Unshielded", short label "No shield"; the card tag "Shielded" is a different word and stays', () => {
    const M = WORLD_COPY.realmMap as Record<string, unknown>;
    expect(M.unshielded).toBe('Unshielded'); expect(M.unshieldedShort).toBe('No shield');
    expect('shielded' in M).toBe(false); expect('shieldedShort' in M).toBe(false);
    expect(WORLD_COPY.tags.shielded).toBe('Shielded');
  });
});

