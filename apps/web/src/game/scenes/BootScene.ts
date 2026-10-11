/**
 * Boot/preload: the eager category multiatlases (historical groups @2x;
 * current-art fallback @1x) + the sprite metadata sidecar (anchors,
 * footprints, palette swaps, animation families from the asset pipeline).
 *
 * The per-level `trpdg_l<N>` groups are deliberately NOT here — see
 * world/atlasLoader.ts for why and who pulls them in.
 */
import Phaser from 'phaser';
import {
  ATLAS_PREFIXES, atlasGroupFor, deviceAtlasScale, eagerAtlasScale,
  type AtlasPrefix, type DeviceArtProfile,
} from '@shardkeep/shared';
import { bus, type BootFileDiagnostic, type BootRoundDiagnostic } from '../../lib/events';
import { deviceArtProfile } from '../../lib/deviceProfile';
import { useApp } from '../../state/store';
import { BUILD } from '../../lib/version';
import type { V2Meta } from '../v2/clips';
import type { WareMeta } from '../ware/clips';
import {
  ART_PROFILE_REGISTRY_KEY, stitchAtlas, supportsLogicalAtlasUpscale,
} from '../world/atlasTexels';
import {
  KEEP_CLOCK_META_REGISTRY_KEY, parseKeepClockMetadata,
} from '../world/keepClock';
import { MARKET_ART_REGISTRY_KEY, parseMarketArtMetadata } from '../world/marketArt';
import { STARTER_FLEET_ART_REGISTRY_KEY, parseStarterFleetMetadata } from '../world/fleetArt';
import { ADVANCED_FLEET_ART_REGISTRY_KEY, parseAdvancedFleetMetadata } from '../world/advancedFleetArt';

/**
 * The grouping rule and the eager set now live in @shardkeep/shared, because
 * the asset packer decides the same thing and a second copy here drifted
 * silently (see the header of packages/shared/src/atlas.ts). Re-exported under
 * the old names so the existing call sites keep importing them from the scene.
 * `atlasGroupFor` keeps BootScene's historical unknown-prefix → 'ui' fallback.
 */
export { ATLAS_PREFIXES, atlasGroupFor as atlasFor, type AtlasPrefix };

export interface SpriteMeta {
  anchor: [number, number];
  footprint: [number, number] | null;
  /** M22 building aliases are authored around footprint centre; walls are not. */
  anchorAtFootprintCentre?: boolean;
  /** M22 authored-source multiplier; resolved against the loaded atlas scale. */
  sourceScale?: number;
  /** Presentation-only offset in the canonical 32-px game coordinate space. */
  offsetGamePx?: readonly [number, number];
  paletteSwap: Record<string, string> | null;
  animFamily: { base: string; frames: string[]; pingpong: boolean } | null;
}

export type MetaMap = Record<string, SpriteMeta>;

/** Transport/decode deadlines are presentation recovery, not game rules. */
// XHR.timeout is wall-clock time: it cannot pause with the scene, and a service
// worker may expose no headers/bytes until its entire response passes integrity.
// The scene owns cancellation through its finite foreground budget instead.
export const BOOT_REQUEST_TIMEOUT_MS = 0;
export const BOOT_REQUEST_BATCH_BUDGET_MS = 15_000;
export const BOOT_ROUND_TIMEOUT_MS = 20_000;
export const BOOT_MIN_ROUND_BUDGET_MS = 120_000;

export class BootScene extends Phaser.Scene {
  private artProfile: DeviceArtProfile = 'full';
  private retried = false;
  private finished = false;
  private roundTimer: ReturnType<typeof setTimeout> | null = null;
  private roundFiles = new Set<Phaser.Loader.File>();
  private pendingValidation = false;
  private roundActiveMs = 0;
  private activeSince: number | null = null;
  private progressAtMs = 0;
  private roundBudgetMs = BOOT_ROUND_TIMEOUT_MS;
  private progressBytes = new Map<Phaser.Loader.File, number>();
  private fileDiagnostics = new Map<Phaser.Loader.File, BootFileDiagnostic>();
  private roundDiagnostics: BootRoundDiagnostic[] = [];
  private roundRecorded = false;

