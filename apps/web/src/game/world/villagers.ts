/**
 * Townsfolk (owner 2026-07-26: "I want the base to look alive … ordinary small
 * people walking inside the town … to hook players to love their bases").
 *
 * DESIGN — motion has to MEAN something. Random wandering sprites read as a
 * screensaver and get tuned out inside one session, so:
 *  - the POPULATION scales with Keep level (AMBIENCE.villagerPerKeepLevels), which
 *    makes upgrading visibly repopulate your town — that is the actual hook;
 *  - villagers walk between BUILDING DOORS, so the paths trace the town you built
 *    rather than drifting over open grass;
 *  - and they LEAVE town: a minority of trips head out to a tree, a rock or the
 *    outskirts ring just past the claim (owner 2026-07-26), which makes the base
 *    feel like a settlement in a landscape instead of a sealed diorama. Kept a
 *    minority on purpose — the town should stay the busy part;
 *  - a door on a building that is ACTUALLY WORKING (an active builder job) is
 *    weighted so traffic visibly thickens where something is happening — the town
 *    reads as busy where you are investing, using only state the scene already has
 *    (base.jobs) rather than a new endpoint;
 *  - the layout is SEEDED off the wallet, so a player's town looks like *their*
 *    town every session (and a bug is reproducible).
 *
 * ART — there is no civilian art in the project (an atlas sweep for villager /
 * peasant / worker / child / dog / cart found nothing), and assets-v2/ is the art
 * source of truth which is never edited from code. These are therefore static,
 * earth-tinted current-v2 troop stand frames. Their purely decorative tier follows
 * the Keep's authoritative level; it does NOT read or imply troop research. The
 * eager stand frame deliberately stays static while the person moves: that is
 * preferable to flashing a superseded troop sheet until real civilian animation
 * lands (COMBAT-UX-PLAN G6).
 *
 * RULES this layer obeys, matching ambience.ts:
 *  - never `setInteractive` — a tap must always reach the building underneath;
 *  - the eager current-art frame never enters the AnimTicker (there is only one
 *    safe eager frame per tier); the ticker is still used to unregister on cleanup;
 *  - sprites are pooled so routes and pauses survive a base:refresh;
 *  - depth = the villager's own feet Y, so painter's order puts it behind any
 *    building whose bottom edge is lower (HANDOFF §3.3) — correct ONLY while the
 *    feet are on free ground, which is why every waypoint, leg and step goes
 *    through occupancy.ts (owner 2026-07-29: townsfolk walked through footprints
 *    and were therefore painted under them);
 *  - `reduceMotion` freezes movement (a real user toggle, not optional polish).
 */
import { AMBIENCE, artTierOfLevel } from '@shardkeep/shared';
import type Phaser from 'phaser';
import type { AnimTicker } from '../anim';
import { facing } from '../anim';
import type { V2ClipMap, V2Meta } from '../v2/clips';
import { v2FallbackSpec } from '../v2/troop';
import { actorDepth } from './depth';
import type { Occupancy, Pt } from './occupancy';

/** Troop sprites standing in for civilians, each with an earthy tint so they do
 *  not read as soldiers. Swap these keys when real villager art lands (G6). */
const VILLAGER_SKINS: ReadonlyArray<{ troop: string; tint: number }> = [
  { troop: 'plunderer', tint: 0xc9b79a },
  { troop: 'bowman', tint: 0xa8b49c },
  { troop: 'highlander', tint: 0xbba98c },
];

interface Villager {
  sprite: Phaser.GameObjects.Sprite;
  /** current position in world px (feet) */
  x: number; y: number;
  /** destination in world px */
  tx: number; ty: number;
  /** waypoints after the current leg target — the bends of a route that goes
   *  AROUND a building instead of through it. A bend is not a stop. */
  path: Pt[];
  /** ms remaining of the idle pause at a stop; 0 = walking */
  pauseLeft: number;
  dir: string;
}

/** Tiny deterministic LCG — the town layout must be stable per base, and this
 *  layer must not reach for Math.random (reproducibility beats entropy here). */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

export class VillagerLayer {
  private units: Villager[] = [];
  /** In-town waypoints: building doors. The bulk of the traffic. */
  private stops: Array<{ x: number; y: number }> = [];
  /** Out-of-town waypoints: obstacles (trees/rocks) + an outskirts ring. */
  private outdoor: Array<{ x: number; y: number }> = [];
  private rnd: () => number = lcg(1);
  private signature = '';
  /** last Occupancy.version the waypoints/legs were computed against. */
  private occVersion = -1;
  private readonly v2clips: V2ClipMap;
  private decorativeTier: number | null = null;

