# Realm Environment Kit — plan of record (M42, revision 5 ground)

Status: **in progress** on `realm-kit-greenwood` (from `origin/main` `ac89de6f`).
Owner request 2026-09-21 (verbatim intent, see D-173): replace the painted realm
scenery with a **modular, tile-based, animated, interactive realm kit** that matches
the building art and camera; every realm base gets **water and a shipyard place**
for Phase E exploration vehicles; the player's **unlocked expansions render on the
terrain** (kingdom inside the claim, wilderness outside); build **one realm
completely first**, the owner approves the approach and quality on both clients,
then the other seven realms follow the same kit. The provider may be used without
economising generations.

The full researched context (six code-reading reports, measured art bible,
contradictions and their resolutions) is summarised here; the raw brief is kept
with the working notes and is not needed to continue.

## 0. Decisions taken here (engineering) and owner decisions recorded

| Id | Decision |
|---|---|
| D-173 (owner) | Water + shipyard per realm base, in the exterior ring; unlocked land renders as terrain; one realm first (Crownlands), approval on web + native before the rest. Recorded in `docs/DECISIONS.md`. |
| E-1 | Pilot realm: **Crownlands** — the default realm of every free/legacy base, PvE camp and campaign fallback; temperate primitives port to the other realms by palette + prop swap. Alternatives noted: Thornwake (approved r4 look A/B), Stormcairn (coastal). |
| E-2 | Runtime contract: **groundRevision 5 / schemaVersion 3** inside the layered-ground family (same accepted registry, hash-addressed publisher, SW admission path, catalogue pins, native section pattern, deed renderer entry). Revisions 3/4 stay published for frozen replay/archive contexts. |
| E-3 | Autotile convention: **16-tile corner Wang** per transition family, index `NW·8 + NE·4 + SW·2 + SE·1` (bit set = upper terrain at that vertex); cliff families use the provider's 25-tile `pattern_4x4` set at **bake time only**. Route chosen by a same-prompt comparison (standard Wang = stamped/saturated, tiles-pro = flat; pro Wang = accepted). |
| E-4 | Bake-time vs runtime: the publisher bakes every static tile index (exterior scenery, water, shores, roads, forest floor, cliffs) into per-layer 98×98 grids; the **only** runtime resolution is the kingdom/wilderness state from the server claim rect (turf variants inside the claim + one boundary transition ring). One shared pure function does it for web, native and the deed renderer. |
| E-5 | Grid encoding: run-length strings inside the manifest JSON (three layers × 98×98 ≈ 20–40 KB), well under the manifest cap (512 KiB, `LAYERED_GROUND_LIMITS_R5.manifestBytes`); no new file kinds for the service worker or native admission. |
| E-6 | Wilderness inside the 50×50 frame is **ground-level only** (meadow/scrub/flowers/pebbles as tiles); no tall props, no water. Tall props, water, cliffs and the shipyard live outside `[-10,40)`. Placements may still not intersect the protected frame (validator rule kept; test wording rewritten to the new rule). **Amended 2026-09-21 (owner: 'trees can grow anywhere inside and outside base'):** baked props may stand anywhere in the field, protected frame included. A prop is **hidden** while its seat tile lies inside the claim plus its one-tile edge ring — seat = `{ tx: floor(p.x / 32), ty: ceil(p.y / 32) − 1 }` from the placement's anchor point in 32-px source pixels (`realmKitPlacementSeat`), hidden iff tx,ty ∈ `[claim.min − REALM_KIT.edgeRingTiles, claim.max + REALM_KIT.edgeRingTiles)` on both axes (`realmKitPlacementHidden`); web, native and the deed rasterizer ask that one function, so buying land clears the same trees everywhere (the second runtime resolution beside E-4's tile state). The validator no longer keeps placements out of the frame; it refuses a placement seated where the smallest kingdom plus its ring already hides it (`REALM_KIT_SMALLEST_KINGDOM` = `[8,22)`, from `GRID.plotTiles` 30 and `GRID.claimTiles` 14 — such a prop could never be seen). The builder keeps baked props off the whole legacy plot `[0,30)`, where the server's clearable obstacle rows stand. `REALM_KIT.tallPropMarginTiles` no longer exists. The in-frame GROUND rule stands unchanged: meadow-level tiles only, no water. |
| E-7 | Web ground primitive: Phaser 4.1 `TilemapGPULayer` (one tileset texture, animated tiles, fixed cost per pixel); classic `TilemapLayer` is the fallback if the GPU layer misbehaves under `pixelArt`/`Scale.RESIZE`/scene sleep. Props remain culled `Image`s in the ground band (`1 + layer`), far material a `TileSprite` as in r4. |
| E-8 | Native ground primitive: per-chunk cached quad batches (16×16 tiles) from one POT tileset texture drawn before the sprite pass; an **overview still** (4 px/tile, published asset) ~~replaces tiles below zoom 0.35 so the zoom floor never draws tens of thousands of quads~~. **Amended 2026-09-25 (owner, code-27 Seeker test: *"zoomed out does not look good, zoomed in all is ok"*):** the still is drawn only below zoom 0.35 **and** only where one still texel is ≤ 2 physical px (`RealmKitManifest.drawsOverview`, `MAX_STILL_TEXEL_PX`); a phone never reaches that, so every scene (base, scout, preview, raid, replay) draws tiles at every zoom it allows. The starter base opens at 0.284, so the old rule opened every base on a 13.6-px mosaic. Measured ground quads: starter base ≈ 2.2k, claim-50 base ≤ 12.3k, battle floor ≤ 39.6k (Stormcairn); device frame pacing is owed. Native `realm-kit-r5` `68974c2` + `3f5b640`, pinned by `RealmKitOverviewLodTest`. ~~Props enter the depth-sorted pass keyed like `dec_` obstacles.~~ **Amended 2026-09-21:** props draw with the floor, in the ground band under every structure and actor — the same band web E-7 uses and the deed rasterizer composites (props before any placed sprite). Under E-6 amended a prop can share a tile with a troop or a kingdom row, so a native prop in the structure pass covered a last-row building that web and the deed drew over it, and troops in the deploy ring interleaved with canopies on one client only. Pinned by `RealmKitPropPassTest` (native) and the `realmKitGround` depth test (web). Renderer contract **15** (additive section `layeredGroundV5`; whichever of Phase E / this kit lands first takes 15, the other 16). |
| E-9 | Budgets: new `LAYERED_GROUND_LIMITS_R5` in `constants.ts` (≤4 MiB compressed incl. manifest, ≤16 MiB decoded RGBA, ≤24 assets, ≤2048 placements — raised from 1024 on 2026-09-21 because the woods are ~1,700 individual canopy trees —, ≤2048 px, lossless sheets). Native mirrors read the catalogue value (JVM test pins it). |
| E-10 | Deed/thumbnail renderer: `renderRealmKitPixels(manifest, claim)` draws frame 0 of the kingdom tiles plus the boundary ring; `paddingColor` is an explicit manifest field (the kingdom turf tone). |
| E-11 | Interaction set v1: server obstacle rows drawn with the kit's own prop family and **states** (intact → clearing → remnant stump/rubble, remnant kept `OBSTACLE_REMNANT_DAYS` via `clearedObstacles[]` on `GET /base`); tap-to-clear stays the only economy interaction. Ambient tap feedback (birds scatter from a tapped tree, ripple on tapped water) is client-only FX. Harvestable respawning nodes are a **Version 2 proposal** needing the owner's economy sign-off (obstacle regeneration is a known faucet, `constants.ts` OBSTACLES comment). **Expansion obstacles (D-173 expansion obstacles, 2026-09-21):** a baked kit prop becomes a server row of the tier `packages/shared/src/realmKitObstacles.ts` names (`KIT_OBSTACLES`; tier size must equal the builder-written `placement.footprint`) **the moment the claim or its edge ring hides it — row iff `realmKitPlacementHidden`** (corrected 2026-09-21: the first cut seated only seats inside the claim with the whole rect owned, and since the claim grows two tiles a tier past 26 while the ring is one, 90 of Crownlands' 170 mapping props vanished for a tier and grew back as rows), seated once per base by `GET /base` (`apps/api/src/game/kitObstacles.ts`, per-base advisory lock, never on the plot, never recreated after a tombstone) and drawn as the prop's own still by web, native and the deed (`realmKitObstacleSpriteAt`), so buying land makes the same tree clearable instead of hiding it. Ownership gates the clear, not the row: a row on the ring or a 2×2 straddling the claim edge stands and answers a tap with the plot's own 422 `expand your land to clear this` until its whole rect is owned (`kit-obstacles.test.ts` pins row-iff-hidden across every tier). |
| E-12 | Old clients: web reloads to latest on deploy; native APKs below contract 15 are served **revision 4** by the API (version-gated downgrade), never the artVersion-2 painting. |
| E-13 | Art discipline: 32 px/tile, 1 art px = 1 texel, drawn at integer 2×; binary alpha; hard value steps; upper-left light; **no cast shadows**; ground/water/path tiles outline-free; props outlined 1 px in their material's own near-black (like `dec_`/buildings); one palette family per terrain (chained base tiles, palette-checked at build); props ≤ the ladder in §4; naming `env_crownlands_<family>_<variant>`; frame 0 is always a valid still (reduced motion). |
| E-14 | Provider provenance is recorded in `art/realm-kit-v1/<realm>/provenance.json` (job ids, seeds, generations) following `docs/research/realm-quality-pilot-20260915.json`; prompts and asset files never carry the provider or project code names (ART_BIBLE §0). |

Owner questions kept open for the approval review (not blocking the pilot):
O-6 prop size ceiling beyond the ladder; O-7 whether the frozen `dec_` obstacle
masters are replaced by the kit family (the pilot shows both); O-9 ground tone
(the pilot uses the quieter S≈0.45 olive); O-10 PvE camps/campaign follow
Crownlands automatically once `CURRENT_LAYERED_REVISION_BY_REALM.crownlands = 5`;
O-12 whether a "next expansion" preview ring is drawn on terrain (default: no,
the purchase screen keeps that role).

## 1. Ground truth the kit builds on (measured)

- Tile 32 art px; web `T = 64` world px/tile; native `presentation.tilePixels = 64`,
  `worldScale = 2`; NEAREST sampling on both; sim units never reach a renderer.
- Home plot: `GRID.plotTiles = 30` (frozen legacy frame `[0,30)`), `PLOT_GEOMETRY` v2
  `[-10,40)` = the 50×50 buildable/protected square; claim = `claimTilesByExpansion[expansions]`
  ∈ {14…26, 30…50}, centred on tile 15 (`apps/api/src/game/footprints.ts` claimRect);
  server sends `claim {min,max}`, `plotVersion`, `obstacles[]`, `visualContext` on `GET /base`;
  raids stamp `claimMin/claimMax` into the snapshot.
- World/battlefield: tiles `[-34,64)` = 98×98 = manifest `field {-1088,-1088,3136,3136}`
  at 32 px; battle coverage is 118 tiles, so a repeat material beyond the field is mandatory.
- Camera: zoom 0.20 (floor 0.14) … 1.6; one 32-px tile spans 12.8–102 screen px.
- Current r4: 1408² centre painting = 5 world px per texel (2.5× coarser than a wall
  pixel), 1344–1408² exterior, 256² far tile; ≤2 MiB compressed / ≤16 MiB RGBA per realm,
  Crownlands had 14 KB headroom. The kit at 32 px/tile is 2.5× finer than r4's centre.
- Obstacles: deterministic once-per-wallet rows over `[0,30)` only (189 per plot:
  small bush/stump/rock_s, medium pine1/pine2/rock_l, large tree_old/boulder 2×2),
  cleared by a builder job, +15 shards once; expansions 8–12 unlock obstacle-free land.
- Style anchor: `art/game-v4/buildings/keep/l20/identity.png` (144×136, 48 colours,
  1-px charcoal `#1c1716` outline, upper-left key, cool slate shadows, no cast shadow).
  Shipping prop ladder: pine 32×48, tree_old 48×64, boulder 48×40, bush 32×24,
  rock_l 32×24, rock_s/stump 16×16. Approved realm tone: Crownlands `#7c843c`
  (S .55) — the kit uses a quieter olive (S ≈ .45) so building accents read.
- Rejected before (never repeat): 512-px full-field conversions ("too coarse beside
  buildings"); sprite-composed pilots ("flat canvas with repeated trees"); scattered
  palette families (checkerboard); generated whole-canopy loops (brightness pulse);
  mirrored perimeters (kaleidoscope); square stamps / contour blobs / grey claim outline.
- Phase E: berths are 2×2 buildings placed anywhere in the plot with an in-cell
  basin; special sites live on the world map; nothing in Phase E needs map water —
  the kit's water + shipyard are the owner's addition (D-173) and impose no placement rule.

## 2. Kit contract (schemaVersion 3, groundRevision 5)

```
manifest (≤512 KiB JSON, hash-pinned in layeredGroundCatalogue BASE_LAYERED_GROUND_V5)
  schemaVersion 3, groundRevision 5, realmId, status, tilePixels 32
  field {-1088,-1088,3136,3136}, protectedFrame {-320,-320,1600,1600}
  ground:
    kind 'tiles', paddingColor '#rrggbb'
    cells[]      – global cell table, id = index+1: {asset, x, y, frames?, frameDurationMs?}
                   (animated cells lay their frames left→right, 32 px apart)
    layers[]     – ordered draw layers, each {id: 'water'|'base'|'overlay', rle}
                   rle = run-length string over 98×98 cells (row-major from tile -34,-34), 0 = empty;
                   non-empty cells across the three layers ≤ LAYERED_GROUND_LIMITS_R5.bakedTiles (16,384)
    extent       – (runtime, not stored) the field plus REALM_KIT.edgeExtendTiles (64) on every side =
                   226² tiles from -98,-98 (`REALM_KIT_EXTENT`). Beyond the field a tile takes the nearest
                   field tile's `water` and `base` cell (tx/ty clamped into the field: the EDGE CLAMP,
                   owner 2026-09-21 "at the end of theme waters are cut off, we need to fill that till the
                   end"), never an `overlay` decal; beyond the extent only `far` draws. One floor plan over
                   the whole extent stays under LAYERED_GROUND_LIMITS_R5.floorTiles (110,000: water + base
                   over 226² plus the field's water/overlay share of bakedTiles).
    state:       – runtime kingdom/wilderness resolution (E-4)
      turf: [cellId…]         variants picked by a tile hash inside the claim
      edge: {cells: [16],     corner-Wang ring, upper = kingdom turf, lower = the wild ground (the default)
             variants?: [{cell, cells: [16]}]}
                              RING VARIANTS (D-173; K-177 "road end"): one row per baked base cell that is
                              not the wild ground (or its tonal twins) and that a REACHABLE claim ring can
                              cross — the one-tile rings of the 13 CAPS.claimTilesByExpansion rects the API
                              centres in the plot — with, per corner-Wang mask that ring puts on it, the ring
                              cell the builder composited: kingdom corners turf, the other corners the cell's
                              own terrains (turf-meadow, turf-dirt, the DERIVED turf-road family), resolved by
                              the bake's own rule (family → layer composite) but NEVER the `fallback` collapse:
                              a collapsed ring tile is the default turf↔wild cell painted over ground the cell
                              has none of (the K-177 cut-off), so a ring tile no family can draw fails the build
                              naming the tile, claim and terrains even when the terrain declares a fallback
                              (scripts/src/realm-kit.test.ts "never leaves a reachable ring tile at the default");
                              0 = no variant → cells[mask]. Rows unique per cell, ≤ LAYERED_GROUND_LIMITS_R5.edgeVariants
                              (512); the builder fails rather than leave a reachable ring tile at 0 or at the
                              default. Absent → the default ring everywhere (pre-variant manifests still validate).
      clearInside: true       claim cells clear the overlay layer; water never enters the frame
    far:  {asset, origin, period}     POT repeat beyond the field (battle coverage)
    overview: {asset, pxPerTile}      still LOD used by native below zoom 0.35 and by thumbnails
  assets[]       – as r3/r4 (+ lossless sheets), limits LAYERED_GROUND_LIMITS_R5
  placements[]   – as r4 (props, animated, culled; anywhere in the field, the claim hides them — E-6 amended) + optional
                   `states` {intact, clearing, remnant} for obstacle-family assets, `prop` (the kit prop id, dashed)
                   and `footprint` [w, h] tiles — what E-11 expansion obstacles tier a prop by (builder-written)
  obstacleSprites – map from server obstacle spriteKey (bush, stump, rock_s, pine1, pine2,
                   rock_l, tree_old, boulder) → placement-asset ids {intact, remnant}
  paths[]        – render-only ambient routes outside the frame: { id, asset, points (art px), speed (art px/s),
                   directions? 1|2|4 (sheet rows: 4 = [down,left,right,up], 2 = [left,right], 1 = one row, default),
                   frames? (per facing, default frameCount / directions), frameDurationMs? (default the asset's),
                   dwellMs? (pause at every vertex on frame 0 of the facing ahead, default 0),
                   loop? 'cycle' (default; a closed loop when last = first, else a teleport) | 'pingpong',
                   layer? (draw band, default 1) } — D-173 creature paths: a roaming animal is a path whose
                   sheet carries one walk loop per facing; birds and smoke keep the one-row default on
                   REALM_KIT.airLayer. Never an economy or collision object.
```

Shared pure functions (`packages/shared/src/realmKit.ts`, subpath export only, never the barrel):
`decodeRealmKitRle`, `realmKitCell(manifest, claim, layerId, tx, ty)`, `realmKitFloorPlan(manifest,
tilePixels, view, claim, elapsedMs, reducedMotion)`, `realmKitPropPlan(manifest, tilePixels, view,
claim, elapsedMs, reducedMotion, background?)` (omits hidden placements), `realmKitPlacementSeat(p)`,
`realmKitPlacementHidden(p, claim)`, `realmKitPathPose(resolved, elapsedMs, still)` / `realmKitPathPlan(manifest,
tilePixels, view, elapsedMs, reducedMotion, background?)` (a creature's anchor, facing and sheet cell at a
clock, + − × ÷ ⌊⌋ only — `realmKitIsqrt` for segment lengths), `realmKitGroundBandPlan(…)` (props and
creatures in the one draw order below), `realmKitDrawBand(layer)`, `assertRealmKitManifest(value)`. Kotlin
mirrors them 1:1 with paired probe fixtures generated by the TS tests (the existing layered-ground probe
precedent; `pathProbes` pin the creature poses at 19 clocks; the cell `probes` step one tile past the
field so the edge clamp is pinned by data on both clients). `REALM_KIT_EXTENT` is the rect every
floor plan and the deed rasterizer clip to and the web tilemap sizes itself from (`realmKitGround.ts`
reads it rather than recomputing the margin); it is pinned by value in `realmKit.test.ts` next to
`REALM_KIT_FIELD`, and Kotlin derives the same tile rect from `constants.json`
(`RealmKitRules.extentOriginTile`/`extentTiles`, pinned in `RealmKitGroundTest`) for its chunk cache.

Bake-time compositing (2026-09-21, `scripts/src/realm-kit.ts`): where three or four terrains meet on
one tile the builder no longer collapses a corner to its `fallback` (the collapse painted a whole
corner as another terrain — every remaining square notch where a yard met the river or a track met
the road). It composites the terrains in `kit.json` `terrains[].layer` order (Crownlands: water 0 <
meadow/turf 1 < dirt 2 < road 3): the lowest two draw through their own family, each higher terrain
is pasted from its family with the lowest terrain it shares one with (its own class texels plus a
1-px rim of that family's band), so dirt lies over grass and cobbles over dirt while a shore corner
keeps its wet edge; a tile touching water still gets a water cell beneath. Collapse remains the
fallback only where no family chain can draw the tile. The river head is the **cliff waterfall prop**
(`waterfall_cliff`, 160×128, 8-frame clip, 5×4 footprint, seated on meadow at tile 54,-33 on the
north-east rise) with a straight-topped plunge pool under its foot no wider than the ledge (water
rect 55..58 × -30..-27), from which the river runs on; the small spring outcrop it replaced is gone.

## 3. Runtime state rule (E-4, E-6 amended)

```
state(tx, ty, claim):
  inside [claim.min, claim.max)²  → KINGDOM    turf variant; overlay cleared; obstacle rows drawn on top
  ring: 1 tile outside the claim  → EDGE       corner-Wang from the rect (straight runs + 4 corners):
                                               base = edge.variants[baked base cell]?.cells[mask] || edge.cells[mask]
                                               (the baked cell read straight from the base grid — the ring is always
                                               in the field), water and overlay 0 — so a ring tile over the kingdom
                                               road draws cobbles meeting turf, over a yard dirt meeting turf, and
                                               the plain turf↔meadow tile everywhere else (§2 ring variants)
  inside [-10,40)² otherwise      → WILDERNESS baked in-frame layers (ground-level tiles; baked props stand here too)
  outside [-10,40)², in the field → EXTERIOR   baked layers (rich scenery, water, cliffs, shipyard)
  beyond the field, within REALM_KIT.edgeExtendTiles (64) of it
                                  → EXTERIOR   edge clamp: water + base of the nearest field tile
                                               (tx, ty clamped into [-34,64)), overlay 0 — a river
                                               leaving the field runs on to the world's end
  farther out                     → nothing    the far repeat alone (realmKitCell = 0 on every layer)

prop(p, claim):                      seat = (floor(p.x / 32), ceil(p.y / 32) − 1) in 32-px source pixels
  seat inside [claim.min − 1, claim.max + 1)²  → HIDDEN   not drawn on any client nor on the deed (the claim cleared it)
  otherwise                                    → DRAWN    frame included; culled and frame-selected as in §7
```
The dashed claim perimeter and the eight `dec_rock` claim stones are not drawn on
revision 5 (the ring is the boundary); placement/deploy grids are unchanged.

## 4. Crownlands kit v1 — art inventory

Ground families (provider pro-mode corner Wang, 32 px, low top-down, transition 0
unless stated, every family chained on the same base tiles):
turf ↔ dirt (done: `7530eccf`) · turf ↔ wild meadow (boundary) · wild meadow ↔ forest
floor · wild meadow ↔ water · forest floor ↔ water · dirt ↔ water (ford/quay bank) ·
wild meadow ↔ cobbled kingdom road · wild meadow ↔ clover/tall-grass patches (macro
variation blobs) · wild meadow ↔ rock plateau (cliff, 25 tiles, bake-time only).
Dropped 2026-09-21 (§5, `ART-NOTES.md` "Woods"): both forest-floor families and the
clover/tall-grass cover patches; shade/dry tone twins of the meadow took their place.
Water: 4-frame surface loop derived from the water base tile; shore foam as a 3-frame
overlay strip; frame 0 still.

Props (provider create-image pro with the Keep and `tree_old` as style references,
canvas per ladder, binary alpha, outlined, no shadow): oak 48×64, pine 32×48, willow
64×80, hero oak 64×96, dead tree 32×48, sapling 16×24, bush 32×24, berry bush 32×24,
reeds 16×24, lily pad 16×16, rock_s 16×16, rock_l 32×24, boulder 48×40, mossy boulder
48×40, stump 16×16, log 32×16, fallen trunk 48×24, fence post/straight/corner 32-px
modular, signpost 16×32, well 32×40, cart 48×32, hay bale 16×16, wheat patch 32×32 ×3
growth states, campfire 32×32 (animated), lantern post 16×32 (animated), banner pole
16×48 (animated), watchtower ruin 64×80, broken wall 48×40, standing stones 32×32,
windmill 64×96 (animated blades), water mill wheel 48×48 (animated), **shipyard set**:
pier segment/end 32-px modular, mooring post 16×24, boathouse + slipway 96×80,
crane 48×64, starter boat 48×32 (bobbing), barrels/crates 16×16, quay flag 16×48
(animated), gull 16×16 ×3 frames, bridge NS/EW 32×48 segments.
Obstacle family (states intact/remnant): bush, stump, rock_s, pine1, pine2, rock_l,
tree_old, boulder — kit-drawn twins of the frozen `dec_` masters (O-7).

Ambient motion (all localized, palette-locked, frame 0 still, ≤3 px displacement):
water surface, shore foam, waterfall (cliff), reeds sway, banner/flag flutter,
campfire + smoke puffs, windmill blades, water wheel, boat bob, gulls loop path,
lantern flicker, leaf sway on 2 hero trees only.

## 5. Layout authoring (Crownlands)

`art/realm-kit-v1/crownlands/layout.json` is an authored scene (seeded, deterministic):
a river beginning under the **cliff waterfall** on the north-east rise (`waterfall_cliff`,
2026-09-21, owner: "waterwall where water starts need improvement" — it replaced the small
spring outcrop; the river starts as a plunge pool beneath it) bending south along the east
side to a lake in the south-east where the **shipyard/quay** sits, a cobbled kingdom
road running from the smallest kingdom (its `path` ends at row 20 inside `[8,22)`, so every
claim overwrites its tip with turf and its south ring crosses the cobbles — §2 ring variants)
out through the frame's south edge to a bridge over the river, farmland (wheat,
windmill, water mill) south-west, woods north and west, a watchtower ruin
north-west, shade and sun-dried drifts across the meadow.

Woods (amended 2026-09-21, owner: "trees can grow anywhere inside and outside base"):
there is **no forest-floor terrain** — its staircase transitions at 1-tile resolution
read as cut-off tiles in-game, so both forest families are gone. Woods are `shade`
(meadow × 0.88 value) under **canopy stands**: the `woods` scatter uses a `grove`
(jittered hexagonal lattice, `spacing` 2, per-`clusterTiles` species so a wood reads as
stands of oak and stands of fir rather than salt-and-pepper), `woods_edge` softens the
margin with hawthorn/young oak/rowan/saplings, `woods_floor` drops logs, bramble and
mushrooms on shade. The woods wrap the kingdom **through the frame bands** (region
`'field'`/`'frame'`), the claim hides whatever it covers (§3), and the plot's server
obstacle rows draw the same canopy twins. `shade` and `dry` are **builder-derived tonal
twins** of the meadow (tone families, no provider source) and may reach the two rings
because a twin is still meadow texture; the 64 square cover patches and the dead-end
western track are removed.

Rules enforced by the builder: nothing but ground-level tiles inside `[-10,40)`; the
innermost two exterior rings are wild meadow or its tonal twins (so the boundary ring
never meets water or another family); baked props stand anywhere in the field **except
the legacy plot `[0,30)`** (the server's obstacle rows stand there; the validator
additionally refuses a seat the smallest kingdom plus its ring would hide); density caps
per family; every asset used at least once; palette check per family.

`scripts/src/realm-kit.ts`: `build` (pack cells into POT sheets, key shore water,
palette check, bake layers from the layout, write `layered-manifest.json`),
`preview` (CPU renders: wild field, kingdom at claim 14/26/50, zoom-floor overview),
publish via `layered-ground.ts` revision-5 branch, `--pin-layered-r5` catalogue pin.

## 6. Delivery plan and acceptance

1. Shared contract + validator + plans + tests (this branch).
2. Art production and layout; CPU preview PNGs for a first owner look.
3. Web renderer (revision-5 branch of `SceneGround`/`LayeredGround`), QA host preview
   behind `REALM_KIT_PREVIEW_REALMS=crownlands` (server stamps revision 5 only there).
   Local verification switches (dev/QA only — the API ones are refused in production,
   the web one is inert there: `import.meta.env.DEV` is false so its realm map is
   always empty, though the unreachable preview path still ships in the lazy Phaser
   chunk rather than being tree-shaken; `.env.example` documents each): API
   `REALM_KIT_PREVIEW_MANIFESTS=<realm>=atlas/fantasy/layered-ground/<sha256>/manifest.json,…`
   (unpinned kits, one per realm under review), web
   `VITE_REALM_KIT_PREVIEW_MANIFESTS=<realm>=<manifest url>,…` (same map for the client;
   a realm absent from it keeps its catalogue pin, a manifest built for another realm is
   refused), and `DEV_LOGIN_REALM=<realm>` — the dev-login base PRESENTS that realm on every
   reader (`GET /base` visualContext, kit obstacles, deed render, native content). A fresh
   dev base is seeded there; an already-seated one keeps its fantasy claim, because an
   assigned claim is immutable by trigger (`drizzle/0118` `fantasy_claim_identity_guard`),
   so the globe keeps the persisted tile while the base renders the realm under review.
   Every dev-login under the switch re-seats the kit obstacle rows (E-11) from scratch.
4. API: deed renderer, native contract acceptance (1..5), version-gated downgrade,
   `clearedObstacles[]`.
5. Native: `RealmKitGround.kt`, chunk batches, overview LOD, props, contract 15,
   exporter section, GL harness, debug APK on the emulator.
6. Evidence for approval (D-136/D-137 precedent): web + native captures with a real
   base (≥300 buildings) at 1× and 390 px width, portrait + landscape, zoom floor and
   max, expansion 0/7/12 kingdom rings, reduced-motion byte-identical pairs, loading
   time, frame-time report, deed thumbnail parity, first-paint size-check unchanged, and
   the approval blockers below shown closed in the same captures.
7. Owner approval → `CURRENT_LAYERED_REVISION_BY_REALM.crownlands = 5`, native
   release, then the remaining seven realms from the same kit builder.

**Approval blockers (owner, 2026-09-21 evening, "fixing plan").** Two look defects the owner
still sees on the branch. Step 7 does not start while either is open, and the step-6 captures
must show each closed. Both are recorded under issue K-177:

- **Road end against the owned land — CLOSED on this branch (§2 ring variants, K-177).** "connection
  to stone road to land still has ugly cutoff connection". K-177 "The kingdom road stops four tiles
  short of the frame" was structural (the road tip could not pass the pure-meadow rings). Fixed as
  designed there, without a contract revision bump (the field is additive): the manifest carries
  `ground.state.edge.variants`, the one shared cell rule prefers a variant on the ring, Crownlands
  gained the DERIVED `turf-road` family (meadow-road with meadow → turf, the same dirt verge), `road`
  is `inFrame: true` and its `path` runs from the field's south edge to row 20 inside the smallest
  kingdom, so every claim's south ring crosses cobbles and the road always meets the land through
  turf-road. Evidence: the `preview` renders' kingdom-14 / kingdom-26 / kingdom-50 crossings
  (`scripts/src/realm-kit.ts preview`, crop tiles 9..21 × max−5..max+7 at 2×; regenerate into a
  scratch directory — no images in git) show the cobbles entering the turf ring with the Wang cap
  and no meadow strip; the step-6 web/native captures must show the same in the game.
- **Land edge reads as cut-off tiles** — "land still has that cutoffs not full enough". K-177
  "Land edge still shows cut-offs": the edge clamp fixed the WORLD's edge, not the claim's
  `turf-meadow` ring. Interpretation still to confirm with the owner in the game before any fix:
  the ring's 1-tile width, the chord corners, or turf not reaching the claim's last row.
- Neither is the three-way composite (`785f5f7c`): with Crownlands-shaped families a meadow|dirt
  land tile and the shore tile below it share a clean seam (measured row 31 vs row 0: meadow to
  x=15, 1-px rim, dirt to x=31).

## 7. Contract amendment after review (2026-09-21, engineering)

- **Prop sheets, not per-prop assets.** `LAYERED_GROUND_LIMITS_R5.assets = 24` and native
  flushes a batch on every texture switch, so props are packed by canvas size into a few
  uniform-cell sheets (`props32`, `props64`, `props96`, …) whose asset anchor is the shared
  bottom-centre seat (`frameWidth/2`, `frameHeight`). A revision-5 placement therefore
  carries `frame` (its cell index in the sheet, default 0) and, for an animated prop,
  `clip: { frames, frameDurationMs }` — the loop occupies consecutive cells starting at
  `frame`; `animated` is true iff `clip` is present; reduced motion draws `frame`.
  `realmKitPropPlan` owns this frame math (it no longer delegates to `layeredDrawPlan`).
  Every prop keeps binary alpha and its ink bottom on the cell bottom row.
- **Water convention.** Layers draw `water` → `base` → `overlay`. `base` has no holes; a base
  cell over open water is a fully transparent bed cell, a shore cell keys its water texels to
  transparent so the animated water loop beneath shows through. The builder does the keying
  (water palette distance) and a test proves every water-layer cell has a transparent hole
  above it.
- **Manifest cap** `manifestBytes` lives in `LAYERED_GROUND_LIMITS_R5`; the web download reads
  the same constant. Raised 2026-09-21 from 256 KiB to **512 KiB**, with `placements` 1024 →
  **2048**: the woods are individual 1×1-footprint trees with overlapping canopies (no canopy
  terrain), so the authored Crownlands field carries ~1,700 props; both clients cull per frame.
- **Creature paths (2026-09-21, owner: "animals … animated and moving to all sides and fun to see").**
  The static 32-px animal decals are gone; a roaming animal is an ambient `path` whose sheet
  asset carries one walk loop per facing (`directions: 4`, `frameCount = 4 × frames`, rows in
  `REALM_KIT_FACINGS` order down/left/right/up, seated bottom-centre like a prop). `realmKitPathPose`
  walks the polyline at `speed` art px/s, pausing `dwellMs` at every vertex on frame 0 of the facing
  ahead; facing = the segment's dominant axis (|dx| ≥ |dy| → left/right); the sheet cell = row × frames
  + ⌊elapsed / frameDurationMs⌋ mod frames while moving; reduced motion or a backgrounded scene pins
  the first vertex, first facing, frame 0 (the deed does not draw creatures). Every number is integer
  math (`realmKitIsqrt`, floor division), so web, native and the parity fixture agree to the pixel.
  Caps: `LAYERED_GROUND_LIMITS_R5.paths` 32 → **96**, `assets` 24 → **32** (one sheet per species).
- **One painter's band (same date).** With animals walking among the props, the ground band needs one
  draw order for props AND creatures: `realmKitGroundBandPlan` sorts by `realmKitDrawBand(layer)` —
  every layer below **`REALM_KIT.airLayer` (2)** is one band — then the anchor row (a prop's seat, a
  creature's feet), then manifest order with props before paths. A placement's 0/1 layer stays the
  E-11 low/tall semantic, not a draw band: a bush seated south of a tree's seat now covers the trunk
  base instead of hiding under the canopy (the earlier "layer then manifest order" rule got that
  case wrong), a hen north of a hay bale walks behind it, a deer south of a tree in front of it. Web
  expresses it as depth `1 + band + anchor row · 1e-6` with each creature a sub-row tie above the
  props of its row by manifest index (Phaser's depthSort is a stable sort of the LAST frame's list,
  so an equal depth would keep whichever side a creature walked in from), native draws the band plan
  straight over the floor, and the deed rasterizer's prop plan uses the same key.
- **Engine note — Phaser 4.1.0 GPU tilemap animation index (patched).** `TilemapGPULayer`
  reads the tileset's animation-data map as a texel index but the engine stored the bare
  animation ordinal, so only the first animated cell of a tileset resolved and the kit's
  animated water drew as random shore fragments (the diagonal "checkerboard" seen on the
  lake was this, not the art). `patches/phaser@4.1.0.patch` stores the texel index;
  `patches/README.md` has the detail and `apps/web/src/game/phaserTilesetAnimation.test.ts`
  pins both consumed bundles. Re-check upstream before any engine upgrade drops the hunk.

## 8. Authoring inputs the builder consumes (`art/realm-kit-v1/<realm>/`)

```
kit.json         schemaVersion 1, realmId, tilePixels 32
  terrains{}     id → { label, kind: 'ground'|'water'|'plateau', wild: bool, inFrame: bool (Crownlands: turf, meadow,
                        dirt AND road since the §2 ring variants — the kingdom road runs into the smallest kingdom),
                        derived?: { from, value, hue, saturation } (builder-made tonal twin, e.g. shade/dry),
                        layer?: 0..15 (composite order where ≥3 terrains meet on a tile, higher over lower;
                        Crownlands water 0, meadow/turf 1, dirt 2, road 3 — §2 "Bake-time compositing"),
                        fallback?: terrain (a FIELD corner collapses to it only when no family chain can draw the
                        tile; a §2 ring variant never collapses — a ring over this terrain needs its kingdom family
                        or the build fails) }
  boundary       { kingdom, wild, family (the runtime ring's wang16 family), road?: the kingdom road terrain —
                   declared, the build fails unless every reachable claim's ring crosses it (the road reaches the
                   smallest kingdom); every authored realm declares it, so the K-177 cut-off cannot return unseen }
  families[]     { id, lower, upper, source: 'sources/tilesets/<id>', kind: 'wang16'|'cliff25',
                   classify?: 'own' (tell the texels apart by the family's OWN mask-0/15 tiles and count a lower-coloured
                   texel enclosed by the upper terrain as upper — REALM_KIT_BUILD.jointPx — for a sheet whose upper terrain
                   carries the lower's own colours; Frostveil snow-road, whose snow-dusted joints are the sheet's snow) }
                 or { id, lower, upper, kind: 'tone' } (no source: composed from the twin's canonical tile)
  variants{}     terrain → [pure-cell variant PNG paths] (same palette family; hashed per tile)
  water          { frames: 'sources/anim/water/frame_%d.png', frameDurationMs }
  props[]        { id, source, kind: 'tall'|'low'|'decal', footprint: [w,h] tiles, states?: {remnant: id},
                   clip?: { frames, frameDurationMs, source pattern } }
  decals[]       KitDecal { id, source, mask?: 'organic' } — 'organic' noise-erodes a tile-filling patch so it
                 never reads as a pasted square (the Crownlands cover patches were dropped; the mask stays available)
  creatures[]    { id, source: 'sources/creatures/<id>/%s_%d.png' (%s ∈ down,left,right,up; %d ∈ 0..frames−1),
                   directions: 4, frames, frameDurationMs, speed (art px/s), kind: 'ground'|'water' } — packed into
                   one sheet asset per species (4 × frames cells row-major by facing, seated bottom-centre; the
                   builder checks that frame 0 of every facing touches the bottom row, sources/creatures/README.md)
  obstacleSprites{} server spriteKey → { intact: propId, remnant: propId }
  palette        { ground: [hex…] (≤12 per terrain family, checked), accent: [hex…] }
  paddingColor   '#rrggbb' (kingdom turf tone)
layout.json      seed, vertex ops in tile-vertex coords ([-34..64]) applied in order:
                 { op: 'fill'|'rect'|'blob'|'path'|'ring', terrain, … , jitter }
                 scatter[] LayoutScatter { id, region: 'exterior'|'frame'|'field'|rect, terrains[], require?[],
                             props: [{id, weight}], density, minGap, max?,
                             grove?: { spacing, jitter, clusterTiles, clusterWeight } — jittered hex lattice,
                             one preferred species per clusterTiles² cell with probability clusterWeight }
                 decals[]  { id, region, terrains[], decals: [{id, weight}], density }
                 place[]   explicit { prop, tx, ty, frame?, state? } (shipyard, ruin, mill, bridge…)
                 paths[]   render-only ambient routes { id, sprite, points (tiles), speed } — kit sprites on the air layer
                 roam[]    LayoutRoam { id, region, zone?, terrains[], count, radius (tiles), vertices 4..8, dwellMs,
                             creatures: [{id, weight}] } — `count` creatures apportioned by weight (largest remainder,
                             so "sheep ×3" is three sheep), each a seeded closed polyline of distinct tile centres within
                             `radius` of an anchor: every vertex and every tile under every segment on the group's terrains,
                             inside its region/zone, outside the frame's meadow rings, off every placement footprint; a
                             water creature's group may only name water terrains; a group that cannot seat its count fails
                             naming itself. Emitted as manifest paths (directions 4, frames, frameDurationMs, dwellMs,
                             loop 'cycle', layer 1) with ids `<creature>-<n>`.
provenance.json  provider job ids, seeds, generations spent, download hashes (never prompts naming
                 the provider or the project code name)
```
Builder rules (tested): nothing but ground-level cells inside `[-10,40)` (E-6: `inFrame` terrains
only, the kingdom road included); the two wild rings `[-12,42)` hold ground-level terrain only —
no water, no cliff — because the widest claim's boundary ring runs through them and is drawn from
ground families (until the §2 ring variants they had to be pure wild meadow or its twins, which is
what kept the road four tiles short of the frame; any ground may cross them now, and every ring
tile over it is baked as a variant); the ring variants cover every reachable (cell, mask) or the
build fails naming the tile; the declared kingdom road (`kit.json` `boundary.road`) crosses every
reachable claim's ring or the build fails naming the first claim it misses (a road `path` that stops
in the wild ground is the K-177 cut-off; Crownlands: 13 claims × 4 ring tiles over the width-2 road);
baked props seat anywhere in the field except the legacy plot `[0,30)`
(E-6 amended; the validator also refuses a seat the smallest kingdom plus its ring hides); every
terrain pair that touches has a family (else the build fails naming the pair and the tile); every
prop referenced exists; sheets are POT and lossless; palette check per family; deterministic
output (same inputs → same bytes).
