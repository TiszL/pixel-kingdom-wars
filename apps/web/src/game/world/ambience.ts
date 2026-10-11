/**
 * Base ambience (read-app-engines §4, App bRender lines 191–198): the
 * decorative animated sprites that hang off live buildings —
 *  - resource buildings and the batch-13 defences run an idle loop on their
 *    own level key; the loop's SHAPE is read from the sprite meta (idleSeq
 *    below) — the house 2-frame swap bld_<type>_lN ↔ _work_f1 for most, the
 *    electric tower's 4-frame crackle family for the one building authored
 *    that way;
 *  - CHIMNEY SMOKE rises from a crafting building while a job is actually running
 *    (owner 2026-07-26 "make the base feel alive"). State-driven on purpose: smoke
 *    means "something is being made here", so the base reads as WORKING rather
 *    than merely decorated.
 *
 * Every one of these is decoration: pointer-events-free (we never call
 * setInteractive), depth = building bottom-edge band (≤ the building's own z),
 * driven by the shared AnimTicker (260ms). The layer is rebuilt from store
 * state on each refresh; sprites are pooled by a stable key so the ticker keeps
 * phase across refreshes (AnimTicker.register no-ops on an identical seq).
 *
 * Anything that MOVES does not belong here: this layer is never ticked per
 * frame, so the camp garrison and the patrolling hero live in patrol.ts
 * (owner 2026-07-28), which owns the base's per-frame walker seam.
 *
 * App offsets are in 1× game px; we scale by T/32 (=2).
 */
import { B13_DEFENCES } from '@shardkeep/shared';
import type Phaser from 'phaser';
import type { AnimTicker } from '../anim';
import { atlasFor, type MetaMap } from '../scenes/BootScene';
import { buildingSeatY, v2BldSeat, type V2ClipMap } from '../v2/clips';
import { buildingDepth } from './depth';
import type { BaseStateDto } from '../../state/store';

type Building = BaseStateDto['buildings'][number];

/** M22 folds work motion into each full building sprite. The historical loose
 * chimney overlay would mix an old generic effect over the authored work state. */
const SMOKES = new Set<string>();

/**
 * Buildings that run an idle loop on their own level key. The set decides WHO
 * animates; idleSeq() reads WHAT the loop is from the sprite meta, because the
 * batch-13 v2 pack ships two different shapes:
 *  - mine/goldforge/forge and the five remaining legacy defences: one second
 *    idle master per level, house 2-frame swap `<key>` ↔ `<key>_work_f1`;
 *  - Mortar: the protected current V2 two-frame idle pair (its superseded
 *    legacy family is deliberately absent from runtime under D-039);
 *  - electrictower (the 7th defence, new in v2): a true 4-frame crackle
 *    family `<key>_f1..f4` (charge gauge fills, arcs alternate) and NO
 *    `_work_f1` — asking for one does NOT draw nothing: Phaser 4 resolves a
 *    missing frame to the texture's FIRST frame (an arbitrary unrelated
 *    sprite — the K-031 phantom Direwyvern), so drawableSeq() drops any
 *    fabricated frame the texture does not actually contain.
 *
 * Every idle master shares its base master's canvas (pinned for electric in
 * rasterize.test.ts: all 8 states on the bare canvas). Same canvas is what
 * makes this layer's approach safe at all — the animated sprite is a
 * FULL-SIZE COPY drawn over the building, so an idle master with a smaller
 * silhouette would let the base frame show through around it.
 *
 * The defences come from the shared list rather than being retyped, so the set
 * that ANIMATES here can never drift from the set the packer actually routed
 * to blddef and emitted idle masters for. Their `_fire_*` masters belong to
 * the raid replay — a base view has nothing to shoot at.
 */
// M22 replaced every listed ware building. Their old `<key>_work_f1` masters
// must never remain a loading fallback: until a manifest-rich ware group is
// resident, the exact-current eager idle alias stays static. Cannon/Mortar are
// outside this pack and retain their existing v2 animation path.
const WORK_SWAP = new Set<string>(B13_DEFENCES.filter((type) => type === 'cannon' || type === 'mortar'));

export class AmbienceLayer {
  private sprites = new Map<string, Phaser.GameObjects.Sprite>();
  /** One console line per missing atlas:frame — see drawableSeq. */
  private readonly warnedMissing = new Set<string>();

  constructor(
    private scene: Phaser.Scene,
    private ticker: AnimTicker,
    private meta: MetaMap,
    /** world px per tile (64). */
    private T: number,
    /** Rework-v2 clip table (BootScene's `v2meta` registry entry). v2 building
     *  frames are absent from `meta`, so their anchor/scale/footprint seat comes
     *  from v2BldSeat — the SAME resolver BaseScene.positionBuilding uses, so
     *  the animated copy cannot land somewhere the static sprite does not. */
    private v2Clips: V2ClipMap = {},
  ) {}

