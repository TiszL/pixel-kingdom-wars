import { AUDIO_RUNTIME } from '@shardkeep/shared';
import type { Screen } from '../state/store';
import { BUILD } from './version';

/**
 * SFX engine (GDD §3.11) — a tiny Phaser-independent Web Audio loader.
 *
 * Why not Phaser's sound manager: SFX fire from BOTH the React overlay (taps,
 * toasts, claims) and the scenes, and several outlive a scene's lifetime; a
 * single process-wide AudioContext keeps one mixer for everything and survives
 * scene swaps. Files live in /audio/sfx/<name>.wav (served from public/).
 *
 * Policy parity:
 *  - browsers block audio until a user gesture → we lazily create + resume the
 *    context on the first pointer/key/touch (unlock()), then replay nothing
 *    (the gesture itself is silent; sounds play on the events after it).
 *  - the SOUND FX profile toggle (localStorage 'skp_sound_fx', default on) is
 *    the master gate; flipping it off silences everything immediately and stops
 *    any active loops (keg fuse / burrow).
 *  - buffers decode lazily on first play and are cached; a missing/edge-failed
 *    file degrades to silence, never throws (juice must never break gameplay).
 */

/** Every SFX the GDD §3.11 manifest ships (file = /audio/sfx/<name>.wav). */
export type LegacySfx =
  // UI / meta
  | 'sfx_tap' | 'sfx_confirm' | 'sfx_error' | 'sfx_claim_chime'
  | 'sfx_coin_shower' | 'sfx_quest_done' | 'sfx_levelup' | 'sfx_streak_tick'
  // build
  | 'sfx_place_thump' | 'sfx_build_complete' | 'sfx_upgrade_hammer'
  | 'sfx_rubble_crash' | 'sfx_wall_clink'
  // battle
  | 'sfx_deploy_pop' | 'sfx_sword_hit' | 'sfx_bow_shot' | 'sfx_arrow_hit'
  | 'sfx_cannon_fire' | 'sfx_mortar_thunk' | 'sfx_shell_whistle' | 'sfx_keg_fuse'
  | 'sfx_explosion_big' | 'sfx_trap_snap' | 'sfx_burrow_loop' | 'sfx_emerge_pop'
  | 'sfx_rally_horn' | 'sfx_shield_up' | 'sfx_shield_shatter'
  | 'sfx_star_1' | 'sfx_star_2' | 'sfx_star_3'
  // heroes (owner 2026-07-28)
  | 'sfx_hero_dash' | 'sfx_hero_quake'
  | 'sfx_hero_deploy_vex' | 'sfx_hero_deploy_theo';

type ProductionCategory = 'troop' | 'hero' | 'defense' | 'ui' | 'base' | 'battle' | 'ambience';
export type ProductionSfx = `sfx_${ProductionCategory}_${string}_v${1 | 2 | 3}`;
export type Sfx = LegacySfx | ProductionSfx;

const SOUND_FX_KEY = 'skp_sound_fx';

/** SOUND FX profile toggle (localStorage). Defaults ON, matching the profile. */
export function soundFxOn(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(SOUND_FX_KEY) !== '0';
}

/** Handle returned by looping plays so callers can stop the loop. */
export interface SfxHandle {
  stop(): void;
}

export type SfxPriority = 'ambient' | 'normal' | 'critical';

export interface SfxPlayOptions {
  volume?: number;
  loop?: boolean;
  /** Critical cues may evict ordinary/ambient voices; ambient cues never evict
   * gameplay. Same-priority overflow evicts the oldest voice deterministically. */
  priority?: SfxPriority;
  /** Override only for a deliberately layered cue. Defaults to the shared
   * sub-frame duplicate-coalescing window. */
  coalesceMs?: number;
}

/** A scoped decoded-buffer lease. `ready` always settles—even missing/corrupt
 * files remain graceful silence—and `release` is idempotent. */
export interface SfxBank {
  ready: Promise<void>;
  release(): void;
}

/** Lazy manifest record. Creator one-shots can ship compact MP3 derivatives;
 * sample-clean loops can remain WAV or declare exact decoded loop points. */
export interface SfxAssetDefinition {
  id: Sfx;
  /** Same-origin legacy or review-gated production path, including extension. */
  file: string;
  loopStartSeconds?: number;
  loopEndSeconds?: number;
}

/** Dragon attacks can begin within the first half-second of playback. Warm the
 * complete approved breath identity while the player is still deploying, so a
 * cold phone does not substitute the bow/arrow compatibility sounds for those
 * opening attacks. Six bounded files are deliberately scoped here; this is not
 * permission to preload the 247-export catalog. */
export const DRAGON_BATTLE_WARM_SFX = [
  'sfx_troop_dragon_breath_v1',
  'sfx_troop_dragon_breath_v2',
  'sfx_troop_dragon_breath_v3',
  'sfx_troop_dragon_breath_contact_v1',
  'sfx_troop_dragon_breath_contact_v2',
  'sfx_troop_dragon_breath_contact_v3',
] as const satisfies readonly ProductionSfx[];

