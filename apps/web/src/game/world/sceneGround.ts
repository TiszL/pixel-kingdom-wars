/** Scene-owned dispatch for immutable painted, layered and realm-kit terrain
 * revisions. A layered/kit replacement is private until its first update
 * succeeds. Obsolete preparations can never install textures into the next
 * base or battle. */
import type Phaser from 'phaser';
import { isLayeredBaseVisualContext, isRealmId, isRealmKitBaseVisualContext, resolveBaseVisualContext, unsupportedGroundRevision, type BaseVisualContext, type RealmId } from '@shardkeep/shared/baseVisual';
import type { LayeredRect } from '@shardkeep/shared/layeredGround';
import type { RealmKitClaim, RealmKitObstacleState } from '@shardkeep/shared/realmKit';
import { bus } from '../../lib/events';
import { reduceMotionOn } from '../../lib/juice';
import { FantasyGround, type GroundCoverage } from './fantasyGround';
import { LayeredGround, type LayeredGroundProgress } from './layeredGround';
import { RealmKitGround, type RealmKitObstacleSpriteDraw } from './realmKitGround';

/** What SceneGround needs from a prepared manifest renderer. The realm kit adds
 * the server claim and the E-11 obstacle sheet; r3/r4 paintings have neither. */
interface GroundLayer {
  update(view: LayeredRect, deltaMs: number, reducedMotion: boolean, background?: boolean): void;
  destroy(): void;
  setClaim?(claim: RealmKitClaim | undefined): void;
  obstacleSprite?(spriteKey: string, state: RealmKitObstacleState, tx: number, ty: number): RealmKitObstacleSpriteDraw | undefined;
}
/** Dev-only local verification (REALM-KIT-PLAN §6.3, REALM-THEMES-PLAN §3 P0):
 * `VITE_REALM_KIT_PREVIEW_MANIFESTS=<realmId>=<manifest url>,…` — one unpinned kit
 * manifest per realm under review, served under /atlas/... with preview-only status
 * allowed; a realm absent from the map keeps its catalogue pin. A malformed entry
 * throws (naming the variable) rather than previewing nothing, as the API's twin
 * fails boot. Vite replaces `import.meta.env.DEV` with false in production, so the
 * map is always empty there and the switch is inert: previewFor never routes to
 * RealmKitGround.preparePreview whatever the variable held at build time. That is
 * a runtime guarantee, not a bundle one — Rollup cannot fold a Map lookup or drop a
 * class member, so the unreachable call and static still ship in the lazy Phaser
 * chunk (first paint untouched); sceneGround.test.ts pins the inert path under
 * DEV=false. Read per call so a test can stub it. */
const previewManifests = (): ReadonlyMap<RealmId, string> => {
  const map = new Map<RealmId, string>();
  const raw = import.meta.env.DEV ? (import.meta.env.VITE_REALM_KIT_PREVIEW_MANIFESTS as string | undefined)?.trim() : undefined;
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const [realmId, url] = entry.split('=').map((s) => s.trim());
    if (!realmId || !url || !isRealmId(realmId)) throw new Error(`VITE_REALM_KIT_PREVIEW_MANIFESTS entry is not <realmId>=<manifest url>: ${entry}`);
    map.set(realmId, url);
  }
  return map;
};

export class SceneGround {
  private painted: FantasyGround | undefined;
  private layered: GroundLayer | undefined;
  private pending: GroundLayer | undefined;
  private context?: BaseVisualContext;
  private claim: RealmKitClaim | undefined;
  private request?: AbortController;
  private wanted: { context: BaseVisualContext; request: AbortController; preview: string | undefined } | undefined;
  private preparing = false;
  private stopped = false;
  private sleeping = false;
  private coverage?: GroundCoverage;
  private decor: Array<{ image: Phaser.GameObjects.Image; key: string }> = [];
  private layeredState = { state: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
    phase: 'terrain' as 'terrain' | LayeredGroundProgress['phase'], completed: 0, total: 0, error: '' };
  get diagnostics() { return this.context && this.manifestDriven(this.context) ? this.layeredState : this.painted?.diagnostics; }
  private onSleep = () => { this.sleeping = true; };
  private onWake = () => { this.sleeping = false; };
  private onStop = () => this.destroy();
  private onUpdate = (_time: number, delta: number) => {
    if (this.stopped || this.sleeping || document.hidden) return;
    // A covered camera has not necessarily run preRender yet, so worldView may
    // still be 0×0. Derive its visible rectangle without requiring a prior draw.
    const camera = this.scene.cameras.main;
    const width = camera.width / camera.zoom, height = camera.height / camera.zoom;
    const rect = { x: camera.scrollX + (camera.width - width) / 2,
      y: camera.scrollY + (camera.height - height) / 2, width, height };
    if (this.pending) {
      try {
        this.pending.update(rect, 0, reduceMotionOn());
        const old = this.layered;
        this.layered = this.pending; this.pending = undefined;
        this.painted?.destroy(); this.painted = undefined;
        old?.destroy();
        for (const { image } of this.decor) image.setVisible(false);
        this.layeredState.state = 'ready'; this.layeredState.phase = 'ready';
        this.onReady();
      } catch (error) { this.pending?.destroy(); this.pending = undefined; this.failed(error); }
    }
    this.layered?.update(rect, delta, reduceMotionOn());
  };