  constructor(
    private scene: Phaser.Scene,
    private ticker: AnimTicker,
    /** world px per tile (64) */
    private T: number,
    /** shared blocked-tile grid, rebuilt by BaseScene from the live town. */
    private occ: Occupancy,
  ) {
    this.v2clips = (this.scene.registry.get('v2meta') as V2Meta | undefined)?.clips ?? {};
  }

  /**
   * Rebuild the population from live store state. Cheap to call on every
   * base:refresh: it early-returns unless the town's SHAPE actually changed
   * (building set / keep level), so villagers keep walking across a refresh
   * instead of teleporting back to their spawn.
   */
  sync(
    buildings: Array<{ id: string; type: string; tx: number; ty: number; underConstruction: boolean }>,
    footprintOf: (b: { id: string; type: string }) => { fw: number; fh: number },
    keepLevel: number,
    seedText: string,
    /** building ids with an active builder job — their doors get extra footfall. */
    busyIds: ReadonlySet<string> = new Set(),
    /** trees/rocks on the plot — real destinations outside the walls. */
    obstacles: ReadonlyArray<{ tx: number; ty: number }> = [],
    /** buildable claim bounds, for the outskirts ring just beyond it. */
    claim: { min: number; max: number } = { min: 8, max: 22 },
  ): void {
    const tier = artTierOfLevel(keepLevel);
    if (tier !== this.decorativeTier) {
      this.decorativeTier = tier;
      // Tier is presentation-only, but it is still part of visual identity. Do
      // not leave pooled people on the prior Keep tier after an upgrade.
      this.clear();
    }
    const done = buildings.filter((b) => !b.underConstruction);
    // Doors = the bottom-centre of each finished building. Walking door-to-door is
    // what makes the paths trace the town instead of wandering open grass.
    const stops: Array<{ x: number; y: number }> = [];
    for (const b of done) {
      const fp = footprintOf(b);
      // The door is on the building's bottom EDGE, i.e. the tile row below the
      // footprint — free ground unless something was built against the south
      // face, in which case the stop moves to the nearest free tile rather than
      // standing an order to walk into it (owner 2026-07-29).
      const at = this.occ.nearestFree({ x: (b.tx + fp.fw / 2) * this.T, y: (b.ty + fp.fh) * this.T });
      if (!at) continue;
      // A working building is pushed TWICE, so the uniform pick below lands there
      // twice as often — weighting without a weighted-random routine.
      stops.push(at);
      if (busyIds.has(b.id)) stops.push({ ...at });
    }
    // Out of town: every obstacle is a real feature to stand at, plus a ring of
    // points just past the claim so there is somewhere to go even on a bare plot.
    // An obstacle's OWN tile is blocked, so nearestFree lands the villager
    // BESIDE the tree instead of inside its trunk.
    const outdoor: Array<{ x: number; y: number }> = obstacles
      .map((o) => this.occ.nearestFree({ x: (o.tx + 0.5) * this.T, y: (o.ty + 1) * this.T }))
      .filter((p): p is Pt => p !== null);
    const ring = AMBIENCE.villagerOutskirtTiles;
    // Clamped to the plot: a fully-expanded claim + the ring would otherwise put
    // waypoints out in the decorative skirt, sending villagers off into the void.
    const cl = (n: number): number => Math.max(this.occ.minTile, Math.min(this.occ.maxTile - 1, n));
    const lo = cl(claim.min - ring), hi = cl(claim.max + ring);
    const mid = cl(Math.floor((claim.min + claim.max) / 2));
    for (const [tx, ty] of [[mid, lo], [mid, hi], [lo, mid], [hi, mid]] as const) {
      const at = this.occ.nearestFree({ x: (tx + 0.5) * this.T, y: (ty + 1) * this.T });
      if (at) outdoor.push(at);
    }
    this.outdoor = outdoor;

    // The town's SHAPE changed (a building went up, moved or finished): stops
    // moved, and a leg computed against the old occupancy may now cross the new
    // wall. Evict anyone standing in the new footprint and re-route everyone —
    // without touching the population, so nobody teleports home.
    if (this.occVersion !== this.occ.version) {
      this.occVersion = this.occ.version;
      this.stops = stops;
      for (const v of this.units) { this.settle(v); this.retarget(v); }
    }

    const want = Math.min(
      AMBIENCE.villagersMax,
      AMBIENCE.villagersAtKeepL1 + Math.floor(keepLevel / AMBIENCE.villagerPerKeepLevels),
    );
    const sig = `${stops.length}:${want}:${busyIds.size}:${outdoor.length}:t${tier}`;
    if (sig === this.signature && this.units.length === want) {
      this.stops = stops; // doors may have moved; keep the walkers strolling
      return;
    }
    this.signature = sig;
    this.stops = stops;

    let seed = 0;
    for (let i = 0; i < seedText.length; i++) seed = (Math.imul(seed, 31) + seedText.charCodeAt(i)) >>> 0;
    this.rnd = lcg(seed || 7);

    // Nowhere to walk between → show nobody, rather than villagers pacing on the
    // spot looking broken. Counts outdoor waypoints too: a one-building plot with
    // trees around it is still a walkable town.
    if (stops.length + outdoor.length < 2) { this.clear(); return; }

    while (this.units.length > want) this.remove(this.units.length - 1);
    while (this.units.length < want && this.spawn(tier)) { /* fill current tier */ }
  }

