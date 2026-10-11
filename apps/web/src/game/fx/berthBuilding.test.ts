/**
 * BerthBuildingFx state selection against the real generated clip tables. The
 * controller may only compose the authored away/occupied/exhausted
 * presentations of ONE named composition (the P4 starter, or an advanced
 * family at its applied tier) from the server's presence fact, apply that
 * composition's dock translation once, and never invent a journey, a travel
 * loop, a gate effect or a Wake.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BerthBuildingFx, advancedComposition, berthCompositionFor, berthCompositionGroups, journeyDurationMs, journeyOutcomePresence, journeyPlanFor, journeyPlanGroups,
  starterComposition, type BerthComposition, type BerthPresence, type JourneyPlan,
} from './berthBuilding';
import { EMPTY_MARKET_ART, parseMarketArtMetadata } from '../world/marketArt';
import type { FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import { EMPTY_ADVANCED_FLEET_ART, parseAdvancedFleetMetadata } from '../world/advancedFleetArt';
import { EMPTY_STARTER_FLEET_ART, parseStarterFleetMetadata } from '../world/fleetArt';

const manifest = JSON.parse(readFileSync(
  new URL('../../../testFixtures/pe_fleet_starter.manifest.json', import.meta.url), 'utf8',
)) as Record<string, unknown> & { clips: Record<string, unknown>; tracks: unknown };
const { clips, tracks, ...identity } = manifest;
const art = parseStarterFleetMetadata(identity, clips, tracks);
const advanced = parseAdvancedFleetMetadata(JSON.parse(readFileSync(new URL('../../../testFixtures/pe_advanced_fleet.manifest.json', import.meta.url), 'utf8')));

interface Play { atlas: string; base: string; seq: string[]; fps: number; loop: boolean; onFrame?: (frame1: number) => void; onComplete?: () => void }

function stubSprite(name: string) {
  const sprite: Record<string, unknown> = {
    name, active: true, x: 640, y: 512, depth: 1024, scaleX: 1, scaleY: 1, visible: true, alpha: 1,
    textures: [] as Array<[string, string | undefined]>,
  };
  sprite['setTexture'] = vi.fn((atlas: string, frame?: string) => { (sprite['textures'] as unknown[]).push([atlas, frame]); return sprite; });
  for (const method of ['setOrigin', 'setScale', 'setPosition', 'setDepth', 'setVisible', 'setAlpha']) {
    sprite[method] = vi.fn((...args: unknown[]) => {
      if (method === 'setPosition') { sprite['x'] = args[0]; sprite['y'] = args[1]; }
      if (method === 'setDepth') sprite['depth'] = args[0];
      if (method === 'setVisible') sprite['visible'] = args[0];
      if (method === 'setAlpha') sprite['alpha'] = args[0];
      if (method === 'setOrigin') { sprite['originX'] = args[0]; sprite['originY'] = args[1]; }
      return sprite;
    });
  }
  sprite['destroy'] = vi.fn(() => { sprite['active'] = false; });
  return sprite;
}

function harness(presence: BerthPresence, extra: { restLoopSpeed?: number; reducedMotion?: boolean; composition?: BerthComposition } = {}) {
  const plays: Array<[unknown, Play]> = [];
  const vehicles: Array<ReturnType<typeof stubSprite>> = [];
  const berth = stubSprite('berth');
  const ticker = {
    play: vi.fn((s: unknown, p: Play) => { plays.push([s, p]); (s as ReturnType<typeof stubSprite>)['setTexture' as never]; }),
    unregister: vi.fn(),
  };
  const addVehicle = vi.fn((atlas: string) => { const v = stubSprite(`vehicle-${vehicles.length + 1}`); v['atlas'] = atlas; vehicles.push(v); return v as never; });
  const effects: Array<ReturnType<typeof stubSprite>> = [];
  const addEffect = vi.fn((atlas: string) => { const e = stubSprite(`effect-${effects.length + 1}`); e['atlas'] = atlas; effects.push(e); return e as never; });
  const { composition = starterComposition(art)!, ...rest } = extra;
  const fx = new BerthBuildingFx({ ticker: ticker as never, composition, presence, addVehicle, addEffect, ...rest }, berth as never);
  return { fx, plays, berth, vehicles, effects, ticker, addVehicle, addEffect };
}

describe('BerthBuildingFx', () => {
  it('away: rests the berth on the authored ambient loop with no vehicle', () => {
    const { fx, plays, berth, vehicles } = harness('away', { restLoopSpeed: 0.75 });
    expect(fx.atlas).toBe('pe_fleet_starter');
    expect(plays).toHaveLength(1);
    expect(plays[0]![0]).toBe(berth);
    expect(plays[0]![1]).toMatchObject({ atlas: 'pe_fleet_starter', base: 'pe_berth_starter_ambient', fps: 8 * 0.75, loop: true });
    expect(plays[0]![1].seq).toEqual(['pe_berth_starter_ambient_f1', 'pe_berth_starter_ambient_f2', 'pe_berth_starter_ambient_f3', 'pe_berth_starter_ambient_f4', 'pe_berth_starter_ambient_f5', 'pe_berth_starter_ambient_f6', 'pe_berth_starter_ambient_f7', 'pe_berth_starter_ambient_f8']);
    expect(vehicles).toHaveLength(0);
  });

  it('occupied: adds the docked starter loop seated by the dock translation applied once ([0, −34] from the berth origin), above the berth', () => {
    const { plays, berth, vehicles } = harness('occupied');
    expect(vehicles).toHaveLength(1);
    const vehicle = vehicles[0]!;
    expect(plays.map(([, p]) => p.base)).toEqual(['pe_berth_starter_ambient', 'pe_veh_starter_docked']);
    expect(plays[1]![0]).toBe(vehicle);
    expect(plays[1]![1]).toMatchObject({ atlas: 'pe_fleet_starter', fps: 8, loop: true, seq: ['pe_veh_starter_docked_f1', 'pe_veh_starter_docked_f2', 'pe_veh_starter_docked_f3', 'pe_veh_starter_docked_f4'] });
    expect(vehicle['setOrigin']).toHaveBeenCalledWith(0.5, 105 / 112);
    expect(vehicle['x']).toBe(berth['x']);
    expect(vehicle['y']).toBe((berth['y'] as number) - 34);
    expect(vehicle['depth']).toBe((berth['depth'] as number) + 0.5);
    expect(vehicle['setVisible']).toHaveBeenCalledWith(true);
  });

  it('follows the berth on layout (position, scale, depth, visibility, alpha) — a lifted or hidden berth carries its starter', () => {
    const { fx, berth, vehicles } = harness('occupied');
    const vehicle = vehicles[0]!;
    Object.assign(berth, { x: 100, y: 200, depth: 2500, visible: false, alpha: 0.6, scaleX: 1, scaleY: 1 });
    fx.layout();
    expect(vehicle['x']).toBe(100); expect(vehicle['y']).toBe(166); expect(vehicle['depth']).toBe(2500.5);
    expect(vehicle['setVisible']).toHaveBeenLastCalledWith(false);
    expect(vehicle['setAlpha']).toHaveBeenLastCalledWith(0.6);
  });

  it('a presence change re-rests: occupied → away destroys the starter, away → occupied adds it; the same presence is a no-op', () => {
    const { fx, plays, vehicles, ticker } = harness('occupied');
    fx.setPresence('occupied');
    expect(plays).toHaveLength(2);
    fx.setPresence('away');
    expect(vehicles[0]!['destroy']).toHaveBeenCalledOnce();
    expect(ticker.unregister).toHaveBeenCalledWith(vehicles[0]);
    expect(plays.map(([, p]) => p.base)).toEqual(['pe_berth_starter_ambient', 'pe_veh_starter_docked', 'pe_berth_starter_ambient']);
    fx.setPresence('occupied');
    expect(vehicles).toHaveLength(2);
    expect(plays.at(-1)![1].base).toBe('pe_veh_starter_docked');
  });

  it('reduced motion: the static intact berth and the docked first frame, held', () => {
    const { plays, vehicles } = harness('occupied', { reducedMotion: true });
    expect(plays[0]![1]).toMatchObject({ base: 'pe_berth_starter_intact', seq: ['pe_berth_starter_intact_f1'], fps: 0, loop: false });
    expect(plays[1]![1]).toMatchObject({ base: 'pe_veh_starter_docked', seq: ['pe_veh_starter_docked_f1'], fps: 0, loop: false });
    expect(vehicles).toHaveLength(1);
  });

  it('never selects departure, return, travel, effect or wake clips, and destroy releases both sprites', () => {
    const { fx, plays, berth, vehicles, ticker } = harness('occupied');
    fx.setPresence('away'); fx.setPresence('occupied');
    for (const [, p] of plays) expect(p.base).toMatch(/^pe_(?:berth_starter_(?:ambient|intact)|veh_starter_docked)$/);
    const berthPlays = plays.filter(([s]) => s === berth).length;
    fx.destroy();
    expect(ticker.unregister).toHaveBeenCalledWith(berth);
    expect(vehicles.at(-1)!['destroy']).toHaveBeenCalled();
    fx.setPresence('away');
    expect(plays.filter(([s]) => s === berth).length).toBe(berthPlays); // no rest after destroy
  });

  it('P6a: an advanced family composes its own berth group, vehicle tier group and dock offset; exhausted is the authored still at the exact same seat', () => {
    const balloon = advancedComposition(advanced, 'survey_balloon', 1)!;
    expect(balloon).toMatchObject({ berthAtlas: 'pe_berth_survey_balloon', intactClip: 'pe_berth_survey_balloon_intact', ambientClip: 'pe_berth_survey_balloon_ambient',
      damagedClip: 'pe_berth_survey_balloon_damaged', destroyedClip: 'pe_berth_survey_balloon_destroyed',
      vehicle: { atlas: 'pe_veh_survey_balloon_t1', dockedClip: 'pe_veh_survey_balloon_t1_docked', exhaustedClip: 'pe_veh_survey_balloon_t1_exhausted', offset: [0, -56] } });
    expect(berthCompositionGroups(balloon, 'away')).toEqual(['pe_berth_survey_balloon']);
    expect(berthCompositionGroups(balloon, 'occupied')).toEqual(['pe_berth_survey_balloon', 'pe_veh_survey_balloon_t1']);
    expect(berthCompositionGroups(balloon, 'exhausted')).toEqual(['pe_berth_survey_balloon', 'pe_veh_survey_balloon_t1']);
    const occupied = harness('occupied', { composition: balloon });
    expect(occupied.fx.atlas).toBe('pe_berth_survey_balloon');
    expect(occupied.addVehicle).toHaveBeenCalledExactlyOnceWith('pe_veh_survey_balloon_t1');
    expect(occupied.plays.map(([, p]) => [p.atlas, p.base, p.loop])).toEqual([['pe_berth_survey_balloon', 'pe_berth_survey_balloon_ambient', true], ['pe_veh_survey_balloon_t1', 'pe_veh_survey_balloon_t1_docked', true]]);
    expect(occupied.plays[1]![1].seq).toHaveLength(4);
    expect(occupied.vehicles[0]!['setOrigin']).toHaveBeenCalledWith(0.5, 110 / 112);
    expect(occupied.vehicles[0]!['y']).toBe((occupied.berth['y'] as number) - 56);
    const exhausted = harness('exhausted', { composition: balloon });
    expect(exhausted.plays.map(([, p]) => p.base)).toEqual(['pe_berth_survey_balloon_ambient', 'pe_veh_survey_balloon_t1_exhausted']);
    expect(exhausted.plays[1]![1]).toMatchObject({ seq: ['pe_veh_survey_balloon_t1_exhausted_f1'], fps: 0, loop: false });
    expect(exhausted.vehicles[0]!['y']).toBe((exhausted.berth['y'] as number) - 56);
    // occupied → exhausted keeps the vehicle sprite and re-rests it on the still; → away drops it.
    occupied.fx.setPresence('exhausted');
    expect(occupied.vehicles).toHaveLength(1);
    expect(occupied.plays.at(-1)![1].base).toBe('pe_veh_survey_balloon_t1_exhausted');
    occupied.fx.setPresence('away');
    expect(occupied.vehicles[0]!['destroy']).toHaveBeenCalledOnce();
    // A nautical family at tier 4 uses its own contact/offset (barge: [56,105] → [0,−34], the starter's geometry).
    const barge = advancedComposition(advanced, 'expedition_barge', 4)!;
    expect(barge.vehicle!.offset).toEqual([0, -34]);
    const docked = harness('occupied', { composition: barge });
    expect(docked.vehicles[0]!['setOrigin']).toHaveBeenCalledWith(0.5, 105 / 112);
    expect(docked.vehicles[0]!['y']).toBe((docked.berth['y'] as number) - 34);
    expect(advancedComposition(EMPTY_ADVANCED_FLEET_ART, 'expedition_barge', 4)).toBeNull();
  });

  it('P6a: the starter facts select the P4 composition and the advanced facts their family/tier; a family without admitted art selects nothing', () => {
    expect(berthCompositionFor({ family: 'starter', presence: 'occupied' }, art, advanced)).toEqual(starterComposition(art));
    expect(berthCompositionFor({ family: 'cargo_cutter', tier: 3, presence: 'away' }, art, advanced)).toEqual(advancedComposition(advanced, 'cargo_cutter', 3));
    expect(berthCompositionFor({ family: 'starter', presence: 'occupied' }, EMPTY_STARTER_FLEET_ART, advanced)).toBeNull();
    expect(berthCompositionFor({ family: 'cargo_cutter', tier: 3, presence: 'away' }, art, EMPTY_ADVANCED_FLEET_ART)).toBeNull();
    // The starter composition has no exhausted still; its facts never name that presence, and the controller then shows no vehicle rather than inventing one.
    const starter = harness('exhausted');
    expect(starter.vehicles).toHaveLength(0);
  });

  it('P6a frozen damage (D-b): damaged keeps the vehicle on the damaged berth still; collapse rests on the destroyed still and drops the vehicle', () => {
    const { fx, plays, berth, vehicles, ticker } = harness('occupied', { composition: advancedComposition(advanced, 'courier_airship', 2)! });
    const lastBerthPlay = () => plays.filter(([s]) => s === berth).at(-1)![1];
    fx.setDamaged(true);
    expect(lastBerthPlay()).toMatchObject({ base: 'pe_berth_courier_airship_damaged', seq: ['pe_berth_courier_airship_damaged_f1'], fps: 0 });
    expect(plays.at(-1)![1].base, 'the vehicle re-rests docked on the damaged berth').toBe('pe_veh_courier_airship_t2_docked');
    expect(vehicles[0]!['destroy']).not.toHaveBeenCalled();
    fx.setDamaged(false);
    expect(lastBerthPlay().base).toBe('pe_berth_courier_airship_ambient');
    fx.setDamaged(true);
    fx.collapse();
    expect(plays.at(-1)![1]).toMatchObject({ base: 'pe_berth_courier_airship_destroyed', seq: ['pe_berth_courier_airship_destroyed_f1'] });
    expect(vehicles[0]!['destroy']).toHaveBeenCalledOnce();
    expect(ticker.unregister).toHaveBeenCalledWith(vehicles[0]);
    // A collapsed berth never re-rests: presence changes after destruction add nothing.
    const berthPlays = plays.filter(([s]) => s === berth).length;
    fx.setPresence('away'); fx.setPresence('occupied');
    expect(plays.filter(([s]) => s === berth).length).toBe(berthPlays);
    expect(vehicles).toHaveLength(1);
  });
});

/**
 * C5 (D153.248): ONE typed root event plays the installation's OWN authored
 * one-second track once — offsets AND opacity on the craft, the Wake riding its
 * contact, the shared gate effect on the family's authored berth seat — then the
 * controller rests on the LATEST server presence. Nothing is inferred from polls.
 */
