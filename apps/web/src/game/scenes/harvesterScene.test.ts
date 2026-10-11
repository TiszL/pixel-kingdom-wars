import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { type MarketArtChoice, type MarketArtTable, parseMarketArtMetadata } from '../world/marketArt';
import { HARVESTER_UNPRESENTED_KEY } from '../world/harvesterArt';
import { harvesterFixture } from '../world/harvesterArt.test-support';

vi.mock('phaser', () => ({ default: {
  Scene: class {},
  Display: { Color: class {} },
  Geom: { Rectangle: class {} },
  Math: { Clamp: (n: number, low: number, high: number) => Math.max(low, Math.min(high, n)), Distance: { Between: () => 0 } },
  Core: { Events: { RESUME: 'resume', BLUR: 'blur', HIDDEN: 'hidden' } },
  Scenes: { Events: { SHUTDOWN: 'shutdown', SLEEP: 'sleep', WAKE: 'wake' } },
  Scale: { Events: { RESIZE: 'resize' } },
} }));
vi.mock('../world/sceneVisualGate', () => ({ SceneVisualGate: class {} }));
const resident = vi.hoisted(() => new Set<string>());
vi.mock('../world/atlasLoader', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  isV2AtlasLoaded: (_scene: unknown, group: string) => resident.has(group),
}));

type Building = { id: string; type: string; level: number; tx: number; ty: number; underConstruction: boolean };
const building: Building = { id: 'realm-harvester', type: 'harvester', level: 6, tx: 2, ty: 3, underConstruction: false };
interface Seams {
  marketChoiceFor(building: Building): MarketArtChoice;
  spriteKeyFor(building: Building): string;
  footprintOf(key: string): { fw: number; fh: number };
  buildingSeat(key: string): { origin: readonly [number, number]; scale: number };
  syncMarketController(building: Building, sprite: unknown, job: string | null): void;
  requestSnapshotMarketArt(buildings: Building[]): Promise<void>[];
}
const originalBase = useApp.getState().base;
afterEach(() => { useApp.setState({ base: originalBase }); resident.clear(); vi.restoreAllMocks(); });
const art = (): MarketArtTable => parseMarketArtMetadata(undefined, undefined, undefined, harvesterFixture(true));
const home = (realmId: 'frostveil' | 'cinderfall' | 'seeker-reach'): void => {
  useApp.setState({ base: { visualContext: { version: 1, artVersion: 2, realmId } } as BaseStateDto });
};
function sceneFor(proto: Seams, table = art()) {
  return { marketArt: table, marketAwnings: new Map(), marketBuildings: new Map(),
    marketChoiceFor: proto.marketChoiceFor, meta: {}, v2meta: { clips: {} }, waremeta: { clips: {} },
    starterFleetArt: { clips: {} }, advancedFleetArt: { clips: {} },
    ticker: { unregister: vi.fn() }, wareTicker: { play: vi.fn(), unregister: vi.fn() } };
}

