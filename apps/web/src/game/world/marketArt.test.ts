/**
 * Market art table + Awning selection against the REAL generated manifests
 * (docs/evidence/2026-09-30-bound-cosmetic-visuals) and root's actual
 * current/frozen presentation fixture. The table is presentation only; every
 * refusal below keeps ordinary Market art and gameplay geometry usable.
 */
import { readFileSync } from 'node:fs';
import { STRUCTURES } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  AWNING_ATLAS_GROUP, EMPTY_MARKET_ART, MARKET_FRAME_KEY, awningClipId, marketArtClipId, marketArtFamilyOf,
  marketArtGroup, marketArtTierOfLevel, marketAtlasGroup, marketClipId, marketFrameFamily, marketRestFrameKey,
  marketSeat, parseMarketArtMetadata, selectMarketAwnings,
} from './marketArt';

const evidence = (name: string): unknown => JSON.parse(readFileSync(
  new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
));
const peMarket = evidence('pe_market.manifest.json');
const peCosmetics = evidence('pe_cosmetics.manifest.json');
const fixture = evidence('actual-presentation.fixture.json') as {
  currentBase: {
    boundCosmetics: unknown;
    buildings: Array<{ id: string; type: string; level: number; underConstruction: boolean }>;
  };
  pendingRaid: { boundCosmeticVisual: unknown; snapshot: { buildings: Array<{ id: string; type: string; level: number }> } };
  raid: { boundCosmeticVisual: unknown };
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const art = parseMarketArtMetadata(peMarket, peCosmetics);
const MARKET_ID = fixture.currentBase.buildings.find((b) => b.type === 'market')!.id;
const currentBuildings = fixture.currentBase.buildings;
const STATES = ['idle', 'construction', 'working', 'ready', 'damaged', 'collapse', 'destroyed'] as const;

describe('parseMarketArtMetadata', () => {
  it('parses both generated families with one-based keys, exact groups and the Awning bindings', () => {
    expect(Object.keys(art.clips)).toHaveLength(32 + 30);
    expect(Object.keys(art.bindings).sort()).toEqual([
      'artisan_market_awning_t1', 'artisan_market_awning_t2', 'artisan_market_awning_t3',
      'artisan_market_awning_t4', 'aurora_wake',
    ]);
    for (const tier of [1, 2, 3, 4]) {
      for (const state of STATES) {
        const ordinary = art.clips[marketClipId(tier, state)]!;
        const awning = art.clips[awningClipId(`artisan_market_awning_t${tier}` as never, state)]!;
        expect(ordinary.atlas).toBe(marketAtlasGroup(tier));
        expect(awning.atlas).toBe(AWNING_ATLAS_GROUP);
        for (const clip of [ordinary, awning]) {
          expect([clip.cellW, clip.cellH]).toEqual([112, 112]);
          expect(clip.anchorPx).toEqual([56, 112]);
          expect(clip.sourcePivot).toEqual([56, 104]);
          expect(clip.frames[0]).toMatch(/_f1$/);
          expect(clip.frames.every((key) => MARKET_FRAME_KEY.test(key))).toBe(true);
        }
      }
      // Ready aliases idle's packed cell plus the craft-success overlay at [24,0].
      expect(art.clips[marketClipId(tier, 'ready')]).toMatchObject({
        alias: marketClipId(tier, 'idle'), frames: [`pe_market_t${tier}_idle_f1`],
        overlay: { clip: `pe_market_t${tier}_ready_fx`, offset: [24, 0] },
      });
      expect(art.clips[marketClipId(tier, 'idle')]!.alias).toBeNull();
      expect(art.clips[awningClipId(`artisan_market_awning_t${tier}` as never, 'ready')]!.overlay)
        .toEqual({ clip: 'pe_cos_ready_fx', offset: [24, 0] });
      // Authored clocks: working 8f loop, construction/collapse 9f one-shot, statics fps 0.
      expect(art.clips[marketClipId(tier, 'working')]).toMatchObject({ fps: 8, loop: true, frames: expect.any(Array) });
      expect(art.clips[marketClipId(tier, 'working')]!.frames).toHaveLength(8);
      expect(art.clips[marketClipId(tier, 'construction')]).toMatchObject({ fps: 8, loop: false });
      expect(art.clips[marketClipId(tier, 'construction')]!.frames).toHaveLength(9);
      expect(art.clips[marketClipId(tier, 'collapse')]!.frames).toHaveLength(9);
      expect(art.clips[marketClipId(tier, 'destroyed')]).toMatchObject({ fps: 0, loop: false });
      expect(art.clips[marketClipId(tier, 'destroyed')]!.frames).toHaveLength(1);
      expect(art.clips[marketClipId(tier, 'damaged')]!.frames).toHaveLength(1);
      // Rubble is the Workshop rubble named by the source manifest, packed
      // inside the family (same pixels as the collapse's final frame).
      const binding = art.bindings[`artisan_market_awning_t${tier}`]!;
      expect(binding.clips.every((id) => art.clips[id])).toBe(true);
      expect(binding.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The generated wake clip rides the cosmetics group but is not a Market state.
    expect(art.clips['pe_cos_wake']?.atlas).toBe(AWNING_ATLAS_GROUP);
  });

  it('parses each family independently so a legacy or defective sidecar leaves the other usable', () => {
    expect(parseMarketArtMetadata(undefined, undefined)).toBe(EMPTY_MARKET_ART);
    const marketOnly = parseMarketArtMetadata(peMarket, undefined);
    expect(Object.keys(marketOnly.clips)).toHaveLength(32);
    expect(marketOnly.bindings).toEqual({});
    const cosmeticsOnly = parseMarketArtMetadata(null, peCosmetics);
    expect(Object.keys(cosmeticsOnly.clips)).toHaveLength(30);
    expect(Object.keys(cosmeticsOnly.bindings)).toHaveLength(5);
  });

  it.each([
    ['schema version', (m: Record<string, unknown>) => { m['schemaVersion'] = 2; }],
    ['zero-based keys', (m: Record<string, unknown>) => { m['keyIndexBase'] = 0; }],
    ['a frame key out of order', (m: Record<string, unknown>) => {
      const clip = (m['clips'] as Record<string, { frames: Array<{ key: string }> }>)['pe_market_t1_idle']!;
      clip.frames[0]!.key = 'pe_market_t1_idle_f2';
    }],
    ['a clip packed outside the declared groups', (m: Record<string, unknown>) => {
      const clips = m['clips'] as Record<string, { frames: Array<{ key: string }> }>;
      clips['pe_market_t9_idle'] = clone(clips['pe_market_t1_idle']!);
      clips['pe_market_t9_idle']!.frames.forEach((f, i) => { f.key = `pe_market_t9_idle_f${i + 1}`; });
    }],
    ['a reduced-motion frame past the clip', (m: Record<string, unknown>) => {
      (m['clips'] as Record<string, { reducedMotionFrame: number }>)['pe_market_t2_working']!.reducedMotionFrame = 8;
    }],
    ['a corrupt frame hash', (m: Record<string, unknown>) => {
      (m['clips'] as Record<string, { frames: Array<{ rgbaSha256: string }> }>)['pe_market_t3_idle']!.frames[0]!.rgbaSha256 = 'nope';
    }],
    ['an overlay naming a missing clip', (m: Record<string, unknown>) => {
      (m['clips'] as Record<string, { overlay: { clip: string } }>)['pe_market_t4_ready']!.overlay.clip = 'pe_market_t4_missing';
    }],
    ['an alias whose cells differ from the aliased clip', (m: Record<string, unknown>) => {
      (m['clips'] as Record<string, { alias: string }>)['pe_market_t4_ready']!.alias = 'pe_market_t4_damaged';
    }],
  ])('rejects the whole Market family on %s rather than animating half the tiers', (_label, corrupt) => {
    const broken = clone(peMarket) as Record<string, unknown>;
    corrupt(broken);
    const table = parseMarketArtMetadata(broken, peCosmetics);
    expect(Object.keys(table.clips).filter((id) => id.startsWith('pe_market_'))).toHaveLength(0);
    expect(Object.keys(table.clips)).toHaveLength(30);
  });

  it.each([
    ['a binding hash that is not hex', (m: Record<string, unknown>) => {
      (m['bindings'] as Record<string, { sha256: string }>)['artisan_market_awning_t1']!.sha256 = 'x';
    }],
    ['a binding whose outputId disagrees with its key', (m: Record<string, unknown>) => {
      (m['bindings'] as Record<string, { value: { outputId: string } }>)['artisan_market_awning_t1']!.value.outputId = 'artisan_market_awning_t2';
    }],
    ['a binding naming an unpacked clip', (m: Record<string, unknown>) => {
      (m['bindings'] as Record<string, { value: { clips: Array<{ id: string }> } }>)['artisan_market_awning_t2']!.value.clips.push({ id: 'pe_cos_market_t2_ghost' });
    }],
    ['the wrong atlas group', (m: Record<string, unknown>) => { m['atlas'] = 'pe_market_t1'; }],
  ])('rejects the whole cosmetics family on %s and keeps ordinary Market art', (_label, corrupt) => {
    const broken = clone(peCosmetics) as Record<string, unknown>;
    corrupt(broken);
    const table = parseMarketArtMetadata(peMarket, broken);
    expect(Object.keys(table.clips)).toHaveLength(32);
    expect(table.bindings).toEqual({});
  });
});

describe('Market tier, groups and seat', () => {
  it('maps completed levels to the four visual tiers through the shared boundary rule and clamps past the cap', () => {
    const per = STRUCTURES.market.maxLevel / 4;
    for (let level = 1; level <= STRUCTURES.market.maxLevel; level++) {
      expect(marketArtTierOfLevel(level)).toBe(Math.ceil(level / per));
    }
    expect(marketArtTierOfLevel(0)).toBe(1);
    expect(marketArtTierOfLevel(STRUCTURES.market.maxLevel + 7)).toBe(4);
  });

  it('selects the Awning family only for an applied choice and rests both on their idle f1 key', () => {
    const ordinary = { tier: 3, awning: null };
    const awning = { tier: 3, awning: 'artisan_market_awning_t3' as const };
    expect(marketArtGroup(ordinary)).toBe('pe_market_t3');
    expect(marketArtGroup(awning)).toBe(AWNING_ATLAS_GROUP);
    expect(marketArtClipId(ordinary, 'damaged')).toBe('pe_market_t3_damaged');
    expect(marketArtClipId(awning, 'damaged')).toBe('pe_cos_market_t3_damaged');
    expect(marketRestFrameKey(art, ordinary)).toBe('pe_market_t3_idle_f1');
    expect(marketRestFrameKey(art, awning)).toBe('pe_cos_market_t3_idle_f1');
    expect(marketRestFrameKey(EMPTY_MARKET_ART, ordinary)).toBeNull();
  });

  it('seats every Market/Awning frame at the full-cell bottom-centre at world scale 1 and no other key', () => {
    const seat = { origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] };
    expect(marketSeat(art, 'pe_market_t1_idle_f1')).toEqual(seat);
    expect(marketSeat(art, 'pe_cos_market_t4_collapse_f9')).toEqual(seat);
    expect(marketSeat(art, 'pe_market_t1_ready_fx_f1')).toBeNull(); // the overlay is not a body frame
    expect(marketSeat(art, 'bld_market_l1')).toBeNull();
    expect(marketSeat(art, 'pe_market_t1_idle_f1'.replace('t1', 't7'))).toBeNull();
    expect(marketSeat(EMPTY_MARKET_ART, 'pe_market_t1_idle_f1')).toBeNull();
  });
});

describe('selectMarketAwnings', () => {
  it('applies the fixture Awning to its completed Market from the current base and both frozen raid projections', () => {
    const current = selectMarketAwnings(art, fixture.currentBase.boundCosmetics, currentBuildings);
    expect(current).toEqual({ awnings: new Map([[MARKET_ID, 'artisan_market_awning_t1']]), unavailable: false });
    const frozenBuildings = fixture.pendingRaid.snapshot.buildings.map((b) => ({ ...b, underConstruction: false }));
    expect(selectMarketAwnings(art, fixture.pendingRaid.boundCosmeticVisual, frozenBuildings).awnings.get(MARKET_ID))
      .toBe('artisan_market_awning_t1');
    expect(selectMarketAwnings(art, fixture.raid.boundCosmeticVisual, frozenBuildings).awnings.get(MARKET_ID))
      .toBe('artisan_market_awning_t1');
  });

  it('draws ordinary art for legacy absence and for a verified empty visual without flagging either', () => {
    expect(selectMarketAwnings(art, undefined, currentBuildings)).toEqual({ awnings: new Map(), unavailable: false });
    const off = { state: 'available', visual: { version: 1, marketAwnings: [] } };
    expect(selectMarketAwnings(art, off, currentBuildings)).toEqual({ awnings: new Map(), unavailable: false });
  });

  it('flags an explicit unavailable read as ordinary-but-unverified, never a verified off', () => {
    const read = { state: 'unavailable', visual: null };
    expect(selectMarketAwnings(art, read, currentBuildings)).toEqual({ awnings: new Map(), unavailable: true });
  });

  type Refusal = {
    label: string;
    corrupt?: (raw: never) => void;
    remap?: (buildings: typeof currentBuildings) => typeof currentBuildings;
  };
  const refusals: Refusal[] = [
    { label: 'an unowned next tier on a level-1 Market', corrupt: (r: { visual: { marketAwnings: Array<{ appearance: { outputId: string } }> } }) => {
      r.visual.marketAwnings[0]!.appearance.outputId = 'artisan_market_awning_t2';
    } },
    { label: 'an Awning on a Market still under initial construction', remap: (buildings) =>
      buildings.map((b) => (b.id === MARKET_ID ? { ...b, underConstruction: true } : b)) },
    { label: 'an Awning naming a building that is not a Market', corrupt: (r: { visual: { marketAwnings: Array<{ buildingId: string }> } }) => {
      r.visual.marketAwnings[0]!.buildingId = currentBuildings.find((b) => b.type === 'workshop')!.id;
    } },
    { label: 'a binding hash the generated art does not carry', corrupt: (r: { visual: { marketAwnings: Array<{ appearance: { bindingSha256: string } }> } }) => {
      r.visual.marketAwnings[0]!.appearance.bindingSha256 = 'f'.repeat(64);
    } },
    { label: 'a source manifest hash from another asset build', corrupt: (r: { visual: { marketAwnings: Array<{ appearance: { sourceManifestSha256: string } }> } }) => {
      r.visual.marketAwnings[0]!.appearance.sourceManifestSha256 = '0'.repeat(64);
    } },
    { label: 'a malformed projection', corrupt: (r: Record<string, unknown>) => { r['state'] = 'applied'; } },
  ];
  it.each(refusals)('refuses $label whole: ordinary art, flagged unverified, no partial application', ({ corrupt, remap }) => {
    const raw = clone(fixture.currentBase.boundCosmetics) as never;
    corrupt?.(raw);
    const buildings = remap ? remap(currentBuildings) : currentBuildings;
    expect(selectMarketAwnings(art, raw, buildings)).toEqual({ awnings: new Map(), unavailable: true });
  });

  it('refuses an applied Awning whose family is absent from this client\'s table', () => {
    const marketOnly = parseMarketArtMetadata(peMarket, undefined);
    expect(selectMarketAwnings(marketOnly, fixture.currentBase.boundCosmetics, currentBuildings))
      .toEqual({ awnings: new Map(), unavailable: true });
  });
});

describe('ordinary Workshop/Lodge families (P5)', () => {
  const serviceFixture = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_service_buildings.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown> & { clips: Record<string, Record<string, unknown>>; bindings: Record<string, unknown> };
  const withServices = (mutate: (table: typeof serviceFixture) => void = () => {}) => {
    const table = clone(serviceFixture); mutate(table);
    return parseMarketArtMetadata(peMarket, peCosmetics, table);
  };
  const full = withServices();

  it('adds the two service families (64 clips, eight 1x groups) to the accepted Market table without touching its 62 clips or 5 bindings', () => {
    expect(Object.keys(full.clips)).toHaveLength(62 + 64);
    expect(Object.keys(full.bindings)).toHaveLength(5);
    for (const family of ['workshop', 'lodge'] as const) for (const tier of [1, 2, 3, 4]) {
      for (const state of STATES) expect(full.clips[`pe_${family}_t${tier}_${state}`], `${family} t${tier} ${state}`).toBeDefined();
      expect(full.clips[`pe_${family}_t${tier}_idle`]).toMatchObject({ atlas: `pe_${family}_t${tier}`, cellW: 112, cellH: 112, anchorPx: [56, 112], sourcePivot: [56, 104], fps: 0, loop: false });
    }
    // Lodge ready = idle alias + craft-success overlay [24,0]; Workshop ready = a distinct still with neither.
    expect(full.clips['pe_lodge_t1_ready']).toMatchObject({ alias: 'pe_lodge_t1_idle', overlay: { clip: 'pe_lodge_t1_ready_fx', offset: [24, 0] } });
    expect(full.clips['pe_workshop_t1_ready']).toMatchObject({ alias: null, overlay: null, frames: ['pe_workshop_t1_ready_f1'] });
    // Nothing in the accepted Market/Awning parse changed (same clip objects, same frames).
    expect(full.clips['pe_market_t1_working']).toEqual(art.clips['pe_market_t1_working']);
    expect(art.clips['pe_market_t1_working']!.playbackFrameIndices).toBeNull();
  });

  it('D1: an absent reducedMotionFrame reads as frame 0 only inside the validated service table; an explicit invalid value still refuses', () => {
    expect(serviceFixture.clips['pe_workshop_t1_working']!['reducedMotionFrame']).toBeUndefined();
    expect(full.clips['pe_workshop_t1_working']!.reducedMotionFrame).toBe(0);
    expect(full.clips['pe_lodge_t4_collapse']!.reducedMotionFrame).toBe(0);
    expect(withServices((t) => { t.clips['pe_workshop_t1_working']!['reducedMotionFrame'] = 9; }).clips['pe_workshop_t1_idle']).toBeUndefined();
    expect(withServices((t) => { t.clips['pe_workshop_t1_working']!['reducedMotionFrame'] = -1; }).clips['pe_workshop_t1_idle']).toBeUndefined();
    // The Market families keep requiring the authored field: the policy is not theirs.
    const marketMissing = clone(peMarket) as { clips: Record<string, Record<string, unknown>> };
    delete marketMissing.clips['pe_market_t1_working']!['reducedMotionFrame'];
    expect(parseMarketArtMetadata(marketMissing, peCosmetics, serviceFixture).clips['pe_market_t1_idle']).toBeUndefined();
  });

  it('D2: authored playback indices are validated and carried; the Workshop working loop is 0..7 and construction/collapse 0..8', () => {
    expect(full.clips['pe_workshop_t1_working']).toMatchObject({ playbackFrameIndices: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(full.clips['pe_workshop_t1_working']!.frames).toHaveLength(9);
    expect(full.clips['pe_workshop_t2_construction']!.playbackFrameIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(full.clips['pe_lodge_t1_working']!.playbackFrameIndices).toBeNull();
    for (const bad of [[], [0, 0], [1, 0], [0, 9], [0, 1.5], 'nope']) {
      expect(withServices((t) => { t.clips['pe_workshop_t1_working']!['playbackFrameIndices'] = bad; }).clips['pe_workshop_t1_idle'], JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('refuses a defective service table as a whole and leaves the Market/Awning families untouched', () => {
    const marketOnly = parseMarketArtMetadata(peMarket, peCosmetics);
    for (const [label, mutate] of [
      ['a foreign family list', (t: typeof serviceFixture) => { t['families'] = ['workshop']; }],
      ['a foreign atlas', (t: typeof serviceFixture) => { (t['atlases'] as string[])[0] = 'pe_market_t1'; }],
      ['a missing state', (t: typeof serviceFixture) => { delete t.clips['pe_lodge_t3_damaged']; }],
      ['a foreign clip id', (t: typeof serviceFixture) => { t.clips['pe_workshop_t5_idle'] = t.clips['pe_workshop_t4_idle']!; }],
      ['a bad index hash', (t: typeof serviceFixture) => { t['indexSha256'] = 'nope'; }],
      ['a bad provenance record', (t: typeof serviceFixture) => { t['provenanceSha256'] = { workshop: 'nope', lodge: 'x' }; }],
      ['a provenance record missing a family', (t: typeof serviceFixture) => { delete (t['provenanceSha256'] as Record<string, string>)['lodge']; }],
      ['a manifest record that is a bare string', (t: typeof serviceFixture) => { t['sourceManifestSha256'] = '0'.repeat(64); }],
      ['a binding manifest outside the table sources', (t: typeof serviceFixture) => { ((t.bindings['pe_workshop_t3'] as { value: Record<string, unknown> }).value)['sourceManifestSha256'] = '0'.repeat(64); }],
      ['a binding with another provenance', (t: typeof serviceFixture) => { ((t.bindings['pe_lodge_t2'] as { value: Record<string, unknown> }).value)['sourceIndexSha256'] = '0'.repeat(64); }],
      ['a binding naming an unknown clip', (t: typeof serviceFixture) => { ((t.bindings['pe_lodge_t2'] as { value: { clips: unknown[] } }).value).clips.push('pe_lodge_t2_missing'); }],
      ['a missing binding', (t: typeof serviceFixture) => { delete t.bindings['pe_workshop_t1']; }],
      ['a bad key index base', (t: typeof serviceFixture) => { t['keyIndexBase'] = 0; }],
    ] as const) {
      const table = withServices(mutate);
      expect(Object.keys(table.clips), label).toEqual(Object.keys(marketOnly.clips));
    }
    expect(parseMarketArtMetadata(peMarket, peCosmetics, undefined)).toEqual(marketOnly);
    expect(parseMarketArtMetadata(undefined, undefined, serviceFixture).clips['pe_lodge_t1_idle']).toBeDefined();
  });

  it('family-aware helpers: type → family, tier rule, groups, clip ids, rest keys, seats and frame keys; Awnings stay Market-only', () => {
    expect(marketArtFamilyOf('workshop')).toBe('workshop'); expect(marketArtFamilyOf('lodge')).toBe('lodge');
    expect(marketArtFamilyOf('market')).toBe('market'); expect(marketArtFamilyOf('berth')).toBeNull(); expect(marketArtFamilyOf('keep')).toBeNull();
    expect(marketArtTierOfLevel(1, 'workshop')).toBe(1); expect(marketArtTierOfLevel(6, 'lodge')).toBe(2); expect(marketArtTierOfLevel(20, 'lodge')).toBe(4); expect(marketArtTierOfLevel(99, 'workshop')).toBe(4);
    expect(marketAtlasGroup(2, 'lodge')).toBe('pe_lodge_t2'); expect(marketClipId(3, 'collapse', 'workshop')).toBe('pe_workshop_t3_collapse');
    expect(marketArtGroup({ family: 'workshop', tier: 3, awning: null })).toBe('pe_workshop_t3');
    expect(marketArtClipId({ family: 'lodge', tier: 1, awning: null }, 'damaged')).toBe('pe_lodge_t1_damaged');
    // A stray Awning on a non-Market family is ignored, never applied.
    expect(marketArtGroup({ family: 'workshop', tier: 1, awning: 'artisan_market_awning_t1' })).toBe('pe_workshop_t1');
    expect(marketArtClipId({ family: 'lodge', tier: 1, awning: 'artisan_market_awning_t1' }, 'idle')).toBe('pe_lodge_t1_idle');
    expect(marketRestFrameKey(full, { family: 'workshop', tier: 4, awning: null })).toBe('pe_workshop_t4_idle_f1');
    expect(marketRestFrameKey(art, { family: 'workshop', tier: 4, awning: null }), 'no service art → no rest key').toBeNull();
    expect(marketSeat(full, 'pe_lodge_t1_working_f4')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    expect(marketSeat(full, 'pe_workshop_t2_ready_fx_f3'), 'an overlay is not a body frame (Market rule kept)').toBeNull();
    expect(marketFrameFamily('pe_workshop_t2_ready_fx_f3')).toBeNull();
    for (const key of ['pe_workshop_t1_collapse_f9', 'pe_lodge_t4_idle_f1', 'pe_market_t1_idle_f1', 'pe_cos_market_t1_idle_f1']) expect(MARKET_FRAME_KEY.test(key), key).toBe(true);
    for (const key of ['bld_workshop_l1', 'pe_berth_starter_intact_f1', 'pe_fleet_t1_idle_f1']) expect(MARKET_FRAME_KEY.test(key), key).toBe(false);
    expect(marketFrameFamily('pe_workshop_t1_idle_f1')).toBe('workshop'); expect(marketFrameFamily('pe_cos_market_t1_idle_f1')).toBe('market'); expect(marketFrameFamily('bld_lodge_l1')).toBeNull();
    // Defaults keep every accepted Market caller exact.
    expect(marketArtGroup({ tier: 2, awning: null })).toBe('pe_market_t2');
    expect(marketArtClipId({ tier: 2, awning: 'artisan_market_awning_t2' }, 'idle')).toBe('pe_cos_market_t2_idle');
  });
});