/** Battle subset of the current 35-file compatibility pack. The production
 * manifest supplies an exact replay slice separately; never preload all 247. */
export const LEGACY_BATTLE_SFX = [
  'sfx_error', 'sfx_confirm', 'sfx_deploy_pop', 'sfx_sword_hit',
  'sfx_bow_shot', 'sfx_arrow_hit', 'sfx_cannon_fire', 'sfx_mortar_thunk',
  'sfx_shell_whistle', 'sfx_keg_fuse', 'sfx_explosion_big', 'sfx_trap_snap',
  'sfx_burrow_loop', 'sfx_emerge_pop', 'sfx_rally_horn', 'sfx_shield_up',
  'sfx_shield_shatter', 'sfx_star_1', 'sfx_star_2', 'sfx_star_3',
  'sfx_rubble_crash', 'sfx_hero_dash', 'sfx_hero_quake',
  'sfx_hero_deploy_vex', 'sfx_hero_deploy_theo',
] as const satisfies readonly Sfx[];

/** Only cues needed before an authoritative replay exists. */
export const LEGACY_PLACEMENT_SFX = [
  'sfx_error', 'sfx_confirm', 'sfx_deploy_pop',
  'sfx_hero_deploy_vex', 'sfx_hero_deploy_theo',
] as const satisfies readonly Sfx[];

const NOOP_HANDLE: SfxHandle = { stop() { /* nothing playing */ } };

type Ctor = typeof AudioContext;

interface BufferEntry {
  buffer: AudioBuffer;
  bytes: number;
  used: number;
}

interface OneShotVoice {
  name: Sfx;
  source: AudioBufferSourceNode;
  gain: GainNode;
  priority: number;
  sequence: number;
}

interface LoopVoice {
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  requests: Map<symbol, number>;
  retained: boolean;
}

interface QueuedLoad {
  name: Sfx;
  priority: number;
  order: number;
  active: boolean;
  cancelled: boolean;
  controller: AbortController | null;
  admission: AdmissionTurn | null;
  run(job: QueuedLoad): Promise<AudioBuffer | null>;
  resolve(value: AudioBuffer | null): void;
}

interface AdmissionTurn {
  wait: Promise<void>;
  done(): void;
}

const PRIORITY: Readonly<Record<SfxPriority, number>> = {
  ambient: 0,
  normal: 1,
  critical: 2,
};

/** Stable FNV-1a selection for authored variants. Event/entity keys produce
 * repeatable replays and never introduce presentation-side Math.random. */
