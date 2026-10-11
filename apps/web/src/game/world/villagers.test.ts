import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../scenes/BaseScene.ts', import.meta.url), 'utf8');

describe('base troop actor ownership', () => {
  it('does not mount the retired troop-proxy VillagerLayer', () => {
    // Owner 2026-08-11: Bowman, Plunderer and Highlander must appear only when
    // they are real trained troops. The former decorative layer made a second,
    // oversized, single-frame population independent of the player's army.
    expect(source).not.toContain('VillagerLayer');
    expect(source).not.toContain('this.villagers');
  });

  it('keeps PatrolLayer as the single owner of trained garrison walkers', () => {
    expect(source.match(/new PatrolLayer\(/g)).toHaveLength(1);
    expect(source).toContain('this.patrol?.update(dt, reduceMotion)');
    expect(source).toContain('this.patrol.sync(');
  });

  it('keeps real builder-job actors intact while removing decorative troop proxies', () => {
    expect(source.match(/new JobLayer\(/g)).toHaveLength(1);
    expect(source).toContain('this.jobs?.update(now)');
    expect(source).toContain('this.jobs.sync(');
  });
});