  constructor(private scene: Phaser.Scene, private cornerTile: number, private sizeTiles: number,
    private tilePixels: number, private onLoading: () => void = () => {},
    /** Fired after a manifest renderer is swapped in (the kit's obstacle sheet is now answerable). */
    private onReady: () => void = () => {}) {
    scene.events.on('update', this.onUpdate);
    scene.events.on('sleep', this.onSleep); scene.events.on('pause', this.onSleep);
    scene.events.on('wake', this.onWake); scene.events.on('resume', this.onWake);
    scene.events.once('shutdown', this.onStop); scene.events.once('destroy', this.onStop);
  }
  /** Revision 5 under the dev preview switch, or any manifest-driven revision. */
  private manifestDriven(context: BaseVisualContext): boolean {
    return isLayeredBaseVisualContext(context) || isRealmKitBaseVisualContext(context) || this.previewFor(context) !== undefined;
  }
  private previewFor(context: BaseVisualContext): string | undefined {
    return context.artVersion === 2 ? previewManifests().get(context.realmId) : undefined;
  }

  set(value?: unknown, retry = false): void {
    if (this.stopped) return;
    // The one place every base and raid context lands: a revision newer than this
    // bundle still paints the fallback below, but the player is asked to reload.
    const newer = unsupportedGroundRevision(value);
    if (newer !== undefined) bus.emit('scene:artworkOutdated', { groundRevision: newer });
    const context = resolveBaseVisualContext(value);
    if (!retry && JSON.stringify(context) === JSON.stringify(this.context)) return;
    this.context = context;
    this.request?.abort(); this.pending?.destroy(); this.pending = undefined;
    this.wanted = undefined;
    if (!this.manifestDriven(context)) {
      this.layered?.destroy(); this.layered = undefined;
      if (!this.painted) {
        this.painted = new FantasyGround(this.scene, this.cornerTile, this.sizeTiles, this.tilePixels,
          undefined, this.onLoading);
        for (const { image, key } of this.decor) this.painted.styleDecor(image, key);
        if (this.coverage) this.painted.setCoverage(this.coverage);
      }
      if (retry) this.painted.set(context, true); else this.painted.set(value);
      return;
    }
    // Same-context updates returned above: only changing scene identity needs a
    // cover. Retain the prior objects until verified replacement pixels exist.
    this.onLoading();
    this.layeredState = { state: 'loading', phase: 'terrain', completed: 0, total: 0, error: '' };
    const request = new AbortController(); this.request = request;
    this.wanted = { context, request, preview: this.previewFor(context) };
    void this.prepareLatest();
  }
  private async prepareLatest(): Promise<void> {
    if (this.preparing) return;
    this.preparing = true;
    try {
      // Only one in-flight preparation and one replaceable desired context.
      // Await cancellation cleanup before admitting its successor so rapid
      // realm changes cannot transiently exceed the two-realm texture budget.
      while (this.wanted && !this.stopped) {
        const { context, request, preview } = this.wanted; this.wanted = undefined;
        const report = (progress: LayeredGroundProgress) => {
          if (!this.stopped && this.request === request && !request.signal.aborted) Object.assign(this.layeredState, progress);
        };
        try {
          const layer: GroundLayer = preview !== undefined
            ? await RealmKitGround.preparePreview(this.scene, preview, this.tilePixels, request.signal, report, context.realmId)
            : isRealmKitBaseVisualContext(context)
              ? await RealmKitGround.prepareContext(this.scene, context, this.tilePixels, request.signal, report)
              : await LayeredGround.prepareContext(this.scene, context, this.tilePixels, request.signal, report);
          if (this.stopped || this.request !== request || request.signal.aborted) { layer.destroy(); continue; }
          layer.setClaim?.(this.claim);
          this.pending = layer;
        } catch (error) {
          if (!this.stopped && this.request === request && !request.signal.aborted) this.failed(error);
        }
      }
    } finally { this.preparing = false; }
  }
  private failed(error: unknown): void {
    this.layeredState.state = 'failed';
    this.layeredState.error = error instanceof Error ? error.message : 'Realm could not open';
  }
  retryLoad(): void { this.set(this.context, true); }
  /** The authoritative claim rect (BaseScene: GET /base; BattleScene: the raid
   * snapshot's claimMin/claimMax). Revision 5 cannot draw without it and says so
   * through diagnostics rather than guessing a plot. Paintings ignore it. */
  setClaim(claim: RealmKitClaim | undefined): void {
    this.claim = claim ? { min: claim.min, max: claim.max } : undefined;
    this.pending?.setClaim?.(this.claim); this.layered?.setClaim?.(this.claim);
  }
  /** E-11: the kit sheet frame for a server obstacle row at (tx, ty) once the kit is
   * the ready ground, else undefined (BaseScene keeps the frozen `dec_` master). The
   * tile matters: a row seated on a kit prop draws that prop's own still. */
  obstacleSprite(spriteKey: string, state: RealmKitObstacleState, tx: number, ty: number): RealmKitObstacleSpriteDraw | undefined {
    return this.layered?.obstacleSprite?.(spriteKey, state, tx, ty);
  }
  setCoverage(coverage: GroundCoverage): void { this.coverage = coverage; this.painted?.setCoverage(coverage); }
  styleDecor(image: Phaser.GameObjects.Image, key: string): void {
    this.decor.push({ image, key });
    if (this.context && this.manifestDriven(this.context)) image.setVisible(false);
    else this.painted?.styleDecor(image, key);
  }
  destroy(): void {
    if (this.stopped) return; this.stopped = true;
    this.request?.abort(); this.pending?.destroy(); this.layered?.destroy(); this.painted?.destroy();
    this.wanted = undefined;
    this.pending = undefined; this.layered = undefined; this.painted = undefined; this.decor = [];
    this.scene.events.off('update', this.onUpdate);
    this.scene.events.off('sleep', this.onSleep); this.scene.events.off('pause', this.onSleep);
    this.scene.events.off('wake', this.onWake); this.scene.events.off('resume', this.onWake);
    this.scene.events.off('shutdown', this.onStop); this.scene.events.off('destroy', this.onStop);
  }
}