  /** Advance the walk. `dtMs` is real elapsed time so speed is framerate-independent. */
  update(dtMs: number, reduceMotion: boolean): void {
    if (reduceMotion || this.stops.length < 2) return; // frozen, but still dressed
    const step = (AMBIENCE.villagerSpeedPxPerSec * dtMs) / 1000;
    for (const v of this.units) {
      if (v.pauseLeft > 0) { v.pauseLeft -= dtMs; continue; }
      // Filtered through occupancy: the leg is pre-routed clear, and this is the
      // backstop that makes "never inside a building" a property of the movement
      // itself rather than of the routing being perfect.
      const next = this.occ.advance(v.x, v.y, v.tx, v.ty, step);
      const dx = next.x - v.x;
      const dy = next.y - v.y;
      v.x = next.x; v.y = next.y;
      if (!next.moved) {
        // Boxed in mid-leg (a wall went up across it): stand a beat, re-route.
        v.pauseLeft = AMBIENCE.villagerPauseMinMs;
        this.stand(v);
        this.retarget(v);
      } else if (v.x === v.tx && v.y === v.ty) {
        const bend = v.path.shift();
        if (bend) {
          v.tx = bend.x; v.ty = bend.y; // a bend is not a stop — keep walking
        } else {
          v.pauseLeft = AMBIENCE.villagerPauseMinMs
            + this.rnd() * (AMBIENCE.villagerPauseMaxMs - AMBIENCE.villagerPauseMinMs);
          this.stand(v);           // arriving = stop the legs (see stand())
          this.tryChat(v);         // G1e: did we stop next to someone?
          this.retarget(v);
        }
      } else {
        const f = facing(dx, dy);
        v.dir = f.dir;
        v.sprite.setFlipX(f.flip);
        // Unconditional: stand() unregisters the sprite, so resuming in the SAME
        // direction as before the pause would otherwise slide along with frozen
        // legs. register() early-outs when the sequence is unchanged AND still
        // registered, so re-asserting it every frame keeps the walk phase intact.
        this.walk(v);
      }
      // Depth = feet Y so a villager draws behind any building standing in front
      // of them — in WORLD_DEPTH.actor, which is what makes a villager standing
      // in a doorway (feet exactly on the building's bottom edge, i.e. the
      // COMMON case here, since every waypoint we generate sits on one) draw in
      // front of the door instead of inside it. Depth is written only when it
      // changed: Phaser's setter queues a display-list sort on every write.
      const depth = actorDepth(v.y);
      v.sprite.setPosition(v.x, v.y);
      if (v.sprite.depth !== depth) v.sprite.setDepth(depth);
    }
  }

  destroy(): void { this.clear(); }

  // -- internals ------------------------------------------------------------

  private spawn(tier: number): boolean {
    const skins = VILLAGER_SKINS.flatMap((skin) => {
      const fallback = v2FallbackSpec(this.v2clips, skin.troop, tier);
      return fallback ? [{ skin, fallback }] : [];
    });
    // Missing/corrupt metadata must fail closed. A legacy frame here is exactly
    // the stale-art flash this layer exists to prevent.
    if (skins.length === 0) return false;
    const { skin, fallback } = skins[Math.floor(this.rnd() * skins.length)]!;
    const spawnPool = this.stops.length > 0 ? this.stops : this.outdoor;
    const at = spawnPool[Math.floor(this.rnd() * spawnPool.length)]!;
    const sp = this.scene.add.sprite(at.x, at.y, fallback.atlas, fallback.frame)
      .setOrigin(...fallback.origin)
      .setScale(AMBIENCE.villagerScale * fallback.scale)
      .setTint(skin.tint)
      .setDepth(actorDepth(at.y));
    const v: Villager = {
      sprite: sp, x: at.x, y: at.y, path: [],
      tx: at.x, ty: at.y, pauseLeft: this.rnd() * AMBIENCE.villagerPauseMaxMs, dir: 's',
    };
    // Spawns start mid-pause (staggered so the town doesn't move as one body), so
    // they must START standing — registering the walk cycle here marched them in
    // place until their first step.
    this.stand(v);
    this.retarget(v);
    this.units.push(v);
    return true;
  }

