import { readFileSync } from 'node:fs';
import type Phaser from 'phaser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureV2Atlases, onDemandAtlasState, releaseAtlasGroups,
  releaseUnreferencedAtlases, retainAtlasGroups,
} from '../world/atlasLoader';
import { optionalV2TroopAtlasGroups, requiredV2TroopAtlasGroups } from '../v2/troop';
import { ON_DEMAND_ART_BUDGET_BYTES } from '../world/artBudget';
import { BattleScene } from './BattleScene';

vi.mock('phaser', () => ({ default: {
  Scene: class {}, Core: { Events: { RESUME: 'resume' } },
  Scenes: { Events: { SHUTDOWN: 'shutdown' } }, Scale: { Events: { RESIZE: 'resize' } },
  Math: { Clamp: (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n)) },
} }));

const atlasRoot = new URL('../../../public/atlas/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('meta.json', atlasRoot), 'utf8'));
type LoadedTexture = { key: string; source: Array<{ width: number; height: number }> };
class Textures {
  entries = new Map<string, LoadedTexture>();
  exists(key: string): boolean { return this.entries.has(key); }
  get(key: string): LoadedTexture { return this.entries.get(key) ?? { key: '__MISSING', source: [] }; }
  addAtlas(key: string, image: { width: number; height: number }): void {
    this.entries.set(key, { key, source: [{ width: image.width, height: image.height }] });
  }
  remove(key: string): void { this.entries.delete(key); }
}

function fixture() {
  const textures = new Textures();
  const scenes: unknown[] = [];
  const game = { scene: { scenes }, renderer: {} };
  const events = { once: vi.fn(), off: vi.fn() };
  let active = true;
  const scene = new BattleScene() as unknown as Record<string, any>;
  Object.assign(scene, {
    textures, game, events, registry: { get: () => undefined },
    cache: { json: { remove: vi.fn() } }, children: { list: [] },
    scene: { isActive: () => active }, time: { now: 0 },
    armyLevels: { giant: 1, hexbarrow: 1, barrowling: 1, direwyvern: 1 },
    v2meta: { clips: meta.v2Clips, atlasBytes: meta.atlasBytes, breathStream: meta.breathStream },
    rebuildDeployMarks: vi.fn(), stopHoldDeploy: vi.fn(), resetPauseCatchUp: vi.fn(),
    clearTransientFx: vi.fn(), releaseDragonDeploymentSfxBank: vi.fn(),
    releaseProductionSfxBanks: vi.fn(),
  });
  const base = { textures, game, children: { list: [] } } as unknown as Phaser.Scene;
  scenes.push(base, scene);
  const decoded = new Map<string, { width: number; height: number }>();
  const blobs = new WeakMap<Blob, string>();
  const controls: { fail: boolean; wait: Promise<void> | null } = { fail: false, wait: null };
  vi.stubGlobal('fetch', async (input: string) => {
    await controls.wait;
    if (controls.fail) throw new Error('offline');
    const match = /\/([^/]+)@1x\.(png|json)/.exec(input)!;
    const group = match[1]!;
    const json = readFileSync(new URL(`${group}@1x.json`, atlasRoot), 'utf8');
    const { w, h } = JSON.parse(json).textures[0].size;
    decoded.set(`blob:${group}`, { width: w, height: h });
    const blob = new Blob([match[2] === 'json' ? json : group]);
    blobs.set(blob, group);
    return { ok: true, blob: async () => blob };
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${blobs.get(blob as Blob)}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  class DecodedImage {
    width = 0; height = 0; naturalWidth = 0; naturalHeight = 0;
    set src(value: string) {
      const size = decoded.get(value); if (!size) return;
      this.width = this.naturalWidth = size.width; this.height = this.naturalHeight = size.height;
    }
    async decode(): Promise<void> {}
  }
  vi.stubGlobal('Image', DecodedImage);
  return { scene, base, textures, controls, deactivate: () => { active = false; } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function expectSurvives(base: Phaser.Scene, groups: string[]): void {
  releaseUnreferencedAtlases(base); // sleeping BaseScene's ordinary refresh
  releaseAtlasGroups(base, groups); // its delayed unadopted candidate cleanup
  for (const group of groups) expect(base.textures.exists(group), group).toBe(true);
  expect(onDemandAtlasState(base).bytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
}

describe('battle dependency lifetime between actor events', () => {
  it('keeps an undeployed reserve and its compact effects through home-base cleanup', async () => {
    const { scene, base, textures } = fixture();
    await scene.requestV2TroopLocomotionArt(['giant']);
    const groups = [...onDemandAtlasState(scene as Phaser.Scene).groups];
    expect(groups).toContain('v2trp_giant_t1_combatcore');
    expect(groups).toContain('v2trp_giant_t1_compactfx');
    expectSurvives(base, groups);
    expect(scene.v2TroopDepsOf('giant')?.compact).toBe(true);
    expect(textures.get('v2trp_giant_t1_combatcore').key).not.toBe('__MISSING');
  });

  it('keeps rich Hexbarrow future brood states before the first minion exists', async () => {
    const { scene, base } = fixture();
    await scene.requestV2TroopArt('hexbarrow');
    expect(scene.v2TroopTiers.get('hexbarrow')).toBe(1);
    expect(scene.v2TroopTiers.get('barrowling')).toBe(1);
    const groups = [...new Set(['v2fx', ...requiredV2TroopAtlasGroups('hexbarrow', 1),
      ...requiredV2TroopAtlasGroups('barrowling', 1)])];
    expectSurvives(base, groups);
    expect(scene.v2TroopDepsOf('barrowling', 101, 1, 3)?.variant).toBe(3);
  });

  it('keeps accepted optional Dire lifecycle sheets between animation states', async () => {
    const { scene, base } = fixture();
    const core = scene.requestV2TroopArt('direwyvern');
    await core;
    await scene.requestV2DireEnhancementArt(core);
    const groups = optionalV2TroopAtlasGroups('direwyvern', 1);
    expect(groups.length).toBeGreaterThan(0);
    expectSurvives(base, groups);
  });

  it('releases once on cleanup and starts the next raid without keeping previous art', async () => {
    const { scene, base, textures } = fixture();
    await scene.requestV2TroopLocomotionArt(['giant']);
    const releaseBase = retainAtlasGroups(base, ['v2trp_giant_t1_compactfx']);
    scene.cleanupBattle(); scene.cleanupBattle();
    expect(textures.exists('v2trp_giant_t1_combatcore')).toBe(false);
    expect(textures.exists('v2trp_giant_t1_compactfx')).toBe(true);
    expect(scene.v2TroopLocomotionTiers.size).toBe(0);
    releaseBase(); releaseUnreferencedAtlases(base);
    expect(onDemandAtlasState(base).bytes).toBe(0);
    scene.battleCleanedUp = false;
    await scene.requestV2TroopLocomotionArt(['giant']);
    expectSurvives(base, ['v2trp_giant_t1_combatcore']);
    scene.cleanupBattle();
    expect(onDemandAtlasState(base).bytes).toBe(0);
  });

  it('does not retain failed or late inactive admissions', async () => {
    const first = fixture(); first.controls.fail = true;
    await first.scene.requestV2TroopLocomotionArt(['giant']);
    expect(first.scene.v2TroopLocomotionTiers.size).toBe(0);
    expect(onDemandAtlasState(first.base).bytes).toBe(0);
    first.controls.fail = false;
    await ensureV2Atlases(first.scene as Phaser.Scene, ['v2trp_giant_t1_combatcore']);
    releaseUnreferencedAtlases(first.base);
    expect(first.textures.exists('v2trp_giant_t1_combatcore')).toBe(false);

    const next = fixture(); let unblock!: () => void;
    next.controls.wait = new Promise<void>((resolve) => { unblock = resolve; });
    const request = next.scene.requestV2TroopLocomotionArt(['giant']);
    next.deactivate(); next.scene.artLifecycleEpoch++;
    unblock(); await request;
    expect(next.scene.v2TroopLocomotionTiers.size).toBe(0);
    expect(onDemandAtlasState(next.base).bytes).toBe(0);
  });
});
