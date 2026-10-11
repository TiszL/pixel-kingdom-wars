# Rework v2 integration — giant, dragon, cannon, mortar (owner 2026-08-08)

The owner's art drop `Giant dragon cannon  mortar rework v2/` (note the DOUBLE
space) fully replaces the giant + dragon troops and cannon + mortar defenses:
191 SVG grid atlases (8 facing rows × frame columns), manifest.json with
per-clip fps + per-frame muzzle/maw emitter tables, projectile travel sets,
damaged/collapse states, tier portraits, and 5 HTML labs (`_src/_lab.js`) that
are the reference implementation for sequencing. `HANDOFF-V2.md` in the folder
is the human spec; its manifest is the machine spec. This document is the
integration plan of record — implementation agents work FROM it.

## Locked owner decisions (asked + answered 2026-08-08)

1. **Native size, 1×1 cannon kept.** Art ships at authored size (bigger,
   more readable — the point of the rework). Cannon stays footprint [1,1] in
   sim/server/DB; the larger sprite overhangs its tile visually. No base
   migration.
2. **Full v2 fidelity in this pass**: 8-direction facings, per-clip fps,
   aim-direction turrets, damaged-below-50% + per-building collapse, manifest
   emitter anchoring, 3-part breath stream, arced tumbling projectiles.