  /**
   * Rebuild the ambient sprite set from the buildings in store state.
   * @param buildings live building rows
   * @param footprintOf footprint resolver shared with BaseScene
   */
  sync(
    buildings: Building[],
    footprintOf: (key: string) => { fw: number; fh: number },
    spriteKeyFor: (b: Building) => string,
    /** rendered top-edge Y (world px) of a building's sprite — the banner
     * anchors to the real sprite top (taller than its footprint), App parity. */
    spriteTopOf: (id: string) => number | undefined,
    /** building ids with an ACTIVE builder job — drives the chimney smoke. */
    busyIds: ReadonlySet<string> = new Set(),
  ): void {
    const T = this.T;
    const s = T / 32;
    const seen = new Set<string>();

    for (const b of buildings) {
      // skip ambience on a building that is still under construction (scaffolded)
      if (b.underConstruction) continue;
      const key = spriteKeyFor(b);
      const fp = footprintOf(key);
      const left = b.tx * T;
      const yB = (b.ty + fp.fh) * T;

      if (WORK_SWAP.has(b.type)) {
        // Idle loop on the building's OWN level key — see WORK_SWAP for which
        // buildings ship idle masters and idleSeq for the loop shape. The loop
        // is filtered against the live texture (K-031, drawableSeq): a copy
        // whose frames do not all exist must degrade to a truthful still — and
        // if even its base frame is missing, the copy must not exist at all
        // (the static building sprite beneath it is already the honest render;
        // leaving the id un-seen lets the sweep destroy a stale pooled copy).
        const id = `amb:${b.type}:${b.id}`;
        const atlas = atlasFor(key);
        const seq = this.drawableSeq(atlas, this.idleSeq(key));
        if (seq.length > 0) {
          seen.add(id);
          const sp = this.ensure(id, atlas, seq[0]!, seq);
          // ONE decider for v2 seating (see the ctor's v2Clips note): a v2
          // tower's anchor is its own art centre and its @1x art draws at ×2, so
          // the old `meta.anchor ?? [0.5,1]` fallback ghosted the animated copy
          // half a cell off the static sprite AND at half its size. Origin and
          // scale go on FIRST because the seat — the drawn bottom edge on the
          // footprint's south edge, `buildingSeatY`, the same call BaseScene
          // makes — is measured off the resulting displayHeight. Depth stays
          // yB+1.
          const seat = v2BldSeat(this.v2Clips, key);
          const meta = this.meta[key];
          const [ax, ay] = seat?.origin ?? meta?.anchor ?? [0.5, 1];
          sp.setOrigin(ax, ay)
            .setScale(seat?.scale ?? 1) // explicit: pooled across legacy ⇄ v2 re-keys
            .setDepth(buildingDepth(yB) + 1);
          sp.setPosition(
            (b.tx + fp.fw / 2) * T,
            buildingSeatY(b.ty, fp.fh, T, ay, sp.displayHeight),
          );
          this.ticker.register(sp, atlas, seq);
        }
      }

      // Keep banners: RETIRED with the batch-12 keep rework (overnight
      // 2026-07-26) — the new keep art bakes tier flags into the masters from
      // L4+, so the earned-banner overlay (G2b) would double-flag every keep.
      // The owner reviews the loss of the earned-banner reward loop in the
      // morning report; bannerTier.ts and its tests retired with it.

      // Hero altars (HEROES MVP, overnight 2026-07-26): the altar pulses its
      // glow ALWAYS (it is a living recruitment anchor, not a job site). The
      // hero itself PATROLS the base from patrol.ts (owner 2026-07-28) — the
      // pinned dais idler retired with that; combat is still plan D4.
      if (b.type === 'heroaltar' || b.type === 'siegestool') {
        const id = `amb:altar:${b.id}`;
        const key = `bld_${b.type}`;
        const atlas = atlasFor(key);
        const seq = this.drawableSeq(atlas, this.idleSeq(key));
        if (seq.length > 0) {
          seen.add(id);
          const sp = this.ensure(id, atlas, seq[0]!, seq);
          const [ax, ay] = this.meta[key]?.anchor ?? [0.5, 1];
          sp.setOrigin(ax, ay).setPosition((b.tx + fp.fw / 2) * T, yB).setDepth(buildingDepth(yB) + 1);
          // Altars ship the house `_work_f1` shape, so idleSeq resolves to the
          // same pair it always registered — routed through the helper so there
          // is exactly one place that decides what an idle loop looks like.
          this.ticker.register(sp, atlas, seq);
        }
      }

      // Chimney smoke while this crafting building is actually working. Restricted
      // to the buildings that would plausibly have a chimney — smoke over a Mine or
      // a Vault upgrade would read as damage, not industry.
      if (SMOKES.has(b.type) && busyIds.has(b.id)) {
        const id = `amb:smoke:${b.id}`;
        const top = spriteTopOf(b.id) ?? yB - fp.fh * T;
        const atlas = atlasFor('fx_smoke_f1');
        const seq = this.drawableSeq(atlas, ['fx_smoke_f1', 'fx_smoke_f2', 'fx_smoke_f3']);
        if (seq.length > 0) {
          seen.add(id);
          const sp = this.ensure(id, atlas, seq[0]!, seq);
          // Slightly right of centre and just above the roofline, so it reads as a
          // flue rather than the whole building steaming.
          sp.setOrigin(0.5, 1)
            .setPosition(left + fp.fw * T * 0.62, top + 2 * s)
            .setAlpha(0.75)
            .setDepth(buildingDepth(yB) + 2);
          this.ticker.register(sp, atlas, seq);
        }
      }
    }

    for (const [id, sp] of this.sprites) {
      if (!seen.has(id)) {
        this.ticker.unregister(sp);
        sp.destroy();
        this.sprites.delete(id);
      }
    }

    // A resync IS the authoritative rebuild: every surviving copy was just
    // repositioned from live rows, so any drag-lift hide() is over — reveal
    // everything. This is the drop-CONFIRM half of the D3 fix: BaseScene never
    // calls show() on a confirmed move, because until this refresh landed the
    // store row still held the OLD tile, and showing early would repaint the
    // copy there for the whole server round trip (the exact ghost being fixed).
    // Reveal + reposition happening in one pass is what makes it flicker-free;
    // it only works because ensure() POOLS sprites across syncs.
    for (const sp of this.sprites.values()) sp.setVisible(true);
  }

