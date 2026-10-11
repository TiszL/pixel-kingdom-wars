import { readFileSync } from 'node:fs';

import { AUDIO_RUNTIME } from '@shardkeep/shared';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  DRAGON_BATTLE_WARM_SFX, musicTrackForScreen, productionDefinitionsFromManifest,
  ambienceFamilyForScreen, productionFamilyForLegacySfx,
  setMusic, setMusicScreen, SfxEngine, type LegacySfx, type Sfx,
} from './audio';
import { BUILD } from './version';

class FakeGain {
  gain = { value: 1 };
  connect<T>(target: T): T { return target; }
  disconnect(): void { /* observed through source lifecycle */ }
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  started = 0;
  stopped = 0;
  connect<T>(target: T): T { return target; }
  disconnect(): void { /* no-op */ }
  start(): void { this.started++; }
  stop(): void { this.stopped++; }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 1;
  destination = {} as AudioDestinationNode;
  readonly sources: FakeSource[] = [];
  decodedLength = 44_100;
  constructor() { FakeAudioContext.instances.push(this); }
  createGain(): GainNode { return new FakeGain() as unknown as GainNode; }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  async decodeAudioData(): Promise<AudioBuffer> {
    return {
      length: this.decodedLength,
      numberOfChannels: 1,
      sampleRate: 44_100,
      duration: this.decodedLength / 44_100,
    } as AudioBuffer;
  }
  async resume(): Promise<void> { this.state = 'running'; }
}

function installSfxFakes(
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  FakeAudioContext.instances = [];
  // Version refresh imports the session-aware API; keep the browser event
  // surface available while replacing only audio hardware in this fixture.
  vi.stubGlobal('window', { AudioContext: FakeAudioContext, addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
  });
  vi.stubGlobal('fetch', vi.fn(fetchImpl ?? (async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as Response))));
}