3. **Giant combat** (supersedes "not a wall-chewer", owner 2026-07-29 — this
   IS the owner re-deciding): hp 700→**1600**; **boulder throw** vs defenses
   at **2.5 tiles** (640 units — below bowman 3.5 / archertower 4); dps 55
   both modes; buildingDamageMult 2 kept (defenses/buildings AND now walls);
   walls blocking the path are melee'd at dps×mult (was 1× last-resort only);
   gap-preference pathing kept; never SEEKS walls (kegrunner's job). Train
   cost/pts unchanged.
4. **SIM_VERSION 2→3**, golden fixtures regenerated. Old raid replays show
   recorded results (same as the v2 bump precedent).
5. **Tier mapping**: art tier = ceil(level/5), 4 tiers × 5 levels; the 16
   `ui_portrait_{unit}_t{n}` portraits replace the 40 level portraits for
   these units.
6. Landing-site dioramas/og.png keep old art (separate follow-up). Wyrmling +
   other 5 defenses stay batch-13 style — mixed styles accepted.

## Load-bearing facts (verified by exploration; do not rediscover)

- **Pack format**: one SVG atlas per (unit, tier, state); rows = 8 facings in
  order `[s,sw,w,nw,n,ne,e,se]` (DIR_YAW s=180…); cols = frames; frame (d,f)
  at x=f*cellW, y=d*cellH. Directionless clips (collapse, decals, impacts,
  muzzle flashes) are single-row. Travel-set FX (fireball/cannonball/boulder/
  shell, `travel:true`) use HEADING rows: row0 = +x screen right, +45° CCW per
  row — different semantics from facing rows.
- Cells: dragon 160×120 anchor(80,110); giant 112×112 anchor(56,100);
  cannon/mortar 112×120 anchor(56,104) — buildings drawn at ONE fixed camera;
  rows are AIM direction only, base never rotates.
- Clips (fps): dragon fly8@12L hover4@8L breath8@12 spit6@14 spawn6@12 hit3@16
  death8@10; giant walk8@10L idle4@6L attack8@11(slam@f4, walls) throw6@12
  (boulder@f3, defenses) spawn6@10 hit3@16 death6@9; cannon idle2@3L aim4@12
  fire6@14(muzzle+ball+recoil@f2, smoke@f3) reload6@8 damaged2@3L collapse4@8;
  mortar same but reload8@9, fire fx mortarflash@2+shell@2.
- Emitters: `manifest.emitters.muzzle[row][frame]=[x,y]` + `axis[row][frame]`
  degrees for cannon/mortar; `maw[row][frame]` for dragon breath/spit. NEVER
  derive the angle from muzzle recoil deltas (rounding noise dominates).
  Giant has NO emitters — boulder spawns from cell centre (labs' fallback).
- Breath stream: root 32×48 a(4,24) at maw + mid 16×48 tiled period exactly
  16px + tip 48×56 a(0,28) on struck face; n=round((dist−28−19.2)/16); ALL
  parts share ONE frame index; rotate the assembled run as a whole; the tip IS
  the contact effect. minRange 80 (manifest.breathStream); legacy fx_breath
  cone for windup/point-blank.
- Projectile arcs: fireball flat; cannonball peak ~18% of range; boulder lob
  ~45%; shell ~55% + tumble. All pair with fx_shadow (3 columns by altitude:
  lift>0.28 small, >0.12 medium, else large). Heavy impacts crater/rubble
  76×76 6f@18 anchored at CONTACT POINT (38,52), not centre. fx_hit 24×24
  3f@18 is the projectile-vs-unit spark. Labs: 95ms global tick, travel 10
  ticks (spit 9, boulder 11, shell 13), arc y=yb−arc*h*4*t*(1−t).
- **Current pipeline** (`scripts/src/rasterize.ts`): 4 source roots, later
  shadows earlier by basename; per-root entry-count asserts + EXPECTED_SHADOWED
  = 204 exact; one SVG per frame, anim families from `_f<N>` regex; NO fps
  field anywhere (client global 260ms AnimTicker); 4096² single-texture cap
  per group+scale asserted; crispEdges + PALETTE_16 + binary-alpha tripwires
  (v2 shadows #100D15 @0x33/0x55 and its own palette NEED a per-root law).
  After re-delivery of batch-13 run its normalize script first (unrelated).
- **Current render**: anim.ts defines seqs (levelled 6f move/4f attack/death,
  e/s/n + flipX west); fx/troop.ts plays them; dragon attack = breathCone
  special case; defenses: defenceFire probes `_fire_f<N>` frames, muzzleFlash
  overlay at 0.6×height, BAKED_RECOIL={cannon,mortar}; projectiles.ts PROJ_ART
  cannonball/shell/arrow/orb; ambience.ts `_work_f1` idle swap; 20-level art
  bound duplicated in anim.ts/BattleScene.ts/patrol.ts/icons.ts; icons.ts
  globs the OLD rework folder only; deed renderer apps/api/src/game/
  baseRender.ts composites from the same @1x atlases (keys must keep working).
- **Sim**: aiTarget 'defenses' exists (giant/dragon have it); wallPolicy
  'follow' = gap-preference Dijkstra + last-resort chew at 1×; single
  rangeUnits per troop (melee=160 units); troopFire events only when
  range!=='melee', no proj field; defenses fire deterministic pass 5;
  **behaviorOf() must route every new field** or hero Theodor (giant donor)
  inherits the throw. Fixtures: packages/sim/tests/fixtures — **`giant_smash` is
  the only golden that deploys a giant**, so it is the sole bit-exact pin on the
  wall-chew rework; `mixed_assault`'s deploy list has NO giant, which is exactly
  why its fixture legitimately did not move. The THROW has no golden fixture at
  all: its only bit-exact pin is hero-skills.test.ts §3 ("determinism across the
  whole kit"), whose raid deploys a giant beside a cannon and asserts the event
  log replays identically — so the throw's SEMANTICS are pinned by the intent
  tests in ai.test.ts and only its determinism by a replay.
  Regen `UPDATE_GOLDEN=1 pnpm --filter @shardkeep/sim test`;
  sim-version.test.ts forces the bump.

## Phases

### A. Shared constants (packages/shared/src/constants.ts) — first, unblocks all
- `TROOPS.giant.hp: 1600` (source comment: owner 2026-08-08 "giant is a tank,
  it dies like a fly").
- New optional troop field `siegeThrow?: { rangeTiles: number }` on the troop
  stats type + `TROOPS.giant.siegeThrow = { rangeTiles: 2.5 }` — ranged reach
  vs DEFENSES only; melee reach everywhere else. Routed through behaviorOf.
- `ART_V2` const: `{ tiers: 4, levelsPerTier: 5, units: ['giant','dragon',
  'cannon','mortar'] }` + `artTierOfLevel(level)` helper (shared by web +
  deed renderer).
- Bump `SIM_VERSION` to 3 in packages/sim/src/version.ts with history note.

### B. Sim (packages/sim + api touchpoints) — parallel with C
- stats.ts: giant reach = 640 units vs defense-class targets, 160 otherwise
  (new `reachFor(troop, targetKind)`); wall chew damage = dps×buildingDamageMult.
- sim.ts: giant emits cadenced `troopFire` when attacking a defense at range
  (walls/last-resort melee emit none); event gains optional `proj:'boulder'`
  (types.ts, additive); shoot-over: a 'follow' troop WITH siegeThrow may hit
  its defense target through a wall when within throw range (no LoS model,
  same as 'over').
- Tests: ai.test.ts intent updates + new: (1) giant throws at cannon over a
  wall within 2.5t; (2) giant melees blocking wall at 110 deci-dps; (3)
  Theodor does NOT throw (behaviorOf isolation); (4) giant survives
  meaningfully longer vs cannon (hp pin). Golden fixtures regenerated with
  justification; sim-version bump test satisfied.
- API: no schema change (army training reads pts/cost only).

### C. Asset pipeline (scripts/) — parallel with B
- rasterize.ts: FIFTH source root `Giant dragon cannon  mortar rework v2`
  with `format:'grid'`: slice each atlas SVG (render once at 1x via resvg,
  crop cells with sharp) into frames named
  `v2_<file-stem>_d<row>_f<col+1>` (single-row clips: no `_d` token), e.g.
  `v2_trp_giant_t1_walk_d0_f1`. @1x ONLY (the @2x set would blow the 4096²
  cap; the art is authored at final pixel size).
- Atlas groups: `v2trp_<unit>_t<n>` (troops), `v2bld_<unit>_t<n>`
  (defenses), `v2fx` (fx+portraits+decals). Verified budgets: dragon t
  ~6.6Mpx, giant ~4.1Mpx, buildings ~2.3Mpx, all < 16.7Mpx.
- Sidecar meta: v2 entries carry `{clip: {frames,fps,loop,fxAt},
  anchorPx, cellW, cellH, rowOrder, emitters, travel, footprint}` verbatim
  from the pack manifest into the packed meta.json the client loads.
- Tripwires: v2 root gets its OWN palette law (PAL from `_src/_pix2.js`) and
  the #100D15 33/55 shadow whitelist; PALETTE_16 stays for the other roots.
  Entry-count assert for the new root (191); EXPECTED_SHADOWED unchanged
  (all v2 keys are new names — zero collisions, assert that too).
- rasterize.test.ts: v2 pins — slicing geometry (a known frame's palette +
  dims), emitter passthrough, group count, no-collision assert.

### D. Web engine (apps/web) — after C's meta contract exists
- `game/v2/` module: clip registry from meta; per-clip-fps ticker (per-sprite
  accumulator in scene update); 8-dir facing from heading (DIR row order);
  travel-set heading rows for projectiles.
- TroopFx v2 path (giant/dragon when v2 atlas loaded, legacy fallback kept):
  walk/idle/attack/throw/spawn/hit/death; boulder throw on `troopFire
  proj:'boulder'` (lob 45%, tumble, altitude shadow, impact_rubble at contact
  point); dragon fly/hover + 3-part breath stream replacing breathCone (v2
  dragons only; wyrmling keeps legacy cone).
- Defense v2 path (cannon/mortar): idle loop @3fps; on sim `fire`: aim clip
  rows toward target → fire clip with muzzle FX + projectile spawned at the
  manifest emitter px rotated by emitter axis → reload clip; damaged 2f loop
  below 50% hp (fx/stats HP mirror); collapse clip on destroyed instead of
  generic rubble (these two types only). BAKED_RECOIL semantics preserved.
- projectiles.ts: v2 cannonball (18% arc, heading rows), shell (55% lob +
  tumble), boulder; crater/rubble contact-anchored impacts; fx_hit spark.
- UI: icons.ts second glob for the v2 folder + `ui_portrait_<unit>_t<n>` via
  artTierOfLevel (giant/dragon/cannon/mortar only); sheets.tsx build-tray +
  copy.ts codex keys → v2 t1 idle; ambience.ts v2 idle loop; atlasLoader
  loads v2 unit-tier atlases on demand (battle: attacker tiers; base:
  garrison + placed defenses); BattleScene/patrol/deploy-marker wiring;
  the four duplicated 20-level bounds now route through artTierOfLevel.
- Deed renderer (apps/api/src/game/baseRender.ts): cannon/mortar composite
  from `v2bld_<unit>_t<n>` idle d0 f1 via the same meta (anchor/footprint).
- Tests: anim/troop/muzzle/projectiles/icons/atlasLoader/patrol test updates
  + new v2 clip-registry and facing-math tests.

### E. Verification
`pnpm assets` (all tripwires) → `pnpm -r typecheck` → `pnpm -r test` →
dev battle in browser (dev-login seeds giant+camp; raid; verify walk/throw/
breath/aim/fire/damaged/collapse + projectile arcs visually, console clean)
→ scripts/size-check.mjs budget → adversarial review workflow → commit
(includes the pack folder itself — it is now a source root).

## Rollback
The v2 path is additive: legacy art + legacy code paths remain the fallback
whenever a v2 atlas is missing/unloaded, so reverting = removing the fifth
source root + the v2 branches. Sim changes roll back with SIM_VERSION.
