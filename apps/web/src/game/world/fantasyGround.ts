/** Scene-owned terrain. Only the active base/defender theme is decoded; the
 * accepted floor and Sharp deed crop use the same world-coordinate sampler. */
import type Phaser from 'phaser';
import {
  baseGroundArt, assertGroundSource, baseGroundTransport, createGroundRaster,
  resolveBaseVisualContext, type BaseVisualContext, type GroundPixels,
} from '@shardkeep/shared/baseVisual';
import { BASE_GROUND_MOTION } from '@shardkeep/shared';
import { groundEnvironmentFeatures, GROUND_ENVIRONMENT_REVISION_2, type GroundFeatureKind } from '@shardkeep/shared/groundEnvironment';
import { reduceMotionOn } from '../../lib/juice';
import { BUILD } from '../../lib/version';
import { skirtTint } from './underlay';
import { downloadGround, GroundLoadError, VisibleTimeout, type GroundTransferProgress } from './groundDownload';

export interface GroundCoverage { x: number; y: number; width: number; height: number }

function sameGroundRect(a: GroundCoverage, b: GroundCoverage): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function containsGroundRect(outer: GroundCoverage, inner: GroundCoverage): boolean {
  return outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

/** Expand only the axes the camera can reveal, snapping outwards to whole tiles.
 * The original crop remains included; rotation derives a fresh rectangle rather
 * than accumulating portrait and landscape surfaces into one large square. */
export function groundCoverageRect(
  cornerTile: number, sizeTiles: number, tilePx: number, coverage?: GroundCoverage,
): GroundCoverage {
  const lo = cornerTile * tilePx, hi = (cornerTile + sizeTiles) * tilePx;
  if (!coverage) return { x: lo, y: lo, width: hi - lo, height: hi - lo };
  if (![coverage.x, coverage.y, coverage.width, coverage.height].every(Number.isFinite)
    || coverage.width <= 0 || coverage.height <= 0) throw new RangeError('Invalid ground coverage');
  const x = Math.min(lo, Math.floor(coverage.x / tilePx) * tilePx);
  const y = Math.min(lo, Math.floor(coverage.y / tilePx) * tilePx);
  const right = Math.max(hi, Math.ceil((coverage.x + coverage.width) / tilePx) * tilePx);
  const bottom = Math.max(hi, Math.ceil((coverage.y + coverage.height) / tilePx) * tilePx);
  return { x, y, width: right - x, height: bottom - y };
}

/** Outside the authored world the shared sampler clamps to its last pixel.
 * Reuse those edge pixels as texture frames instead of allocating an arbitrarily
 * wide bitmap when a short window can see far beyond the painting. */
export function groundPaintLayout(coverage: GroundCoverage, context: BaseVisualContext, tilePx: number): {
  paint: GroundCoverage; extensions: Array<{ bounds: GroundCoverage; source: GroundCoverage }>;
} {
  if (context.artVersion === 1) return { paint: coverage, extensions: [] };
  const art = baseGroundArt(context), scale = art.tilePx / tilePx;
  const lo = art.worldOriginTiles * tilePx, hi = lo + art.worldTiles * tilePx;
  const x = Math.max(lo, coverage.x), y = Math.max(lo, coverage.y);
  const right = Math.min(hi, coverage.x + coverage.width), bottom = Math.min(hi, coverage.y + coverage.height);
  const paint = { x, y, width: right - x, height: bottom - y };
  if (paint.width <= 0 || paint.height <= 0) throw new RangeError('Ground coverage must include the authored world');
  const axes = (start: number, size: number, fullStart: number, fullSize: number) => [
    { start: fullStart, size: start - fullStart, source: 0, pixels: 1 },
    { start, size, source: 0, pixels: size * scale },
    { start: start + size, size: fullStart + fullSize - start - size, source: size * scale - 1, pixels: 1 },
  ];
  const xs = axes(paint.x, paint.width, coverage.x, coverage.width);
  const ys = axes(paint.y, paint.height, coverage.y, coverage.height);
  const extensions = [];
  for (let row = 0; row < ys.length; row++) for (let col = 0; col < xs.length; col++) {
    const sx = xs[col]!, sy = ys[row]!;
    if ((row === 1 && col === 1) || sx.size <= 0 || sy.size <= 0) continue;
    extensions.push({ bounds: { x: sx.start, y: sy.start, width: sx.size, height: sy.size },
      source: { x: sx.source, y: sy.source, width: sx.pixels, height: sy.pixels } });
  }
  return { paint, extensions };
}

export type GroundPhase = 'download' | 'verify' | 'decode' | 'terrain' | 'upload' | 'ready';
interface GroundLoadProgress extends Partial<GroundTransferProgress> {
  phase: GroundPhase; downloadMs: number; verifyMs: number; decodeMs: number; loadActiveMs?: number;
}
type LoadProgress = (progress: GroundLoadProgress) => void;
export type GroundLoader = (context: BaseVisualContext, signal: AbortSignal, report?: LoadProgress) => Promise<GroundPixels>;
export async function loadGroundPixels(context: BaseVisualContext, signal: AbortSignal, report?: LoadProgress): Promise<GroundPixels> {
  const art = baseGroundArt(context), transport = baseGroundTransport(context);
  const progress: GroundLoadProgress = { phase: 'download', downloadMs: 0, verifyMs: 0, decodeMs: 0 };
  let started = performance.now();
  report?.({ ...progress });
  const bytes = await downloadGround(`${transport.path}?v=${BUILD.gitSha}`, signal, next => {
    Object.assign(progress, next); progress.downloadMs = performance.now() - started; report?.({ ...progress });
  });
  progress.downloadMs = performance.now() - started; progress.phase = 'verify';
  report?.({ ...progress }); started = performance.now();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== transport.sha256) throw new GroundLoadError('integrity');
  signal.throwIfAborted();
  progress.verifyMs = performance.now() - started; progress.phase = 'decode';
  report?.({ ...progress }); started = performance.now();
  const image = await createImageBitmap(new Blob([bytes], { type: transport.mime }));
  try {
    signal.throwIfAborted();
    if (image.width !== art.sourceSize || image.height !== art.sourceSize) {
      throw new Error('Ground artwork dimensions changed');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Ground artwork canvas unavailable');
    ctx.drawImage(image, 0, 0);
    const source = { data: ctx.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    assertGroundSource(source, context);
    progress.decodeMs = performance.now() - started; progress.phase = 'ready'; report?.({ ...progress });
    return source;
  } finally { image.close(); }
}

interface CacheEntry {
  promise: Promise<GroundPixels>; abort: AbortController; references: number;
  bytes: number; used: number; progress: GroundLoadProgress; listeners: Set<LoadProgress>;
}
/** Leases include loading work. When the last scene leaves, an incomplete
 * decode cannot populate an unowned cache or touch a reused Phaser scene. */
export class GroundSourceCache {
  private entries = new Map<string, CacheEntry>();
  private sequence = 0;
  // Presentation residency ceiling; no gameplay values or ownership involved.
  constructor(private loader: GroundLoader = loadGroundPixels,
    private maxIdleEntries = 2, private maxIdleBytes = 18 * 1024 * 1024) {}
  get size(): number { return this.entries.size; }
  clearIdle(): void {
    for (const [key, entry] of this.entries) if (entry.references === 0) {
      entry.abort.abort(); this.entries.delete(key);
    }
  }
  private trim(): void {
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.references === 0)
      .sort((a, b) => a[1].used - b[1].used);
    let bytes = idle.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    while (idle.length > this.maxIdleEntries || bytes > this.maxIdleBytes) {
      const [key, entry] = idle.shift()!;
      bytes -= entry.bytes; entry.abort.abort(); this.entries.delete(key);
    }
  }
  acquire(context: BaseVisualContext, report?: LoadProgress): { ready: Promise<GroundPixels>; cached: boolean; release(): void } {
    const key = `${BUILD.gitSha}:${context.artVersion}:${context.groundRevision ?? 0}:${context.realmId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const abort = new AbortController();
      // One finite visible allowance belongs to the shared entry, including
      // all network attempts, verification and decode. Hiding never resets it.
      const deadline = new VisibleTimeout(120_000, () => abort.abort(new GroundLoadError('active-deadline')));
      let stageDeadline: VisibleTimeout | undefined;
      let rejectAbort!: (reason: unknown) => void;
      const abandoned = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = (): void => { cleanup(); rejectAbort(abort.signal.reason); };
      abort.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        deadline.stop(); stageDeadline?.stop(); abort.signal.removeEventListener('abort', onAbort);
      };
      const listeners = new Set<LoadProgress>();
      const progress: GroundLoadProgress = { phase: 'download', downloadMs: 0, verifyMs: 0, decodeMs: 0 };
      const loading = this.loader(context, abort.signal, next => {
        if (abort.signal.aborted) return;
        if (next.phase !== progress.phase) {
          stageDeadline?.stop(); stageDeadline = undefined;
          if (next.phase === 'verify' || next.phase === 'decode') {
            stageDeadline = new VisibleTimeout(20_000, () => abort.abort(new GroundLoadError('idle-timeout')));
          }
        }
        Object.assign(progress, next, { loadActiveMs: Math.min(120_000, deadline.elapsed) });
        for (const listener of listeners) listener({ ...progress });
      });
      const promise = Promise.race([loading, abandoned]).then(source => {
        abort.signal.throwIfAborted();
        assertGroundSource(source, context);
        if (entry) { entry.bytes = source.data.byteLength; entry.progress.phase = 'ready'; }
        return source;
      }).catch(error => {
        progress.loadReason = error instanceof GroundLoadError ? error.reason : 'decode';
        progress.loadActiveMs = Math.min(120_000, deadline.elapsed);
        for (const listener of listeners) listener({ ...progress });
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }).finally(cleanup);
      entry = { promise, abort, references: 0, bytes: 0, used: ++this.sequence, progress, listeners };
      this.entries.set(key, entry);
    }
    entry.references++;
    entry.used = ++this.sequence;
    if (report) { entry.listeners.add(report); report({ ...entry.progress }); }
    const owned = entry;
    let released = false;
    return { ready: owned.promise, cached: owned.bytes > 0, release: () => {
      if (released) return;
      released = true;
      if (report) owned.listeners.delete(report);
      if (--owned.references === 0) {
        owned.used = ++this.sequence;
        if (owned.bytes === 0) {
          owned.abort.abort();
          if (this.entries.get(key) === owned) this.entries.delete(key);
        } else this.trim();
      }
    } };
  }
}
const groundSources = new GroundSourceCache();
let sequence = 0;

export class FantasyGround {
  private texture = `fantasy-ground-${++sequence}`;
  private textureGeneration = 0;
  private rendered: { key: string; texture: Phaser.Textures.Texture; paint: GroundCoverage } | null = null;
  private image: Phaser.GameObjects.Image | null = null;
  private extensions: Phaser.GameObjects.Image[] = [];
  private backdrop: Phaser.GameObjects.Rectangle;
  private lease: ReturnType<GroundSourceCache['acquire']> | null = null;
  private context: BaseVisualContext | null = null;
  private source: GroundPixels | null = null;
  private coverage: GroundCoverage | undefined;
  private paintedCoverage: GroundCoverage | null = null;
  private epoch = 0;
  private stopped = false;
  private motion: FantasyGroundMotion;
  private decor: Array<{ image: Phaser.GameObjects.Image; key: string }> = [];
  private pendingPaint: {
    raster: ReturnType<typeof createGroundRaster>; bounds: GroundCoverage;
    layout: ReturnType<typeof groundPaintLayout>; context: BaseVisualContext;
    width: number; height: number; epoch: number;
  } | null = null;
  readonly diagnostics = { state: 'idle' as 'idle' | 'loading' | 'ready' | 'failed', error: '', pixels: 0, width: 0, height: 0,
    phase: 'download' as GroundPhase, completed: 0, total: 0, cacheHit: false,
    downloadMs: 0, verifyMs: 0, decodeMs: 0, paintMs: 0, uploadMs: 0, maxPaintBatchMs: 0,
    loadAttempt: 0, loadProtocol: 'unknown' as GroundTransferProgress['loadProtocol'], loadReason: 'complete' as GroundTransferProgress['loadReason'], loadActiveMs: 0 };
  private onDestroy = (): void => this.destroy();
  private onUpdate = (): void => {
    if (this.stopped || !this.pendingPaint || !this.context || !this.lease) return;
    try { this.advancePaint(); }
    catch (error) { this.paintFailed(error, this.context, this.epoch, this.lease); }
  };

  constructor(
    private scene: Phaser.Scene,
    private cornerTile: number,
    private sizeTiles: number,
    private tilePx: number,
    private sources = groundSources,
    private onLoading: () => void = () => {},
  ) {
    this.backdrop = scene.add.rectangle(cornerTile * tilePx, cornerTile * tilePx,
      sizeTiles * tilePx, sizeTiles * tilePx, 0x62764d).setOrigin(0, 0).setDepth(0);
    this.motion = new FantasyGroundMotion(scene, tilePx);
    scene.events.once('destroy', this.onDestroy);
    scene.events.on('update', this.onUpdate);
  }

  set(value?: unknown, retry = false): void {
    if (this.stopped) return;
    const context = resolveBaseVisualContext(value);
    if (!retry && this.context?.realmId === context.realmId && this.context.artVersion === context.artVersion
      && this.context.groundRevision === context.groundRevision) return;
    this.context = context;
    this.onLoading();
    const epoch = ++this.epoch;
    this.lease?.release();
    this.source = null;
    this.clearPaint();
    const art = baseGroundArt(context);
    const color = art.sources[context.realmId].color;
    this.motion.set(null);
    this.backdrop.setFillStyle(Number.parseInt(color.slice(1), 16));
    this.scene.cameras.main.setBackgroundColor(color);
    this.diagnostics.state = 'loading'; this.diagnostics.error = '';
    this.diagnostics.phase = 'download'; this.diagnostics.completed = 0; this.diagnostics.total = 0;
    this.diagnostics.loadAttempt = 0; this.diagnostics.loadProtocol = 'unknown'; this.diagnostics.loadReason = 'complete'; this.diagnostics.loadActiveMs = 0;
    this.diagnostics.downloadMs = 0; this.diagnostics.verifyMs = 0; this.diagnostics.decodeMs = 0;
    this.diagnostics.paintMs = 0; this.diagnostics.uploadMs = 0; this.diagnostics.maxPaintBatchMs = 0;
    this.refreshDecor();
    const lease = this.sources.acquire(context, progress => {
      if (!this.stopped && this.epoch === epoch) Object.assign(this.diagnostics, progress);
    });
    this.lease = lease; this.diagnostics.cacheHit = lease.cached;
    void lease.ready.then(source => {
      if (this.stopped || this.epoch !== epoch) return;
      this.source = source;
      this.paint(source, context);
    }).catch(error => this.paintFailed(error, context, epoch, lease));
  }

  /** Battle supplies the complete camera pan bounds at its current zoom floor.
   * Zooming/panning inside that band never repaints or refetches the artwork. */
  setCoverage(coverage: GroundCoverage): void {
    if (this.stopped) return;
    this.coverage = coverage;
    if (!this.source || !this.context || this.context.artVersion === 1 || !this.lease
      || this.diagnostics.state === 'failed') return;
    try { this.paint(this.source, this.context); }
    catch (error) { this.paintFailed(error, this.context, this.epoch, this.lease); }
  }

  retryLoad(): void {
    this.set(this.context, true);
  }

  private paint(source: GroundPixels, context: BaseVisualContext): void {
    const bounds = groundCoverageRect(this.cornerTile, this.sizeTiles, this.tilePx,
      context.artVersion === 2 ? this.coverage : undefined);
    if (this.pendingPaint && sameGroundRect(this.pendingPaint.bounds, bounds)) return;
    // HUD/tray measurements can oscillate during a live raid. A smaller view
    // already has correct pixels; abandon an obsolete expansion without hiding
    // the field or sampling the same realm again.
    if (this.paintedCoverage && containsGroundRect(this.paintedCoverage, bounds)) {
      this.pendingPaint = null;
      this.diagnostics.phase = 'ready';
      return;
    }
    const { paint, extensions } = groundPaintLayout(bounds, context, this.tilePx);
    if (this.rendered && sameGroundRect(this.rendered.paint, paint)) {
      const next = this.createExtensions(this.rendered.texture, this.rendered.key, extensions);
      for (const image of this.extensions) image.destroy();
      this.extensions = next; this.paintedCoverage = bounds; this.pendingPaint = null;
      this.diagnostics.phase = 'ready'; this.diagnostics.error = '';
      return;
    }
    const scale = baseGroundArt(context).tilePx / this.tilePx;
    const width = paint.width * scale, height = paint.height * scale;
    // A same-context expansion keeps its published texture, ambience and ready
    // gate until replacement pixels exist. Only set() may hide an old realm or
    // revision; a camera resize must never pause combat or cancel held input.
    this.pendingPaint = null;
    if (!this.rendered) this.diagnostics.state = 'loading';
    this.diagnostics.phase = 'terrain'; this.diagnostics.error = '';
    this.diagnostics.completed = 0; this.diagnostics.total = height;
    const started = performance.now();
    const raster = createGroundRaster(source, context, width, height, paint.x * scale, paint.y * scale);
    this.diagnostics.paintMs += performance.now() - started;
    this.pendingPaint = { raster, bounds, layout: { paint, extensions }, context, width, height, epoch: this.epoch };
    this.advancePaint();
  }

  private createExtensions(texture: Phaser.Textures.Texture, key: string,
    extensions: ReturnType<typeof groundPaintLayout>['extensions']): Phaser.GameObjects.Image[] {
    const images: Phaser.GameObjects.Image[] = [];
    try {
      for (const extension of extensions) {
        const s = extension.source, b = extension.bounds;
        // The same core has at most eight edge sources. Stable source names
        // reuse correct frames when only their world-space coverage changes.
        const frame = `edge-${s.x}-${s.y}-${s.width}-${s.height}`;
        texture.add(frame, 0, s.x, s.y, s.width, s.height);
        images.push(this.scene.add.image(b.x, b.y, key, frame)
          .setOrigin(0, 0).setDisplaySize(b.width, b.height).setDepth(0));
      }
      return images;
    } catch (error) {
      for (const image of images) image.destroy();
      throw error;
    }
  }

  private advancePaint(): void {
    const job = this.pendingPaint;
    if (!job) return;
    const started = performance.now();
    // A few rows remain preemptible even on slower phones. The budget includes
    // sampling; the one final Canvas/GPU upload is measured separately.
    do { job.raster.drawRows(8); }
    while (!job.raster.complete && performance.now() - started < 4);
    const elapsed = performance.now() - started;
    this.diagnostics.paintMs += elapsed;
    this.diagnostics.maxPaintBatchMs = Math.max(this.diagnostics.maxPaintBatchMs, elapsed);
    this.diagnostics.completed = job.raster.completedRows;
    if (!job.raster.complete) return;
    this.diagnostics.phase = 'upload';
    const uploadStarted = performance.now();
    const { width, height, layout: { paint, extensions } } = job;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not allocate fantasy ground canvas');
    // ImageData adopts the shared writer's buffer rather than duplicating the
    // complete 3136² RGBA painting before upload.
    const pixels = new ImageData(job.raster.data, width, height);
    context.putImageData(pixels, 0, 0);
    // Register the completed canvas as a plain Texture. CanvasTexture would
    // retain a second full-size getImageData buffer and first upload blank pixels.
    const key = `${this.texture}-${++this.textureGeneration}`;
    let texture: Phaser.Textures.Texture | null = null, image: Phaser.GameObjects.Image | null = null;
    let edgeImages: Phaser.GameObjects.Image[] = [];
    try {
      texture = this.scene.textures.create(key, canvas, width, height);
      if (!texture) throw new Error('Could not allocate fantasy ground texture');
      texture.add('__BASE', 0, 0, 0, width, height);
      texture.setFilter(1);
      image = this.scene.add.image(paint.x, paint.y, key)
        .setOrigin(0, 0).setDisplaySize(paint.width, paint.height).setDepth(0);
      edgeImages = this.createExtensions(texture, key, extensions);
    } catch (error) {
      image?.destroy();
      if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
      throw error;
    }
    if (this.stopped || job !== this.pendingPaint || job.epoch !== this.epoch) {
      image.destroy(); for (const edge of edgeImages) edge.destroy();
      this.scene.textures.remove(key);
      return;
    }
    const previous = this.rendered;
    this.image?.destroy(); for (const edge of this.extensions) edge.destroy();
    this.image = image; this.extensions = edgeImages; this.rendered = { key, texture, paint };
    if (previous) this.scene.textures.remove(previous.key);
    this.paintedCoverage = job.bounds;
    this.pendingPaint = null;
    this.diagnostics.pixels = width * height;
    this.diagnostics.width = width; this.diagnostics.height = height;
    this.diagnostics.uploadMs += performance.now() - uploadStarted;
    if (!previous) this.motion.set(job.context, this.source ?? undefined);
    this.diagnostics.phase = 'ready'; this.diagnostics.state = 'ready';
    this.refreshDecor();
  }

  private paintFailed(
    error: unknown, context: BaseVisualContext, epoch: number,
    lease: ReturnType<GroundSourceCache['acquire']>,
  ): void {
    if (this.stopped || this.epoch !== epoch) return;
    if (this.rendered) {
      // A failed optional expansion must not discard a healthy battlefield or
      // its leased source. Another changed coverage or explicit retry can try
      // again; the current correct realm remains playable.
      this.pendingPaint = null;
      this.diagnostics.phase = 'ready'; this.diagnostics.state = 'ready';
      this.diagnostics.error = error instanceof Error ? error.message : 'Ground coverage failed';
      console.warn('[fantasy-ground]', this.diagnostics.error);
      return;
    }
    this.clearPaint(); this.motion.set(null); this.source = null;
    lease.release(); this.lease = null;
    this.diagnostics.state = 'failed';
    this.refreshDecor();
    this.diagnostics.error = error instanceof Error ? error.message : 'Ground artwork failed';
    console.warn('[fantasy-ground]', this.diagnostics.error);
    // Download attempts already share a finite budget in the source lease.
    // Only the explicit retry action starts another episode.
  }

  /** Only cosmetic skirt images enter this list; authoritative obstacles never do. */
  styleDecor(image: Phaser.GameObjects.Image, key: string): void {
    this.decor.push({ image, key });
    image.setTint(skirtTint(key, this.context));
    image.setVisible(!this.hasPaintedSkirt());
  }

  private hasPaintedSkirt(): boolean {
    return this.context?.artVersion === 2 && this.diagnostics.state === 'ready';
  }

  private refreshDecor(): void {
    // V2 already composes groves, pools and cliffs into its outskirts. Generic
    // scatter would place extra trees over water; retain it only for fallback
    // and historical art. Only explicit styleDecor registrations are affected.
    for (const { image, key } of this.decor) {
      image.setTint(skirtTint(key, this.context));
      image.setVisible(!this.hasPaintedSkirt());
    }
  }

  private clearPaint(): void {
    this.pendingPaint = null;
    this.image?.destroy(); this.image = null;
    for (const image of this.extensions) image.destroy();
    this.extensions = [];
    if (this.rendered) this.scene.textures.remove(this.rendered.key);
    this.rendered = null;
    this.paintedCoverage = null;
    this.diagnostics.pixels = 0; this.diagnostics.width = 0; this.diagnostics.height = 0;
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true; this.epoch++;
    this.scene.events.off('destroy', this.onDestroy);
    this.scene.events.off('update', this.onUpdate);
    this.lease?.release(); this.lease = null;
    this.motion.destroy(); this.decor = []; this.source = null;
    this.clearPaint(); this.backdrop.destroy();
  }
}

type TerrainFeature = GroundFeatureKind;
interface GroundMote { x: number; y: number; seed: number; feature?: TerrainFeature; width?: number; height?: number }

/** Color evidence belongs to presentation only. A feature needs a small patch
 * of matching pixels, so isolated highlights do not turn bare soil into water. */
function terrainFeature(r: number, g: number, b: number, realm: BaseVisualContext['realmId']): TerrainFeature | undefined {
  // The frozen v2 palettes distinguish teal meltwater from blue pine shadows,
  // bright mineral facets from violet soil, and pale vents from warm dry ash.
  if (realm === 'frostveil') {
    if (r >= 70 && r <= 130 && g - r > 40 && b - g >= 10 && b - g <= 28) return 'water';
    if (r > 145 && g > r * 1.04 && b > r * 1.05) return 'ice';
    return undefined;
  }
  if (realm === 'seeker-reach') {
    if ((g > 180 && r < g * 0.87 && b >= r)
      || (b > 190 && r > 160 && b > g * 1.13 && r > g * 0.95)) return 'crystal';
    if (g > 130 && g < 180 && r < g * 0.8 && b > r) return 'water';
    return undefined;
  }
  if (realm === 'stormcairn') {
    if (r >= 85 && r <= 126 && g - r >= 12 && g - r <= 32
      && b - g >= 12 && b - g <= 30 && b >= 130) return 'water';
    return undefined;
  }
  if (realm === 'cinderfall') {
    if (r >= 110 && r - g >= -3 && r - g <= 15 && g - b >= 5 && g - b <= 20) return 'vent';
    return undefined;
  }
  if (b > r * 1.15 && g > r * 1.08 && b > g * 0.85 && b + g > 150) return 'water';
  return undefined;
}

/** Decode-time feature search. World registration is the same affine transform
 * as the shared pixel sampler; camera movement never resamples source artwork. */
function attachTerrainFeatures(points: GroundMote[], source: GroundPixels, context: BaseVisualContext, tilePx: number): void {
  const art = baseGroundArt(context);
  const scale = source.width / (art.worldTiles * tilePx);
  const origin = art.worldOriginTiles * tilePx;
  const read = (x: number, y: number): TerrainFeature | undefined => {
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) return undefined;
    const at = (y * source.width + x) * 4;
    return terrainFeature(source.data[at]!, source.data[at + 1]!, source.data[at + 2]!, context.realmId);
  };
  const offsets = [0, -1, 1];
  const step = BASE_GROUND_MOTION.cellTiles * tilePx / 3;
  for (const point of points) {
    let found = false;
    for (const dy of offsets) {
      for (const dx of offsets) {
        const x = point.x + dx * step, y = point.y + dy * step;
        const sx = Math.floor((x - origin) * scale), sy = Math.floor((y - origin) * scale);
        const feature = read(sx, sy);
        if (!feature || (feature === 'ice' && point.seed % 3 !== 0)) continue;
        const radius = feature === 'water' ? 4 : 2;
        const support = [[-radius, 0], [radius, 0], [0, -radius], [0, radius]]
          .filter(([ox, oy]) => read(sx + ox!, sy + oy!) === feature).length;
        if (support < 3) continue;
        point.x = x; point.y = y; point.feature = feature;
        found = true; break;
      }
      if (found) break;
    }
  }
}

/** Authored accents are admitted by revision, never inferred from a new palette.
 * Put scenery first in the existing visible cap, then ambient cells outside the
 * complete building frame. The affine seats match both native and deed art. */
export function revisionGroundMotes(context: BaseVisualContext, tilePx: number, ambient: GroundMote[]): GroundMote[] | undefined {
  const features = groundEnvironmentFeatures(context);
  if (!features) return undefined;
  const art = baseGroundArt(context);
  const scale = art.worldTiles * tilePx / GROUND_ENVIRONMENT_REVISION_2.sourceSize;
  const origin = art.worldOriginTiles * tilePx;
  return [...features.map(point => ({ x: origin + point.x * scale, y: origin + point.y * scale,
    seed: point.seed, feature: point.kind, width: point.width * scale, height: point.height * scale })),
  ...ambient.filter(p => p.x < 0 || p.y < 0 || p.x >= art.plotTiles * tilePx || p.y >= art.plotTiles * tilePx)];
}

/** Stable world cells, shared by home and defender views. Nothing is simulated:
 * these small marks have no hit area and never alter terrain or obstacle data. */
function groundMotes(corner: number, tiles: number, tilePx: number): GroundMote[] {
  const cell = BASE_GROUND_MOTION.cellTiles;
  const points: GroundMote[] = [];
  for (let cy = Math.floor(corner / cell); cy < Math.ceil((corner + tiles) / cell); cy++) {
    for (let cx = Math.floor(corner / cell); cx < Math.ceil((corner + tiles) / cell); cx++) {
      const hash = Math.imul(cx + 431, 374761393) ^ Math.imul(cy + 719, 668265263);
      const seed = (hash ^ (hash >>> 13)) >>> 0;
      const x = (cx + (seed & 255) / 256) * cell * tilePx;
      const y = (cy + ((seed >>> 8) & 255) / 256) * cell * tilePx;
      if (x >= corner * tilePx && y >= corner * tilePx
        && x < (corner + tiles) * tilePx && y < (corner + tiles) * tilePx) points.push({ x, y, seed });
    }
  }
  // When the entire map is visible, the cap still covers every part of it.
  return points.sort((a, b) => a.seed - b.seed);
}

/** One lightweight Graphics overlay over the cached painting. Camera movement
 * only reselects cached points; neither animation nor zoom regenerates pixels. */
export class FantasyGroundMotion {
  private graphics: Phaser.GameObjects.Graphics;
  private context: BaseVisualContext | null = null;
  private points: GroundMote[] = [];
  private visible: GroundMote[] = [];
  private view = '';
  private sleeping = false;
  private stopped = false;
  private nextFrame = 0;
  private phase = 0;
  private zoom = 1;
  private media: MediaQueryList | undefined;
  readonly diagnostics = { redraws: 0, visiblePoints: 0, cachedPoints: 0, featurePoints: 0, paused: true };
  private onSleep = (): void => { this.sleeping = true; this.pause(); };
  private onWake = (): void => { this.sleeping = false; this.nextFrame = 0; };
  private onDestroy = (): void => this.destroy();
  private onVisibility = (): void => {
    if (document.hidden || reduceMotionOn()) this.pause();
    else this.nextFrame = 0;
  };
  private onUpdate = (time: number): void => {
    if (this.stopped || time < this.nextFrame) return;
    this.nextFrame = time + BASE_GROUND_MOTION.frameMs;
    if (!this.context || this.sleeping || document.hidden || reduceMotionOn()) {
      this.pause(); return;
    }
    this.diagnostics.paused = false;
    // A backgrounded tab never catches up a backlog or jumps all its particles.
    this.phase += BASE_GROUND_MOTION.frameMs / 1000;
    const camera = this.scene.cameras.main;
    this.zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
    const view = camera.worldView;
    const key = `${view.x}:${view.y}:${view.width}:${view.height}`;
    if (this.view !== key) {
      this.view = key;
      const margin = this.tilePx;
      this.visible = this.points.filter(p => {
        const pad = margin + Math.max(p.width ?? 0, p.height ?? 0);
        return p.x >= view.x - pad && p.y >= view.y - pad && p.x <= view.right + pad && p.y <= view.bottom + pad;
      })
        .slice(0, BASE_GROUND_MOTION.maxVisiblePoints);
    }
    this.graphics.clear();
    for (const point of this.visible) this.draw(point);
    this.diagnostics.redraws++;
    this.diagnostics.visiblePoints = this.visible.length;
  };

  constructor(private scene: Phaser.Scene, private tilePx: number) {
    // Beneath the claim perimeter and deploy guides, far beneath every actor.
    this.graphics = scene.add.graphics().setDepth(0.5);
    this.media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.media?.addEventListener('change', this.onVisibility);
    document.addEventListener('visibilitychange', this.onVisibility);
    scene.events.on('update', this.onUpdate);
    scene.events.on('sleep', this.onSleep);
    scene.events.on('wake', this.onWake);
    scene.events.on('pause', this.onSleep);
    scene.events.on('resume', this.onWake);
    scene.events.once('destroy', this.onDestroy);
  }

  set(context: BaseVisualContext | null, source?: GroundPixels): void {
    this.context = context?.artVersion === 2 ? context : null;
    this.pause(); this.view = ''; this.nextFrame = 0;
    const art = this.context ? baseGroundArt(this.context) : null;
    this.points = art ? groundMotes(art.worldOriginTiles, art.worldTiles, this.tilePx) : [];
    const authored = this.context ? revisionGroundMotes(this.context, this.tilePx, this.points) : undefined;
    if (authored) this.points = authored;
    else if (source && this.context) attachTerrainFeatures(this.points, source, this.context, this.tilePx);
    this.diagnostics.cachedPoints = this.points.length;
    this.diagnostics.featurePoints = this.points.filter(point => point.feature).length;
  }

  private pause(): void {
    if (!this.diagnostics.paused) this.graphics.clear();
    this.diagnostics.paused = true; this.diagnostics.visiblePoints = 0;
  }

  private draw(point: GroundMote): void {
    const g = this.graphics, nativeUnit = this.tilePx / 32;
    // Ambient marks retain a visible screen footprint at fit zoom. Painted
    // water/crystal/vent accents grow only slightly so they stay on the feature.
    const ambientUnit = Math.max(nativeUnit, BASE_GROUND_MOTION.minAmbientScreenPx / this.zoom);
    const unit = point.feature ? Math.min(ambientUnit, nativeUnit * BASE_GROUND_MOTION.maxFeatureScale) : ambientUnit;
    const stroke = Math.max(unit / 2, BASE_GROUND_MOTION.minStrokeScreenPx / this.zoom);
    const phase = this.phase + (point.seed & 255) / 13;
    const wave = Math.sin(phase), pulse = (Math.sin(phase * 0.7) + 1) / 2;
    const drift = Math.max(3 * nativeUnit, BASE_GROUND_MOTION.minDriftScreenPx / this.zoom);
    const x = point.x + wave * drift, y = point.y;
    // Terrain-linked marks stay precisely over their sampled pool/crystal/vent;
    // only the sparse ambient marks below drift away from their world seats.
    if (point.feature && point.width && point.height) {
      this.drawEnvironmentFeature(point, stroke, phase, wave, pulse); return;
    }
    if (point.feature) {
      switch (point.feature) {
        case 'water': {
          const ripple = (phase % 4) / 4;
          g.lineStyle(stroke, 0xc7fff1, (1 - ripple) * 0.3);
          g.strokeEllipse(point.x, y, (3 + ripple * 8) * unit, (1 + ripple * 3) * unit);
          g.lineStyle(stroke, 0xe1ffff, pulse * 0.25);
          g.lineBetween(point.x - 2 * unit, y, point.x + 2 * unit, y);
          return;
        }
        case 'ice':
          g.lineStyle(stroke, 0xecffff, pulse * 0.55);
          g.lineBetween(point.x - 3 * unit, y, point.x + 3 * unit, y);
          g.lineBetween(point.x, y - 2 * unit, point.x, y + 2 * unit);
          return;
        case 'crystal':
          g.fillStyle(0xd8fff0, pulse * 0.3);
          g.fillTriangle(point.x, y - 3 * unit, point.x - 2 * unit, y + unit, point.x + 2 * unit, y + unit);
          g.lineStyle(stroke, 0xc9ffef, pulse * 0.45);
          g.lineBetween(point.x, y - 3 * unit, point.x, y + 2 * unit);
          return;
        case 'vent':
          g.fillStyle(0xff9c42, 0.08 + pulse * 0.17);
          g.fillEllipse(point.x, y, (5 + pulse * 3) * unit, (2 + pulse) * unit);
          g.fillStyle(0xffd689, pulse * 0.45);
          g.fillRect(point.x, y, unit, unit);
          return;

      }
    }
    const realm = this.context!.realmId;
    switch (realm) {
      case 'frostveil':
        g.fillStyle(0xe4fcff, 0.18 + pulse * 0.25);
        g.fillRect(x, y + (phase % 7) * unit, unit, unit);
        if ((point.seed & 3) === 0) {
          g.lineStyle(stroke, 0xc7f7ff, pulse * 0.4);
          g.lineBetween(point.x - 2 * unit, y, point.x + 2 * unit, y);
          g.lineBetween(point.x, y - 2 * unit, point.x, y + 2 * unit);
        }
        break;
      case 'elderwood':
      case 'crownlands':
        g.fillStyle(realm === 'elderwood' ? 0xeac17b : 0xffe4a0, 0.16 + pulse * 0.2);
        g.fillEllipse(x, y + Math.cos(phase * 0.7) * 3 * unit, 2.5 * unit, unit);
        break;
      case 'sunscar':
        g.lineStyle(unit, 0xf5deb1, 0.1 + pulse * 0.15);
        g.lineBetween(x - 4 * unit, y, x + 4 * unit, y + wave * unit);
        break;
      case 'seeker-reach':
        g.fillStyle((point.seed & 1) ? 0x9dffd8 : 0xe2c6ff, 0.15 + pulse * 0.32);
        g.fillRect(x, y - pulse * 5 * unit, unit, 2 * unit);
        break;
      case 'stormcairn': {
        const fall = (phase % 3) * 5 * unit;
        g.lineStyle(stroke, 0xc6e7ed, 0.16 + pulse * 0.1);
        g.lineBetween(x, y + fall, x - 2 * unit, y + fall + 4 * unit);
        break;
      }
      case 'thornwake':
        g.fillStyle(0xcbffe2, 0.1 + pulse * 0.2);
        g.fillCircle(x, y - pulse * 4 * unit, unit * 0.7);
        break;
      case 'cinderfall':
        g.fillStyle((point.seed & 1) ? 0xffb456 : 0xee7449, 0.15 + pulse * 0.32);
        g.fillRect(x, y - pulse * 6 * unit, unit, unit);
        break;
    }
  }

  /** Source-sized landmarks breathe locally; the painting never changes or uploads. */
  private drawEnvironmentFeature(point: GroundMote, stroke: number, phase: number, wave: number, pulse: number): void {
    const g = this.graphics, x = point.x, y = point.y, w = point.width!, h = point.height!;
    switch (point.feature) {
      case 'water': {
        const ripple = (phase % 4) / 4;
        g.lineStyle(stroke, 0xc7fff1, (1 - ripple) * 0.25);
        g.strokeEllipse(x, y, w * (0.3 + ripple * 0.6), h * (0.3 + ripple * 0.6));
        g.lineStyle(stroke, 0xe1ffff, pulse * 0.25);
        g.lineBetween(x - w * 0.2, y, x + w * 0.2, y); break;
      }
      case 'ice':
        g.lineStyle(stroke, 0xecffff, pulse * 0.5);
        g.lineBetween(x - w * 0.4, y, x + w * 0.4, y);
        g.lineBetween(x, y - h * 0.4, x, y + h * 0.4); break;
      case 'crystal':
        g.fillStyle(0xd8fff0, pulse * 0.13);
        g.fillTriangle(x, y - h * 0.45, x - w * 0.3, y + h * 0.3, x + w * 0.3, y + h * 0.3);
        g.lineStyle(stroke, 0xc9ffef, pulse * 0.4);
        g.lineBetween(x, y - h * 0.4, x, y + h * 0.3); break;
      case 'vent':
        g.fillStyle(0xff9c42, 0.06 + pulse * 0.12);
        g.fillEllipse(x, y, w * (0.6 + pulse * 0.3), h * 0.15);
        g.fillStyle(0xcdb8a2, (1 - pulse) * 0.1);
        g.fillEllipse(x + wave * w * 0.15, y - pulse * h * 0.8, w * (0.3 + pulse * 0.5), h * 0.2); break;
      case 'foliage': {
        const bend = wave * w * 0.12;
        g.lineStyle(stroke, 0xa6bd78, 0.12 + pulse * 0.14);
        for (const offset of [-0.25, 0, 0.25]) g.lineBetween(x + w * offset, y,
          x + w * offset + bend, y - h * (0.6 - Math.abs(offset)));
        g.fillStyle(0xd8d99a, pulse * 0.16);
        g.fillEllipse(x + bend, y - h * 0.45, w * 0.3, h * 0.12); break;
      }
      case 'waterfall': {
        const fall = (phase % 2) / 2;
        g.lineStyle(stroke, 0xdcffff, 0.18 + pulse * 0.22);
        for (const offset of [-0.25, 0, 0.25]) {
          const top = ((fall + offset + 1) % 1) * 0.7 - 0.45;
          g.lineBetween(x + offset * w, y + top * h, x + offset * w, y + (top + 0.22) * h);
        } break;
      }
      case 'dust':
        g.lineStyle(stroke, 0xf5deb1, 0.06 + pulse * 0.1);
        g.lineBetween(x - w * 0.4 + wave * w * 0.1, y, x + w * 0.4 + wave * w * 0.1, y - h * 0.3); break;
      case 'mist':
        g.fillStyle(0xc9dedc, 0.025 + pulse * 0.04);
        g.fillEllipse(x + wave * w * 0.08, y - pulse * h * 0.2, w * (0.7 + pulse * 0.2), h * 0.7); break;
    }
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.media?.removeEventListener('change', this.onVisibility);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.events.off('update', this.onUpdate);
    this.scene.events.off('sleep', this.onSleep);
    this.scene.events.off('wake', this.onWake);
    this.scene.events.off('pause', this.onSleep);
    this.scene.events.off('resume', this.onWake);
    this.scene.events.off('destroy', this.onDestroy);
    this.points = []; this.visible = [];
    this.graphics.destroy();
  }
}