export function deterministicSfxHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Sfx, BufferEntry>();
  private pending = new Map<Sfx, Promise<AudioBuffer | null>>();
  private assets = new Map<Sfx, Omit<SfxAssetDefinition, 'id'>>();
  private families = new Map<string, ProductionSfx[]>();
  private loadQueue: QueuedLoad[] = [];
  private loadJobs = new Map<Sfx, QueuedLoad>();
  private activeLoads = 0;
  private loadOrder = 0;
  private admissionTail = Promise.resolve();
  private pins = new Map<Sfx, number>();
  private preloadDemands = new Map<Sfx, number>();
  private transientDemands = new Map<Sfx, number>();
  /** Loads requested for playback and live sources retain their decoded buffer
   * even if its bank has rolled forward. Keep those bytes in the cache/account
   * until the voice ends so eviction cannot hide real WebAudio memory. */
  private playbackRetains = new Map<Sfx, number>();
  private capacityRejected = new Set<Sfx>();
  private decodedBytes = 0;
  private sequence = 0;
  private voices = new Set<OneShotVoice>();
  /** One shared loop per cue. Per-troop handles are reference leases, so forty
   * Keg Runners still produce one fuse bed rather than forty phase-stacked beds. */
  private loops = new Map<Sfx, LoopVoice>();
  private lastStartedMs = new Map<Sfx, number>();
  private unlocked = false;
  private unlockInstalled = false;
  private resumePending = false;
  private resumeNeedsGesture = false;

  registerAssets(definitions: readonly SfxAssetDefinition[]): void {
    for (const { id, file, loopStartSeconds, loopEndSeconds } of definitions) {
      if (!/^\/audio\/(?:sfx|sfx-ai)\/[A-Za-z0-9_./-]+\.(?:wav|mp3)$/.test(file)
        || file.includes('..') || file.includes('//')) {
        throw new Error(`Invalid same-origin SFX file: ${file}`);
      }
      if (loopStartSeconds !== undefined && (!Number.isFinite(loopStartSeconds) || loopStartSeconds < 0)) {
        throw new Error(`Invalid loop start for ${id}`);
      }
      if (loopEndSeconds !== undefined && (!Number.isFinite(loopEndSeconds)
        || loopEndSeconds <= (loopStartSeconds ?? 0))) {
        throw new Error(`Invalid loop end for ${id}`);
      }
      this.assets.set(id, {
        file,
        ...(loopStartSeconds !== undefined ? { loopStartSeconds } : {}),
        ...(loopEndSeconds !== undefined ? { loopEndSeconds } : {}),
      });
    }
  }

  registerProductionAssets(definitions: readonly SfxAssetDefinition[]): void {
    this.registerAssets(definitions);
    for (const definition of definitions) {
      if (!/_v[1-3]$/.test(definition.id)) continue;
      const id = definition.id as ProductionSfx;
      const family = id.replace(/_v[1-3]$/, '');
      const variants = this.families.get(family) ?? [];
      if (!variants.includes(id)) variants.push(id);
      variants.sort((a, b) => a.localeCompare(b));
      this.families.set(family, variants);
    }
  }

  resolveFamily(family: string, variantKey: string | number, loop = false): ProductionSfx | null {
    const ids = this.families.get(family)?.filter((id) => !loop || this.loopSafe(id));
    if (!ids?.length) return null;
    return ids[deterministicSfxHash(`${family}:${String(variantKey)}`) % ids.length]!;
  }

  private loopSafe(name: Sfx): boolean {
    const asset = this.assets.get(name);
    if (!asset?.file.endsWith('.mp3')) return true;
    return asset.loopStartSeconds !== undefined && asset.loopEndSeconds !== undefined;
  }

  private pumpLoads(): void {
    while (this.activeLoads < AUDIO_RUNTIME.preloadConcurrency && this.loadQueue.length > 0) {
      this.loadQueue.sort((a, b) => b.priority - a.priority || a.order - b.order);
      const job = this.loadQueue.shift()!;
      if (job.cancelled) continue;
      job.active = true;
      job.admission = this.nextAdmissionTurn();
      this.activeLoads++;
      void job.run(job).then(job.resolve, () => job.resolve(null)).finally(() => {
        job.admission?.done();
        this.activeLoads--;
        this.pumpLoads();
      });
    }
  }

  private scheduleLoad(
    name: Sfx,
    priority: number,
    run: (job: QueuedLoad) => Promise<AudioBuffer | null>,
  ): Promise<AudioBuffer | null> {
    let job!: QueuedLoad;
    const promise = new Promise<AudioBuffer | null>((resolve) => {
      job = {
        name, priority, run, resolve, order: ++this.loadOrder,
        active: false, cancelled: false, controller: null, admission: null,
      };
      this.loadQueue.push(job);
    });
    this.loadJobs.set(name, job);
    this.pumpLoads();
    return promise;
  }

  private nextAdmissionTurn(): AdmissionTurn {
    let finish!: () => void;
    let finished = false;
    const current = new Promise<void>((resolve) => { finish = resolve; });
    const turn: AdmissionTurn = {
      wait: this.admissionTail,
      done: () => {
        if (finished) return;
        finished = true;
        finish();
      },
    };
    this.admissionTail = this.admissionTail.then(() => current);
    return turn;
  }

  private hasLoadDemand(name: Sfx): boolean {
    return (this.preloadDemands.get(name) ?? 0) > 0
      || (this.playbackRetains.get(name) ?? 0) > 0
      || (this.transientDemands.get(name) ?? 0) > 0;
  }

  private cancelIfUndemanded(name: Sfx): void {
    void Promise.resolve().then(() => {
      if (this.hasLoadDemand(name)) return;
      const job = this.loadJobs.get(name);
      if (!job || job.cancelled) return;
      job.cancelled = true;
      if (job.active) job.controller?.abort();
      else {
        const index = this.loadQueue.indexOf(job);
        if (index >= 0) this.loadQueue.splice(index, 1);
        job.resolve(null);
      }
    });
  }

  /** Create the context + master gain on demand (post-gesture). */
  private ensureCtx(): boolean {
    if (this.ctx) return true;
    if (typeof window === 'undefined') return false;
    const Ctx: Ctor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!Ctx) return false;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.master = null;
      return false;
    }
    return true;
  }

  /** Device interruption can reject resume even after autoplay was unlocked.
   * Keep gameplay silent, then retry on a real gesture instead of every cue. */
  private resumeContext(fromGesture = false): void {
    const ctx = this.ctx;
    if (fromGesture) this.resumeNeedsGesture = false;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed'
      || this.resumePending || this.resumeNeedsGesture) return;
    this.resumePending = true;
    const failed = (): void => {
      this.resumePending = false;
      this.resumeNeedsGesture = true;
    };
    try {
      void ctx.resume().then(() => { this.resumePending = false; }, failed);
    } catch { failed(); }
  }

  /** Arm autoplay once, retaining gesture recovery after a device interruption. */
  installUnlock(): void {
    if (typeof window === 'undefined' || this.unlockInstalled) return;
    this.unlockInstalled = true;
    const unlock = (): void => {
      const firstGesture = !this.unlocked;
      this.unlocked = true;
      if (this.ensureCtx()) this.resumeContext(true);
      if (firstGesture) {
        void loadProductionSfxManifest();
        startMusicIfEnabled(); // background theme starts on the SAME gesture (autoplay policy)
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
  }

  isUnlocked(): boolean { return this.unlocked; }

  isBuffered(name: Sfx): boolean { return this.buffers.has(name); }

  warm(name: Sfx): void {
    this.transientDemands.set(name, (this.transientDemands.get(name) ?? 0) + 1);
    void this.load(name).finally(() => {
      const next = (this.transientDemands.get(name) ?? 1) - 1;
      if (next > 0) this.transientDemands.set(name, next);
      else this.transientDemands.delete(name);
      this.cancelIfUndemanded(name);
    });
  }

  private async load(name: Sfx): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(name);
    if (cached) {
      cached.used = ++this.sequence;
      return cached.buffer;
    }
    const inflight = this.pending.get(name);
    if (inflight) {
      const job = this.loadJobs.get(name);
      if (job && !job.active && (this.playbackRetains.get(name) ?? 0) > 0) job.priority = 2;
      if (job?.cancelled) {
        return inflight.then(() => {
          if (this.hasLoadDemand(name)) return this.load(name);
          return null;
        });
      }
      return inflight;
    }
    if (this.capacityRejected.has(name)) {
      return null;
    }
    if (!this.ensureCtx() || !this.ctx) {
      return null;
    }
    const ctx = this.ctx;
    const priority = (this.playbackRetains.get(name) ?? 0) > 0 ? 2 : 1;
    const p = this.scheduleLoad(name, priority, async (job): Promise<AudioBuffer | null> => {
      try {
        // Pair changed generated audio with the exact web build. Old open tabs
        // retain their old URL; a new release cannot receive a stale SFX body.
        const file = this.assets.get(name)?.file ?? `/audio/sfx/${name}.wav`;
        const controller = new AbortController();
        job.controller = controller;
        const timeout = setTimeout(() => controller.abort(), AUDIO_RUNTIME.assetRequestTimeoutMs);
        let res: Response;
        try {
          res = await fetch(`${file}${file.includes('?') ? '&' : '?'}v=${BUILD.gitSha}`, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        await job.admission?.wait;
        if (job.cancelled || !this.hasLoadDemand(name)) return null;
        const buf = await ctx.decodeAudioData(bytes);
        if (job.cancelled || !this.hasLoadDemand(name)) return null;
        const decoded = buf.length * buf.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (decoded > AUDIO_RUNTIME.maxDecodedBytes) {
          this.capacityRejected.add(name);
          return null;
        }
        this.evictUnpinned(AUDIO_RUNTIME.maxDecodedBytes - decoded);
        if (this.decodedBytes + decoded > AUDIO_RUNTIME.maxDecodedBytes) {
          this.capacityRejected.add(name);
          return null;
        }
        this.buffers.set(name, { buffer: buf, bytes: decoded, used: ++this.sequence });
        this.decodedBytes += decoded;
        return buf;
      } catch {
        return null; // missing/corrupt file → silence, never throw
      } finally {
        job.controller = null;
        job.admission?.done();
      }
    });
    this.pending.set(name, p);
    void p.finally(() => {
      if (this.pending.get(name) === p) {
        this.pending.delete(name);
        this.loadJobs.delete(name);
      }
    });
    return p;
  }

  private evictUnpinned(targetBytes = AUDIO_RUNTIME.maxDecodedBytes): void {
    if (this.decodedBytes <= targetBytes) return;
    const candidates = [...this.buffers.entries()]
      .filter(([name]) => (this.pins.get(name) ?? 0) === 0
        && (this.playbackRetains.get(name) ?? 0) === 0)
      .sort((a, b) => a[1].used - b[1].used || a[0].localeCompare(b[0]));
    for (const [name, entry] of candidates) {
      if (this.decodedBytes <= targetBytes) break;
      this.buffers.delete(name);
      this.decodedBytes -= entry.bytes;
    }
  }

  private retainPlayback(name: Sfx): void {
    this.playbackRetains.set(name, (this.playbackRetains.get(name) ?? 0) + 1);
  }

  private releasePlayback(name: Sfx): void {
    const next = (this.playbackRetains.get(name) ?? 1) - 1;
    if (next > 0) this.playbackRetains.set(name, next);
    else this.playbackRetains.delete(name);
    // A cue rejected while live voices occupied the ceiling may now fit.
    this.capacityRejected.clear();
    this.evictUnpinned();
    this.cancelIfUndemanded(name);
  }

  private releaseLoopPlayback(name: Sfx, loop: LoopVoice): void {
    if (!loop.retained) return;
    loop.retained = false;
    this.releasePlayback(name);
  }

  /** Decode a bounded number in parallel. Fetch/decode failures intentionally
   * settle: missing juice must not block battle playback or a scene exit. */
  private async preload(
    names: readonly Sfx[],
    outstanding: Set<Sfx>,
    finish: (name: Sfx) => void,
  ): Promise<void> {
    await Promise.all(names.map(async (name) => {
      if (!outstanding.has(name)) return;
      try { await this.load(name); } finally { finish(name); }
    }));
  }

  acquireBank(names: readonly Sfx[]): SfxBank {
    const unique = [...new Set(names)];
    const outstanding = new Set(unique);
    for (const name of unique) {
      this.pins.set(name, (this.pins.get(name) ?? 0) + 1);
      this.preloadDemands.set(name, (this.preloadDemands.get(name) ?? 0) + 1);
    }
    const finish = (name: Sfx): void => {
      if (!outstanding.delete(name)) return;
      const next = (this.preloadDemands.get(name) ?? 1) - 1;
      if (next > 0) this.preloadDemands.set(name, next);
      else this.preloadDemands.delete(name);
      this.cancelIfUndemanded(name);
    };
    const abandonPreload = (): void => {
      unique.forEach((name) => {
        if (!outstanding.has(name)) return;
        finish(name);
      });
    };
    let released = false;
    const preload = this.preload(unique, outstanding, finish);
    const ready = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        abandonPreload();
        resolve();
      }, AUDIO_RUNTIME.bankReadyDeadlineMs);
      void preload.finally(() => { clearTimeout(timeout); resolve(); });
    });
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        abandonPreload();
        for (const name of unique) {
          const next = (this.pins.get(name) ?? 1) - 1;
          if (next > 0) this.pins.set(name, next); else this.pins.delete(name);
        }
        this.evictUnpinned();
        this.capacityRejected.clear();
      },
    };
  }

  private endVoice(voice: OneShotVoice, stop: boolean): void {
    if (!this.voices.delete(voice)) return;
    if (stop) {
      try { voice.source.stop(); } catch { /* already ended */ }
    }
    voice.source.disconnect();
    voice.gain.disconnect();
    this.releasePlayback(voice.name);
  }

  private admitVoice(name: Sfx, priority: number): boolean {
    const same = [...this.voices]
      .filter((voice) => voice.name === name)
      .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    if (same.length >= AUDIO_RUNTIME.maxOneShotVoicesPerCue) {
      const victim = same[0]!;
      if (victim.priority > priority) return false;
      this.endVoice(victim, true);
    }
    if (this.voices.size < AUDIO_RUNTIME.maxOneShotVoices) return true;
    const victim = [...this.voices]
      .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)[0];
    if (!victim || victim.priority > priority) return false;
    this.endVoice(victim, true);
    return true;
  }

  private playLoop(name: Sfx, volume: number): SfxHandle {
    const token = Symbol(name);
    let loop = this.loops.get(name);
    if (!loop) {
      loop = { source: null, gain: null, requests: new Map(), retained: true };
      this.loops.set(name, loop);
      this.retainPlayback(name);
      const expected = loop;
      void this.load(name).then((buf) => {
        if (!buf || this.loops.get(name) !== expected || expected.requests.size === 0
          || !this.ctx || this.ctx.state !== 'running' || !this.master || !soundFxOn()) {
          if (this.loops.get(name) === expected) this.loops.delete(name);
          this.releaseLoopPlayback(name, expected);
          return;
        }
        const source = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        source.buffer = buf;
        source.loop = true;
        const asset = this.assets.get(name);
        if (asset?.loopStartSeconds !== undefined) source.loopStart = asset.loopStartSeconds;
        if (asset?.loopEndSeconds !== undefined) source.loopEnd = asset.loopEndSeconds;
        gain.gain.value = Math.max(...expected.requests.values());
        source.connect(gain).connect(this.master);
        expected.source = source;
        expected.gain = gain;
        source.onended = () => {
          if (this.loops.get(name) === expected) this.loops.delete(name);
          source.disconnect();
          gain.disconnect();
          this.releaseLoopPlayback(name, expected);
        };
        source.start();
      });
    }
    loop.requests.set(token, volume);
    if (loop.gain) loop.gain.gain.value = Math.max(...loop.requests.values());
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        const current = this.loops.get(name);
        if (current !== loop) return;
        current.requests.delete(token);
        if (current.requests.size > 0) {
          if (current.gain) current.gain.gain.value = Math.max(...current.requests.values());
          return;
        }
        this.loops.delete(name);
        if (current.source) {
          try { current.source.stop(); } catch { /* already ended */ }
        } else {
          this.releaseLoopPlayback(name, current);
        }
      },
    };
  }

  /**
   * Play `name` once (or looping). Honors the SOUND FX toggle. `volume` is a
   * 0..1 gain on top of the master. Returns a stop handle (meaningful for loops).
   */
  play(name: Sfx, opts?: SfxPlayOptions): SfxHandle {
    if (!soundFxOn() || typeof window === 'undefined') return NOOP_HANDLE;
    if (!this.ensureCtx() || !this.ctx || !this.master) return NOOP_HANDLE;
    this.resumeContext();
    // Do not retain a playback request behind a cold asset load while silent:
    // that old cue could otherwise start after a later gesture recovers audio.
    if (this.resumeNeedsGesture || this.ctx.state !== 'running') return NOOP_HANDLE;

    const ctx = this.ctx;
    const master = this.master;
    const loop = opts?.loop ?? false;
    const vol = Math.max(0, Math.min(1, opts?.volume ?? 1));
    if (loop) return this.playLoop(name, vol);
    const priority = PRIORITY[opts?.priority ?? 'normal'];
    const coalesceMs = Math.max(0, opts?.coalesceMs ?? AUDIO_RUNTIME.duplicateCoalesceMs);
    let src: AudioBufferSourceNode | null = null;
    let voice: OneShotVoice | null = null;
    let stopped = false;
    let pendingRetention = true;
    const releasePendingRetention = (): void => {
      if (!pendingRetention) return;
      pendingRetention = false;
      this.releasePlayback(name);
    };

    this.retainPlayback(name);
    void this.load(name).then((buf) => {
      if (!buf || stopped || ctx.state !== 'running' || !soundFxOn()) {
        releasePendingRetention();
        return;
      }
      const nowMs = ctx.currentTime * 1_000;
      const previous = this.lastStartedMs.get(name);
      if (previous !== undefined && nowMs - previous < coalesceMs) {
        releasePendingRetention();
        return;
      }
      if (!this.admitVoice(name, priority)) {
        releasePendingRetention();
        return;
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      node.connect(gain).connect(master);
      voice = { name, source: node, gain, priority, sequence: ++this.sequence };
      // The live voice now owns the existing retain; endVoice releases it.
      pendingRetention = false;
      this.voices.add(voice);
      this.lastStartedMs.set(name, nowMs);
      src = node;
      node.onended = () => { if (voice) this.endVoice(voice, false); };
      node.start();
    });

    return {
      stop: () => {
        stopped = true;
        if (src) {
          if (voice) this.endVoice(voice, true);
        } else releasePendingRetention();
      },
    };
  }

  /** Prefer an already-buffered reviewed family; otherwise begin warming and
   * use the truthful compatibility cue for this one event. Kept on the engine
   * so tests can prove a deployment-time bank prevents the fallback. */
  playFamily(
    family: string,
    variantKey: string | number,
    fallback?: LegacySfx,
    opts?: SfxPlayOptions,
  ): SfxHandle {
    const selected = this.resolveFamily(family, variantKey, opts?.loop === true);
    if (selected && this.isBuffered(selected)) return this.play(selected, opts);
    if (selected) this.warm(selected);
    return fallback ? this.play(fallback, opts) : NOOP_HANDLE;
  }

  /** Stop every active looping source (master mute / battle exit). */
  stopLoops(): void {
    const loops = [...this.loops.entries()];
    this.loops.clear();
    for (const [name, loop] of loops) {
      loop.requests.clear();
      if (loop.source) {
        try { loop.source.stop(); } catch { /* already ended */ }
      } else {
        this.releaseLoopPlayback(name, loop);
      }
    }
  }

  stopAll(): void {
    this.stopLoops();
    for (const voice of [...this.voices]) this.endVoice(voice, true);
  }

  /** Test/dev observability without exposing AudioNodes or mutable collections. */
  diagnostics(): { decodedBytes: number; buffers: number; voices: number; loops: number } {
    return {
      decodedBytes: this.decodedBytes,
      buffers: this.buffers.size,
      voices: this.voices.size,
      loops: this.loops.size,
    };
  }
}

