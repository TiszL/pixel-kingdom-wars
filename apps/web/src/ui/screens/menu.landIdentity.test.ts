import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./menu.tsx', import.meta.url), 'utf8');
const profileStart = source.indexOf('export function ProfileScreen');
const profileEnd = source.indexOf('// CLANS (');
if (profileStart < 0 || profileEnd <= profileStart) {
  throw new Error('menu.tsx ProfileScreen boundary markers moved');
}
const profile = source.slice(profileStart, profileEnd);

describe('profile deed land identity', () => {
  it('pairs the selected deed with its persisted directory location without Earth-history fallbacks', () => {
    // Fantasy identity supersedes D-063's public Earth cell. Reconciliation
    // bindings remain private even if presentation is paused after cutover.
    expect(profile).toContain('baseLocationLabel(profileLocationBase, fantasyDirectory(baseDirectory))');
    expect(profile).toContain('selectedDirectoryBase');
    expect(profile).not.toMatch(/EARTH CELL|EARTH LAND TITLE|profileEarthCell/);
    expect(profile).not.toContain("selectedBasePath('/map/me')");
    expect(profile).not.toMatch(/PARCEL \$\{[^}]+\.x\},\$\{[^}]+\.y\}/);
  });
});