  /**
   * D3 drag-ghost seam (flagged in the batch-13 review as "pre-existing
   * defect, amplified"; the owner hit it live 2026-08-03 and read it as server
   * lag): this layer only ever repositions on a refresh, so while BaseScene's
   * hold-to-lift drag carries the static sprite, the animated FULL-SIZE COPY
   * (and any chimney smoke) stayed planted on the old tile until base:refresh
   * returned — and once batch 13 animated all seven defences plus the resource
   * buildings, every single move showed the ghost. BaseScene hide()s on lift
   * and show()s ONLY on the drag ends that get no refresh (drop rejected /
   * cancel / sleep — the building never moved); a confirmed drop stays hidden
   * until sync() reveals the repositioned copy (see the reveal pass above).
   *
   * Copies are matched by owning id: every key this layer mints is
   * `amb:<tag>:<id>` and server ids never contain ':', so the segment after
   * the LAST ':' is exactly the building id. (A plain suffix test would let
   * id "1" hide id "11"'s copies.)
   */
  hide(buildingId: string): void {
    this.setOwnerVisible(buildingId, false);
  }

  /** Undo hide() on the no-refresh drag ends — see hide(). Ids owning no
   *  copies are a deliberate no-op (wall line drags call this; walls keep no
   *  ambience). */
  show(buildingId: string): void {
    this.setOwnerVisible(buildingId, true);
  }

  private setOwnerVisible(buildingId: string, visible: boolean): void {
    for (const [key, sp] of this.sprites) {
      if (key.slice(key.lastIndexOf(':') + 1) === buildingId) sp.setVisible(visible);
    }
  }