const engine = new SfxEngine();

const PRODUCTION_MANIFEST_URL = `/audio/sfx-ai/manifest.json?v=${BUILD.gitSha}`;
let manifestLoad: Promise<boolean> | null = null;
let manifestRetryAt = 0;
let manifestReady = false;

interface PublicSfxManifestEntry {
  id?: unknown;
  file?: unknown;
  loopStart?: unknown;
  loopEnd?: unknown;
}

/** Parse the exact hash-verified publisher schema. Family/variant stay encoded
 * in the stable ID, keeping the public manifest compact and independently
 * deployable from the generation catalogue. Invalid rows fail closed. */
export function productionDefinitionsFromManifest(raw: unknown): SfxAssetDefinition[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const manifest = raw as { schemaVersion?: unknown; entries?: unknown };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) return [];
  const definitions: SfxAssetDefinition[] = [];
  for (const candidate of manifest.entries as PublicSfxManifestEntry[]) {
    if (typeof candidate.id !== 'string'
      || !/^sfx_(?:troop|hero|defense|ui|base|battle|ambience)_[a-z0-9_]+_v[1-3]$/.test(candidate.id)
      || typeof candidate.file !== 'string'
      || !/^[A-Za-z0-9_./-]+\.(?:mp3|wav)$/.test(candidate.file)
      || candidate.file.includes('..') || candidate.file.includes('//')) continue;
    const hasLoop = candidate.loopStart !== undefined || candidate.loopEnd !== undefined;
    if (hasLoop && (typeof candidate.loopStart !== 'number'
      || typeof candidate.loopEnd !== 'number' || !Number.isFinite(candidate.loopStart)
      || !Number.isFinite(candidate.loopEnd) || candidate.loopStart < 0
      || candidate.loopStart >= candidate.loopEnd)) continue;
    definitions.push({
      id: candidate.id as ProductionSfx,
      file: `/audio/sfx-ai/${candidate.file}`,
      ...(hasLoop ? {
        loopStartSeconds: candidate.loopStart as number,
        loopEndSeconds: candidate.loopEnd as number,
      } : {}),
    });
  }
  return definitions;
}

