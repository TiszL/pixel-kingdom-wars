import type Phaser from 'phaser';
import { WALL_ART } from '@shardkeep/shared';
import {
  buildField, captureCollapse, COLLAPSE_DURATION, composeCollapse, composeWall,
  wallDamageStage, wallFrameKey, wallRenderKey, wallTierOfLevel,
  type WallCollapse, type WallFrame, type WallGrid,
} from '@shardkeep/shared/wallRender';

export interface WallSpriteInput {
  id: string;
  tx: number;
  ty: number;
  level: number;
  hp?: number;
  maxHp?: number;
  /** Invalid carried walls keep their own material without entering occupied terrain. */
  detached?: boolean;
  sprite: Phaser.GameObjects.Sprite;
}

type PreparedWall = { input: WallSpriteInput; stateKey: string; texture: string };
type FallingWall = { input: WallSpriteInput; snapshot: WallCollapse; elapsed: number; frame: number; texture: string | null };
let sceneSequence = 0;

/** Each scene owns its contextual pixels. A completed batch is published together,
 * so a height/material change never exposes half of a new mating edge. Canvas
 * preparation is staged; unchanged pieces keep their textures and input surface. */
export class WallLayer {
  private readonly prefix = `wallctx_${++sceneSequence}_`;
  private sequence = 0;
  private grid: WallGrid = new Map();
  private detachedGrid: WallGrid = new Map();
  private signature = '';
  private current = new Map<string, PreparedWall>();
  private inputs: WallSpriteInput[] = [];
  private pending: { field: ReturnType<typeof buildField> | null; detachedField: ReturnType<typeof buildField> | null; queue: Array<{ input: WallSpriteInput; stateKey: string }>; done: PreparedWall[] } | null = null;
  private falling = new Map<string, FallingWall>();
  private owned = new Set<string>();
  private stopped = false;
  private waiters: Array<() => void> = [];
  private lastPreparationCellMs = 0;
  private lastCollapseCellMs = 0;
  private collapseCursor = 0;
  readonly diagnostics = {
    compositions: 0, batches: 0, maxPreparationMs: 0, maxFieldPreparationMs: 0,
    maxCellPreparationMs: 0, maxPublicationMs: 0, textureCount: 0,
    collapseCompositions: 0, maxCollapsePreparationMs: 0, maxCollapseCellMs: 0, maxCollapseInitialMs: 0,
    error: '',
  };

  constructor(
    private scene: Phaser.Scene,
    private onTexture: (input: WallSpriteInput) => void = () => {},
    private clock: () => number = () => performance.now(),
  ) {}

  sync(inputs: readonly WallSpriteInput[]): void {
    if (this.stopped) return;
    if (this.diagnostics.error) { this.inputs = [...inputs]; return; }
    const rows = inputs.map((input) => ({
      ...input,
      stage: wallDamageStage(input.hp ?? 1, input.maxHp ?? 1),
      tier: wallTierOfLevel(input.level),
    }));
    const signature = rows.map((row) => `${row.id}:${row.tx},${row.ty}:${row.tier}:${row.stage}:${Number(!!row.detached)}`).join('|');
    this.inputs = rows;
    // Replay restart replaces the sprite while retaining its authoritative ID.
    // Rebind the owned pixels even when geometry did not change.
    for (const row of rows) {
      const old = this.current.get(row.id);
      if (old && old.input.sprite !== row.sprite) {
        old.input = row;
        this.apply(old);
      }
      const collapse = this.falling.get(row.id);
      if (collapse) {
        if (collapse.input.sprite === row.sprite) this.baseline(row);
        if (collapse.texture) this.removeTexture(collapse.texture);
        this.falling.delete(row.id);
      }
    }
    if (signature === this.signature) return;
    this.signature = signature;
    if (this.pending) for (const prepared of this.pending.done) this.removeTexture(prepared.texture);
    const gridFor = (detached: boolean): WallGrid => new Map(rows.filter(row => !!row.detached === detached).map((row) => [`${row.tx},${row.ty}`, {
      tier: row.tier, damage: row.stage > 0, damageStage: row.stage > 1 ? 2 as const : 1 as const,
    }]));
    this.grid = gridFor(false);
    this.detachedGrid = gridFor(true);
    const queue = rows.flatMap((input) => {
      const stateKey = `${Number(!!input.detached)}:${wallRenderKey(input.detached ? this.detachedGrid : this.grid, input.tx, input.ty)}`;
      return this.current.get(input.id)?.stateKey === stateKey ? [] : [{ input, stateKey }];
    });
    this.pending = { field: null, detachedField: null, queue, done: [] };
    if (queue.length === 0) this.publish();
  }