  /**
   * Pick the next waypoint: usually another building door, sometimes a trip out of
   * town to a tree/rock/outskirt. Retries a few times so a villager never picks the
   * spot it is already standing on (which would look like a stall) — and, since
   * 2026-07-29, so it never picks one it cannot REACH: each candidate is routed
   * (straight line, or one bend around the blocker) and skipped if the town is in
   * the way. A walled-in villager stays inside the walls, which is the honest
   * reading of a walled town.
   */
  private retarget(v: Villager): void {
    const goOut = this.outdoor.length > 0
      && this.rnd() * 100 < AMBIENCE.villagerOutdoorTripPct;
    const pool = goOut ? this.outdoor : this.stops;
    if (pool.length === 0) return;
    for (let i = 0; i < AMBIENCE.walkerRouteRetries; i++) {
      const s = pool[Math.floor(this.rnd() * pool.length)]!;
      if (s.x === v.x && s.y === v.y) continue;
      const route = this.occ.route(v.x, v.y, s);
      if (route) {
        const first = route[0]!;
        v.tx = first.x; v.ty = first.y;
        v.path = route.slice(1);
        return;
      }
    }
    v.tx = v.x; v.ty = v.y; v.path = []; // nowhere reachable this beat; wait
  }

  /** Evict a villager standing inside a footprint (a building just went up on
   *  top of them) to the nearest free ground. A one-tile teleport on a build
   *  beats a townsman embedded in a wall. */
  private settle(v: Villager): void {
    if (this.occ.free(v.x, v.y)) return;
    const at = this.occ.nearestFree({ x: v.x, y: v.y });
    if (!at) return;
    v.x = at.x; v.y = at.y;
    v.sprite.setPosition(at.x, at.y);
    v.tx = at.x; v.ty = at.y; v.path = [];
  }

  /** Pin the exact-current eager frame. The unregister is defensive cleanup for
   *  sprites that survived hot reload from the former legacy walk-cycle path. */
  private stand(v: Villager): void {
    this.ticker.unregister(v.sprite);
    v.sprite.setFlipX(false);
  }

  private walk(v: Villager): void {
    // Only one exact-current frame is eager. Position still walks; the sprite
    // remains pinned until dedicated civilian locomotion exists.
    v.sprite.setFlipX(false);
  }

  /**
   * G1e — idle vignette. On arriving, look for another villager who is ALREADY
   * stopped nearby; if found, both turn to face each other and hold. Motion has
   * to mean something (plan §"Design principle"), and two people stopping beside
   * each other without acknowledging it is exactly what makes a crowd read as a
   * screensaver. Deliberately no speech bubble: no art for one, and the turn
   * alone reads as conversation.
   */
  private tryChat(v: Villager): void {
    for (const other of this.units) {
      if (other === v || other.pauseLeft <= 0) continue;
      const dx = other.x - v.x;
      const dy = other.y - v.y;
      if (Math.hypot(dx, dy) > AMBIENCE.villagerChatRadiusPx) continue;

      const hold = AMBIENCE.villagerChatMinMs
        + this.rnd() * (AMBIENCE.villagerChatMaxMs - AMBIENCE.villagerChatMinMs);
      // Both hold for the SAME beat, so the pair breaks up together rather than
      // one walking off mid-sentence.
      v.pauseLeft = hold;
      other.pauseLeft = hold;
      this.face(v, dx, dy);
      this.face(other, -dx, -dy);
      return; // one partner is a chat; three is a crowd we haven't designed
    }
  }

  /** Turn to look at something without starting the walk cycle. */
  private face(v: Villager, dx: number, dy: number): void {
    const f = facing(dx, dy);
    v.dir = f.dir;
    v.sprite.setFlipX(f.flip);
    this.stand(v);
  }

  private remove(i: number): void {
    const v = this.units[i];
    if (!v) return;
    this.ticker.unregister(v.sprite);
    v.sprite.destroy();
    this.units.splice(i, 1);
  }

  private clear(): void {
    while (this.units.length > 0) this.remove(this.units.length - 1);
  }
}