  private canProgress(): boolean {
    return !this.game.isPaused && (typeof document === 'undefined' || !document.hidden);
  }

  private readonly suspendRound = (): void => {
    this.roundActiveMs = this.activeRoundMs();
    this.activeSince = null;
    this.clearRoundTimer();
  };
  private readonly resumeRound = (): void => {
    if (this.finished || !this.canProgress()) return;
    if (this.pendingValidation) {
      this.pendingValidation = false;
      this.create();
    } else this.watchRound();
  };
  private readonly visibilityChanged = (): void => {
    if (this.canProgress()) this.resumeRound();
    else this.suspendRound();
  };

  private activeRoundMs(): number {
    return this.roundActiveMs + (this.activeSince === null ? 0 : Math.max(0, performance.now() - this.activeSince));
  }

  private readonly fileProgress = (file: Phaser.Loader.File): void => {
    if (!this.roundFiles.has(file)) return;
    const previous = this.progressBytes.get(file) ?? 0;
    if (!Number.isFinite(file.bytesLoaded) || file.bytesLoaded <= previous) return;
    this.progressBytes.set(file, file.bytesLoaded);
    this.captureFile(file, 'loading');
    this.usefulProgress();
  };

  private readonly fileLoaded = (file: Phaser.Loader.File): void => {
    if (!this.roundFiles.has(file)) return;
    this.captureFile(file, 'processing');
    this.usefulProgress();
  };

  private readonly fileFailed = (file: Phaser.Loader.File): void => {
    if (!this.roundFiles.has(file)) return;
    this.captureFile(file, 'failed');
    this.usefulProgress();
  };

  private readonly fileComplete = (key: string): void => {
    const file = [...this.roundFiles].find(candidate => this.fileDiagnostics.get(candidate)?.key === key);
    if (!file) return;
    this.captureFile(file, 'complete');
    this.usefulProgress();
    this.publishProgress();
  };

  private readonly beforeLoaderComplete = (): void => {
    // Native loadComplete destroys File objects before emitting COMPLETE.
    // Capture their terminal states first, including image-processing failures
    // that do not emit the transport-only LOAD_ERROR event.
    for (const file of this.roundFiles) this.captureFile(file);
  };

  private usefulProgress(): void {
    this.progressAtMs = this.activeRoundMs();
    this.watchRound();
  }

  private captureFile(file: Phaser.Loader.File, phase?: BootFileDiagnostic['phase']): void {
    const record = this.fileDiagnostics.get(file);
    if (!record) return;
    if (phase) record.phase = phase;
    if (Number.isSafeInteger(file.state)) record.state = file.state;
    const status = file.xhrLoader?.status;
    if (typeof status === 'number' && Number.isSafeInteger(status) && status >= 0 && status <= 599) record.status = status;
    for (const [source, target] of [['bytesLoaded', 'loadedBytes'], ['bytesTotal', 'totalBytes']] as const) {
      const value = file[source];
      if (Number.isSafeInteger(value) && value >= 0) record[target] = value;
    }
  }

  private publishProgress(): void {
    const total = ATLAS_PREFIXES.length * 2 + 1;
    const complete = [...this.fileDiagnostics.values()].filter(file => file.phase === 'complete').length;
    bus.emit('boot:progress', {
      completed: total - this.roundFiles.size + complete, total, attempt: this.retried ? 2 : 1,
    });
  }

  private recordRound(reason: BootRoundDiagnostic['reason']): void {
    if (this.roundRecorded) return;
    this.roundRecorded = true;
    for (const file of this.roundFiles) this.captureFile(file);
    this.roundDiagnostics.push({
      attempt: this.retried ? 2 : 1, reason,
      activeMs: Math.round(this.activeRoundMs()), budgetMs: this.roundBudgetMs,
      queued: this.load.list?.size ?? 0, inflight: this.load.inflight?.size ?? 0,
      processing: this.load.queue?.size ?? 0,
      files: [...this.fileDiagnostics.values()].map(file => ({ ...file })),
    });
  }