/** Rolling-deploy safe: an old asset build has no manifest and simply retains
 * the 35 public-domain WAVs. Only hash-reviewed promoted files appear here. */
export function loadProductionSfxManifest(): Promise<boolean> {
  if (manifestReady) return Promise.resolve(true);
  if (manifestLoad) return manifestLoad;
  if (Date.now() < manifestRetryAt) return Promise.resolve(false);
  manifestLoad = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AUDIO_RUNTIME.manifestRequestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(PRODUCTION_MANIFEST_URL, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) return false;
      const definitions = productionDefinitionsFromManifest(await response.json());
      engine.registerProductionAssets(definitions);
      return definitions.length > 0;
    } catch {
      return false;
    }
  })().then((loaded) => {
    if (loaded) manifestReady = true;
    else manifestRetryAt = Date.now() + AUDIO_RUNTIME.manifestRetryDelayMs;
    return loaded;
  }).finally(() => { manifestLoad = null; });
  return manifestLoad;
}

/** Resolve without loading/playing so a battle can acquire its exact event bank. */
export function resolveSfxFamily(
  family: string,
  variantKey: string | number,
  loop = false,
): ProductionSfx | null {
  return engine.resolveFamily(family, variantKey, loop);
}

/** Prefer a reviewed production family and retain one truthful legacy fallback
 * for partial/rolling asset deployments. */
