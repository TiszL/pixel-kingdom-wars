/**
 * MarketBuildingFx state selection against the real generated clip tables.
 * The controller may only ever choose an authored state from real inputs
 * (job kind, HP, destruction) and must never invent Market work or repaint a
 * ruin from a stale rest request.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MarketBuildingFx, marketStaticFrame } from './marketBuilding';
import { parseMarketArtMetadata } from '../world/marketArt';

const evidence = (name: string): unknown => JSON.parse(readFileSync(
  new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
));
const art = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'));
const serviceFixture = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_service_buildings.manifest.json', import.meta.url), 'utf8')) as unknown;
const serviceArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'), serviceFixture);

interface Play { atlas: string; base: string; seq: string[]; fps: number; loop: boolean; hold?: { atlas: string; frame?: string }; onComplete?: () => void }

function harness(choice: { tier: number; awning: 'artisan_market_awning_t1' | 'artisan_market_awning_t2' | 'artisan_market_awning_t3' | 'artisan_market_awning_t4' | null }, extra: { restLoopSpeed?: number; reducedMotion?: boolean } = {}) {
  const plays: Play[] = [];
  const textures: Array<[string, string | undefined]> = [];
  const sprite = { active: true, setTexture: vi.fn((atlas: string, frame?: string) => { textures.push([atlas, frame]); return sprite; }) };
  const ticker = {
    play: vi.fn((s: unknown, p: Play) => {
      plays.push(p);
      // Mirror V2Ticker: registration shows the first frame immediately.
      (s as typeof sprite).setTexture(p.atlas, p.seq[0]);
    }),
    unregister: vi.fn(),
  };
  const fx = new MarketBuildingFx({ ticker: ticker as never, art, choice, ...extra }, sprite as never);
  return { fx, plays, textures, sprite, ticker };
}

describe('MarketBuildingFx', () => {
  it('rests on the ordinary tier idle loop from the completed level and owns the texture from construction', () => {
    const { fx, plays, textures } = harness({ tier: 2, awning: null }, { restLoopSpeed: 0.75 });
    expect(fx.atlas).toBe('pe_market_t2');
    expect(plays).toHaveLength(1);
    // The authored idle is a static cell (fps 0): registered as a held frame.
    expect(plays[0]).toMatchObject({ atlas: 'pe_market_t2', base: 'pe_market_t2_idle', fps: 0, loop: false, seq: ['pe_market_t2_idle_f1'] });
    expect(textures[0]).toEqual(['pe_market_t2', 'pe_market_t2_idle_f1']);
  });

  it('selects the applied Awning family for the same states at the same tier', () => {
    const { fx, plays } = harness({ tier: 4, awning: 'artisan_market_awning_t4' });
    expect(fx.atlas).toBe('pe_cosmetics');
    expect(plays[0]).toMatchObject({ atlas: 'pe_cosmetics', base: 'pe_cos_market_t4_idle', fps: 0, seq: ['pe_cos_market_t4_idle_f1'] });
    fx.setDamaged(true);
    expect(plays.at(-1)).toMatchObject({ base: 'pe_cos_market_t4_damaged', fps: 0, seq: ['pe_cos_market_t4_damaged_f1'] });
  });

  it('shows the current tier\'s construction one-shot for an initial build or an upgrade and returns to idle when the job ends', () => {
    const { fx, plays } = harness({ tier: 1, awning: null });
    fx.setJob('build');
    expect(plays.at(-1)).toMatchObject({ base: 'pe_market_t1_construction', loop: false, fps: 8 });
    expect(plays.at(-1)!.seq).toHaveLength(9);
    fx.setJob('build'); // unchanged job: no restart
    expect(plays).toHaveLength(2);
    fx.setJob('upgrade'); // a new job replays the scaffold; the queued level never selects tier 2 art
    expect(plays).toHaveLength(3);
    expect(plays.at(-1)).toMatchObject({ base: 'pe_market_t1_construction', loop: false });
    fx.setJob('clear'); // not a Market job kind
    expect(plays.at(-1)).toMatchObject({ base: 'pe_market_t1_idle', fps: 0, seq: ['pe_market_t1_idle_f1'] });
    expect(plays.every((p) => !p.base.includes('working') && !p.base.includes('ready'))).toBe(true);
  });

  it('holds the static damaged cell below half HP and returns to idle when repaired by a correction', () => {
    const { fx, plays } = harness({ tier: 3, awning: null });
    fx.setDamaged(true);
    expect(plays.at(-1)).toMatchObject({ base: 'pe_market_t3_damaged', fps: 0, loop: false, seq: ['pe_market_t3_damaged_f1'] });
    fx.setDamaged(false);
    expect(plays.at(-1)).toMatchObject({ base: 'pe_market_t3_idle', fps: 0, seq: ['pe_market_t3_idle_f1'] });
  });

  it('collapses through the authored one-shot into the pack rubble cell and refuses any later rest', () => {
    const { fx, plays, textures, sprite } = harness({ tier: 2, awning: 'artisan_market_awning_t2' });
    fx.setDamaged(true);
    fx.collapse();
    const collapse = plays.at(-1)!;
    expect(collapse).toMatchObject({ base: 'pe_cos_market_t2_collapse', loop: false, fps: 8 });
    expect(collapse.seq).toHaveLength(9);
    expect(collapse.hold).toEqual({ atlas: 'pe_cosmetics', frame: 'pe_cos_market_t2_destroyed_f1' });
    const before = plays.length;
    fx.setDamaged(false);
    fx.setJob('build');
    fx.collapse();
    expect(plays).toHaveLength(before);
    expect(textures.at(-1)).toEqual(['pe_cosmetics', 'pe_cos_market_t2_collapse_f1']);
    expect(sprite.active).toBe(true);
  });

  it('rests every state on its authored reduced-motion frame when motion is reduced', () => {
    const { fx, plays } = harness({ tier: 1, awning: null }, { reducedMotion: true });
    expect(plays[0]).toMatchObject({ base: 'pe_market_t1_idle', fps: 0, seq: ['pe_market_t1_idle_f1'] });
    fx.setJob('build');
    expect(plays.at(-1)).toMatchObject({ base: 'pe_market_t1_construction', fps: 0, seq: ['pe_market_t1_construction_f1'] });
  });

  it('unregisters from the ticker on destroy and never plays again', () => {
    const { fx, plays, ticker, sprite } = harness({ tier: 1, awning: null });
    fx.destroy();
    expect(ticker.unregister).toHaveBeenCalledExactlyOnceWith(sprite);
    fx.setDamaged(true);
    expect(plays).toHaveLength(1);
  });

  it('exposes the static seek cells for a controller-less body', () => {
    expect(marketStaticFrame(art, { tier: 4, awning: null }, 'destroyed')).toEqual({ atlas: 'pe_market_t4', frame: 'pe_market_t4_destroyed_f1' });
    expect(marketStaticFrame(art, { tier: 1, awning: 'artisan_market_awning_t1' }, 'damaged')).toEqual({ atlas: 'pe_cosmetics', frame: 'pe_cos_market_t1_damaged_f1' });
    expect(marketStaticFrame(parseMarketArtMetadata(undefined, undefined), { tier: 1, awning: null }, 'idle')).toBeNull();
  });
});

describe('MarketBuildingFx — ordinary Workshop/Lodge families (P5)', () => {
  function serviceHarness(choice: { family: 'workshop' | 'lodge'; tier: number }, extra: { reducedMotion?: boolean } = {}) {
    const plays: Play[] = [];
    const sprite = { active: true, setTexture: vi.fn(() => sprite) };
    const ticker = { play: vi.fn((_s: unknown, p: Play) => { plays.push(p); }), unregister: vi.fn() };
    const fx = new MarketBuildingFx({ ticker: ticker as never, art: serviceArt, choice: { ...choice, awning: null }, ...extra }, sprite as never);
    return { fx, plays, sprite, ticker };
  }

  it('plays the Workshop working grid by its authored playback indices (0..7), never the duplicate endpoint frame 9', () => {
    const { fx, plays } = serviceHarness({ family: 'workshop', tier: 1 });
    expect(fx.atlas).toBe('pe_workshop_t1');
    // Rest is the static idle cell (fps 0, held).
    expect(plays[0]).toMatchObject({ atlas: 'pe_workshop_t1', base: 'pe_workshop_t1_idle', fps: 0, loop: false, seq: ['pe_workshop_t1_idle_f1'] });
    // The authored working clip packs nine cells; playback is the eight-frame loop.
    const clip = serviceArt.clips['pe_workshop_t1_working']!;
    expect(clip.frames).toHaveLength(9);
    expect(clip.playbackFrameIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // A build/upgrade job plays the nine-cell construction one-shot through indices 0..8 and holds the endpoint.
    fx.setJob('upgrade');
    expect(plays.at(-1)).toMatchObject({ base: 'pe_workshop_t1_construction', fps: 8, loop: false });
    expect(plays.at(-1)!.seq).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `pe_workshop_t1_construction_f${n}`));
    // Working/ready are never selected at home (D5): no such play exists.
    expect(plays.map((p) => p.base)).not.toContain('pe_workshop_t1_working');
  });

  it('plays a Lodge with every packed frame in order (no authored indices) and collapses onto its own rubble', () => {
    const { fx, plays, sprite } = serviceHarness({ family: 'lodge', tier: 2 });
    expect(fx.atlas).toBe('pe_lodge_t2');
    expect(serviceArt.clips['pe_lodge_t2_construction']!.playbackFrameIndices).toBeNull();
    fx.setJob('build');
    expect(plays.at(-1)!.seq).toHaveLength(9);
    fx.setJob(null);
    fx.collapse();
    expect(plays.at(-1)).toMatchObject({ base: 'pe_lodge_t2_collapse', loop: false, hold: { atlas: 'pe_lodge_t2', frame: 'pe_lodge_t2_destroyed_f1' } });
    expect(marketStaticFrame(serviceArt, { family: 'lodge', tier: 2, awning: null }, 'destroyed')).toEqual({ atlas: 'pe_lodge_t2', frame: 'pe_lodge_t2_destroyed_f1' });
    expect(sprite.setTexture).not.toHaveBeenCalledWith('fx', expect.anything());
  });

  it('reduced motion rests every service state on frame 0 by this consumer\'s policy (the pack authors no reduced frame)', () => {
    const { fx, plays } = serviceHarness({ family: 'workshop', tier: 3 }, { reducedMotion: true });
    fx.setJob('upgrade');
    expect(plays.at(-1)).toMatchObject({ base: 'pe_workshop_t3_construction', fps: 0, loop: false, seq: ['pe_workshop_t3_construction_f1'] });
    fx.setDamaged(true);
    expect(plays.at(-1)).toMatchObject({ base: 'pe_workshop_t3_damaged', seq: ['pe_workshop_t3_damaged_f1'] });
  });

  it('keeps the accepted Market behaviour byte-identical: no playback indices, every packed frame plays', () => {
    const { plays } = harness({ tier: 1, awning: null });
    const clip = art.clips['pe_market_t1_working']!;
    expect(clip.playbackFrameIndices).toBeNull();
    expect(plays[0]!.seq).toEqual(['pe_market_t1_idle_f1']);
  });
});
