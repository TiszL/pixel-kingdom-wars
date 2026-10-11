import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { atlasGroupFor, eagerAtlasScale } from '@shardkeep/shared';
import { parseHarvesterArtMetadata, HARVESTER_UNPRESENTED_KEY } from './harvesterArt';
import { marketArtFamilyOf, marketArtGroup, marketArtTierOfLevel, marketFrameFamily, marketRestFrameKey, marketSeat, parseMarketArtMetadata } from './marketArt';
import { harvesterFixture, harvesterManifestBytes, type RawHarvesterManifest } from './harvesterArt.test-support';

describe('Harvester owner-art admission and geometry', () => {
  it('preserves the actual pending export bytes so tests cannot silently promote owner art', () => {
    expect(createHash('sha256').update(harvesterManifestBytes).digest('hex')).toBe('de576d736894d8363b736eca165689f29b09fb7984f29e7143f2ee86de7febfa');
    expect(harvesterFixture()).toMatchObject({ runtimeReady: false, sourceStatus: 'complete_export_pending_owner_art_approval' });
    expect(parseHarvesterArtMetadata(harvesterFixture()).clips).toEqual({});
  });

  it.each([undefined, null, {}, { runtimeReady: 'true' }])('fails closed for absent or malformed metadata because packed files are not admission (%s)', raw => {
    expect(parseHarvesterArtMetadata(raw).clips).toEqual({});
  });

  it('reads all actual frames after explicit readiness promotion without synthesizing pixels or aliases', () => {
    const art = parseHarvesterArtMetadata(harvesterFixture(true));
    expect(Object.keys(art.clips)).toHaveLength(224);
    expect(Object.values(art.clips).reduce((sum, clip) => sum + clip.frames.length, 0)).toBe(992);
    expect(art.bindings).toEqual({}); // These are not cosmetic ownership bindings.
    const work = art.clips['pe_harvester_frostveil_t1_working']!;
    expect(work).toMatchObject({ atlas: 'pe_harvester_frostveil_t1', cellW: 112, cellH: 112, anchorPx: [56, 112], sourcePivot: [56, 104], fps: 8, loop: true, reducedMotionFrame: 0 });
    expect(work.frames).toHaveLength(9);
    expect(work.playbackFrameIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(art.clips['pe_harvester_frostveil_t1_ready']!.frames).toEqual(['pe_harvester_frostveil_t1_ready_f1']);
    expect(art.clips['pe_harvester_frostveil_t1_ready']!.overlay).toBeNull(); // ready FX is already composed.
  });

  const corruptions: Array<[string, (raw: RawHarvesterManifest) => void]> = [
    ['wrong schema', raw => { raw['schemaVersion'] = 2; }],
    ['wrong source scale', raw => { raw['sourceScale'] = 2; }],
    ['wrong key index base', raw => { raw['keyIndexBase'] = 0; }],
    ['unknown realm atlas', raw => { raw.atlases[0] = 'pe_harvester_unknown_t1'; }],
    ['duplicate atlas', raw => { raw.atlases[1] = raw.atlases[0]!; }],
    ['missing tier state', raw => { delete raw.clips['pe_harvester_cinderfall_t4_collapse']; }],
    ['cross-realm frame', raw => { raw.clips['pe_harvester_frostveil_t1_idle']!.frames[0]!.key = 'pe_harvester_elderwood_t1_idle_f1'; }],
    ['invalid digest', raw => { raw.clips['pe_harvester_frostveil_t1_idle']!.frames[0]!.rgbaSha256 = 'bad'; }],
    ['wrong source index', raw => { raw.clips['pe_harvester_frostveil_t1_idle']!.frames[0]!.sourceIndex = 1; }],
    ['out of range playback', raw => { raw.clips['pe_harvester_frostveil_t1_working']!['playbackFrameIndices'] = [0, 9]; }],
    ['invalid anchor', raw => { raw.clips['pe_harvester_frostveil_t1_idle']!['anchorPx'] = [56, Infinity]; }],
    ['explicit invalid reduced frame', raw => { raw.clips['pe_harvester_frostveil_t1_idle']!['reducedMotionFrame'] = 1; }],
    ['cross-family binding', raw => { raw.bindings['pe_harvester_frostveil_t1']!.value['family'] = 'market'; }],
    ['changed binding provenance', raw => { raw.bindings['pe_harvester_frostveil_t1']!.value['sourceManifestSha256'] = '0'.repeat(64); }],
    ['missing binding', raw => { delete raw.bindings['pe_harvester_frostveil_t1']; }],
  ];
  it.each(corruptions)('refuses the whole Harvester family on %s so siblings never imply a valid partial pack', (_why, corrupt) => {
    const raw = harvesterFixture(true); corrupt(raw);
    expect(parseHarvesterArtMetadata(raw).clips).toEqual({});
  });

  it('keeps each realm/tier in its 1x group and at the authored full-cell seat, including hyphenated Seeker Reach', () => {
    const art = parseHarvesterArtMetadata(harvesterFixture(true));
    expect(marketArtFamilyOf('harvester')).toBe('harvester');
    for (const realm of REALM_IDS) for (const tier of [1, 2, 3, 4]) {
      const choice = { family: 'harvester' as const, realm, tier, awning: null };
      const group = `pe_harvester_${realm.replace('-', '_')}_t${tier}`;
      const frame = `${group}_idle_f1`;
      expect(marketArtGroup(choice)).toBe(group);
      expect(marketRestFrameKey(art, choice)).toBe(frame);
      expect(atlasGroupFor(frame)).toBe(group);
      expect(eagerAtlasScale(group)).toBe(1);
      expect(marketFrameFamily(frame)).toBe('harvester');
      expect(marketSeat(art, frame)).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    }
    expect(marketFrameFamily(HARVESTER_UNPRESENTED_KEY)).toBe('harvester');
  });

  it('uses completed-level tier boundaries and refuses cosmetic awnings for a Harvester', () => {
    expect([1, 5, 6, 10, 11, 15, 16, 20, 99].map(level => marketArtTierOfLevel(level, 'harvester'))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4]);
    expect(marketArtGroup({ family: 'harvester', realm: 'frostveil', tier: 1, awning: 'artisan_market_awning_t1' })).toBe('pe_harvester_frostveil_t1');
  });

  it('merges the admitted Harvester family independently and never lets pending art poison existing families', () => {
    const admitted = parseMarketArtMetadata(undefined, undefined, undefined, harvesterFixture(true));
    expect(Object.keys(admitted.clips)).toHaveLength(224);
    const pending = parseMarketArtMetadata(undefined, undefined, undefined, harvesterFixture());
    expect(pending.clips).toEqual({});
  });
});
