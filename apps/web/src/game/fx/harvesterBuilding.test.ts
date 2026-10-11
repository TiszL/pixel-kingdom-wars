import { describe, expect, it, vi } from 'vitest';
import { MarketBuildingFx, marketStaticFrame } from './marketBuilding';
import { parseHarvesterArtMetadata } from '../world/harvesterArt';
import { harvesterFixture } from '../world/harvesterArt.test-support';

interface Play { atlas: string; base: string; seq: string[]; fps: number; loop: boolean; hold?: { atlas: string; frame?: string }; onComplete?: () => void }
function harness(reducedMotion = false) {
  const art = parseHarvesterArtMetadata(harvesterFixture(true));
  const choice = { family: 'harvester' as const, realm: 'seeker-reach' as const, tier: 2, awning: null };
  const plays: Play[] = [], sprite = { active: true, setTexture: vi.fn() };
  const ticker = { play: vi.fn((_sprite: unknown, play: Play) => plays.push(play)), unregister: vi.fn() };
  const fx = new MarketBuildingFx({ ticker: ticker as never, art, choice, reducedMotion }, sprite as never);
  return { art, choice, plays, sprite, ticker, fx };
}
describe('Harvester uses the existing service renderer without invented production state', () => {
  it('holds the authored idle frame because the base does not authorize working or ready animation', () => {
    const { fx, plays } = harness();
    expect(fx.atlas).toBe('pe_harvester_seeker_reach_t2');
    expect(plays).toEqual([expect.objectContaining({ base: 'pe_harvester_seeker_reach_t2_idle', seq: ['pe_harvester_seeker_reach_t2_idle_f1'], fps: 0, loop: false })]);
    fx.setJob('harvester');
    expect(plays).toHaveLength(1);
  });
  it('plays a real construction job at the completed tier once and returns to idle without restarting unchanged jobs', () => {
    const { fx, plays } = harness(); fx.setJob('upgrade'); fx.setJob('upgrade');
    expect(plays).toHaveLength(2);
    expect(plays.at(-1)).toMatchObject({ base: 'pe_harvester_seeker_reach_t2_construction', fps: 8, loop: false });
    expect(plays.at(-1)!.seq).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `pe_harvester_seeker_reach_t2_construction_f${n}`));
    fx.setJob(null);
    expect(plays.at(-1)!.base).toBe('pe_harvester_seeker_reach_t2_idle');
    expect(plays.every(p => !/working|ready/.test(p.base))).toBe(true);
  });
  it('uses authored damage and collapse cells and cannot repaint a destroyed Harvester from a late job update', () => {
    const { fx, plays, art, choice } = harness(); fx.setDamaged(true); fx.collapse();
    expect(plays.at(-2)!.base).toBe('pe_harvester_seeker_reach_t2_damaged');
    expect(plays.at(-1)).toMatchObject({ base: 'pe_harvester_seeker_reach_t2_collapse', hold: { atlas: 'pe_harvester_seeker_reach_t2', frame: 'pe_harvester_seeker_reach_t2_destroyed_f1' } });
    const before = plays.length; fx.setJob('build'); fx.setDamaged(false); fx.collapse();
    expect(plays).toHaveLength(before);
    expect(marketStaticFrame(art, choice, 'destroyed')).toEqual({ atlas: 'pe_harvester_seeker_reach_t2', frame: 'pe_harvester_seeker_reach_t2_destroyed_f1' });
  });
  it('uses the same static accessibility policy as Workshop when the pack has no reduced-motion frame', () => {
    const { fx, plays } = harness(true); fx.setJob('build');
    expect(plays.at(-1)).toMatchObject({ fps: 0, loop: false, seq: ['pe_harvester_seeker_reach_t2_construction_f1'] });
  });
  it('unregisters its ticker when removed so a retired base cannot retain a Harvester art loop', () => {
    const { fx, ticker, sprite, plays } = harness(); fx.destroy(); fx.setJob('build');
    expect(ticker.unregister).toHaveBeenCalledExactlyOnceWith(sprite);
    expect(plays).toHaveLength(1);
  });
});