export function playSfxFamily(
  family: string,
  variantKey: string | number,
  fallback?: LegacySfx,
  opts?: SfxPlayOptions,
): SfxHandle {
  return engine.playFamily(family, variantKey, fallback, opts);
}

/** Unambiguous old-call aliases. Generic deploy/melee/ranged/impact cues are
 * intentionally absent: BattleScene supplies their actor/defense identity. */
const LEGACY_PRODUCTION_FAMILY: Partial<Record<LegacySfx, string>> = {
  sfx_tap: 'sfx_ui_tap',
  sfx_confirm: 'sfx_ui_confirm',
  sfx_error: 'sfx_ui_error',
  sfx_claim_chime: 'sfx_ui_claim_chime',
  sfx_coin_shower: 'sfx_ui_coin_shower',
  sfx_quest_done: 'sfx_ui_quest_done',
  sfx_levelup: 'sfx_ui_levelup',
  sfx_streak_tick: 'sfx_ui_streak_tick',
  sfx_place_thump: 'sfx_base_place',
  sfx_build_complete: 'sfx_base_build_complete',
  sfx_upgrade_hammer: 'sfx_base_upgrade_hammer',
  sfx_rubble_crash: 'sfx_base_rubble_collapse',
  sfx_wall_clink: 'sfx_base_wall_place',
  sfx_cannon_fire: 'sfx_defense_cannon_fire',
  sfx_mortar_thunk: 'sfx_defense_mortar_launch',
  sfx_shell_whistle: 'sfx_defense_mortar_whistle',
  sfx_keg_fuse: 'sfx_troop_kegrunner_fuse_loop',
  sfx_trap_snap: 'sfx_defense_spiketrap_snap',
  sfx_rally_horn: 'sfx_battle_rally',
  sfx_shield_up: 'sfx_battle_shield_up',
  sfx_shield_shatter: 'sfx_battle_shield_shatter',
  sfx_star_1: 'sfx_battle_star_1',
  sfx_star_2: 'sfx_battle_star_2',
  sfx_star_3: 'sfx_battle_star_3',
  sfx_hero_dash: 'sfx_hero_vex_crimson_dash',
  sfx_hero_quake: 'sfx_hero_theodor_cheek_quake',
  sfx_hero_deploy_vex: 'sfx_hero_vex_deploy',
  sfx_hero_deploy_theo: 'sfx_hero_theodor_deploy',
};
let legacyVariantSequence = 0;