  constructor() {
    super('boot');
  }

  preload(): void {
    // NOT load.multiatlas: in Phaser 4.1 its child PNGs queue but never kick
    // (observed: 9 pending / 0 inflight stall). Our atlases are single-texture,
    // so load image+json separately and stitch in create().
    // ?v=<gitSha> on every atlas fetch — the same trick sw.ts uses. The atlas
    // PNG and its JSON are ONE artifact split in two files: frame rects in the
    // json are offsets into that exact png. Unversioned URLs let any cache
    // (Cloudflare edge, browser, SW) pair files from DIFFERENT deploys, and a
    // repack moves every rect — the whole base then renders as wrong crops.
    // Observed live 2026-08-03: the edge served a 105-min-old blddef@2x.png
    // (age 6305, max-age 14400) against the new meta/json for over an hour;
    // every phone that loaded in that window saw a scrambled base. Sha-keyed
    // URLs make a mixed pairing impossible: new code can only ever fetch the
    // atlases built WITH it.
    // WebGL can keep @1x source texels while presenting the historical @2x
    // logical frame geometry. Canvas cannot separate those two dimensions, so
    // its rare fallback stays on the unchanged full profile.
    this.artProfile = supportsLogicalAtlasUpscale(this) ? deviceArtProfile() : 'full';
    this.registry.set(ART_PROFILE_REGISTRY_KEY, this.artProfile);
    this.retried = false;
    this.finished = false;
    this.pendingValidation = false;
    this.roundDiagnostics = [];
    this.load.on('fileprogress', this.fileProgress);
    this.load.on('load', this.fileLoaded);
    this.load.on('loaderror', this.fileFailed);
    this.load.on('filecomplete', this.fileComplete);
    this.load.on('postprocess', this.beforeLoaderComplete);
    this.game.events.on('pause', this.suspendRound);
    this.game.events.on('resume', this.resumeRound);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityChanged);
    this.events.once('shutdown', this.disposeBoot, this);
    this.events.once('destroy', this.disposeBoot, this);
    this.queueRequiredFiles();
    this.watchRound();
  }

  private queueRequiredFiles(): void {
    // Own the single retry and foreground deadline so invalid JSON shapes,
    // transport failures and PNG decode stalls share one bounded policy.
    this.load.maxRetries = 0;
    this.load.imageLoadType = 'XHR';
    const xhrSettings = { timeout: BOOT_REQUEST_TIMEOUT_MS, responseType: 'text' as const };
    for (const p of ATLAS_PREFIXES) {
      const scale = deviceAtlasScale(p, this.artProfile);
      if (!this.textures.exists(`${p}-img`)) {
        this.load.image(`${p}-img`, `/atlas/${p}@${scale}x.png?v=${BUILD.gitSha}`, { ...xhrSettings, responseType: 'blob' });
      }
      if (!Array.isArray(this.cache.json.get(`${p}-json`)?.textures?.[0]?.frames)) {
        this.cache.json.remove(`${p}-json`);
        this.load.json({ key: `${p}-json`, url: `/atlas/${p}@${scale}x.json?v=${BUILD.gitSha}`, xhrSettings });
      }
    }
    const metadata = this.cache.json.get('sprite-meta');
    if (!metadata?.sprites || typeof metadata.sprites !== 'object' || Array.isArray(metadata.sprites)) {
      this.cache.json.remove('sprite-meta');
      this.load.json({ key: 'sprite-meta', url: `/atlas/meta.json?v=${BUILD.gitSha}`, xhrSettings });
    }
    this.roundFiles = new Set(this.load.list);
    this.progressBytes.clear();
    this.fileDiagnostics.clear();
    for (const file of this.roundFiles) {
      const nativeProgress = file.onProgress;
      file.onProgress = (event: ProgressEvent): void => {
        if (!this.roundFiles.has(file) || !file.loader) return;
        nativeProgress.call(file, event);
        // Phaser calculates percentages only when the response total is known.
        // A streaming response without that total still proves useful progress;
        // keep its bytes without inventing a percentage or extending the budget.
        if (!event.lengthComputable && Number.isSafeInteger(event.loaded) && event.loaded >= 0) {
          file.bytesLoaded = event.loaded;
          this.fileProgress(file);
        }
      };
      this.fileDiagnostics.set(file, {
        key: file.key, kind: file.type === 'image' ? 'image' : 'json', phase: 'queued',
        state: Number.isSafeInteger(file.state) ? file.state : null,
        status: null, loadedBytes: 0, totalBytes: 0,
      });
    }
    this.roundRecorded = false;
    this.roundActiveMs = 0;
    this.activeSince = null;
    this.progressAtMs = 0;
    const count = this.roundFiles.size;
    const parallel = Number.isSafeInteger(this.load.maxParallelDownloads)
      ? Math.max(1, this.load.maxParallelDownloads) : 1;
    // More parallel slots do not make a multi-MB atlas download faster. Phaser's
    // desktop/iOS 32-slot default previously capped healthy transfers at 35s.
    // Keep batch allowance for slower queues, with the same 120s minimum used by
    // terrain preparation. Useful progress/visibility never renew this ceiling;
    // the current required set gets at most two 120s rounds. The existing 20s
    // observable-idle check remains; buffered OPENED requests use the round cap.
    this.roundBudgetMs = Math.max(BOOT_MIN_ROUND_BUDGET_MS,
      Math.ceil(count / parallel) * BOOT_REQUEST_BATCH_BUDGET_MS + BOOT_ROUND_TIMEOUT_MS);
    this.publishProgress();
  }

  private clearRoundTimer(): void {
    if (this.roundTimer !== null) clearTimeout(this.roundTimer);
    this.roundTimer = null;
  }

  private cancelPendingFiles(): void {
    // Loader.reset clears its Sets but does not cancel XHR/decode callbacks.
    // Keep the queued identities even if Loader's shutdown listener ran first.
    for (const file of this.roundFiles) {
      if (!file.loader) continue;
      const xhr = file.xhrLoader;
      if (xhr) {
        file.resetXHR(); xhr.ontimeout = null; xhr.onabort = null; xhr.abort();
      }
      if (file.type === 'image' && file.data && !this.textures.exists(file.key)) {
        const image = file.data as HTMLImageElement;
        image.onload = null; image.onerror = null;
        if (image.src?.startsWith('blob:')) URL.revokeObjectURL(image.src);
        image.removeAttribute('src');
      }
    }
    this.roundFiles.clear();
    this.events.off('update', this.load.update, this.load);
    // Direct Game/Scene destruction runs Loader.destroy before this listener.
    // Its Sets are then null, although our saved file callbacks still need aborting.
    if (this.load.list) this.load.reset();
  }

  private remainingRoundMs(): number {
    const activeMs = this.activeRoundMs();
    // OPENED (1) means no response headers are visible. In particular, the SW
    // buffers and verifies a complete atlas before exposing anything to XHR.
    // Zero observable progress here cannot distinguish a healthy transfer from
    // a hung peer; both remain bounded by the same finite active-round ceiling.
    const waitingForResponse = [...this.roundFiles].some(file => file.loader
      && file.xhrLoader?.readyState === 1 && (this.progressBytes.get(file) ?? 0) === 0);
    return Math.min(this.roundBudgetMs - activeMs, waitingForResponse ? Infinity
      : BOOT_ROUND_TIMEOUT_MS - (activeMs - this.progressAtMs));
  }

  private watchRound(): void {
    this.clearRoundTimer();
    // Android queues only six files at once; Phaser advances the rest on RAF.
    // A hidden/paused game cannot drain that queue and must not spend its retry.
    if (!this.canProgress()) return;
    if (this.activeSince === null) this.activeSince = performance.now();
    const remaining = this.remainingRoundMs();
    // A useful byte/file completion buys idle time, while a finite active-round
    // ceiling still bounds a peer that drips progress indefinitely.
    this.roundTimer = setTimeout(() => {
      this.roundTimer = null;
      if (this.finished || !this.canProgress()) return;
      // preload arms before Loader.start creates XHRs. Recheck current state
      // rather than treating that initial no-transport idle deadline as final.
      if (this.remainingRoundMs() > 0) { this.watchRound(); return; }
      this.recordRound(this.activeRoundMs() >= this.roundBudgetMs ? 'active-deadline' : 'idle-timeout');
      this.cancelPendingFiles();
      // An empty Loader.start completes through the ordinary scene lifecycle:
      // first preload invokes create; the recovery round invokes it once more.
      this.load.start();
    }, Math.max(0, Math.ceil(remaining)));
  }

  private disposeBoot(): void {
    this.finished = true;
    this.clearRoundTimer();
    this.pendingValidation = false;
    this.activeSince = null;
    this.load.off('fileprogress', this.fileProgress);
    this.load.off('load', this.fileLoaded);
    this.load.off('loaderror', this.fileFailed);
    this.load.off('filecomplete', this.fileComplete);
    this.load.off('postprocess', this.beforeLoaderComplete);
    this.game.events.off('pause', this.suspendRound);
    this.game.events.off('resume', this.resumeRound);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.load.off('complete', this.create, this);
    this.events.off('shutdown', this.disposeBoot, this);
    this.events.off('destroy', this.disposeBoot, this);
    this.cancelPendingFiles();
    this.progressBytes.clear();
    this.fileDiagnostics.clear();
  }

  create(): void {
    this.clearRoundTimer();
    if (this.finished) return;
    // Transport errors/completions can arrive while the game is backgrounded.
    // Validate/retry on return instead of exhausting both attempts offscreen.
    if (!this.canProgress()) { this.pendingValidation = true; return; }
    this.recordRound('complete');
    // Phaser completes its loader even when files failed. Validate the whole
    // required set before stitching/removing any staging texture, so a failed
    // fetch cannot strand a signed-in player behind an unbooted loading screen.
    const files: string[] = [];
    for (const p of ATLAS_PREFIXES) {
      const scale = deviceAtlasScale(p, this.artProfile);
      const data = this.cache.json.get(`${p}-json`);
      if (!this.textures.exists(`${p}-img`)) files.push(`${p}@${scale}x.png`);
      if (!Array.isArray(data?.textures?.[0]?.frames)) files.push(`${p}@${scale}x.json`);
    }
    const metadata = this.cache.json.get('sprite-meta');
    if (!metadata?.sprites || typeof metadata.sprites !== 'object' || Array.isArray(metadata.sprites)) {
      files.push('meta.json');
    }
    if (files.length) {
      if (!this.retried) {
        this.retried = true;
        this.queueRequiredFiles();
        this.load.once('complete', this.create, this);
        this.watchRound();
        this.load.start();
        return;
      }
      this.disposeBoot();
      bus.emit('boot:failed', { files, diagnostics: { profile: this.artProfile, rounds: this.roundDiagnostics } });
      return;
    }
    this.disposeBoot();
    for (const p of ATLAS_PREFIXES) {
      const data = this.cache.json.get(`${p}-json`) as {
        textures: Array<{ frames: unknown[] }>;
      };
      // free-tex-packer "textures" array → Phaser JSONArray atlas shape
      const fileScale = deviceAtlasScale(p, this.artProfile);
      const logicalScale = eagerAtlasScale(p);
      stitchAtlas(
        this,
        p,
        this.textures.get(`${p}-img`).getSourceImage() as HTMLImageElement,
        data.textures[0]!.frames,
        logicalScale / fileScale,
      );
      // Drop the staging texture. addAtlas built its OWN TextureSource around
      // the same HTMLImageElement, so `<p>-img` is now a second, complete copy
      // of every atlas on the GPU — measured live before this line existed:
      // 291MB of textures, with blddef@2x present twice at 38.1MB each.
      //
      // Verified in a real renderer rather than reasoned about, because the
      // failure mode is a black screen: after remove(), the atlas keeps its own
      // glTexture and all 481 frames (atlas.source[0] !== staging.source[0],
      // same underlying image). Phaser only tears down the source it owns.
      this.textures.remove(`${p}-img`);
    }
    // sidecar shape: { version, scales, atlases, brandStandalones, sprites,
    // v2Clips, breathStream, atlasBytes } — the rework-v2 clip tables and exact
    // on-demand decoded-RGBA residency ride the same generated file.
    const sidecar = this.cache.json.get('sprite-meta') as {
      sprites: MetaMap;
      v2Clips?: V2Meta['clips'];
      breathStream?: V2Meta['breathStream'];
      atlasBytes?: V2Meta['atlasBytes'];
      wareClips?: WareMeta['clips'];
      builderClips?: V2Meta['clips'];
      currentArtAliases?: WareMeta['currentArtAliases'];
      keepClock?: unknown;
      peMarket?: unknown;
      peCosmetics?: unknown;
      peServiceBuildings?: unknown;
      peHarvesters?: unknown;
      peStarterFleet?: unknown;
      peClips?: unknown;
      peTracks?: unknown;
      peAdvancedFleet?: unknown;
    };
    this.registry.set('meta', sidecar.sprites);
    this.registry.set('builderClips', sidecar.builderClips ?? {});
    // Rework-v2 sidecar (game/v2/clips.ts V2Meta): clip shapes, fps, emitters,
    // stream geometry. Stashed whole — the v2 renderers read it through the
    // typed registry in game/v2/clips.ts rather than re-parsing meta.json.
    const v2meta: V2Meta = {
      clips: sidecar.v2Clips ?? {},
      breathStream: sidecar.breathStream ?? null,
      // Backward-compatible during a rolling deploy or stale local asset
      // checkout: consumers see a safe empty table, never `undefined`.
      atlasBytes: sidecar.atlasBytes ?? {},
    };
    this.registry.set('v2meta', v2meta);
    const waremeta: WareMeta = {
      clips: sidecar.wareClips ?? {},
      currentArtAliases: sidecar.currentArtAliases ?? {},
      atlasBytes: sidecar.atlasBytes ?? {},
    };
    this.registry.set('waremeta', waremeta);
    // Optional until the approved KEEP progression publishes exact per-frame
    // clock pivots. Missing metadata is deliberately clockless, never guessed.
    this.registry.set(
      KEEP_CLOCK_META_REGISTRY_KEY,
      parseKeepClockMetadata(sidecar.keepClock),
    );
    // Phase E Market art (C3): the ordinary pe_market_t<T> groups and the bound
    // Awning pe_cosmetics group are on-demand, never in ATLAS_PREFIXES. A legacy
    // or defective sidecar registers the empty table and boots normally. P5 adds
    // the ordinary Workshop/Lodge families (peServiceBuildings) to the SAME table;
    // a defective service table leaves the Market families untouched.
    this.registry.set(
      MARKET_ART_REGISTRY_KEY,
      parseMarketArtMetadata(sidecar.peMarket, sidecar.peCosmetics, sidecar.peServiceBuildings, sidecar.peHarvesters),
    );
    // Phase E starter fleet (P4): the single optional 1x group pe_fleet_starter is
    // on-demand, never in ATLAS_PREFIXES. Identity/geometry come from peStarterFleet,
    // its clips and authored tracks from peClips/peTracks; a legacy or defective
    // sidecar registers the empty table and boots normally.
    this.registry.set(
      STARTER_FLEET_ART_REGISTRY_KEY,
      parseStarterFleetMetadata(sidecar.peStarterFleet, sidecar.peClips, sidecar.peTracks),
    );
    // Phase E advanced fleet (P6a): the twenty optional 1x groups stay on-demand,
    // never in ATLAS_PREFIXES; a legacy or defective sidecar registers the empty
    // table and boots normally.
    this.registry.set(ADVANCED_FLEET_ART_REGISTRY_KEY, parseAdvancedFleetMetadata(sidecar.peAdvancedFleet));
    this.scene.start('base');
    useApp.getState().setBooted(true);
    bus.emit('boot:ready', undefined);
  }
}