async function flushAudio(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function gesture(type = 'pointerdown'): void {
  const listener = vi.mocked(window.addEventListener).mock.calls.find(([event]) => event === type)?.[1];
  expect(listener).toBeTypeOf('function');
  (listener as EventListener)(new Event(type));
}

const MANY_CUES: readonly Sfx[] = [
  'sfx_tap', 'sfx_confirm', 'sfx_error', 'sfx_claim_chime', 'sfx_coin_shower',
  'sfx_quest_done', 'sfx_levelup', 'sfx_streak_tick', 'sfx_place_thump',
  'sfx_build_complete', 'sfx_upgrade_hammer', 'sfx_rubble_crash', 'sfx_wall_clink',
  'sfx_deploy_pop', 'sfx_sword_hit', 'sfx_bow_shot', 'sfx_arrow_hit',
  'sfx_cannon_fire', 'sfx_mortar_thunk', 'sfx_shell_whistle', 'sfx_keg_fuse',
  'sfx_explosion_big', 'sfx_trap_snap', 'sfx_burrow_loop', 'sfx_emerge_pop',
];

describe('mobile-safe SFX runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stays silent after device resume rejection and recovers on a later gesture', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    const bank = engine.acquireBank(['sfx_tap']);
    await bank.ready;
    const ctx = FakeAudioContext.instances[0]!;
    ctx.state = 'suspended';
    const resume = vi.spyOn(ctx, 'resume').mockRejectedValueOnce(
      new DOMException('Failed to start the audio device', 'InvalidStateError'),
    );
    engine.installUnlock();
    engine.installUnlock();
    expect(window.addEventListener).toHaveBeenCalledTimes(3);
    gesture();
    await flushAudio();
    engine.play('sfx_tap');
    engine.play('sfx_tap', { loop: true });
    await flushAudio();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(ctx.sources).toHaveLength(0);

    gesture('keydown');
    await flushAudio();
    engine.play('sfx_tap');
    await flushAudio();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(ctx.sources[0]?.started).toBe(1);
    bank.release();
  });

  it('coalesces interrupted resume attempts and drops sounds queued while hardware is unavailable', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    const bank = engine.acquireBank(['sfx_tap', 'sfx_confirm']);
    await bank.ready;
    const ctx = FakeAudioContext.instances[0]!;
    ctx.state = 'interrupted' as AudioContextState;
    let rejectResume!: (cause: Error) => void;
    const resume = vi.spyOn(ctx, 'resume').mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectResume = reject;
    }));
    engine.installUnlock();
    gesture();
    engine.play('sfx_tap');
    engine.play('sfx_confirm', { loop: true });
    await flushAudio();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(ctx.sources).toHaveLength(0);
    rejectResume(new DOMException('Device unavailable', 'InvalidStateError'));
    await flushAudio();
    gesture('touchstart');
    await flushAudio();
    engine.play('sfx_confirm', { loop: true });
    await flushAudio();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]?.started).toBe(1);
    engine.stopAll();
    bank.release();
  });

  it('contains a synchronous resume refusal and retries playback after another gesture', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    const bank = engine.acquireBank(['sfx_tap']);
    await bank.ready;
    const ctx = FakeAudioContext.instances[0]!;
    ctx.state = 'suspended';
    vi.spyOn(ctx, 'resume').mockImplementationOnce(() => {
      throw new DOMException('Device unavailable', 'InvalidStateError');
    });
    engine.installUnlock();
    expect(() => engine.play('sfx_tap')).not.toThrow();
    gesture();
    await flushAudio();
    engine.play('sfx_tap');
    await flushAudio();
    expect(ctx.sources[0]?.started).toBe(1);
    bank.release();
  });

  it.each([false, true])('does not replay a deferred cold cue requested during device failure (loop=%s)', async (loop) => {
    let resolveAsset!: (response: Response) => void;
    installSfxFakes((input) => String(input).includes('/audio/sfx/sfx_tap.wav')
      ? new Promise<Response>((resolve) => { resolveAsset = resolve; })
      : Promise.resolve({ ok: false } as Response));
    const engine = new SfxEngine();
    const bank = engine.acquireBank(['sfx_tap']);
    await flushAudio();
    const ctx = FakeAudioContext.instances[0]!;
    ctx.state = 'suspended';
    let rejectResume!: (cause: Error) => void;
    vi.spyOn(ctx, 'resume').mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectResume = reject;
    }));
    engine.installUnlock();
    gesture();
    engine.play('sfx_tap', { loop });
    rejectResume(new DOMException('Device unavailable', 'InvalidStateError'));
    await flushAudio();
    gesture('keydown');
    await flushAudio();
    resolveAsset({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response);
    await bank.ready;
    await flushAudio();
    expect(ctx.sources).toHaveLength(0);

    engine.play('sfx_tap', { loop });
    await flushAudio();
    expect(ctx.sources[0]?.started).toBe(1);
    engine.stopAll();
    bank.release();
  });

  it('bounds cold-bank network/decode work, deduplicates names, and supports lazy MP3 records', async () => {
    let active = 0;
    let peak = 0;
    installSfxFakes(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    const engine = new SfxEngine();
    engine.registerAssets([{
      id: 'sfx_tap', file: '/audio/sfx-ai/ui/sfx_ui_tap_v1.mp3',
    }]);
    const bank = engine.acquireBank([...MANY_CUES.slice(0, 8), 'sfx_tap']);
    await bank.ready;

    expect(peak).toBe(AUDIO_RUNTIME.preloadConcurrency);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      `/audio/sfx-ai/ui/sfx_ui_tap_v1.mp3?v=${BUILD.gitSha}`,
    );
    bank.release();
  });

  it('plays a deployment-prebuffered Dragon breath without touching its legacy fallback', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    engine.registerProductionAssets(DRAGON_BATTLE_WARM_SFX.map((id) => ({
      id,
      file: `/audio/sfx-ai/${id}.mp3`,
    })));
    const bank = engine.acquireBank(DRAGON_BATTLE_WARM_SFX);
    await bank.ready;

    const selected = engine.resolveFamily(
      'sfx_troop_dragon_breath', '3:3:release', false,
    );
    expect(selected).toMatch(/^sfx_troop_dragon_breath_v[1-3]$/);
    engine.playFamily(
      'sfx_troop_dragon_breath', '3:3:release', 'sfx_bow_shot',
    );
    await flushAudio();

    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(1);
    expect(FakeAudioContext.instances[0]!.sources[0]!.started).toBe(1);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)))
      .not.toContain(`/audio/sfx/sfx_bow_shot.wav?v=${BUILD.gitSha}`);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)))
      .toContain(`/audio/sfx-ai/${selected}.mp3?v=${BUILD.gitSha}`);

    FakeAudioContext.instances[0]!.sources[0]!.onended?.();
    bank.release();
  });

  it('cancels an abandoned bad-cellular bank so its replacement starts immediately', async () => {
    let aborted = 0;
    installSfxFakes(async (input, init) => {
      if (String(input).includes('sfx_place_thump')) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted++;
          reject(new DOMException('abandoned', 'AbortError'));
        }, { once: true });
      });
    });
    const engine = new SfxEngine();
    const abandoned = engine.acquireBank(MANY_CUES.slice(0, 8));
    abandoned.release();
    const replacement = engine.acquireBank(['sfx_place_thump']);
    await replacement.ready;

    expect(aborted).toBe(AUDIO_RUNTIME.preloadConcurrency);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('sfx_place_thump')))
      .toBe(true);
    expect(fetch).toHaveBeenCalledTimes(AUDIO_RUNTIME.preloadConcurrency + 1);
    replacement.release();
  });

  it('releases and aborts pre-start one-shot and loop demand immediately', async () => {
    let aborted = 0;
    installSfxFakes(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted++;
        reject(new DOMException('stopped before decode', 'AbortError'));
      }, { once: true });
    }));
    const engine = new SfxEngine();
    const oneShot = engine.play('sfx_tap');
    const loop = engine.play('sfx_keg_fuse', { loop: true });
    oneShot.stop();
    loop.stop();
    await flushAudio();

    expect(aborted).toBe(2);
    expect(engine.diagnostics()).toMatchObject({ voices: 0, loops: 0, buffers: 0 });
  });

  it('admits the current bank before a faster future bank on bad cellular', async () => {
    let releaseFirst!: (response: Response) => void;
    installSfxFakes(async (input) => {
      if (String(input).includes('sfx_tap')) {
        return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      }
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    const engine = new SfxEngine();
    const currentBank = engine.acquireBank(['sfx_tap']);
    const futureBank = engine.acquireBank(['sfx_confirm']);
    FakeAudioContext.instances[0]!.decodedLength = (10 * 1024 * 1024) / 4;
    await flushAudio();
    expect(engine.diagnostics().buffers).toBe(0);

    releaseFirst({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response);
    await Promise.all([currentBank.ready, futureBank.ready]);
    expect(engine.isBuffered('sfx_tap')).toBe(true);
    expect(engine.isBuffered('sfx_confirm')).toBe(false);
    expect(engine.diagnostics().decodedBytes).toBe(10 * 1024 * 1024);
    currentBank.release();
    futureBank.release();
  });

  it('shares one sample-clean loop across many troop leases until the last handle stops', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    engine.registerAssets([{
      id: 'sfx_keg_fuse', file: '/audio/sfx/sfx_keg_fuse.mp3',
      loopStartSeconds: 0.08, loopEndSeconds: 1.42,
    }]);
    const bank = engine.acquireBank(['sfx_keg_fuse']);
    await bank.ready;
    const first = engine.play('sfx_keg_fuse', { loop: true, volume: 0.4 });
    const second = engine.play('sfx_keg_fuse', { loop: true, volume: 0.7 });
    await flushAudio();

    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]).toMatchObject({ loop: true, loopStart: 0.08, loopEnd: 1.42 });
    expect(engine.diagnostics().loops).toBe(1);
    first.stop();
    expect(ctx.sources[0]!.stopped).toBe(0);
    second.stop();
    expect(ctx.sources[0]!.stopped).toBe(1);
    expect(engine.diagnostics().loops).toBe(0);
    bank.release();
  });

  it('selects authored variants deterministically regardless of manifest order', () => {
    const definitions = [
      { id: 'sfx_ui_tap_v1', file: '/audio/sfx-ai/ui/tap-v1.mp3' },
      { id: 'sfx_ui_tap_v2', file: '/audio/sfx-ai/ui/tap-v2.mp3' },
      { id: 'sfx_ui_tap_v3', file: '/audio/sfx-ai/ui/tap-v3.mp3' },
    ] as const;
    const first = new SfxEngine();
    const second = new SfxEngine();
    first.registerProductionAssets(definitions);
    second.registerProductionAssets([...definitions].reverse());
    const keys = ['event:1', 'event:2', 'entity:999'];
    expect(keys.map((key) => first.resolveFamily('sfx_ui_tap', key)))
      .toEqual(keys.map((key) => second.resolveFamily('sfx_ui_tap', key)));
  });

  it('coalesces same-tick duplicates and enforces per-cue and total voice limits', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    const bank = engine.acquireBank(MANY_CUES);
    await bank.ready;

    for (let i = 0; i < 5; i++) engine.play('sfx_tap');
    await flushAudio();
    expect(engine.diagnostics().voices).toBe(1);

    FakeAudioContext.instances[0]!.currentTime += 1;
    for (let i = 0; i < 5; i++) engine.play('sfx_confirm', { coalesceMs: 0 });
    await flushAudio();
    expect(engine.diagnostics().voices).toBe(1 + AUDIO_RUNTIME.maxOneShotVoicesPerCue);

    for (const cue of MANY_CUES.slice(2)) engine.play(cue, { coalesceMs: 0 });
    await flushAudio();
    expect(engine.diagnostics().voices).toBe(AUDIO_RUNTIME.maxOneShotVoices);
    const stoppedBefore = FakeAudioContext.instances[0]!.sources
      .reduce((sum, source) => sum + source.stopped, 0);
    engine.play('sfx_error', { priority: 'critical', coalesceMs: 0 });
    await flushAudio();
    expect(engine.diagnostics().voices).toBe(AUDIO_RUNTIME.maxOneShotVoices);
    expect(FakeAudioContext.instances[0]!.sources
      .reduce((sum, source) => sum + source.stopped, 0)).toBeGreaterThan(stoppedBefore);
    bank.release();
  });

  it('reclaims released decoded banks under the mobile working-set ceiling', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    // Three mono buffers at 6 MiB each cannot all fit. Even pinned banks fail
    // closed at the hard mobile ceiling; the rejected cue uses its fallback.
    const bank = engine.acquireBank(MANY_CUES.slice(0, 3));
    FakeAudioContext.instances[0]!.decodedLength = (6 * 1024 * 1024) / 4;
    await bank.ready;
    expect(engine.diagnostics().decodedBytes).toBe(12 * 1024 * 1024);
    expect(engine.diagnostics().buffers).toBe(2);
    bank.release();
    expect(engine.diagnostics().decodedBytes).toBeLessThanOrEqual(AUDIO_RUNTIME.maxDecodedBytes);
    expect(engine.diagnostics().buffers).toBe(2);
  });

  it('counts live-source buffers inside the hard decoded-memory ceiling', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    const first = engine.acquireBank(['sfx_tap']);
    FakeAudioContext.instances[0]!.decodedLength = (10 * 1024 * 1024) / 4;
    await first.ready;
    engine.play('sfx_tap', { coalesceMs: 0 });
    await flushAudio();
    first.release();

    const blocked = engine.acquireBank(['sfx_confirm']);
    await blocked.ready;
    expect(engine.diagnostics()).toMatchObject({
      decodedBytes: 10 * 1024 * 1024,
      buffers: 1,
      voices: 1,
    });
    expect(engine.diagnostics().decodedBytes).toBeLessThanOrEqual(AUDIO_RUNTIME.maxDecodedBytes);

    FakeAudioContext.instances[0]!.sources[0]!.onended?.();
    const retry = engine.acquireBank(['sfx_confirm']);
    await retry.ready;
    expect(engine.diagnostics()).toMatchObject({
      decodedBytes: 10 * 1024 * 1024,
      buffers: 1,
      voices: 0,
    });
    blocked.release();
    retry.release();
  });

  it('keeps a live loop inside the same decoded-memory ceiling until it ends', async () => {
    installSfxFakes();
    const engine = new SfxEngine();
    const first = engine.acquireBank(['sfx_keg_fuse']);
    FakeAudioContext.instances[0]!.decodedLength = (10 * 1024 * 1024) / 4;
    await first.ready;
    const loop = engine.play('sfx_keg_fuse', { loop: true });
    await flushAudio();
    first.release();

    const blocked = engine.acquireBank(['sfx_confirm']);
    await blocked.ready;
    expect(engine.diagnostics()).toMatchObject({
      decodedBytes: 10 * 1024 * 1024,
      buffers: 1,
      loops: 1,
    });

    loop.stop();
    FakeAudioContext.instances[0]!.sources[0]!.onended?.();
    const retry = engine.acquireBank(['sfx_confirm']);
    await retry.ready;
    expect(engine.diagnostics()).toMatchObject({
      decodedBytes: 10 * 1024 * 1024,
      buffers: 1,
      loops: 0,
    });
    blocked.release();
    retry.release();
  });

  it('fails open to fallback when a mobile asset request stalls', async () => {
    vi.useFakeTimers();
    installSfxFakes(async () => new Promise<Response>(() => { /* stalled radio */ }));
    const engine = new SfxEngine();
    const bank = engine.acquireBank(['sfx_tap']);
    let settled = false;
    void bank.ready.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(AUDIO_RUNTIME.bankReadyDeadlineMs);
    expect(settled).toBe(true);
    bank.release();
  });

  it('preloads only exact-plan fallbacks and never gates playback on audio', () => {
    const source = readFileSync(new URL('../game/scenes/BattleScene.ts', import.meta.url), 'utf8');
    expect(source).toContain('acquireSfxBank(LEGACY_PLACEMENT_SFX)');
    expect(source).toContain('legacyFallbackBankForPlan(audioPlan)');
    expect(source).not.toContain('acquireSfxBank(LEGACY_BATTLE_SFX)');
    // Optional audio and rich-art readiness may warm in the background, but a
    // stalled mobile request must never delay the tick-zero deploy prefix.
    expect(source).not.toContain('const audioGate =');
    expect(source).not.toContain('await Promise.all([requested, audioGate])');
    expect(source).toContain('void Promise.allSettled([');
    expect(source).toContain('void fallbackBank.ready;');
    expect(source).toContain('productionBankWindowsForPlan(audioPlan)');
    expect(source).toContain('this.replayFallbackSfxBank?.release()');
  });

  it('retries a failed production manifest after the bounded mobile cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    installSfxFakes();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          entries: [{ id: 'sfx_ui_tap_v1', file: 'ui/tap-v1.mp3' }],
        }),
      } as Response);
    vi.resetModules();
    const isolatedAudio = await import('./audio');

    expect(await isolatedAudio.loadProductionSfxManifest()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await isolatedAudio.loadProductionSfxManifest()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUDIO_RUNTIME.manifestRetryDelayMs);
    expect(await isolatedAudio.loadProductionSfxManifest()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('leaves identity-planned replay audio as the only owner of combat sounds', () => {
    const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source('../game/v2/defense.ts')).not.toContain('playSfx(');
    expect(source('../game/v2/troop.ts')).not.toContain('playSfx(');
    expect(source('../game/fx/projectiles.ts')).not.toContain('playSfx(');
    expect(source('../ui/RaidUI.tsx')).not.toContain("playSfx('sfx_deploy_pop')");
    expect(source('../game/scenes/BattleScene.ts')).toContain('troopDeploySfxFamily(');
  });

  it('accepts only the hash-publisher public schema and preserves measured loop points', () => {
    expect(productionDefinitionsFromManifest({ schemaVersion: 1, entries: [
      { id: 'sfx_ui_tap_v1', file: 'ui/tap.mp3' },
      { id: 'sfx_defense_mortar_impact_v3', file: 'defense/mortar-impact-v3.wav' },
      { id: 'sfx_ambience_battle_v1', file: 'ambience/battle.wav', loopStart: 0.1, loopEnd: 19.8 },
      { id: 'sfx_ui_error_v1', file: '../escape.mp3' },
      { id: 'sfx_ambience_base_day_v1', file: 'base.mp3', loopStart: 0.2 },
    ] })).toEqual([
      { id: 'sfx_ui_tap_v1', file: '/audio/sfx-ai/ui/tap.mp3' },
      {
        id: 'sfx_defense_mortar_impact_v3',
        file: '/audio/sfx-ai/defense/mortar-impact-v3.wav',
      },
      {
        id: 'sfx_ambience_battle_v1', file: '/audio/sfx-ai/ambience/battle.wav',
        loopStartSeconds: 0.1, loopEndSeconds: 19.8,
      },
    ]);
  });

  it('routes every current UI/base family and keeps future defeat event-gated', () => {
    const catalog = JSON.parse(readFileSync(
      new URL('../../../../scripts/audio-production/catalog.json', import.meta.url), 'utf8',
    )) as { entries: Array<{ familyId: string }> };
    const catalogSet = (prefix: string): Set<string> => new Set(catalog.entries
      .map((entry) => entry.familyId).filter((family) => family.startsWith(prefix)));
    const aliases: LegacySfx[] = [
      'sfx_tap', 'sfx_confirm', 'sfx_error', 'sfx_claim_chime',
      'sfx_coin_shower', 'sfx_quest_done', 'sfx_levelup', 'sfx_streak_tick',
      'sfx_place_thump', 'sfx_build_complete', 'sfx_upgrade_hammer',
      'sfx_rubble_crash', 'sfx_wall_clink', 'sfx_rally_horn', 'sfx_shield_up',
      'sfx_shield_shatter', 'sfx_star_1', 'sfx_star_2', 'sfx_star_3',
    ];
    const routed = new Set(aliases.flatMap((name) => {
      const family = productionFamilyForLegacySfx(name);
      return family ? [family] : [];
    }));
    expect(new Set([...routed].filter((family) => family.startsWith('sfx_ui_'))))
      .toEqual(catalogSet('sfx_ui_'));
    expect(new Set([...routed].filter((family) => family.startsWith('sfx_base_'))))
      .toEqual(catalogSet('sfx_base_'));
    expect(new Set([...routed].filter((family) => family.startsWith('sfx_battle_'))))
      .toEqual(new Set([...catalogSet('sfx_battle_')]
        .filter((family) => family !== 'sfx_battle_defeat_timeout')));
  });

  it('selects all three reviewed ambience beds only for their truthful screens', () => {
    expect(new Set([
      ambienceFamilyForScreen('base'), ambienceFamilyForScreen('map'),
      ambienceFamilyForScreen('battle'),
    ])).toEqual(new Set([
      'sfx_ambience_base_day', 'sfx_ambience_campaign', 'sfx_ambience_battle',
    ]));
    expect(ambienceFamilyForScreen('profile')).toBeNull();
  });
});