describe('BerthBuildingFx C5 journeys', () => {
  const peCosmetics = JSON.parse(readFileSync(
    new URL('../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/pe_cosmetics.manifest.json', import.meta.url), 'utf8',
  )) as unknown;
  const cosmetics = parseMarketArtMetadata(undefined, peCosmetics);
  const wakeBinding = cosmetics.bindings['aurora_wake']!;
  const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const LEGACY = { state: 'legacy', visual: null } as const;
  const UNAVAILABLE = { state: 'unavailable', visual: null } as const;
  const AVAILABLE = (mutate: (a: Record<string, unknown>) => void = () => {}) => {
    const wake: Record<string, unknown> = {
      version: 1, outputId: 'aurora_wake', sourceId: 'auroraWake', sourceManifestSha256: wakeBinding.sourceManifestSha256,
      sourceIndexSha256: wakeBinding.sourceIndexSha256, bindingSha256: wakeBinding.sha256,
    };
    mutate(wake);
    return { state: 'available', visual: { version: 1, wake } } as unknown as FleetJourneyEvent['wake'];
  };
  const STARTER = { family: 'starter' } as const;
  const BALLOON = { family: 'survey_balloon', tier: 1 } as const;
  const CUTTER = { family: 'cargo_cutter', tier: 2 } as const;
  const departure = (vehicle: FleetJourneyEvent['vehicle'], wake: FleetJourneyEvent['wake'] = LEGACY): FleetJourneyEvent => ({
    version: 1, kind: 'departure', baseId: uuid(1), berthId: uuid(2), installationId: uuid(3), expeditionId: uuid(4),
    at: '2026-10-01T04:00:00.000Z', vehicle, wake,
  });
  const back = (vehicle: FleetJourneyEvent['vehicle'], wake: FleetJourneyEvent['wake'] = LEGACY): FleetJourneyEvent =>
    ({ ...departure(vehicle, wake), kind: 'return', returnId: uuid(5) });
  const backEvent = back;
  const starterHome = { family: 'starter', presence: 'occupied' } as const;
  const balloonHome = { family: 'survey_balloon', tier: 1, presence: 'occupied' } as const;
  const cutterHome = { family: 'cargo_cutter', tier: 2, presence: 'occupied' } as const;
  const plan = (event: FleetJourneyEvent, installation: Parameters<typeof journeyPlanFor>[1], table = cosmetics) =>
    journeyPlanFor(event, installation, art, advanced, table);

  it('selects each installation\'s OWN authored track: starter and the nautical families carry the shared gate effect at their seat, the aerial families lift off without one; never another family\'s path', () => {
    const starterOut = plan(departure(STARTER), starterHome)!;
    expect(starterOut).toMatchObject({ kind: 'departure', fps: 8, wake: null });
    expect(starterOut.steps).toBe(art.tracks!.departure);
    expect(starterOut.fx).toMatchObject({ atlas: 'pe_fleet_starter', clipId: 'pe_fx_departure', stillFrame: 'pe_fx_departure_still_f1', attachmentPx: [56, 28] });
    expect(journeyDurationMs(starterOut)).toBe(1000);
    const starterBack = plan(back(STARTER), starterHome)!;
    expect(starterBack.steps).toBe(art.tracks!.return);
    expect(starterBack.fx).toMatchObject({ clipId: 'pe_fx_return', stillFrame: 'pe_fx_return_still_f1' });
    const balloon = plan(departure(BALLOON), balloonHome)!;
    expect(balloon.steps).toBe(advanced.tracks.get('survey_balloon')!.departure);
    expect(balloon.steps[7]).toEqual({ frame: 7, offsetPx: [0, -78], opacity: 0 });
    expect(balloon.fx).toBeNull();
    const cutter = plan(departure(CUTTER), cutterHome)!;
    expect(cutter.steps).toBe(advanced.tracks.get('cargo_cutter')!.departure);
    // The gate effects are authored once with the starter fleet and seated by the family's own effectAttachmentPx.
    expect(cutter.fx).toMatchObject({ atlas: 'pe_fleet_starter', clipId: 'pe_fx_departure', attachmentPx: [56, 28] });
    // Mismatches select nothing: a foreign family or tier, a return without its receipt, no admitted track or effect.
    expect(plan(departure(STARTER), balloonHome)).toBeNull();
    expect(plan(departure(BALLOON), starterHome)).toBeNull();
    expect(plan(departure({ family: 'survey_balloon', tier: 2 }), balloonHome)).toBeNull();
    expect(plan({ ...back(STARTER), returnId: undefined } as unknown as FleetJourneyEvent, starterHome)).toBeNull();
    expect(journeyPlanFor(departure(STARTER), starterHome, EMPTY_STARTER_FLEET_ART, advanced, cosmetics)).toBeNull();
    expect(journeyPlanFor(departure(CUTTER), cutterHome, EMPTY_STARTER_FLEET_ART, advanced, cosmetics), 'a named gate effect must be admitted').toBeNull();
    expect(journeyPlanFor(departure(BALLOON), balloonHome, EMPTY_STARTER_FLEET_ART, advanced, cosmetics), 'lift-off needs no starter art').not.toBeNull();
    expect(journeyPlanFor(departure(BALLOON), balloonHome, art, EMPTY_ADVANCED_FLEET_ART, cosmetics)).toBeNull();
  });

  it('draws the Wake only for an available ORIGINAL capture whose hashes equal the admitted Aurora binding; legacy, unavailable, a foreign output or any disagreement leaves the journey without one', () => {
    const withWake = plan(departure(STARTER, AVAILABLE()), starterHome)!;
    expect(withWake.wake).toMatchObject({ atlas: 'pe_cosmetics' });
    expect(withWake.wake!.clip).toMatchObject({ cellW: 64, cellH: 64, anchorPx: [32, 32], fps: 8 });
    expect(withWake.wake!.clip.frames).toHaveLength(8);
    expect(plan(departure(STARTER, LEGACY), starterHome)!.wake).toBeNull();
    expect(plan(departure(STARTER, UNAVAILABLE), starterHome)!.wake).toBeNull();
    expect(plan(departure(STARTER, AVAILABLE((a) => { a['bindingSha256'] = 'f'.repeat(64); })), starterHome)!.wake).toBeNull();
    expect(plan(departure(STARTER, AVAILABLE((a) => { a['sourceManifestSha256'] = '0'.repeat(64); })), starterHome)!.wake).toBeNull();
    expect(plan(departure(STARTER, AVAILABLE((a) => { a['sourceIndexSha256'] = '1'.repeat(64); })), starterHome)!.wake).toBeNull();
    expect(plan(departure(STARTER, AVAILABLE((a) => { a['outputId'] = 'artisan_market_awning_t1'; })), starterHome)!.wake).toBeNull();
    expect(plan(departure(STARTER, AVAILABLE()), starterHome, EMPTY_MARKET_ART)!.wake, 'no admitted cosmetics art').toBeNull();
    // Groups: the berth, the craft (even when the server already says away), the effect's and the Wake's.
    expect(journeyPlanGroups(starterComposition(art)!, withWake)).toEqual(['pe_fleet_starter', 'pe_cosmetics']);
    expect(journeyPlanGroups(advancedComposition(advanced, 'survey_balloon', 1)!, plan(departure(BALLOON), balloonHome)!)).toEqual(['pe_berth_survey_balloon', 'pe_veh_survey_balloon_t1']);
    expect(journeyPlanGroups(advancedComposition(advanced, 'cargo_cutter', 2)!, plan(departure(CUTTER, AVAILABLE()), cutterHome)!)).toEqual(['pe_berth_cargo_cutter', 'pe_veh_cargo_cutter_t2', 'pe_fleet_starter', 'pe_cosmetics']);
  });

  function departureHarness(extra: { reducedMotion?: boolean } = {}) {
    const h = harness('occupied', extra);
    const journey = plan(departure(STARTER, AVAILABLE()), starterHome)!;
    const onDone = vi.fn();
    const before = h.plays.length;
    expect(h.fx.playJourney(journey, onDone)).toBe(true);
    const since = h.plays.slice(before);
    const craft = since.find(([s, p]) => s === h.vehicles[0] && typeof p.onFrame === 'function');
    return { ...h, journey, onDone, since, craft };
  }

  it('departure: the craft one-shot cycles its docked frames over the eight authored steps at the track fps, moves by the authored offsets AND opacity, the Wake rides its contact and the gate effect bursts once at [56,28]; then it rests on the LATEST presence', () => {
    const { fx, berth, vehicles, effects, ticker, journey, onDone, since, craft } = departureHarness();
    const vehicle = vehicles[0]!;
    expect(vehicles).toHaveLength(1);
    expect(ticker.unregister).toHaveBeenCalledWith(vehicle);
    expect(craft![1]).toMatchObject({ atlas: 'pe_fleet_starter', base: 'pe_veh_starter_docked', fps: 8, loop: false });
    expect(craft![1].seq).toEqual(['pe_veh_starter_docked_f1', 'pe_veh_starter_docked_f2', 'pe_veh_starter_docked_f3', 'pe_veh_starter_docked_f4', 'pe_veh_starter_docked_f1', 'pe_veh_starter_docked_f2', 'pe_veh_starter_docked_f3', 'pe_veh_starter_docked_f4']);
    expect(craft![1].onFrame).toBeTypeOf('function');
    expect(craft![1].onComplete).toBeTypeOf('function');
    // Wake and effect are scene-owned sprites on their own groups.
    expect(effects.map((e) => e['atlas'])).toEqual(['pe_cosmetics', 'pe_fleet_starter']);
    const [wake, effect] = effects as [Record<string, unknown>, Record<string, unknown>];
    const wakePlay = since.find(([s]) => s === wake)![1];
    expect(wakePlay).toMatchObject({ atlas: 'pe_cosmetics', base: 'pe_cos_wake', fps: 8, loop: false });
    expect(wakePlay.seq).toEqual(Array.from({ length: 8 }, (_, i) => `pe_cos_wake_f${i + 1}`));
    expect(wake['setOrigin']).toHaveBeenCalledWith(0.5, 0.5);
    const effectPlay = since.find(([s]) => s === effect)![1];
    expect(effectPlay).toMatchObject({ atlas: 'pe_fleet_starter', base: 'pe_fx_departure', fps: 8, loop: false });
    expect(effectPlay.seq).toEqual(Array.from({ length: 8 }, (_, i) => `pe_fx_departure_f${i + 1}`));
    expect(effect['setOrigin']).toHaveBeenCalledWith(0.5, 0.5);
    // Berth origin is its cell bottom pivot [56,112]; the tidal gate at [56,28] is 84 px above it.
    expect(effect['x']).toBe(berth['x']); expect(effect['y']).toBe((berth['y'] as number) - 84);
    expect(effect['depth']).toBe((berth['depth'] as number) + 0.6);
    // Step through the authored track: dock [0,−34] plus each offset, alpha = opacity; the Wake follows exactly.
    for (const [index, step] of journey.steps.entries()) {
      craft![1].onFrame!(index + 1);
      expect(vehicle['x'], `step ${index}`).toBe((berth['x'] as number) + step.offsetPx[0]);
      expect(vehicle['y'], `step ${index}`).toBe((berth['y'] as number) - 34 + step.offsetPx[1]);
      expect(vehicle['alpha'], `step ${index}`).toBe(step.opacity);
      expect([wake['x'], wake['y'], wake['alpha']], `wake ${index}`).toEqual([vehicle['x'], vehicle['y'], step.opacity]);
    }
    expect(wake['depth']).toBe((berth['depth'] as number) + 0.4);
    expect(vehicle['y']).toBe((berth['y'] as number) - 34 - 40);
    // The server's poll already says away: the poll never yanks the departing craft back.
    fx.setPresence('away');
    expect(fx.journeyActive).toBe(true);
    expect(vehicle['destroy']).not.toHaveBeenCalled();
    craft![1].onComplete!();
    expect(fx.journeyActive).toBe(false);
    expect(onDone).toHaveBeenCalledOnce();
    expect(vehicle['destroy'], 'latest presence is away').toHaveBeenCalledOnce();
    expect(wake['destroy']).toHaveBeenCalledOnce(); expect(effect['destroy']).toHaveBeenCalledOnce();
    expect(ticker.unregister).toHaveBeenCalledWith(wake); expect(ticker.unregister).toHaveBeenCalledWith(effect);
  });

  it('return: the craft enters from the authored far step (offset −40, opacity 0) to the dock and rests on the docked loop; layout mid-flight re-seats the current step; cancel drops the sprites without finishing', () => {
    const { fx, plays, berth, vehicles, effects } = harness('away');
    fx.setPresence('occupied'); // the same response already reports the craft home
    const journey = plan(back(STARTER, AVAILABLE()), starterHome)!;
    const onDone = vi.fn();
    expect(fx.playJourney(journey, onDone)).toBe(true);
    const vehicle = vehicles[0]!;
    const craft = plays.filter(([s]) => s === vehicle).at(-1)![1];
    expect(craft).toMatchObject({ base: 'pe_veh_starter_docked', loop: false, fps: 8 });
    expect(vehicle['y']).toBe((berth['y'] as number) - 34 - 40); expect(vehicle['alpha']).toBe(0);
    expect(effects.map((e) => e['atlas'])).toEqual(['pe_cosmetics', 'pe_fleet_starter']);
    expect(plays.find(([s]) => s === effects[1])![1].base).toBe('pe_fx_return');
    craft.onFrame!(4);
    expect(vehicle['y']).toBe((berth['y'] as number) - 34 - 22); expect(vehicle['alpha']).toBe(0.85);
    Object.assign(berth, { x: 300, y: 700, scaleX: 2, scaleY: 2 });
    fx.layout();
    expect(vehicle['x']).toBe(300); expect(vehicle['y']).toBe(700 - 2 * (34 + 22)); expect(vehicle['alpha']).toBe(0.85);
    expect([effects[0]!['x'], effects[0]!['y']]).toEqual([vehicle['x'], vehicle['y']]);
    expect([effects[1]!['x'], effects[1]!['y']], 'effect seat scales with the berth').toEqual([300, 700 - 2 * 84]);
    craft.onFrame!(8);
    expect(vehicle['y']).toBe(700 - 2 * 34); expect(vehicle['alpha']).toBe(1);
    craft.onComplete!();
    expect(onDone).toHaveBeenCalledOnce();
    expect(vehicle['destroy']).not.toHaveBeenCalled();
    expect(plays.at(-1)![1]).toMatchObject({ base: 'pe_veh_starter_docked', loop: true, seq: ['pe_veh_starter_docked_f1', 'pe_veh_starter_docked_f2', 'pe_veh_starter_docked_f3', 'pe_veh_starter_docked_f4'] });
    // Cancel: a second journey abandoned mid-flight destroys its sprites, rests, and never reports completion.
    const again = vi.fn();
    fx.playJourney(plan(departure(STARTER, AVAILABLE()), starterHome)!, again);
    expect(effects).toHaveLength(4);
    fx.cancelJourney();
    expect(fx.journeyActive).toBe(false);
    expect(again).not.toHaveBeenCalled();
    expect(effects[2]!['destroy']).toHaveBeenCalledOnce(); expect(effects[3]!['destroy']).toHaveBeenCalledOnce();
    // The abandoned flight was an ACCEPTED departure: its outcome (away) rests, not the
    // stale pre-departure snapshot; a newer presence fact may re-dock the craft later.
    expect(vehicle['destroy']).toHaveBeenCalledOnce();
    expect(plays.at(-1)![1].base).toBe('pe_berth_starter_ambient');
  });

  it('reduced motion honours the authored contract: an immediate occupied↔away transition with no movement, the gate effect\'s authored still for the track\'s duration, no Wake; collapse mid-flight drops the journey with the berth', () => {
    const { fx, plays, vehicles, effects, onDone, craft } = departureHarness({ reducedMotion: true });
    expect(craft, 'no craft one-shot under reduced motion').toBeUndefined();
    fx.setPresence('away');
    expect(vehicles[0]!['destroy'], 'immediate transition to the latest presence').toHaveBeenCalledOnce();
    expect(effects.map((e) => e['atlas'])).toEqual(['pe_fleet_starter']);
    const still = plays.find(([s]) => s === effects[0])![1];
    expect(still).toMatchObject({ atlas: 'pe_fleet_starter', base: 'pe_fx_departure', fps: 8, loop: false });
    expect(still.seq).toEqual(Array.from({ length: 8 }, () => 'pe_fx_departure_still_f1'));
    still.onComplete!();
    expect(effects[0]!['destroy']).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
    // A lift-off family has no effect: reduced motion completes at once.
    const balloon = harness('occupied', { reducedMotion: true, composition: advancedComposition(advanced, 'survey_balloon', 1)! });
    const done = vi.fn();
    expect(balloon.fx.playJourney(plan(departure(BALLOON), balloonHome)!, done)).toBe(true);
    expect(done).toHaveBeenCalledOnce(); expect(balloon.effects).toHaveLength(0);
    // Collapse during a full-motion journey: effects and craft leave with the berth, nothing finishes.
    const live = departureHarness();
    live.fx.collapse();
    expect(live.fx.journeyActive).toBe(false);
    expect(live.onDone).not.toHaveBeenCalled();
    for (const sprite of [...live.effects, ...live.vehicles]) expect(sprite['destroy']).toHaveBeenCalledOnce();
    expect(live.plays.at(-1)![1].base).toBe('pe_berth_starter_destroyed');
    // No vehicle art: nothing to play.
    const bare: JourneyPlan = plan(departure(STARTER), starterHome)!;
    const noVehicle = harness('away', { composition: { ...starterComposition(art)!, vehicle: null } });
    expect(noVehicle.fx.playJourney(bare)).toBe(false);
  });

  it('an accepted departure outranks the snapshot it arrived with (completing with NO newer fact rests AWAY, never re-docked from the stale occupied snapshot); a return keeps the CURRENT post-settlement presence — exhausted stays exhausted, occupied stays occupied — also under reduced motion; a newer fact still wins', () => {
    expect(journeyOutcomePresence('departure')).toBe('away'); expect(journeyOutcomePresence('return')).toBeNull();
    // Departure from the originating (occupied) snapshot, no setPresence during or after the flight.
    const { fx, vehicles, effects, onDone, craft } = departureHarness();
    craft![1].onComplete!();
    expect(onDone).toHaveBeenCalledOnce();
    expect(vehicles[0]!['destroy'], 'the craft is gone, not re-docked from the stale snapshot').toHaveBeenCalledOnce();
    for (const sprite of effects) expect(sprite['destroy']).toHaveBeenCalledOnce();
    // The stale snapshot re-applying "occupied" is the SCENE's business to refuse; a genuinely newer fact re-docks.
    fx.setPresence('occupied');
    expect(vehicles).toHaveLength(2);
    // ACTUAL return contract: the response carrying the return already states the post-settlement
    // presence. An advanced craft's last use settles EXHAUSTED: the return flight plays, then the
    // authored exhausted still rests at the dock — never a pinned 'occupied'.
    const airshipHome = { family: 'courier_airship', tier: 2, presence: 'exhausted' } as const;
    const airship = { family: 'courier_airship', tier: 2 } as const;
    const spent = harness('exhausted', { composition: advancedComposition(advanced, 'courier_airship', 2)! });
    const done = vi.fn();
    expect(spent.fx.playJourney(plan(backEvent(airship), airshipHome)!, done)).toBe(true);
    const flight = spent.plays.filter(([s]) => s === spent.vehicles[0]).at(-1)![1];
    expect(flight).toMatchObject({ base: 'pe_veh_courier_airship_t2_docked', loop: false, fps: 8 });
    flight.onComplete!();
    expect(done).toHaveBeenCalledOnce();
    expect(spent.vehicles[0]!['destroy']).not.toHaveBeenCalled();
    expect(spent.plays.at(-1)![1]).toMatchObject({ base: 'pe_veh_courier_airship_t2_exhausted', seq: ['pe_veh_courier_airship_t2_exhausted_f1'], fps: 0 });
    // A return whose current fact is occupied rests on the docked loop (same rule, no pin either way).
    const home = harness('occupied');
    expect(home.fx.playJourney(plan(backEvent(STARTER), starterHome)!)).toBe(true);
    home.plays.filter(([s]) => s === home.vehicles[0]).at(-1)![1].onComplete!();
    expect(home.vehicles[0]!['destroy']).not.toHaveBeenCalled();
    expect(home.plays.at(-1)![1]).toMatchObject({ base: 'pe_veh_starter_docked', loop: true });
    // Reduced motion: an exhausted return transitions at once to the exhausted still.
    const spentReduced = harness('exhausted', { reducedMotion: true, composition: advancedComposition(advanced, 'courier_airship', 2)! });
    expect(spentReduced.fx.playJourney(plan(backEvent(airship), airshipHome)!)).toBe(true);
    expect(spentReduced.vehicles[0]!['destroy']).not.toHaveBeenCalled();
    expect(spentReduced.plays.filter(([s]) => s === spentReduced.vehicles[0]).at(-1)![1]).toMatchObject({ base: 'pe_veh_courier_airship_t2_exhausted', fps: 0 });
    // Reduced motion: the departure's outcome applies immediately.
    const reduced = harness('occupied', { reducedMotion: true });
    expect(reduced.fx.playJourney(plan(departure(STARTER), starterHome)!)).toBe(true);
    expect(reduced.vehicles[0]!['destroy']).toHaveBeenCalledOnce();
    // A newer presence fact during the flight still controls rest (the latest-presence rule is unchanged).
    const newer = departureHarness();
    newer.fx.setPresence('occupied'); // a newer fact says the craft is home after all
    newer.craft![1].onComplete!();
    expect(newer.vehicles[0]!['destroy']).not.toHaveBeenCalled();
    expect(newer.plays.at(-1)![1]).toMatchObject({ base: 'pe_veh_starter_docked', loop: true });
  });
});