  get preparing(): boolean { return this.pending !== null; }

  ready(): Promise<void> {
    if (!this.pending || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The preparation budget is a scheduling target: a synchronous field build or
   * compose/upload cannot be preempted. Field setup yields separately; later cells
   * start only when their last observed cost fits. One cell always makes progress.
   * Publishing remains atomic and is measured separately from preparation. */
  update(delta = 0): void {
    if (this.stopped || this.diagnostics.error) return;
    try { this.advance(delta); }
    catch (error) { this.failPreparation(error); }
  }

  private failPreparation(error: unknown): void {
    this.diagnostics.error = error instanceof Error ? error.message : 'Wall artwork failed';
    if (this.pending) for (const prepared of this.pending.done) this.removeTexture(prepared.texture);
    this.pending = null;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  retryPreparation(): void {
    if (this.stopped || !this.diagnostics.error) return;
    this.diagnostics.error = '';
    this.signature = 'retry-pending'; // force publication even if all walls were destroyed while failed
    this.sync(this.inputs);
  }

  private advance(delta: number): void {
    if (this.pending) {
      const start = this.clock();
      const first = this.pending.queue[0];
      if (first && !(first.input.detached ? this.pending.detachedField : this.pending.field)) {
        if (first.input.detached) this.pending.detachedField = buildField(this.detachedGrid);
        else this.pending.field = buildField(this.grid);
        this.diagnostics.maxFieldPreparationMs = Math.max(this.diagnostics.maxFieldPreparationMs, this.clock() - start);
      } else {
        let prepared = 0;
        while (this.pending.queue.length) {
          const next = this.pending.queue[0]!;
          const detached = next.input.detached;
          const field = detached ? this.pending.detachedField : this.pending.field;
          // A second occupancy field also gets its own frame, without delaying collapse motion.
          if (!field) break;
          if (prepared > 0 && this.clock() - start + this.lastPreparationCellMs >= WALL_ART.preparationBudgetMs) break;
          this.pending.queue.shift();
          const cellStart = this.clock();
          const frame = composeWall(detached ? this.detachedGrid : this.grid, next.input.tx, next.input.ty, field);
          if (frame) {
            this.pending.done.push({ ...next, texture: this.texture(frame) });
            this.diagnostics.compositions++;
          }
          // Include Canvas allocation, pixel transfer and the GPU upload in the estimate.
          this.lastPreparationCellMs = this.clock() - cellStart;
          this.diagnostics.maxCellPreparationMs = Math.max(this.diagnostics.maxCellPreparationMs, this.lastPreparationCellMs);
          prepared++;
        }
      }
      this.diagnostics.maxPreparationMs = Math.max(this.diagnostics.maxPreparationMs, this.clock() - start);
      if (this.pending.queue.length === 0) this.publish();
    }
    const falls = [...this.falling.values()];
    for (const fall of falls) {
      fall.elapsed = Math.min(COLLAPSE_DURATION, fall.elapsed + Math.max(0, delta));
    }
    // All clocks advance, but an explosion must not upload every changing wall
    // in one frame. Resume fairly and skip obsolete intermediate samples under
    // load; each frozen snapshot still reaches its exact final rubble.
    const collapseStart = this.clock();
    let rendered = 0;
    const cursor = this.collapseCursor;
    for (let step = 0; step < falls.length; step++) {
      const index = (cursor + step) % falls.length, fall = falls[index]!;
      const frame = Math.min(WALL_ART.collapseFrames - 1, Math.floor(fall.elapsed / COLLAPSE_DURATION * WALL_ART.collapseFrames));
      if (frame === fall.frame) continue;
      if (rendered > 0 && this.clock() - collapseStart + this.lastCollapseCellMs >= WALL_ART.preparationBudgetMs) break;
      const cellStart = this.clock();
      const time = frame === WALL_ART.collapseFrames - 1 ? COLLAPSE_DURATION : frame / (WALL_ART.collapseFrames - 1) * COLLAPSE_DURATION;
      const texture = this.texture(composeCollapse(fall.snapshot, time));
      this.apply({ input: fall.input, stateKey: '', texture });
      if (fall.texture) this.removeTexture(fall.texture);
      fall.texture = texture;
      fall.frame = frame;
      this.lastCollapseCellMs = this.clock() - cellStart;
      this.diagnostics.maxCollapseCellMs = Math.max(this.diagnostics.maxCollapseCellMs, this.lastCollapseCellMs);
      this.diagnostics.collapseCompositions++;
      this.collapseCursor = (index + 1) % falls.length;
      rendered++;
    }
    if (rendered) this.diagnostics.maxCollapsePreparationMs = Math.max(this.diagnostics.maxCollapsePreparationMs, this.clock() - collapseStart);
  }

  /** Snapshot precedes the caller's removal from adjacency. Seeking holds the
   * final material-specific rubble without replaying obsolete transient motion. */
  collapse(id: string, final = false): void {
    const input = this.inputs.find((row) => row.id === id);
    if (!input || this.falling.has(id)) return;
    const start = this.clock();
    const snapshot = captureCollapse(input.detached ? this.detachedGrid : this.grid, input.tx, input.ty, 0);
    if (!snapshot) return;
    // Publish a valid detached frame before sync can retire the intact texture.
    // An isolated breach has no surviving work queue and publishes synchronously.
    const elapsed = final ? COLLAPSE_DURATION : 0;
    const fall: FallingWall = { input, snapshot, elapsed, frame: -1, texture: null };
    this.falling.set(id, fall);
    try {
      fall.texture = this.texture(composeCollapse(snapshot, elapsed));
      this.apply({ input, stateKey: '', texture: fall.texture });
      fall.frame = final ? WALL_ART.collapseFrames - 1 : 0;
    } catch (error) { this.failPreparation(error); }
    finally { this.diagnostics.maxCollapseInitialMs = Math.max(this.diagnostics.maxCollapseInitialMs, this.clock() - start); }
  }

  private texture(frame: WallFrame): string {
    const key = `${this.prefix}${++this.sequence}`;
    const texture = this.scene.textures.createCanvas(key, frame.width, frame.height);
    if (!texture) throw new Error(`Could not create contextual wall texture ${key}`);
    try {
      const pixels = texture.context.createImageData(frame.width, frame.height);
      pixels.data.set(frame.data);
      texture.context.putImageData(pixels, 0, 0);
      texture.add(key, 0, 0, 0, frame.width, frame.height);
      texture.setFilter(1); // Phaser NEAREST; the accepted pixels are never smoothed.
      texture.refresh();
    } catch (error) { this.scene.textures.remove(key); throw error; }
    this.owned.add(key);
    this.diagnostics.textureCount = this.owned.size;
    return key;
  }

  private apply(prepared: PreparedWall): void {
    if (!prepared.input.sprite.active) return;
    prepared.input.sprite.setTexture(prepared.texture, prepared.texture).setOrigin(0.5, 1).setScale(WALL_ART.drawScale);
    this.onTexture(prepared.input);
  }

  private baseline(input: WallSpriteInput): void {
    if (!input.sprite.active) return;
    input.sprite.setTexture('wall5', wallFrameKey(input.level)).setOrigin(0.5, 1).setScale(WALL_ART.drawScale);
    this.onTexture(input);
  }

  private publish(): void {
    if (!this.pending) return;
    const start = this.clock();
    const replacements = new Map(this.pending.done.map((prepared) => [prepared.input.id, prepared]));
    const next = new Map<string, PreparedWall>();
    for (const input of this.inputs) {
      const prepared = replacements.get(input.id) ?? this.current.get(input.id);
      if (!prepared) continue;
      prepared.input = input;
      next.set(input.id, prepared);
      if (replacements.has(input.id)) this.apply(prepared);
    }
    for (const [id, old] of this.current) if (next.get(id)?.texture !== old.texture) {
      // Trayed walls are hidden, still-live sprites. Park them on accepted
      // baseline art before freeing their Frame, so restore/cancel is safe even
      // before the next contextual batch has completed.
      if (!next.has(id) && !this.falling.has(id)) this.baseline(old.input);
      this.removeTexture(old.texture);
    }
    this.current = next;
    this.pending = null;
    this.diagnostics.batches++;
    this.diagnostics.maxPublicationMs = Math.max(this.diagnostics.maxPublicationMs, this.clock() - start);
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private removeTexture(key: string): void {
    if (!this.owned.delete(key)) return;
    this.scene.textures.remove(key);
    this.diagnostics.textureCount = this.owned.size;
  }

  destroy(): void {
    this.stopped = true;
    this.pending = null;
    this.current.clear();
    this.falling.clear();
    this.inputs = [];
    this.grid = new Map();
    this.detachedGrid = new Map();
    for (const key of this.owned) this.scene.textures.remove(key);
    this.owned.clear();
    this.diagnostics.textureCount = 0;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

export function isContextWallFrame(frame: string): boolean { return frame.startsWith('wallctx_'); }