describe('background-music screen routing', () => {
  it('uses the retained original theme only for the battle lifecycle', () => {
    expect(musicTrackForScreen('battle')).toBe('battle');
    for (const screen of ['loading', 'title', 'base', 'build', 'map', 'scout', 'profile'] as const) {
      expect(musicTrackForScreen(screen), screen).toBe('world');
    }
  });

  it('pauses one looping track before playing the other and keeps the music toggle authoritative', () => {
    class AudioStub {
      readonly src: string;
      loop = false;
      volume = 1;
      readonly play = vi.fn(async () => undefined);
      readonly pause = vi.fn();
      constructor(src: string) { this.src = src; }
    }
    const created: AudioStub[] = [];
    const stored = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem(key: string): string | null { return stored.get(key) ?? null; },
      setItem(key: string, value: string): void { stored.set(key, value); },
    });
    vi.stubGlobal('Audio', class extends AudioStub {
      constructor(src: string) { super(src); created.push(this); }
    });

    setMusic(false);
    setMusicScreen('battle');
    expect(created).toHaveLength(0);
    setMusic(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.src).toBe(`/audio/bgmusic-battle.mp3?v=${BUILD.gitSha}`);
    expect(created[0]!.loop).toBe(true);
    expect(created[0]!.play).toHaveBeenCalledOnce();

    setMusicScreen('base');
    expect(created[0]!.pause).toHaveBeenCalledOnce();
    expect(created).toHaveLength(2);
    expect(created[1]!.src).toBe(`/audio/bgmusic-world.mp3?v=${BUILD.gitSha}`);
    expect(created[1]!.play).toHaveBeenCalledOnce();

    setMusic(false);
    expect(created[0]!.pause).toHaveBeenCalledTimes(2);
    expect(created[1]!.pause).toHaveBeenCalledOnce();
  });

  it('subscribes the app shell to screen changes instead of relying on each screen to opt in', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(appSource).toContain('setMusicScreen(useApp.getState().screen)');
    expect(appSource).toMatch(/useApp\.subscribe\([\s\S]*setMusicScreen\(state\.screen\)/);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});