export function productionFamilyForLegacySfx(name: LegacySfx): string | undefined {
  return LEGACY_PRODUCTION_FAMILY[name];
}

/** Arm first-gesture unlock. Call once at app start. */
export function installAudioUnlock(): void {
  engine.installUnlock();
}

/** Play a one-shot (or looping) SFX. Returns a stop handle for loops. */
export function playSfx(name: Sfx, opts?: SfxPlayOptions): SfxHandle {
  if (!/_v[1-3]$/.test(name)) {
    const family = productionFamilyForLegacySfx(name as LegacySfx);
    if (family) {
      const selected = engine.resolveFamily(
        family, `${name}:${legacyVariantSequence++}`, opts?.loop === true,
      );
      if (selected && engine.isBuffered(selected)) return engine.play(selected, opts);
      if (selected) engine.warm(selected);
    }
  }
  return engine.play(name, opts);
}

/** Decode and pin only the cues relevant to the active screen/battle. */
export function acquireSfxBank(names: readonly Sfx[]): SfxBank {
  return engine.acquireBank(names);
}

/** Register only the currently lazy-loaded manifest slice. Existing 35 cues
 * need no records and keep their historical `/audio/sfx/<id>.wav` contract. */
export function registerSfxAssets(definitions: readonly SfxAssetDefinition[]): void {
  engine.registerProductionAssets(definitions);
}

/** Persist the profile switch and stop every live source immediately when off. */
export function setSoundFx(on: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_FX_KEY, on ? '1' : '0');
  if (!on) engine.stopAll();
  else void syncProductionAmbience();
}