describe('Harvester renderer entry and residency', () => {
  it('selects the current home realm on every render, so switching kingdoms cannot reuse the prior realm texture', async () => {
    const { BaseScene } = await import('./BaseScene');
    const proto = BaseScene.prototype as unknown as Seams, scene = sceneFor(proto);
    home('frostveil');
    expect(proto.spriteKeyFor.call(scene, building)).toBe('pe_harvester_frostveil_t2_idle_f1');
    home('cinderfall');
    expect(proto.spriteKeyFor.call(scene, building)).toBe('pe_harvester_cinderfall_t2_idle_f1');
    home('seeker-reach');
    expect(proto.spriteKeyFor.call(scene, building)).toBe('pe_harvester_seeker_reach_t2_idle_f1');
    expect(proto.footprintOf.call(scene, 'pe_harvester_seeker_reach_t2_collapse_f9')).toEqual({ fw: 2, fh: 2 });
    expect(proto.buildingSeat.call(scene, 'pe_harvester_seeker_reach_t2_idle_f1')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
  });

  it('uses a hidden 2x2 fallback while approval is pending because no legacy Harvester frame exists', async () => {
    const { BaseScene } = await import('./BaseScene');
    const proto = BaseScene.prototype as unknown as Seams;
    home('frostveil');
    const scene = sceneFor(proto, parseMarketArtMetadata(undefined, undefined, undefined, harvesterFixture()));
    expect(proto.spriteKeyFor.call(scene, building)).toBe(HARVESTER_UNPRESENTED_KEY);
    expect(proto.footprintOf.call(scene, HARVESTER_UNPRESENTED_KEY)).toEqual({ fw: 2, fh: 2 });
  });

  it('creates no controller before residency and grants one exactly once when the selected realm group arrives', async () => {
    const { BaseScene } = await import('./BaseScene');
    const proto = BaseScene.prototype as unknown as Seams, scene = sceneFor(proto);
    const sprite = { active: true, setTexture: vi.fn() };
    home('frostveil');
    proto.syncMarketController.call(scene, building, sprite, null);
    expect(scene.marketBuildings.size).toBe(0);
    expect(scene.wareTicker.play).not.toHaveBeenCalled();
    resident.add('pe_harvester_frostveil_t2');
    proto.syncMarketController.call(scene, building, sprite, null);
    const controller = scene.marketBuildings.get(building.id);
    proto.syncMarketController.call(scene, building, sprite, null);
    expect(scene.marketBuildings.get(building.id)).toBe(controller);
    expect(scene.wareTicker.play).toHaveBeenCalledExactlyOnceWith(sprite, expect.objectContaining({ atlas: 'pe_harvester_frostveil_t2', seq: ['pe_harvester_frostveil_t2_idle_f1'] }));
  });

  it('uses the frozen defender realm for battle requests even while the selected home realm changes', async () => {
    const { BattleScene } = await import('./BattleScene');
    const proto = BattleScene.prototype as unknown as Seams;
    const scene = { ...sceneFor(proto), serviceVisualContext: { version: 1, artVersion: 2, realmId: 'frostveil' } };
    home('cinderfall');
    expect(proto.spriteKeyFor.call(scene, building)).toBe('pe_harvester_frostveil_t2_idle_f1');
    const request = vi.spyOn(BattleScene.prototype as unknown as { requestDefenseArtCandidates: (candidates: unknown[]) => Promise<void>[] }, 'requestDefenseArtCandidates').mockReturnValue([]);
    proto.requestSnapshotMarketArt.call(scene, [building]);
    expect(request).toHaveBeenCalledExactlyOnceWith([{ id: 'market:pe_harvester_frostveil_t2', kind: 'market', bodyGroup: 'pe_harvester_frostveil_t2', groups: ['pe_harvester_frostveil_t2'] }]);
    home('seeker-reach');
    expect(proto.spriteKeyFor.call(scene, building)).toBe('pe_harvester_frostveil_t2_idle_f1');
  });

  it('requests no battle art for a pending pack so the approval gate cannot leak through preloading', async () => {
    const { BattleScene } = await import('./BattleScene');
    const proto = BattleScene.prototype as unknown as Seams;
    const scene = { ...sceneFor(proto, parseMarketArtMetadata(undefined, undefined, undefined, harvesterFixture())), serviceVisualContext: undefined };
    const request = vi.spyOn(BattleScene.prototype as unknown as { requestDefenseArtCandidates: (candidates: unknown[]) => Promise<void>[] }, 'requestDefenseArtCandidates').mockReturnValue([]);
    proto.requestSnapshotMarketArt.call(scene, [building]);
    expect(request).toHaveBeenCalledExactlyOnceWith([]);
    expect(proto.spriteKeyFor.call(scene, building)).toBe(HARVESTER_UNPRESENTED_KEY);
  });

  it('connects Boot sidecar admission before base start and freezes defender context before any art request', () => {
    const boot = readFileSync(new URL('./BootScene.ts', import.meta.url), 'utf8');
    const registration = boot.indexOf('parseMarketArtMetadata(sidecar.peMarket');
    expect(registration).toBeGreaterThan(0);
    expect(boot.slice(registration, boot.indexOf("this.scene.start('base')", registration))).toContain('sidecar.peHarvesters');
    const battle = readFileSync(new URL('./BattleScene.ts', import.meta.url), 'utf8');
    const freeze = battle.indexOf('this.serviceVisualContext = data.visualContext');
    expect(freeze).toBeGreaterThan(0);
    expect(freeze).toBeLessThan(battle.indexOf('this.requestSnapshotMarketArt(data.snapshot.buildings)'));
  });
});
