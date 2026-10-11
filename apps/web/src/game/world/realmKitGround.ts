/** Revision-5 realm environment kit renderer (docs/REALM-KIT-PLAN.md E-7, D-173).
 * Same lifecycle as LayeredGround: prepared privately (manifest → verify →
 * assets one per foreground frame → hidden objects), then swapped in by
 * SceneGround only after its first successful update. The ground is a Phaser
 * 4.1 Tilemap: one Tileset over the kit's single tileset texture, one layer per
 * manifest layer (water → base → overlay), drawn as a TilemapGPULayer when the
 * WebGL renderer can build one (fixed cost per screen pixel, animated water in
 * the shader) and as a culled classic TilemapLayer otherwise. Tile indices come
 * from the shared realmKitCell rule for all 98×98 tiles and are regenerated
 * whenever the server claim changes, so the kingdom/wilderness read is the same
 * one native and the deed renderer draw. Props remain culled Images in the
 * ground band, under every structure and actor — native draws them with the
 * floor and the deed composites them before any placed sprite, so a prop
 * sharing a tile with a building or troop (E-6 amended) stacks alike on all
 * three; the far material is a TileSprite exactly as r4. D-173 creature paths:
 * every ambient path is one more Image in that band (a roaming animal's walk
 * sheet, a gull, a smoke puff), posed each update by realmKitPathPlan on the
 * kit's own foreground clock; depth = 1 + realmKitDrawBand(layer) + anchor y
 * (art px) · 1e-6 for props and creatures alike (a creature a sub-row tie above
 * the props of its row, by manifest index), so a deer walking south of a tree's
 * seat is in front of it and behind it once north — the painter's order
 * realmKitGroundBandPlan gives native and the deed.
 *
 * Overview asset: NOT used on web. The GPU layer costs one fragment per screen
 * pixel at any zoom, so the zoom floor (0.14) is no dearer than 1× (headless
 * smoke run 2026-09-21: 98×98 field, three layers, ready in ~200 ms, no errors
 * at zooms 0.14–1.6); the overview still exists for native (E-8) and
 * thumbnails (E-10). The tilemap spans the field plus its edge-clamped margin
 * (226² cells), but a GPU layer owns a Tile object only per cell of the field
 * and its one-tile ring (100²): every farther margin cell aliases the ring cell
 * nearest it, since the shared clamp makes them equal and Phaser 4.1's
 * generateLayerDataTexture reads nothing but index/flip flags per cell. So the
 * kit costs what the 98² field cost before the margin (~10k Tiles per layer
 * against 51k, and regenerate walks the ring block, not the extent; 153k
 * cells measured ~46 MB and ~60 ms on desktop node, a few hundred ms on a
 * phone). The classic fallback owns every cell (its culler and renderer read
 * each tile's own position) and keeps culling on, so at the floor it still
 * draws only the visible tiles.
 * Aliasing below REALM_KIT.overviewMaxZoom is the NEAREST shimmer r4 already
 * has; it is left for the owner review rather than swapped for the still. */