/** Stop all looping SFX (keg fuse / burrow) — e.g. on battle exit. */
export function stopAllLoops(): void {
  engine.stopLoops();
}

// ---------------------------------------------------------------------------
// Background music — the new owner theme for the world/menu and the previous
// theme retained temporarily for battle. SEPARATE from SFX: its own localStorage
// toggle + streamed HTMLAudioElements, so MUSIC and SOUND FX mute independently.
// Autoplay is blocked until a gesture, so it starts from the same unlock() the
// SFX engine arms. Each route keeps its playback position while the other plays.
// ---------------------------------------------------------------------------

const MUSIC_KEY = 'skp_music';
export type MusicTrack = 'world' | 'battle';
const MUSIC_SOURCES: Readonly<Record<MusicTrack, string>> = {
  // The content changes independently of the display semver. The exact build
  // SHA makes a freshly deployed owner track a new URL without asking players
  // to clear a stale browser/CDN entry manually.
  world: `/audio/bgmusic-world.mp3?v=${BUILD.gitSha}`,
  battle: `/audio/bgmusic-battle.mp3?v=${BUILD.gitSha}`,
};

/** The battle screen owns deploy, playback and result phases; every other
 * route uses the calmer normal-game theme. */
export function musicTrackForScreen(screen: Screen): MusicTrack {
  return screen === 'battle' ? 'battle' : 'world';
}

/** MUSIC profile toggle (localStorage). Defaults ON, mirroring soundFxOn(). */
export function musicOn(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(MUSIC_KEY) !== '0';
}

let activeMusicTrack: MusicTrack = 'world';
const musicEls: Partial<Record<MusicTrack, HTMLAudioElement>> = {};
let activeAmbienceScreen: Screen = 'loading';
let activeAmbience: SfxHandle | null = null;
let ambienceGeneration = 0;

export function ambienceFamilyForScreen(screen: Screen): string | null {
  if (screen === 'battle') return 'sfx_ambience_battle';
  if (screen === 'map' || screen === 'scout') return 'sfx_ambience_campaign';
  if (screen === 'base' || screen === 'build' || screen === 'layout' || screen === 'expand') {
    return 'sfx_ambience_base_day';
  }
  return null;
}

/** Swap one low-gain reviewed bed per world context. MP3 loops without measured
 * boundaries resolve to null, so a bad promotion yields silence—not a click. */
async function syncProductionAmbience(): Promise<void> {
  const generation = ++ambienceGeneration;
  activeAmbience?.stop();
  activeAmbience = null;
  const family = ambienceFamilyForScreen(activeAmbienceScreen);
  if (!family || !soundFxOn() || !engine.isUnlocked() || !await loadProductionSfxManifest()
    || generation !== ambienceGeneration) return;
  const selected = resolveSfxFamily(family, activeAmbienceScreen, true);
  if (!selected) return;
  const bank = acquireSfxBank([selected]);
  await bank.ready;
  if (generation !== ambienceGeneration || !soundFxOn()) {
    bank.release();
    return;
  }
  activeAmbience = playSfxFamily(family, activeAmbienceScreen, undefined, {
    loop: true,
    volume: AUDIO_RUNTIME.ambienceVolume,
    priority: 'ambient',
  });
  bank.release();
}

function ensureMusicEl(track = activeMusicTrack): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  let el = musicEls[track];
  if (!el) {
    el = new Audio(MUSIC_SOURCES[track]);
    el.loop = true;
    el.volume = 0.4; // sit under the SFX; a theme, not a foreground sound
    musicEls[track] = el;
  }
  return el;
}

/** Route music with screen state. Pause the previous mood before starting the
 * next one, while retaining both playback positions for a natural return. */
export function setMusicScreen(screen: Screen): void {
  if (screen !== activeAmbienceScreen) {
    activeAmbienceScreen = screen;
    void syncProductionAmbience();
  }
  const next = musicTrackForScreen(screen);
  if (next === activeMusicTrack) return;
  musicEls[activeMusicTrack]?.pause();
  activeMusicTrack = next;
  if (musicOn()) {
    const el = ensureMusicEl();
    if (el) void el.play().catch(() => { /* the next unlock/tap can retry */ });
  }
}

/** Start the theme IF the toggle is on. Called from the unlock gesture (so
 *  autoplay is satisfied) and re-callable safely (play() is idempotent). */
export function startMusicIfEnabled(): void {
  void syncProductionAmbience();
  if (!musicOn()) return;
  const el = ensureMusicEl();
  if (el) void el.play().catch(() => { /* autoplay may still reject pre-gesture */ });
}

/** Flip the MUSIC toggle: persist AND start/pause the live element immediately. */
export function setMusic(on: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(MUSIC_KEY, on ? '1' : '0');
  if (on) {
    const el = ensureMusicEl();
    if (el) void el.play().catch(() => { /* needs a gesture; the next unlock covers it */ });
  } else {
    for (const el of Object.values(musicEls)) el.pause();
  }
}

// dev handle for preview-driven smoke checks (mirrors window.__bus / __store)
if (typeof import.meta !== 'undefined' && import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __sfx?: typeof playSfx }).__sfx = playSfx;
}