  /**
   * The idle loop for a building sprite key, read from the packed sprite meta.
   * A `_f1` sibling means the art ships a true cyclic family — the electric
   * tower's 4-frame crackle is the only animated building authored this way —
   * and we play exactly the frames the packer emitted, so a re-delivered pack
   * with a different frame count animates correctly without a client edit.
   * Otherwise the house 2-frame swap `<key>` ↔ `<key>_work_f1` (resource
   * buildings, the five remaining legacy defences, the altars). Probing meta keys rather
   * than retyping a frame count keeps this file free of a number that already
   * lives in meta.json.
   *
   * CADENCE: the shared AnimTicker runs the whole base on one 260ms clock
   * (HANDOFF §4). The pack README asks 140–160ms for the crackle; at 260ms the
   * 4-frame cycle is ~1s and still reads as charging, so we keep the single
   * clock rather than fork a per-sprite timer for one decoration. If the owner
   * wants it snappier, that timer's ms is an art fact and belongs right here.
   */
  private idleSeq(key: string): string[] {
    // Rework-v2 cannon/mortar: BaseScene keys them by their v2 idle master
    // (`v2_bld_<unit>_t<n>_idle_d0_f1`) once the tier atlas is loaded. The v2
    // frames live in meta.json's v2Clips, not in the sprites map this layer
    // probes, and every one of the 8 v2 building atlases ships idle as
    // exactly 2 frames (manifest fact, pinned in ambience.test.ts) — so the
    // loop is the pair. It rides the ONE shared 260ms ticker like every other
    // base decoration (the electric-crackle precedent above: no per-sprite
    // clock for a decoration; the battle scene is where the authored 3fps
    // plays on the per-clip V2Ticker).
    const v2 = /^(v2_bld_[a-z]+_t\d+_idle_d0)_f1$/.exec(key);
    if (v2) return [`${v2[1]}_f1`, `${v2[1]}_f2`];
    // Eager exact-current building fallbacks (V2_BUILDING_FALLBACKS: idle f1+f2
    // per unit/tier are copied into the v2fallback atlas). Matching EVERY unit
    // matters (K-031): when this matched Mortar alone, Cannon's fallback key —
    // added 2026-08-16 — fell through to the `_work_f1` house swap below, and
    // that fabricated sibling does not exist in the v2fallback texture. Phaser 4
    // resolves a missing frame to the texture's FIRST frame, which in that atlas
    // is `v2_fallback_direwyvern_t1` — an untrained Direwyvern blinking over the
    // cannon at the 260ms cadence until the rich atlas landed.
    const fallback = /^(v2_fallback_bld_[a-z]+_t\d+_idle_d0)_f1$/.exec(key);
    if (fallback) return [`${fallback[1]}_f1`, `${fallback[1]}_f2`];
    if (`${key}_f1` in this.meta) {
      const seq: string[] = [];
      for (let f = 1; `${key}_f${f}` in this.meta; f++) seq.push(`${key}_f${f}`);
      return seq;
    }
    return [key, `${key}_work_f1`];
  }

  /**
   * K-031 guard: every frame this layer hands ensure()/AnimTicker must exist in
   * the texture it will be drawn from. This layer is the one base-view seam
   * that FABRICATES frame names by string concatenation (`_work_f1`, `_f2`
   * siblings) instead of deriving them from fail-closed clip metadata — and a
   * fabricated frame missing from its texture does not draw "nothing": Phaser 4
   * (Texture.get) warns and resolves it to the texture's FIRST frame, i.e. an
   * arbitrary unrelated sprite. In the eager `v2fallback` sheet that first
   * frame is `v2_fallback_direwyvern_t1`, which is how an untrained Direwyvern
   * blinked over the Cannon on every base load (K-031). Missing frames are
   * dropped — a shortened loop is a truthful still, a substituted frame is a
   * different unit entirely — and warned once per atlas:frame so a future art
   * regression is a console line, not a phantom monster. Headless tests without
   * a TextureManager (and atlases not yet registered) pass through unchanged.
   */
  private drawableSeq(atlas: string, seq: string[]): string[] {
    const textures = (this.scene as { textures?: Phaser.Textures.TextureManager }).textures;
    if (!textures?.exists(atlas)) return seq;
    const texture = textures.get(atlas);
    return seq.filter((frame) => {
      if (texture.has(frame)) return true;
      const warnKey = `${atlas}:${frame}`;
      if (!this.warnedMissing.has(warnKey)) {
        this.warnedMissing.add(warnKey);
        console.warn('[ambience] dropped frame missing from its atlas', atlas, frame);
      }
      return false;
    });
  }

  private ensure(
    id: string,
    atlas: string,
    frame: string,
    validFrames: readonly string[] = [frame],
  ): Phaser.GameObjects.Sprite {
    let sp = this.sprites.get(id);
    if (!sp) {
      // decoration only — never interactive, so it can't swallow a pan/drag.
      sp = this.scene.add.sprite(0, 0, atlas, frame);
      this.sprites.set(id, sp);
    } else if (sp.texture.key !== atlas || !validFrames.includes(String(sp.frame.name))) {
      // The pool key is the stable BUILDING id, while an upgrade or optional
      // V2-atlas completion changes the requested texture. Re-key immediately,
      // before AnimTicker preserves the old sequence's phase, so the pooled
      // copy can never show a previous tier/body between store refreshes.
      // Frames already inside the requested loop stay untouched: routine syncs
      // therefore preserve their live animation phase instead of restarting f1.
      sp.setTexture(atlas, frame);
    }
    return sp;
  }

  destroy(): void {
    for (const sp of this.sprites.values()) {
      this.ticker.unregister(sp);
      sp.destroy();
    }
    this.sprites.clear();
  }
}