import Phaser from 'phaser';
import type { BaseVisualContext, RealmId } from '@shardkeep/shared/baseVisual';
import { LAYERED_GROUND_LIMITS_R5, REALM_KIT } from '@shardkeep/shared';
import type { LayeredAsset, LayeredRect } from '@shardkeep/shared/layeredGround';
import * as layeredCatalogue from '@shardkeep/shared/layeredGroundCatalogue';
import type { LayeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import { assertRealmKitManifest, OBSTACLE_SPRITE_KEYS, realmKitCell, realmKitDrawBand, realmKitPathPlan, realmKitPropPlan, REALM_KIT_EXTENT,
  type ObstacleSpriteKey, type RealmKitClaim, type RealmKitLayerId, type RealmKitManifest, type RealmKitObstacleState } from '@shardkeep/shared/realmKit';
import { realmKitObstacleSpriteAt } from '@shardkeep/shared/realmKitObstacles';
import { downloadGround } from './groundDownload';
import type { LayeredGroundProgress, LayeredGroundReporter } from './layeredGround';
import { versionedPublicAsset } from '../../lib/version';

const TILE = REALM_KIT.tilePixels, FIELD = REALM_KIT.fieldTiles, MARGIN = REALM_KIT.edgeExtendTiles;
// The tilemap covers REALM_KIT_EXTENT — the field plus its edge-clamped margin (REALM_KIT.edgeExtendTiles),
// the same rect the shared floor plan and deed rasterizer clip to — so a wide view at the zoom floor
// sees rivers run on instead of the far repeat cutting them. Sized from the shared rect, not recomputed
// here: a second copy of the extent is how the web and the shared clamp would drift apart.
const ORIGIN = REALM_KIT_EXTENT.x / TILE, N = REALM_KIT_EXTENT.width / TILE;
/** Local coordinates of the one-tile ring around the field (inclusive). A GPU layer owns a Tile per
 * cell of the field and this ring; a farther margin cell aliases the ring cell nearest it (`rep`),
 * which is the cell the shared edge clamp gives it anyway. */
const RING0 = MARGIN - 1, RING1 = MARGIN + FIELD;
const rep = (t: number) => t < RING0 ? RING0 : t > RING1 ? RING1 : t;
/** Ground-band depths: far 0 (as r4), then the kit layers in draw order below
 * the r4 centre painting's 0.2..0.5 band consumers and the props and creatures at
 * bandDepth (1 + draw band + anchor row). */
const LAYER_DEPTH: Record<RealmKitLayerId, number> = { water: 0.1, base: 0.2, overlay: 0.3 };
/** Phaser 4.1 TilemapGPULayer-frag computes `uv.y = 1.0 - fract(y)`, which is
 * exactly 1.0 when a pixel centre lands on a tile boundary, so that pixel samples
 * the sheet cell ABOVE its tile (a one-pixel seam; measured at zoom 0.25/0.5 on
 * rows whose boundary fell on a half pixel). Seating the field 1/16 world px
 * (1/32 texel) lower keeps boundaries off pixel centres at every zoom the camera
 * band allows; NEAREST sampling makes the shift itself invisible. x needs no nudge
 * (uv.x is not flipped). A Phaser patch is the proper fix (see the handoff). */
const GPU_SEAM_NUDGE_PX = 1 / 16;
/** Ground-band depth of a prop or creature: its draw band about the r4 prop floor of 1, then
 * its anchor row in art px (−1088..2048 → ±0.002, well inside a band and above the tile
 * layers) — the shared realmKitGroundBandPlan order as a Phaser depth. `tie` (0 ≤ tie < 1, a
 * fraction of a row) breaks an equal row the way that plan does: props at 0 (their depth never
 * changes, so Phaser's stable sort keeps their manifest order), creatures above them by manifest
 * index (pathTie). Phaser 4.1 depthSort is a StableSort of the LAST frame's list, not creation
 * order, so a creature re-seated each frame at a depth EQUAL to a prop's would keep whichever
 * side it walked in from — under the canopy it dwells in front of on native and the deed. */
const bandDepth = (layer: number, bottomArtPx: number, tie = 0) => 1 + realmKitDrawBand(layer) + (bottomArtPx + tie) * 1e-6;
/** A creature's sub-row tie-break: manifest index k of n paths → (k + 1) / (n + 1), inside (0, 1). */
const pathTie = (index: number, count: number) => (index + 1) / (count + 1);
/** What BaseScene needs to draw a server obstacle row from the kit sheet (E-11). */
export interface RealmKitObstacleSpriteDraw { key: string; frame: number; origin: [number, number]; scale: number }

interface KitTileLayer { id: RealmKitLayerId; data: Phaser.Tilemaps.LayerData; object: Phaser.Tilemaps.TilemapLayer | Phaser.Tilemaps.TilemapGPULayer; gpu: boolean }

/** The revision-5 twin of BASE_LAYERED_GROUND_V3/V4 (REALM-KIT-PLAN §2). The
 * builder pins it into the shared catalogue with the first accepted Crownlands
 * kit; until that block exists every realm is unpublished and a revision-5
 * context fails loudly through diagnostics instead of drawing older ground.
 * Typed-optional so the pin needs no edit here (the API deed renderer reads it
 * the same way). */
export function realmKitDescriptor(context: BaseVisualContext): LayeredGroundDescriptor {
  const table = (layeredCatalogue as unknown as { BASE_LAYERED_GROUND_V5?: Readonly<Partial<Record<string, LayeredGroundDescriptor>>> }).BASE_LAYERED_GROUND_V5;
  const row = table?.[context.realmId];
  if (!row) throw new Error(`Realm kit artwork is not published: ${context.realmId}`);
  return row;
}

let nextInstance = 0, resident = 0;
export class RealmKitGround {
  private readonly id = ++nextInstance;
  private readonly keys = new Map<string, string>();
  private readonly images = new Map<string, Phaser.GameObjects.Image>();
  /** One Image per ambient path (D-173 creature paths), keyed by path id, with its bandDepth tie-break. */
  private readonly pathImages = new Map<string, { image: Phaser.GameObjects.Image; tie: number }>();
  private readonly assets: Map<string, LayeredAsset>;
  /** Cell id (1-based) → local tileset index; index 0 is a real tile, −1 is empty. */
  private readonly tileIndexOfCell: Int32Array;
  private map: Phaser.Tilemaps.Tilemap | undefined;
  private layers: KitTileLayer[] = [];
  /** Holds the GPU layers at the field transform (see buildTilemap). */
  private field: Phaser.GameObjects.Container | undefined;
  private material?: Phaser.GameObjects.TileSprite;
  private stopListening: (() => void) | undefined;
  private destroyed = false;
  private elapsed = 0;
  private claim: RealmKitClaim | undefined;
  private drawnClaim: RealmKitClaim | undefined;
  private constructor(private scene: Phaser.Scene, readonly manifest: RealmKitManifest, private tilePixels: number) {
    this.assets = new Map(manifest.assets.map(a => [a.id, a]));
    const tileset = this.assets.get(manifest.ground.cells[0]!.asset)!, columns = tileset.width / TILE;
    this.tileIndexOfCell = new Int32Array(manifest.ground.cells.length + 1).fill(-1);
    manifest.ground.cells.forEach((c, i) => { this.tileIndexOfCell[i + 1] = (c.y / TILE) * columns + c.x / TILE; });
  }
  /** Which GPU/classic primitive the ground uses, for diagnostics and tests. */
  get primitive(): 'gpu' | 'classic' | 'none' { return this.layers.length ? this.layers[0]!.gpu ? 'gpu' : 'classic' : 'none'; }

  /** Production entry: the hash-pinned descriptor from the layered catalogue
   * (REALM-KIT-PLAN §2: BASE_LAYERED_GROUND_V5 shares the r3/r4 registry and
   * the service worker's content-addressed admission path). */
  static async prepareContext(scene: Phaser.Scene, context: BaseVisualContext, tilePixels: number, signal: AbortSignal, report: LayeredGroundReporter = () => {}): Promise<RealmKitGround> {
    const descriptor = realmKitDescriptor(context);
    const value = await this.downloadManifest(versionedPublicAsset(`/${descriptor.manifestPath}`), signal, report, descriptor);
    assertRealmKitManifest(value);
    if (value.realmId !== context.realmId || value.groundRevision !== context.groundRevision || value.status !== 'accepted') throw new Error('Realm kit manifest disagrees with its frozen context');
    return this.prepare(scene, value, tilePixels, signal, report);
  }
  /** Dev-only entry (VITE_REALM_KIT_PREVIEW_MANIFESTS): an unpinned manifest URL
   * under /atlas/, preview-only status allowed. `realmId` is the realm the map
   * entry was keyed by: a manifest built for another realm is refused, so a
   * mis-keyed entry cannot quietly draw Crownlands under a Frostveil base.
   * Never reached in production. */
  static async preparePreview(scene: Phaser.Scene, url: string, tilePixels: number, signal: AbortSignal, report: LayeredGroundReporter = () => {}, realmId?: RealmId): Promise<RealmKitGround> {
    const value = await this.downloadManifest(url, signal, report);
    assertRealmKitManifest(value);
    if (realmId !== undefined && value.realmId !== realmId) throw new Error(`Realm kit preview manifest is for ${value.realmId}, not ${realmId}`);
    return this.prepare(scene, value, tilePixels, signal, report, true);
  }
  private static async downloadManifest(url: string, signal: AbortSignal, report: LayeredGroundReporter,
    descriptor?: { sha256: string; size: number }): Promise<unknown> {
    const cap = LAYERED_GROUND_LIMITS_R5.manifestBytes;
    const bytes = await downloadGround(url, signal, p => report({ phase: 'download', completed: p.completed, total: descriptor?.size ?? p.total }), { maxBytes: cap });
    report({ phase: 'verify', completed: bytes.byteLength, total: descriptor?.size ?? bytes.byteLength });
    if (bytes.byteLength > cap) throw new Error('Realm kit manifest integrity mismatch');
    if (descriptor) {
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== descriptor.size || sha256 !== descriptor.sha256) throw new Error('Realm kit manifest integrity mismatch');
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  static async prepare(scene: Phaser.Scene, value: unknown, tilePixels: number, signal: AbortSignal, report: LayeredGroundReporter = () => {}, previewAllowed = false): Promise<RealmKitGround> {
    assertRealmKitManifest(value);
    if (value.status !== 'accepted' && !previewAllowed) throw new Error('Unapproved realm kit artwork requires a preview host');
    if (!Number.isFinite(tilePixels) || tilePixels <= 0 || resident >= LAYERED_GROUND_LIMITS_R5.residentRealms) throw new Error('Realm kit residency unavailable');
    const result = new RealmKitGround(scene, value, tilePixels); resident++;
    const callerSignal = signal, abort = new AbortController();
    const cancelled = () => abort.abort(callerSignal.reason);
    const stopped = () => { abort.abort(new Error('Realm kit scene stopped')); result.destroy(); };
    callerSignal.addEventListener('abort', cancelled, { once: true });
    scene.events.once('shutdown', stopped);
    result.stopListening = () => scene.events.off('shutdown', stopped);
    if (callerSignal.aborted) cancelled(); signal = abort.signal;
    try {
      let completed = 0; const total = value.assets.reduce((sum, asset) => sum + asset.size, 0);
      // One hash/decode/upload page at a time, each on a visible frame, so a
      // cancelled preparation never leaves textures in a later scene.
      for (const asset of value.assets) {
        signal.throwIfAborted(); await foregroundFrame(signal);
        const bytes = await downloadGround(versionedPublicAsset(`/${asset.path}`), signal, p => report({ phase: 'download', completed: completed + p.completed, total }), { maxBytes: asset.size });
        completed += bytes.byteLength; report({ phase: 'verify', completed, total });
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== asset.size || hash !== asset.sha256) throw new Error('Realm kit integrity mismatch');
        const url = URL.createObjectURL(new Blob([bytes], { type: asset.path.endsWith('.webp') ? 'image/webp' : 'image/png' }));
        try {
          report({ phase: 'decode', completed, total });
          const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted();
          if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) throw new Error('Realm kit dimensions mismatch');
          await foregroundFrame(signal);
          report({ phase: 'upload', completed, total });
          const key = `realm-kit-${result.id}-${asset.sha256}`;
          scene.textures.addSpriteSheet(key, image, { frameWidth: asset.frameWidth, frameHeight: asset.frameHeight });
          result.keys.set(asset.id, key);
        } finally { URL.revokeObjectURL(url); }
      }
      signal.throwIfAborted();
      result.buildTilemap();
      for (const p of value.placements) result.images.set(p.id, scene.add.image(0, 0, result.keys.get(p.asset)!, 0).setOrigin(0).setDepth(bandDepth(p.layer, p.y)).setVisible(false));
      value.paths.forEach((path, index) => {
        const tie = pathTie(index, value.paths.length);
        result.pathImages.set(path.id, { tie, image: scene.add.image(0, 0, result.keys.get(path.asset)!, 0).setOrigin(0).setDepth(bandDepth(path.layer ?? 1, path.points[0]!.y, tie)).setVisible(false) });
      });
      report({ phase: 'ready', completed, total });
      return result;
    } catch (error) { result.destroy(); throw error; }
    finally { callerSignal.removeEventListener('abort', cancelled); }
  }
  /** One Tileset over the kit texture (32-px cells, no margin/spacing, gid 0 so
   * the local index IS the map index), animated cells registered as Tiled-style
   * tile animations (frames step one cell to the right, REALM-KIT-PLAN §2), then
   * one LayerData per manifest layer over the whole field, every tile empty until
   * the claim arrives. Objects are created hidden: nothing shows before the first
   * valid update. */
  private buildTilemap(): void {
    const m = this.manifest, g = m.ground, scene = this.scene;
    const tilesetAsset = this.assets.get(g.cells[0]!.asset)!;
    const map = scene.make.tilemap({ tileWidth: TILE, tileHeight: TILE, width: N, height: N });
    this.map = map;
    const tileset = map.addTilesetImage('realm-kit', this.keys.get(tilesetAsset.id)!, TILE, TILE, 0, 0, 0);
    if (!tileset) throw new Error('Realm kit tileset texture unavailable');
    // Tiled-shaped tile animations (what Tileset.createAnimationDataTexture and
    // getAnimatedTileId read): local index → { animation[{tileid,duration,startTime}], animationDuration }.
    const tileData = tileset.tileData as Record<number, { animation: { tileid: number; duration: number; startTime: number }[]; animationDuration: number }>;
    g.cells.forEach((c, i) => {
      const frames = c.frames ?? 1;
      if (frames < 2) return;
      const first = this.tileIndexOfCell[i + 1]!, duration = c.frameDurationMs!;
      tileData[first] = { animation: Array.from({ length: frames }, (_, f) => ({ tileid: first + f, duration, startTime: f * duration })),
        animationDuration: frames * duration };
    });
    let gpuCapable = scene.sys.renderer?.type === Phaser.WEBGL;
    const scale = this.tilePixels / m.tilePixels, x = ORIGIN * this.tilePixels, y = ORIGIN * this.tilePixels;
    for (const layer of g.layers) {
      const data = new Phaser.Tilemaps.LayerData({ name: layer.id, tileWidth: TILE, tileHeight: TILE, width: N, height: N });
      map.layers.push(data);
      let object: KitTileLayer['object'] | null = null;
      if (gpuCapable) {
        // E-7: the GPU layer is the primitive; a renderer that cannot build it
        // (missing extension, data-texture failure) falls back to the culled
        // classic layer for every layer instead of leaving the realm blank.
        data.data = tileRows(data, true);
        try { object = map.createLayer(layer.id, tileset, 0, 0, true); } catch { object = null; }
        if (!object) gpuCapable = false;
      }
      if (!object) data.data = tileRows(data, false);
      if (object) {
        // Phaser 4.1 SubmitterTilemapGPULayer applies the layer's own x/y twice
        // (once in its ITRS matrix, again in setQuad), so a GPU layer only draws
        // where it should at (0,0) scale 1: the field transform (origin tile −34,
        // 32 → 64 px) lives on a Container, which the submitter honours through
        // parentMatrix. Children render in insertion order = manifest draw order.
        this.field ??= scene.add.container(x, y + GPU_SEAM_NUDGE_PX).setScale(scale).setDepth(LAYER_DEPTH.water).setVisible(false);
        this.field.add(object.setOrigin(0, 0).setVisible(false));
      } else {
        object = map.createLayer(layer.id, tileset, x, y, false);
        if (!object) throw new Error('Realm kit tile layer unavailable');
        // The classic layer culls from its OWN transform, so it is positioned directly.
        object.setOrigin(0, 0).setScale(scale).setDepth(LAYER_DEPTH[layer.id]).setVisible(false);
        (object as Phaser.Tilemaps.TilemapLayer).setSkipCull(false);
      }
      // The kit's own foreground clock drives tile animation (uTime); Phaser's
      // per-object timer would otherwise keep counting while SceneGround gates.
      object.setTimerPaused(true).resetTimer(0);
      this.layers.push({ id: layer.id, data, object, gpu: gpuCapable });
    }
  }
  /** The server claim (plot tiles, half-open). Tiles are regenerated on the next
   * update; an update without a claim fails loudly (SceneGround reports it). */
  setClaim(claim: RealmKitClaim | undefined): void { this.claim = claim; }
  private regenerate(claim: RealmKitClaim): void {
    const m = this.manifest;
    for (const layer of this.layers) {
      const rows = layer.data.data;
      // A GPU layer's margin cells alias their ring cell (tileRows), so the field plus
      // its ring is the whole walk there; a classic layer owns every cell of the extent.
      const lo = layer.gpu ? RING0 : 0, hi = layer.gpu ? RING1 + 1 : N;
      for (let ty = lo; ty < hi; ty++) {
        const row = rows[ty]!;
        for (let tx = lo; tx < hi; tx++) {
          const cell = realmKitCell(m, claim, layer.id, tx + ORIGIN, ty + ORIGIN);
          row[tx]!.index = cell ? this.tileIndexOfCell[cell]! : -1;
        }
      }
      if (layer.gpu) (layer.object as Phaser.Tilemaps.TilemapGPULayer).generateLayerDataTexture();
    }
    this.drawnClaim = { ...claim };
  }
  update(view: LayeredRect, deltaMs: number, reducedMotion: boolean, background = false): void {
    if (this.destroyed) return;
    const visible = !background && !document.hidden;
    for (const image of this.images.values()) image.setVisible(false);
    for (const { image } of this.pathImages.values()) image.setVisible(false);
    this.material?.setVisible(false); this.field?.setVisible(false);
    for (const layer of this.layers) layer.object.setVisible(false);
    if (!visible) return;
    const claim = this.claim;
    if (!claim) throw new Error('Realm kit needs the server claim');
    if (!reducedMotion && Number.isFinite(deltaMs) && deltaMs > 0) this.elapsed += Math.min(deltaMs, 100);
    if (!this.drawnClaim || this.drawnClaim.min !== claim.min || this.drawnClaim.max !== claim.max) this.regenerate(claim);
    const m = this.manifest, g = m.ground, scale = this.tilePixels / m.tilePixels;
    // Far repeat: the r4 primitive with a fixed world phase (tile position is in
    // source texels, independent of object scale).
    const far = this.assets.get(g.far.asset)!;
    this.material ??= this.scene.add.tileSprite(0, 0, 1, 1, this.keys.get(far.id)!, 0).setOrigin(0).setDepth(0);
    const sx = g.far.period.width * scale / far.width, sy = g.far.period.height * scale / far.height;
    this.material.setPosition(view.x, view.y).setSize(view.width, view.height).setScale(1).setTileScale(sx, sy).setVisible(true);
    this.material.tilePositionX = (view.x - g.far.origin.x * scale) / sx;
    this.material.tilePositionY = (view.y - g.far.origin.y * scale) / sy;
    // Frame 0 is the still: reduced motion holds the animation clock at 0, which
    // the shader/classic renderer resolve to each animation's first frame.
    const clock = reducedMotion ? 0 : this.elapsed;
    this.field?.setVisible(true);
    for (const layer of this.layers) layer.object.resetTimer(clock).setVisible(true);
    // E-6 amended: props seated inside the claim + ring are not listed (owned land is cleared land).
    for (const draw of realmKitPropPlan(m, this.tilePixels, view, claim, this.elapsed, reducedMotion)) {
      this.images.get(draw.id)!.setPosition(draw.destination.x, draw.destination.y).setDisplaySize(draw.destination.width, draw.destination.height).setFrame(draw.frame).setVisible(true);
    }
    // D-173 creature paths: the pose at this clock (facing row × frames + walk frame is the
    // sheet cell; reduced motion pins the first vertex), depth by the anchor row so the animal
    // slips behind the tree it walks north of. Sheets carry both sides: flipX is never needed.
    for (const draw of realmKitPathPlan(m, this.tilePixels, view, this.elapsed, reducedMotion)) {
      const { image, tie } = this.pathImages.get(draw.id)!;
      image.setPosition(draw.destination.x, draw.destination.y).setDisplaySize(draw.destination.width, draw.destination.height)
        .setFrame(draw.frame).setDepth(bandDepth(draw.layer, draw.anchor.y, tie)).setVisible(true);
    }
  }
  /** E-11: the kit sheet frame BaseScene draws for a server obstacle row at (tx, ty),
   * or undefined when the manifest leaves that key to the frozen `dec_` master. A
   * standing row seated on a kit prop of its kind draws that prop's own still — the
   * tree an expansion reached keeps its species (E-11 expansion obstacles) — else the
   * tier twin's frame 0; remnants always draw the twin. Anchor is the asset's own.
   * A key outside the server's eight also answers undefined: the scene keeps its
   * historical `dec_rock_s` fallback rather than losing the whole render pass. */
  obstacleSprite(spriteKey: string, state: RealmKitObstacleState, tx: number, ty: number): RealmKitObstacleSpriteDraw | undefined {
    if (this.destroyed || !OBSTACLE_SPRITE_KEYS.includes(spriteKey as ObstacleSpriteKey)) return undefined;
    const draw = realmKitObstacleSpriteAt(this.manifest, tx, ty, spriteKey, state);
    const key = draw && this.keys.get(draw.asset.id);
    if (!draw || !key) return undefined;
    const { asset } = draw;
    return { key, frame: draw.frame, origin: [asset.anchor.x / asset.frameWidth, asset.anchor.y / asset.frameHeight], scale: this.tilePixels / this.manifest.tilePixels };
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true;
    this.stopListening?.(); this.stopListening = undefined;
    for (const image of this.images.values()) image.destroy();
    for (const { image } of this.pathImages.values()) image.destroy();
    for (const layer of this.layers) layer.object.destroy();
    this.field?.destroy(); this.field = undefined;
    this.map?.destroy(); this.map = undefined;
    this.material?.destroy(); for (const key of this.keys.values()) this.scene.textures.remove(key);
    this.images.clear(); this.pathImages.clear(); this.layers = []; this.keys.clear(); resident--;
  }
}
/** The N×N tile grid of one layer, every index −1. A classic layer owns a Tile per cell (its culler
 * and renderer read each tile's own position). A GPU layer is read only through Phaser 4.1's
 * generateLayerDataTexture (index and flip flags per cell), so it owns Tiles for the field and its
 * one-tile ring and every farther margin cell aliases the ring cell nearest it: the shared clamp
 * gives such a cell exactly that ring cell's content, and the extent's 226² cells cost 100² objects
 * and a 100² regenerate instead of 226² (~46 MB and a few hundred ms per realm on a phone). */
function tileRows(data: Phaser.Tilemaps.LayerData, aliased: boolean): Phaser.Tilemaps.Tile[][] {
  const rows: (Phaser.Tilemaps.Tile | undefined)[][] = Array.from({ length: N }, () => new Array<Phaser.Tilemaps.Tile | undefined>(N));
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    if (!aliased || (rep(tx) === tx && rep(ty) === ty)) rows[ty]![tx] = new Phaser.Tilemaps.Tile(data, -1, tx, ty, TILE, TILE, TILE, TILE);
  }
  if (aliased) for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) rows[ty]![tx] ??= rows[rep(ty)]![rep(tx)]!;
  return rows as Phaser.Tilemaps.Tile[][];
}
function foregroundFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', schedule); signal.removeEventListener('abort', aborted); };
    const aborted = () => { finish(); reject(signal.reason); };
    let frame = 0;
    const schedule = () => {
      if (document.hidden || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (document.hidden) return; finish(); resolve(); });
    };
    signal.addEventListener('abort', aborted, { once: true }); document.addEventListener('visibilitychange', schedule);
    if (signal.aborted) aborted(); else schedule();
  });
}
export type { LayeredGroundProgress as RealmKitGroundProgress };
