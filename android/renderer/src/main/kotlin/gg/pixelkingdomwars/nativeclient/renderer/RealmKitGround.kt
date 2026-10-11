package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Revision 5 realm environment kit: the Kotlin mirror of `packages/shared/src/realmKit.ts`
 * (docs/REALM-KIT-PLAN.md §2–§3, §7; D-153). Every rule, hash and frame formula here is the
 * one the web client and the deed renderer run, pinned by the parity fixture the TS tests emit.
 * Coordinates are source-art pixels (32 px per tile) or plot tiles; never simulation units.
 * Presentation admission only: nothing here grants land, clears an obstacle or moves a claim. */

/** `REALM_KIT`, `LAYERED_GROUND_LIMITS_R5` and the `GRID` claim numbers as the constants catalogue
 * publishes them. The renderer reads them from `catalogue.json`; no number is restated in Kotlin (a JVM
 * test pins the catalogue values against the parity fixture, so drift fails loud instead of drawing differently). */
class RealmKitRules private constructor(
    val tilePixels: Int, val fieldOriginTiles: Int, val fieldTiles: Int, val frameMinTile: Int, val frameMaxTile: Int,
    val edgeRingTiles: Int, val overviewMaxZoom: Double, val meadowRingsOutsideFrame: Int,
    /** `REALM_KIT.edgeExtendTiles` (owner 2026-09-21: "waters are cut off, we need to fill that till the end"): tiles
     * within this many beyond the field take the nearest field tile's water/base cell — the edge clamp — so a river
     * leaving the field runs on to the world's end instead of stopping at the far repeat; the overlay stays empty there. */
    val edgeExtendTiles: Int,
    /** `REALM_KIT.airLayer` (D-153 creature paths): every placement/path layer below it is ONE painter's band
     * drawn by the anchor row; this layer and above (birds, smoke) stack over the band by layer. */
    val airLayer: Int,
    val compressedBytes: Long, val manifestBytes: Int, val rgbaBytes: Long, val residentRealms: Int, val assets: Int,
    val placements: Int, val dimension: Int, val cells: Int, val layers: Int, val paths: Int, val pathPoints: Int,
    /** `LAYERED_GROUND_LIMITS_R5.bakedTiles`: the cap on a manifest's non-empty field cells across its three layers (the
     * validator refuses a denser bake); `floorTiles`: the hard wall on tiles one floor plan may emit over the whole
     * edge-clamped extent (water + base over the extent plus the field's water/overlay share of the bake). */
    val bakedTiles: Int, val floorTiles: Int,
    /** `LAYERED_GROUND_LIMITS_R5.edgeVariants` (REALM-KIT-PLAN §2 ring variants, D-153, K-131 road end): the cap on
     * `ground.state.edge.variants` rows — one per in-frame base cell a reachable claim ring can cross. A pack from before
     * the contract carries no key and was validated with no rows, so it reads as 0: a manifest with rows under it is drift. */
    val edgeVariants: Int,
    /** `GRID.plotTiles` / `GRID.claimTiles`: the legacy plot and the claim every base starts with. */
    val plotTiles: Int, val claimTiles: Int,
    /** `OBSTACLES.tiers[*].kinds`: the only keys `obstacleSprites` may map (the server row's spriteKey is the join). */
    val obstacleSpriteKeys: List<String>,
    /** `OBSTACLES.tiers[*].sizeTiles` per kind: the server row's rect is size×size from its top-left (apps/api obstacleRect). */
    val obstacleSizeByKey: Map<String, Int>,
    /** `LAYERED_GROUND_LIMITS_R5.footprintTiles`: the widest/tallest placement footprint a manifest may declare. */
    val footprintTiles: Int,
    /** `KIT_OBSTACLES` (E-11 expansion obstacles): the rule that turns a kit prop the claim reached into a server row. */
    val kitObstacles: KitObstacleRules,
) {
    val fieldEndTile: Int = fieldOriginTiles + fieldTiles
    val fieldCells: Int = fieldTiles * fieldTiles
    /** `REALM_KIT_EXTENT` in tiles: the drawable extent, the field plus its edge-clamped margin on every side. */
    val extentOriginTile: Int = fieldOriginTiles - edgeExtendTiles
    val extentEndTile: Int = fieldEndTile + edgeExtendTiles
    val extentTiles: Int = extentEndTile - extentOriginTile
    /** `realmKitDrawBand`: the draw band of a ground-band layer — 0 for everything under [airLayer], else the layer. */
    fun drawBand(layer: Int): Int = if (layer < airLayer) 0 else layer
    /** `REALM_KIT_SMALLEST_KINGDOM`: the claim every base starts with (footprints.claimRect centres
     * GRID.claimTiles on the legacy plot). A prop seated inside it or its ring could never be seen, so
     * the validator refuses one — baked props stay off the whole legacy plot, where the server's
     * clearable obstacle rows stand instead. */
    val smallestKingdom = RealmKitClaim((plotTiles - claimTiles) / 2, (plotTiles - claimTiles) / 2 + claimTiles)
    val field = LayeredGroundRect((fieldOriginTiles * tilePixels).toDouble(), (fieldOriginTiles * tilePixels).toDouble(),
        (fieldTiles * tilePixels).toDouble(), (fieldTiles * tilePixels).toDouble())
    val protectedFrame = LayeredGroundRect((frameMinTile * tilePixels).toDouble(), (frameMinTile * tilePixels).toDouble(),
        ((frameMaxTile - frameMinTile) * tilePixels).toDouble(), ((frameMaxTile - frameMinTile) * tilePixels).toDouble())
    init {
        require(tilePixels > 0 && fieldTiles > 0 && frameMaxTile > frameMinTile && frameMinTile >= fieldOriginTiles && frameMaxTile <= fieldEndTile)
        require(edgeRingTiles >= 1 && overviewMaxZoom > 0 && meadowRingsOutsideFrame >= 0 && edgeExtendTiles >= 0 && airLayer in 1..15)
        require(compressedBytes > 0 && manifestBytes > 0 && rgbaBytes > 0 && residentRealms >= 1 && assets >= 1 && placements >= 0 && dimension >= tilePixels)
        // A full base layer must fit the bake, and the field's bake must fit one floor plan.
        require(cells >= 1 && layers >= 1 && paths >= 0 && pathPoints >= 2 && bakedTiles >= fieldCells && floorTiles >= bakedTiles && obstacleSpriteKeys.isNotEmpty())
        // A variant row addresses one base cell, so more rows than cells could never all be used.
        require(edgeVariants in 0..cells)
        require(obstacleSpriteKeys.toSet().size == obstacleSpriteKeys.size)
        require(obstacleSpriteKeys.all { obstacleSizeByKey[it]?.let { size -> size >= 1 } == true } && footprintTiles >= 2)
        require(kitObstacles.tallByParity.isNotEmpty() && (kitObstacles.tallByParity + kitObstacles.tallLarge + kitObstacles.low + kitObstacles.byProp.map { it.second }).all { it in obstacleSpriteKeys })
        require(kitObstacles.creatureCellPixels > 0)
        // The smallest kingdom is a claim like any other: whole tiles, centred, inside the frame.
        require(claimTiles >= 1 && plotTiles >= claimTiles && (plotTiles - claimTiles) % 2 == 0)
        require(smallestKingdom.min >= frameMinTile && smallestKingdom.max <= frameMaxTile)
    }
    companion object {
        /** `constants` is `catalogue.json`'s constants object (every `constants.ts` export). */
        fun read(constants: JsonValue): RealmKitRules {
            val kit = requireNotNull(constants.get("REALM_KIT")) { "The content pack has no realm kit geometry" }
            val limits = requireNotNull(constants.get("LAYERED_GROUND_LIMITS_R5")) { "The content pack has no revision-5 ground limits" }
            val grid = requireNotNull(constants.get("GRID")) { "The content pack has no grid contract" }
            val obstacles = requireNotNull(constants.get("OBSTACLES")?.get("tiers")) { "The content pack has no obstacle tiers" }
            fun int(v: JsonValue, key: String): Int { val n = requireNotNull(v.get(key)) { "Missing $key" }; require(n.isLong); return n.asLong().toInt() }
            fun long(v: JsonValue, key: String): Long { val n = requireNotNull(v.get(key)) { "Missing $key" }; require(n.isLong); return n.asLong() }
            val zoom = requireNotNull(kit.get("overviewMaxZoom")); require(zoom.isNumber)
            val kitObstacles = requireNotNull(constants.get("KIT_OBSTACLES")) { "The content pack has no kit obstacle rule" }
            fun strings(v: JsonValue, key: String): List<String> { val row = requireNotNull(v.get(key)) { "Missing $key" }; require(row.isArray); return row.map { it.asString() } }
            val byProp = requireNotNull(kitObstacles.get("byProp")) { "Missing byProp" }; require(byProp.isObject)
            // A pack exported before the monorepo's a8a29923 (edge clamp + limits split) carries neither
            // REALM_KIT.edgeExtendTiles nor LAYERED_GROUND_LIMITS_R5.bakedTiles: it was validated with no margin and
            // with floorTiles as the bake cap, so it is read exactly that way (the locked pack, sourceCommit 65b7f936,
            // is one; its margin draws once a pack from a8a29923 or later is synced). A pack carrying only one of
            // the two keys is drift, not an older schema, and fails loud like any other missing key.
            val split = kit.has("edgeExtendTiles") || limits.has("bakedTiles")
            val floorTiles = int(limits, "floorTiles")
            val edgeExtendTiles = if (split) int(kit, "edgeExtendTiles") else 0
            val bakedTiles = if (split) int(limits, "bakedTiles") else floorTiles
            // A pack exported before the monorepo's 343a391a (§2 ring variants) has no edgeVariants: validated with no rows.
            val edgeVariants = if (limits.has("edgeVariants")) int(limits, "edgeVariants") else 0
            return RealmKitRules(int(kit, "tilePixels"), int(kit, "fieldOriginTiles"), int(kit, "fieldTiles"), int(kit, "frameMinTile"), int(kit, "frameMaxTile"),
                int(kit, "edgeRingTiles"), zoom.asDouble(), int(kit, "meadowRingsOutsideFrame"), edgeExtendTiles, int(kit, "airLayer"),
                long(limits, "compressedBytes"), int(limits, "manifestBytes"), long(limits, "rgbaBytes"), int(limits, "residentRealms"), int(limits, "assets"),
                int(limits, "placements"), int(limits, "dimension"), int(limits, "cells"), int(limits, "layers"), int(limits, "paths"), int(limits, "pathPoints"),
                bakedTiles, floorTiles, edgeVariants,
                int(grid, "plotTiles"), int(grid, "claimTiles"),
                obstacles.flatMap { tier -> requireNotNull(tier.get("kinds")).map { it.asString() } },
                obstacles.flatMap { tier -> val size = int(tier, "sizeTiles"); requireNotNull(tier.get("kinds")).map { it.asString() to size } }.toMap(),
                int(limits, "footprintTiles"),
                KitObstacleRules(byProp.map { it.name to it.asString() }, strings(kitObstacles, "tallByParity"), kitObstacles.getString("tallLarge"),
                    kitObstacles.getString("low"), int(kitObstacles, "creatureCellPixels")))
        }
    }
}
/** `KIT_OBSTACLES` as constants.ts publishes it (E-11 expansion obstacles, D-153). `byProp` keeps its
 * declaration order: prefixes are matched in that order, as the TS rule walks Object.entries. */
data class KitObstacleRules(val byProp: List<Pair<String, String>>, val tallByParity: List<String>, val tallLarge: String, val low: String, val creatureCellPixels: Int)

/** Run-length grid codec, shared verbatim with the TS side (`encodeRealmKitRle` / `decodeRealmKitRle`):
 *   rle := run (';' run)*  run := value | value ':' count  value := base-36 0..65535  count := base-36 ≥ 2
 * Canonical: adjacent runs differ, `:1` and leading zeros are rejected, the decoder demands the exact
 * length — one grid has exactly one string, so a hash-addressed manifest cannot drift by re-encoding. */
object RealmKitRle {
    private val token = Regex("^([0-9a-z]+)(?::([0-9a-z]+))?$")
    fun encode(cells: IntArray): String {
        val out = StringBuilder()
        var i = 0
        while (i < cells.size) {
            val v = cells[i]; require(v in 0..0xffff)
            var run = 1
            while (i + run < cells.size && cells[i + run] == v) run++
            if (out.isNotEmpty()) out.append(';')
            out.append(v.toString(36)); if (run > 1) out.append(':').append(run.toString(36))
            i += run
        }
        return out.toString()
    }
    /** `length` is the expected cell count; `maximum` the field cell cap (`RealmKitRules.fieldCells`). */
    fun decode(rle: String, length: Int, maximum: Int): IntArray {
        require(length in 0..maximum) { "Invalid realm kit manifest" }
        val out = IntArray(length)
        if (rle.isEmpty()) { require(length == 0) { "Invalid realm kit manifest" }; return out }
        var i = 0
        for (part in rle.split(';')) {
            val match = token.matchEntire(part) ?: fail()
            val valueText = match.groupValues[1]; val countText = match.groups[2]?.value
            val value = valueText.toLongOrNull(36) ?: fail()
            val run = if (countText == null) 1L else countText.toLongOrNull(36) ?: fail()
            if (value > 0xffff || valueText != value.toString(36) || run < 1 || i + run > length
                || (countText != null && (run == 1L || countText != run.toString(36)))
                || (i > 0 && out[i - 1].toLong() == value)) fail()
            out.fill(value.toInt(), i, (i + run).toInt())
            i += run.toInt()
        }
        if (i != length) fail()
        return out
    }
    private fun fail(): Nothing = throw IllegalArgumentException("Invalid realm kit manifest")
}

enum class RealmKitLayerId(val id: String) { WATER("water"), BASE("base"), OVERLAY("overlay");
    companion object { fun of(id: String?): RealmKitLayerId? = entries.firstOrNull { it.id == id } }
}
enum class RealmKitTileState { KINGDOM, EDGE, WILDERNESS, EXTERIOR }
enum class RealmKitObstacleState { INTACT, CLEARING, REMNANT }
/** Server claim in plot tiles, half-open: kingdom tiles are [min,max)². */
data class RealmKitClaim(val min: Int, val max: Int)
/** One 32-px cell of the tileset; animated cells lay their frames left→right, 32 px apart. */
data class RealmKitCell(val asset: String, val x: Int, val y: Int, val frames: Int, val frameDurationMs: Int?)
class RealmKitLayer(val id: RealmKitLayerId, val grid: IntArray)
data class RealmKitSpriteStates(val intact: String, val clearing: String?, val remnant: String)
data class RealmKitClip(val frames: Int, val frameDurationMs: Int)
/** §7: `frame` is the still cell in the prop sheet; `clip` is present iff `animated`. `x`/`y` is the
 * placement's anchor point (bottom-centre for props) in source-art pixels — the seat E-6 hides by. */
data class RealmKitPlacement(val id: String, val asset: String, val x: Double, val y: Double, val bounds: LayeredGroundRect, val layer: Int,
    val animated: Boolean, val frame: Int, val clip: RealmKitClip?, val states: RealmKitSpriteStates?,
    /** E-11 expansion obstacles: the kit prop id the builder placed (dashed; the id prefix when absent). */
    val prop: String? = null,
    /** The prop's tile footprint (w, h); 1×1 when absent. */
    val footprint: Pair<Int, Int>? = null)
/** `realmKitObstacleSpriteAt`'s answer: the sheet and cell a server obstacle row draws. */
data class RealmKitObstacleSprite(val asset: LayeredGroundAsset, val frame: Int)
/** The plot tile a placement stands on (`realmKitPlacementSeat`). */
data class RealmKitSeat(val tx: Int, val ty: Int)
data class RealmKitPoint(val x: Int, val y: Int)
/** A creature's facing: the sheet ROW of a `directions = 4` asset, in this order (`REALM_KIT_FACINGS`). */
enum class RealmKitFacing { DOWN, LEFT, RIGHT, UP }
/** Render-only ambient route (D-153 creature paths, `RealmKitPath` with every default applied): a polyline
 * in art px walked at `speed` art px/s. `directions` sheet rows (4: REALM_KIT_FACINGS order; 2: [left, right];
 * 1: one row), `frames` per facing, `frameDurationMs` the walk frame time, `dwellMs` the pause at every vertex
 * on frame 0 of the facing ahead, `pingpong` walks the points back to the start, `layer` its draw band. */
data class RealmKitPath(val id: String, val asset: String, val points: List<RealmKitPoint>, val speed: Int,
    val directions: Int = 1, val frames: Int, val frameDurationMs: Int, val dwellMs: Int = 0, val pingpong: Boolean = false, val layer: Int = 1)
/** `realmKitPathPose`: where a creature is at a clock — anchor (art px), facing, the segment vector and whether it dwells. */
data class RealmKitPathPose(val x: Int, val y: Int, val facing: RealmKitFacing, val dx: Int, val dy: Int, val dwelling: Boolean)
/** One ambient path's draw (`RealmKitPathDraw`): the sheet cell, facing, draw band layer and anchor. */
data class RealmKitPathDraw(val draw: LayeredGroundDraw, val facing: RealmKitFacing, val layer: Int, val anchor: RealmKitPoint)
/** One entry of the ground band (`RealmKitBandDraw`): a prop or a creature with its band layer and anchor row. */
data class RealmKitBandDraw(val draw: LayeredGroundDraw, val layer: Int, val bottom: Double, val facing: RealmKitFacing? = null)
data class RealmKitOverview(val asset: LayeredGroundAsset, val pxPerTile: Int)
data class RealmKitKingdomFill(val destination: LayeredGroundRect, val color: Int)
/** `RealmKitOverviewPlan`: [margin] is the edge-clamped margin below the zoom floor — the still's outer tile
 * row or column (pxPerTile texels deep) stretched over each of the eight margin rects (four sides, four
 * corners), culled to the view, row-major; tile for tile the clamp [RealmKitManifest.cell] applies, so a
 * river leaving the field runs on at every zoom instead of stopping at the far repeat once the still replaces the tiles. */
data class RealmKitOverviewPlan(val far: LayeredGroundDraw, val overview: LayeredGroundDraw?, val margin: List<LayeredGroundDraw>, val kingdom: RealmKitKingdomFill?)
data class RealmKitTileDraw(val layer: RealmKitLayerId, val tx: Int, val ty: Int, val cell: Int, val frame: Int, val destination: LayeredGroundRect)
data class RealmKitFloorPlan(val tiles: List<RealmKitTileDraw>, val far: LayeredGroundDraw)

/** Validate before opening files, allocating pixels or admitting upload work — the mirror of
 * `assertRealmKitManifest`, rule for rule. `manifestSizeBytes` is the encoded manifest's byte
 * length (the TS side measures `JSON.stringify(m) + '\n'`, which is what the publisher wrote). */
class RealmKitManifest(v: JsonValue, val rules: RealmKitRules, allowedRealms: Set<String>, manifestSizeBytes: Int) {
    val realmId: String = v.getString("realmId")
    val status: String = v.getString("status")
    val schemaVersion: Int = 3
    val groundRevision: Int = 5
    val tilePixels: Int
    val field: LayeredGroundRect
    val protectedFrame: LayeredGroundRect
    val paddingColor: Int
    val cells: List<RealmKitCell>
    val layers: List<RealmKitLayer>
    val turf: List<Int>
    val edgeCells: List<Int>
    /** REALM-KIT-PLAN §2 ring variants (D-153; K-131 "road end"), `ground.state.edge.variants` keyed by the base cell
     * id: the 16 ring cells the builder baked for that cell per corner-Wang mask, 0 where none (the default `edgeCells[mask]`
     * draws). Additive — a manifest without the field, or with an empty list, draws the default ring everywhere, as before. */
    val edgeVariants: Map<Int, List<Int>>
    val far: LayeredGroundFar
    val overview: RealmKitOverview?
    val assets: Map<String, LayeredGroundAsset>
    val tileset: LayeredGroundAsset
    /** Draw order (`orderedPlacements`): the draw band (`RealmKitRules.drawBand`), then the anchor row — bottom-seated
     * props stack like a painter, the one further south in front — then manifest order (stable across clients). */
    val placements: List<RealmKitPlacement>
    /** Manifest order, for rules that break ties by it (the seat index). */
    private val placementsInManifestOrder: List<RealmKitPlacement>
    val obstacleSprites: Map<String, RealmKitSpriteStates>
    val paths: List<RealmKitPath>
    val compressedBytes: Long
    val rgbaBytes: Long
    /** Non-empty baked cells across every field layer (capped by `LAYERED_GROUND_LIMITS_R5.bakedTiles`). */
    val bakedTiles: Int
    private val grids: Map<RealmKitLayerId, IntArray>
    init {
        val L = rules; val tile = rules.tilePixels
        require(number(v, "schemaVersion", 3, 3) == 3 && number(v, "groundRevision", 5, 5) == 5)
        require(realmId in allowedRealms && status in setOf("preview-only", "accepted"))
        tilePixels = number(v, "tilePixels", tile, tile)
        field = rect(v.get("field")); protectedFrame = rect(v.get("protectedFrame"))
        require(field == rules.field && protectedFrame == rules.protectedFrame)
        val g = requireNotNull(v.get("ground")); require(g.isObject && g.getString("kind") == "tiles")
        val colour = g.getString("paddingColor"); require(colour.matches(Regex("#[0-9a-f]{6}")))
        paddingColor = colour.substring(1).toInt(16)
        val cellRows = requireNotNull(g.get("cells")); val layerRows = requireNotNull(g.get("layers")); val state = requireNotNull(g.get("state")); val farRow = requireNotNull(g.get("far"))
        val assetRows = requireNotNull(v.get("assets")); val placeRows = requireNotNull(v.get("placements")); val obstacleRows = requireNotNull(v.get("obstacleSprites")); val pathRows = requireNotNull(v.get("paths"))
        require(cellRows.isArray && layerRows.isArray && state.isObject && farRow.isObject && assetRows.isArray && placeRows.isArray && obstacleRows.isObject && pathRows.isArray)
        require(assetRows.size in 1..L.assets && placeRows.size <= L.placements && cellRows.size in 1..L.cells && layerRows.size in 1..L.layers && pathRows.size <= L.paths)
        assets = assetRows.map { a ->
            val id = a.getString("id"); require(id.matches(ID))
            val hash = a.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}")))
            val file = a.getString("path")
            require(file == "atlas/fantasy/layered-ground/assets/$hash.png" || file == "atlas/fantasy/layered-ground/assets/$hash.webp")
            val width = number(a, "width", 1, L.dimension); val height = number(a, "height", 1, L.dimension)
            val fw = number(a, "frameWidth", 1, L.dimension); val fh = number(a, "frameHeight", 1, L.dimension)
            val count = number(a, "frameCount", 1, 64)
            require(width % fw == 0 && height % fh == 0 && width / fw * (height / fh) == count)
            require(number(a, "reducedMotionFrame", 0, 0) == 0)
            val anchor = requireNotNull(a.get("anchor")); require(anchor.isObject)
            LayeredGroundAsset(id, file, hash, numberLong(a, "size", 1, L.compressedBytes), width, height, fw, fh, count,
                number(a, "frameDurationMs", 50, 10000), number(anchor, "x", 0, fw), number(anchor, "y", 0, fh))
        }.also { list -> require(list.map { it.id }.distinct().size == list.size && list.map { it.path }.distinct().size == list.size) }.associateBy { it.id }
        compressedBytes = assets.values.sumOf { it.size }; rgbaBytes = assets.values.sumOf { it.width.toLong() * it.height * 4 }
        require(manifestSizeBytes > 0 && compressedBytes <= L.compressedBytes && rgbaBytes <= L.rgbaBytes
            && manifestSizeBytes <= L.manifestBytes && compressedBytes + manifestSizeBytes <= L.compressedBytes)
        val farAsset = requireNotNull(assets[farRow.getString("asset")])
        require(farAsset.frameCount == 1 && powerOfTwo(farAsset.width) && powerOfTwo(farAsset.height))
        val origin = requireNotNull(farRow.get("origin")); val period = requireNotNull(farRow.get("period")); require(origin.isObject && period.isObject)
        far = LayeredGroundFar(farAsset, LayeredGroundRepeat(coordinate(origin, "x", -16384.0, 16384.0), coordinate(origin, "y", -16384.0, 16384.0),
            coordinate(period, "width", tile.toDouble(), 16384.0), coordinate(period, "height", tile.toDouble(), 16384.0)))
        overview = g.get("overview")?.let { o ->
            require(o.isObject)
            val pxPerTile = number(o, "pxPerTile", 1, tile)
            val asset = requireNotNull(assets[o.getString("asset")])
            require(asset !== farAsset && asset.frameCount == 1 && asset.width == pxPerTile * L.fieldTiles && asset.height == pxPerTile * L.fieldTiles)
            RealmKitOverview(asset, pxPerTile)
        }
        val first = cellRows.get(0); require(first.isObject)
        tileset = requireNotNull(assets[first.getString("asset")])
        require(tileset !== farAsset && tileset !== overview?.asset && tileset.frameCount == 1 && powerOfTwo(tileset.width) && powerOfTwo(tileset.height))
        cells = cellRows.map { c ->
            require(c.isObject && c.getString("asset") == tileset.id)
            val x = number(c, "x", 0, L.dimension); val y = number(c, "y", 0, L.dimension)
            require(x % tile == 0 && y % tile == 0)
            val frames = if (c.get("frames") == null) 1 else number(c, "frames", 1, 64)
            val duration = c.get("frameDurationMs")?.let { number(c, "frameDurationMs", 50, 10000) }
            require((frames == 1 || duration != null) && x + frames * tile <= tileset.width && y + tile <= tileset.height)
            RealmKitCell(tileset.id, x, y, frames, duration)
        }
        fun cellId(n: JsonValue?): Int { requireNotNull(n); require(n.isLong && n.asLong() in 1L..cells.size.toLong()); return n.asLong().toInt() }
        val turfRow = requireNotNull(state.get("turf")); require(turfRow.isArray && turfRow.size in 1..L.cells)
        turf = turfRow.map(::cellId)
        val edge = requireNotNull(state.get("edge")); require(edge.isObject)
        val edgeRow = requireNotNull(edge.get("cells")); require(edgeRow.isArray && edgeRow.size == 16)
        edgeCells = edgeRow.map(::cellId)
        // §2 ring variants (optional): ≤ L.edgeVariants rows, one per base cell (unique), 16 masks each, every non-zero
        // entry a cell id — a row addressing a cell outside the table would draw garbage on the ring of one client and
        // be refused by the other. `null` is not "absent": it is a malformed field like any other.
        edgeVariants = edge.get("variants")?.let { rows ->
            require(rows.isArray && rows.size <= L.edgeVariants)
            val out = LinkedHashMap<Int, List<Int>>()
            for (row in rows) {
                require(row.isObject)
                val cell = cellId(row.get("cell")); require(cell !in out)
                val masks = requireNotNull(row.get("cells")); require(masks.isArray && masks.size == 16)
                out[cell] = masks.map { n -> require(n.isLong && n.asLong() in 0L..cells.size.toLong()); n.asLong().toInt() }
            }
            out
        } ?: emptyMap()
        val clear = requireNotNull(state.get("clearInside")); require(clear.isBoolean && clear.asBoolean())
        var baked = 0; var order = -1
        layers = layerRows.map { layer ->
            require(layer.isObject)
            val id = RealmKitLayerId.of(layer.get("id")?.takeIf { it.isString }?.asString()) ?: fail()
            require(id.ordinal > order); order = id.ordinal
            val rle = requireNotNull(layer.get("rle")); require(rle.isString)
            val grid = RealmKitRle.decode(rle.asString(), L.fieldCells, L.fieldCells)
            for (cell in grid) { require(cell <= cells.size); if (cell != 0) baked++ }
            RealmKitLayer(id, grid)
        }
        bakedTiles = baked
        grids = layers.associate { it.id to it.grid }
        val base = requireNotNull(grids[RealmKitLayerId.BASE])
        require(base.none { it == 0 } && baked <= L.bakedTiles)
        grids[RealmKitLayerId.WATER]?.let { water ->
            val dryMin = L.frameMinTile - L.meadowRingsOutsideFrame; val dryMax = L.frameMaxTile + L.meadowRingsOutsideFrame
            for (ty in dryMin until dryMax) for (tx in dryMin until dryMax)
                require(water[(ty - L.fieldOriginTiles) * L.fieldTiles + (tx - L.fieldOriginTiles)] == 0)
        }
        fun sprite(id: JsonValue?): LayeredGroundAsset? {
            val a = id?.takeIf { it.isString }?.let { assets[it.asString()] } ?: return null
            return a.takeIf { it !== farAsset && it !== overview?.asset && it !== tileset }
        }
        fun states(row: JsonValue?): RealmKitSpriteStates {
            requireNotNull(row); require(row.isObject)
            val intact = requireNotNull(sprite(row.get("intact"))); val remnant = requireNotNull(sprite(row.get("remnant")))
            val clearing = row.get("clearing")?.let { requireNotNull(sprite(it)) }
            return RealmKitSpriteStates(intact.id, clearing?.id, remnant.id)
        }
        val ids = mutableSetOf<String>()
        val indexed = placeRows.mapIndexed { index, p ->
            require(p.isObject)
            val id = p.getString("id"); require(id.matches(ID) && ids.add(id))
            val x = coordinate(p, "x", -4096.0, 4096.0); val y = coordinate(p, "y", -4096.0, 4096.0)
            val width = coordinate(p, "width", 1.0, 2048.0); val height = coordinate(p, "height", 1.0, 2048.0)
            val layer = number(p, "layer", 0, 15)
            val animatedRow = requireNotNull(p.get("animated")); require(animatedRow.isBoolean)
            val interactive = requireNotNull(p.get("interactive")); require(interactive.isBoolean && !interactive.asBoolean())
            val a = requireNotNull(sprite(p.get("asset")))
            val frame = if (p.get("frame") == null) 0 else number(p, "frame", 0, a.frameCount - 1)
            // §7: the still cell exists; a clip is ≥2 consecutive cells that fit the sheet; `animated` and
            // `clip` agree; phaseFrame is 0 (the loop starts at `frame`, never at an r4 phase).
            require(number(p, "phaseFrame", 0, 0) == 0)
            val clipRow = p.get("clip")
            require(animatedRow.asBoolean() == (clipRow != null))
            val clip = clipRow?.let { c -> require(c.isObject); RealmKitClip(number(c, "frames", 2, a.frameCount - frame), number(c, "frameDurationMs", 50, 10000)) }
            val stateRow = p.get("states")?.let { states(it).also { s -> require(s.intact == a.id) } }
            // E-11 expansion obstacles: `prop` is a kit id; `footprint` a [w, h] pair within the limits cap.
            val prop = p.get("prop")?.let { row -> require(row.isString && row.asString().matches(ID)); row.asString() }
            val footprint = p.get("footprint")?.let { row ->
                require(row.isArray && row.size == 2 && row.all { it.isLong && it.asLong() in 1L..L.footprintTiles.toLong() })
                row.get(0).asLong().toInt() to row.get(1).asLong().toInt()
            }
            val bounds = LayeredGroundRect(x - a.anchorX * width / a.frameWidth, y - a.anchorY * height / a.frameHeight, width, height)
            val placement = RealmKitPlacement(id, a.id, x, y, bounds, layer, animatedRow.asBoolean(), frame, clip, stateRow, prop, footprint)
            // E-6 (amended 2026-09-21): props may stand inside the protected frame; the claim hides them at
            // draw time. One seated where the smallest claim's ring already hides it would never show, so it
            // is a layout mistake.
            require(contains(field, bounds) && !placementHidden(placement, rules.smallestKingdom))
            Pair(index, placement)
        }
        placementsInManifestOrder = indexed.map { it.second }
        placements = indexed.sortedWith(compareBy({ rules.drawBand(it.second.layer) }, { it.second.y }, { it.first })).map { it.second }
        obstacleSprites = obstacleRows.associate { row -> require(row.name in L.obstacleSpriteKeys); row.name to states(row) }
        val pathIds = mutableSetOf<String>()
        paths = pathRows.map { path ->
            require(path.isObject)
            val id = path.getString("id"); require(id.matches(ID) && pathIds.add(id))
            val points = requireNotNull(path.get("points")); require(points.isArray && points.size in 2..L.pathPoints)
            val speed = number(path, "speed", 1, 4096)
            val a = requireNotNull(sprite(path.get("asset")))
            // D-153 creature paths: the facing rows tile the sheet exactly (directions × frames = frameCount), the walk
            // frame time and the vertex dwell are bounded like every other clock, the loop is named, the layer is a band.
            val directions = if (path.get("directions") == null) 1 else number(path, "directions", 1, 4)
            require(directions == 1 || directions == 2 || directions == 4)
            val frames = if (path.get("frames") == null) a.frameCount / directions else number(path, "frames", 1, 64)
            require(frames >= 1 && frames * directions == a.frameCount)
            val frameDurationMs = if (path.get("frameDurationMs") == null) a.frameDurationMs else number(path, "frameDurationMs", 50, 10000)
            val dwellMs = if (path.get("dwellMs") == null) 0 else number(path, "dwellMs", 0, 60000)
            val loop = path.get("loop")?.let { require(it.isString); it.asString().also { l -> require(l == "cycle" || l == "pingpong") } } ?: "cycle"
            val layer = if (path.get("layer") == null) 1 else number(path, "layer", 0, 15)
            // The sprite's bounds touch the frame exactly when its anchor enters this open rect.
            val clearRect = LayeredGroundRect(protectedFrame.x + a.anchorX - a.frameWidth, protectedFrame.y + a.anchorY - a.frameHeight,
                protectedFrame.width + a.frameWidth, protectedFrame.height + a.frameHeight)
            var previous: RealmKitPoint? = null
            val vertices = points.map { pt ->
                require(pt.isObject)
                val point = RealmKitPoint(number(pt, "x", -4096, 4096), number(pt, "y", -4096, 4096))
                require(contains(field, LayeredGroundRect((point.x - a.anchorX).toDouble(), (point.y - a.anchorY).toDouble(), a.frameWidth.toDouble(), a.frameHeight.toDouble())))
                previous?.let { require(!segmentEntersOpenRect(it, point, clearRect)) }
                previous = point; point
            }
            RealmKitPath(id, a.id, vertices, speed, directions, frames, frameDurationMs, dwellMs, loop == "pingpong", layer)
        }
    }
    fun asset(id: String): LayeredGroundAsset = assets.getValue(id)
    fun grid(layer: RealmKitLayerId): IntArray? = grids[layer]
    /** Actual native presentation uses 64 px tiles; art coordinates use 32. */
    fun floorBounds(rendererTilePixels: Double) = field.scaled(scale(rendererTilePixels))
    fun assertClaim(claim: RealmKitClaim) {
        require(claim.min in rules.frameMinTile..(rules.frameMaxTile - 1) && claim.max in (claim.min + 1)..rules.frameMaxTile) { "Invalid realm kit claim" }
    }
    private fun state(claim: RealmKitClaim, tx: Int, ty: Int): RealmKitTileState {
        fun inside(lo: Int, hi: Int) = tx >= lo && tx < hi && ty >= lo && ty < hi
        if (inside(claim.min, claim.max)) return RealmKitTileState.KINGDOM
        if (inside(claim.min - rules.edgeRingTiles, claim.max + rules.edgeRingTiles)) return RealmKitTileState.EDGE
        if (inside(rules.frameMinTile, rules.frameMaxTile)) return RealmKitTileState.WILDERNESS
        return RealmKitTileState.EXTERIOR
    }
    /** REALM-KIT-PLAN §3: the only runtime terrain decision, from the server claim rect. The ring
     * outranks the frame test so a 50×50 claim still gets its boundary in the exterior ring. */
    fun tileState(claim: RealmKitClaim, tx: Int, ty: Int): RealmKitTileState { assertClaim(claim); return state(claim, tx, ty) }
    private fun cellAt(grid: IntArray?, layer: RealmKitLayerId, claim: RealmKitClaim, tx: Int, ty: Int): Int {
        when (state(claim, tx, ty)) {
            RealmKitTileState.KINGDOM -> return if (layer != RealmKitLayerId.BASE) 0 else turf[(tileHash(tx, ty) % turf.size).toInt()]
            RealmKitTileState.EDGE -> {
                if (layer != RealmKitLayerId.BASE) return 0
                // §2 ring variants: over a baked base cell the builder gave a row (a road, a yard) the ring takes that
                // cell's own composite for this mask; 0 or no row → the default turf↔wild cell. The ring is always inside
                // the field (assertClaim keeps claims in the frame), so the base grid — `grid` here, the base layer's —
                // is read directly, never clamped.
                val mask = edgeMask(claim, tx, ty)
                val baked = grid?.get((ty - rules.fieldOriginTiles) * rules.fieldTiles + (tx - rules.fieldOriginTiles)) ?: 0
                val variant = if (baked != 0) edgeVariants[baked]?.get(mask) ?: 0 else 0
                return if (variant != 0) variant else edgeCells[mask]
            }
            else -> {}
        }
        if (grid == null) return 0
        if (tx < rules.fieldOriginTiles || ty < rules.fieldOriginTiles || tx >= rules.fieldEndTile || ty >= rules.fieldEndTile) {
            // Edge clamp (REALM_KIT.edgeExtendTiles): beyond the field the nearest field tile's water and base
            // cells continue to the world's end; decals do not repeat outward; beyond the extent, nothing (far repeat).
            if (layer == RealmKitLayerId.OVERLAY || tx < rules.extentOriginTile || ty < rules.extentOriginTile || tx >= rules.extentEndTile || ty >= rules.extentEndTile) return 0
            return grid[(clampTile(ty) - rules.fieldOriginTiles) * rules.fieldTiles + (clampTile(tx) - rules.fieldOriginTiles)]
        }
        return grid[(ty - rules.fieldOriginTiles) * rules.fieldTiles + (tx - rules.fieldOriginTiles)]
    }
    private fun clampTile(t: Int): Int = if (t < rules.fieldOriginTiles) rules.fieldOriginTiles else if (t >= rules.fieldEndTile) rules.fieldEndTile - 1 else t
    /** Cell id (0 = nothing) of one tile on one layer under a claim: kingdom tiles take a turf
     * variant on base and clear overlay/water; the ring takes its Wang cell (the baked cell's §2 ring variant for
     * the mask when the builder made one, else the default) and clears the other layers; else the baked layer —
     * edge-clamped for `REALM_KIT.edgeExtendTiles` beyond the field (water and base only), 0 farther out. */
    fun cell(claim: RealmKitClaim, layer: RealmKitLayerId, tx: Int, ty: Int): Int { assertClaim(claim); return cellAt(grids[layer], layer, claim, tx, ty) }
    /** Tileset source rect of a cell frame: frames step `tilePixels` to the right. */
    fun cellSource(cell: Int, frame: Int): LayeredGroundRect {
        require(cell in 1..cells.size) { "Invalid realm kit cell" }
        val c = cells[cell - 1]; require(frame in 0 until c.frames) { "Invalid realm kit cell frame" }
        return LayeredGroundRect((c.x + frame * tilePixels).toDouble(), c.y.toDouble(), tilePixels.toDouble(), tilePixels.toDouble())
    }
    /** frame = reducedMotion ? 0 : ⌊elapsed / frameDurationMs⌋ mod frames, so frame 0 is always the still. */
    fun cellFrame(cell: Int, elapsedMs: Long, reducedMotion: Boolean): Int {
        val c = cells[cell - 1]
        return if (reducedMotion || c.frames == 1) 0 else ((elapsedMs / c.frameDurationMs!!) % c.frames).toInt()
    }
    fun farDraw(rendererTilePixels: Double, view: LayeredGroundRect) = LayeredGroundDraw("floor-far", far.asset, 0, whole(far.asset), view, repeat = far.repeat.scaled(scale(rendererTilePixels)))
    /** Tiles intersecting the view over the edge-clamped extent (field + margin) in layer order then row-major,
     * plus the far repeat — the reference plan the chunk batches must equal; the cap is a hard wall a valid
     * manifest cannot reach. */
    fun floorPlan(rendererTilePixels: Double, view: LayeredGroundRect, claim: RealmKitClaim, elapsedMs: Long, reducedMotion: Boolean): RealmKitFloorPlan {
        checkView(view); require(elapsedMs >= 0); assertClaim(claim)
        val T = rendererTilePixels; require(T.isFinite() && T > 0)
        val tx0 = max(rules.extentOriginTile.toDouble(), floor(view.x / T)).toInt(); val tx1 = min(rules.extentEndTile.toDouble(), ceil((view.x + view.width) / T)).toInt()
        val ty0 = max(rules.extentOriginTile.toDouble(), floor(view.y / T)).toInt(); val ty1 = min(rules.extentEndTile.toDouble(), ceil((view.y + view.height) / T)).toInt()
        val tiles = mutableListOf<RealmKitTileDraw>()
        for (layer in layers) for (ty in ty0 until ty1) for (tx in tx0 until tx1) {
            val cell = cellAt(layer.grid, layer.id, claim, tx, ty)
            if (cell == 0) continue
            tiles += RealmKitTileDraw(layer.id, tx, ty, cell, cellFrame(cell, elapsedMs, reducedMotion), LayeredGroundRect(tx * T, ty * T, T, T))
            require(tiles.size <= rules.floorTiles) { "Realm kit floor plan exceeds its tile cap" }
        }
        return RealmKitFloorPlan(tiles, farDraw(rendererTilePixels, view))
    }
    /** §7 frame rule: a still draws `frame`; a clip draws `frame + ⌊elapsed / clip.frameDurationMs⌋ mod clip.frames`. */
    fun placementFrame(p: RealmKitPlacement, elapsedMs: Long, still: Boolean): Int {
        if (still || p.clip == null) return p.frame
        return p.frame + ((elapsedMs / p.clip.frameDurationMs) % p.clip.frames).toInt()
    }
    /** `realmKitPlacementSeat`: the tile a placement stands on — its anchor point (bottom-centre for
     * props) in source-art pixels, so a 1-wide prop seated at (tx·32 + 16, (ty + 1)·32) maps back to
     * (tx, ty) and a 2-wide footprint to its right-hand tile. Same floor/ceil as the TS side. */
    fun placementSeat(p: RealmKitPlacement): RealmKitSeat =
        RealmKitSeat(floor(p.x / rules.tilePixels).toInt(), ceil(p.y / rules.tilePixels).toInt() - 1)
    /** `realmKitPlacementHidden` (E-6 amended): a baked prop is hidden while its seat tile lies inside
     * the claim or its edge ring — the land the player owns is cleared land. Web, native and the deed
     * renderer all ask this one rule, so an expansion clears the same trees everywhere. */
    fun placementHidden(p: RealmKitPlacement, claim: RealmKitClaim): Boolean {
        val (tx, ty) = placementSeat(p); val lo = claim.min - rules.edgeRingTiles; val hi = claim.max + rules.edgeRingTiles
        return tx >= lo && tx < hi && ty >= lo && ty < hi
    }
    /** Culled, layer-sorted prop draws with the §7 frame rule, minus every prop the claim hides
     * ([placementHidden]). Unlike r4, a backgrounded scene still lists its props pinned to the still:
     * a hidden client simply does not advance the clock. */
    fun propPlan(rendererTilePixels: Double, view: LayeredGroundRect, claim: RealmKitClaim, elapsedMs: Long, reducedMotion: Boolean, background: Boolean = false): List<LayeredGroundDraw> {
        assertClaim(claim); checkView(view); require(elapsedMs >= 0)
        val scale = scale(rendererTilePixels); val still = reducedMotion || background
        // Per frame over every placement (~1,700 a realm): the claim and view tests read precomputed seats and the scaled
        // edges in place, allocating only for the props that draw. Same arithmetic as placementHidden and
        // LayeredGroundRect.scaled + intersects, so the plan is identical.
        val lo = claim.min - rules.edgeRingTiles; val hi = claim.max + rules.edgeRingTiles
        val seats = placementSeatsInDrawOrder
        val out = ArrayList<LayeredGroundDraw>()
        for (index in placements.indices) {
            val p = placements[index]; val seat = seats[index]
            if (seat.tx >= lo && seat.tx < hi && seat.ty >= lo && seat.ty < hi) continue
            val b = p.bounds
            val x = b.x * scale; val y = b.y * scale; val width = b.width * scale; val height = b.height * scale
            if (!(x < view.x + view.width && view.x < x + width && y < view.y + view.height && view.y < y + height)) continue
            val a = assets.getValue(p.asset); val frame = placementFrame(p, elapsedMs, still)
            out += LayeredGroundDraw(p.id, a, frame, spriteSource(a, frame), LayeredGroundRect(x, y, width, height))
        }
        return out
    }
    /** [placementSeat] of each of [placements], same order: seats never change, so the per-frame claim test reads them. */
    private val placementSeatsInDrawOrder: List<RealmKitSeat> by lazy { placements.map { placementSeat(it) } }
    /** [placements] by id for the band plan (built once, not per frame). */
    private val placementsById: Map<String, RealmKitPlacement> by lazy { placements.associateBy { it.id } }
    /** `realmKitPathPose`: the creature's pose at `elapsedMs`, deterministic and integer-only (Long + − × floorDiv):
     * the polyline is walked at `speed` art px/s, segment i taking ⌊Li · 1000 / speed⌋ ms with Li = isqrt(dx² + dy²),
     * pausing `dwellMs` at every vertex before leaving it; the period is the sum. Pingpong unfolds the points there
     * and back (Pn−1 … P1) and cycles that. `still` (reduced motion or background) is the first vertex, facing
     * along the first segment, dwelling. */
    fun pathPose(path: RealmKitPath, elapsedMs: Long, still: Boolean): RealmKitPathPose {
        val points = if (path.pingpong && path.points.size > 2) path.points + path.points.subList(1, path.points.size - 1).reversed() else path.points
        val vertices = if (path.pingpong) points + points[0] else points
        val segments = vertices.size - 1
        fun dx(i: Int) = vertices[i + 1].x - vertices[i].x
        fun dy(i: Int) = vertices[i + 1].y - vertices[i].y
        fun travel(i: Int): Long { val ddx = dx(i).toLong(); val ddy = dy(i).toLong(); return Math.floorDiv(isqrt(ddx * ddx + ddy * ddy) * 1000L, path.speed.toLong()) }
        val first = vertices[0]
        if (still) return RealmKitPathPose(first.x, first.y, segmentFacing(dx(0), dy(0)), dx(0), dy(0), true)
        var period = 0L
        for (i in 0 until segments) period += path.dwellMs + travel(i)
        var t = if (period > 0) Math.floorMod(elapsedMs, period) else 0L
        for (i in 0 until segments) {
            val p = vertices[i]; val ddx = dx(i); val ddy = dy(i); val facing = segmentFacing(ddx, ddy)
            if (t < path.dwellMs) return RealmKitPathPose(p.x, p.y, facing, ddx, ddy, true)
            t -= path.dwellMs
            val duration = travel(i)
            if (t < duration) return RealmKitPathPose(p.x + Math.floorDiv(ddx * t, duration).toInt(), p.y + Math.floorDiv(ddy * t, duration).toInt(), facing, ddx, ddy, false)
            t -= duration
        }
        return RealmKitPathPose(first.x, first.y, segmentFacing(dx(0), dy(0)), dx(0), dy(0), true)
    }
    /** `realmKitPathPlan`: culled draws of every ambient path at `elapsedMs`, manifest order — the pose from [pathPose],
     * the sheet cell = row(facing) × frames + walk frame (0 while dwelling, ⌊elapsed / frameDurationMs⌋ mod frames on
     * the move), the destination anchored like a prop and culled by its scaled bounds. Reduced motion or a
     * backgrounded scene draws the first vertex, the first segment's facing and frame 0. */
    fun pathPlan(rendererTilePixels: Double, view: LayeredGroundRect, elapsedMs: Long, reducedMotion: Boolean, background: Boolean = false): List<RealmKitPathDraw> {
        checkView(view); require(elapsedMs >= 0)
        val scale = scale(rendererTilePixels); val still = reducedMotion || background
        return paths.mapNotNull { path ->
            val a = assets.getValue(path.asset); val pose = pathPose(path, elapsedMs, still)
            val destination = LayeredGroundRect((pose.x - a.anchorX) * scale, (pose.y - a.anchorY) * scale, a.frameWidth * scale, a.frameHeight * scale)
            if (!destination.intersects(view)) return@mapNotNull null
            val walk = if (still || pose.dwelling) 0 else ((elapsedMs / path.frameDurationMs) % path.frames).toInt()
            val frame = facingRow(path.directions, pose.facing, pose.dx) * path.frames + walk
            RealmKitPathDraw(LayeredGroundDraw(path.id, a, frame, spriteSource(a, frame), destination), pose.facing, path.layer, RealmKitPoint(pose.x, pose.y))
        }
    }
    /** `realmKitGroundBandPlan`: props and creatures in ONE draw order — the draw band (`RealmKitRules.drawBand`:
     * everything under airLayer is one band, birds and smoke above it), then the anchor row in art px (a prop's seat,
     * a creature's feet), ties in manifest order with props before paths — so a deer south of a tree's seat walks in
     * front of it and behind it once north, and a hen behind the hay bale it passes, exactly as on web and the deed. */
    fun groundBandPlan(rendererTilePixels: Double, view: LayeredGroundRect, claim: RealmKitClaim, elapsedMs: Long, reducedMotion: Boolean, background: Boolean = false): List<RealmKitBandDraw> {
        val byId = placementsById
        val props = propPlan(rendererTilePixels, view, claim, elapsedMs, reducedMotion, background).map { d -> val p = byId.getValue(d.id); RealmKitBandDraw(d, p.layer, p.y) }
        val creatures = pathPlan(rendererTilePixels, view, elapsedMs, reducedMotion, background).map { d -> RealmKitBandDraw(d.draw, d.layer, d.anchor.y.toDouble(), d.facing) }
        return (props + creatures).withIndex().sortedWith(compareBy({ rules.drawBand(it.value.layer) }, { it.value.bottom }, { it.index })).map { it.value }
    }
    /** Kit sprite for a server obstacle row; `clearing` falls back to intact (the clear timer is client
     * FX above it, E-11). An unmapped key returns null so the renderer keeps the frozen `dec_` master. */
    fun obstacleSprite(spriteKey: String, state: RealmKitObstacleState): LayeredGroundAsset? {
        require(spriteKey in rules.obstacleSpriteKeys) { "Unknown obstacle sprite key" }
        val states = obstacleSprites[spriteKey] ?: return null
        val id = when (state) { RealmKitObstacleState.REMNANT -> states.remnant; RealmKitObstacleState.CLEARING -> states.clearing ?: states.intact; RealmKitObstacleState.INTACT -> states.intact }
        return assets.getValue(id)
    }
    /** `realmKitObstacleSize`: the row's rect edge in tiles for a sprite key (OBSTACLES.tiers[*].sizeTiles). */
    fun obstacleSize(spriteKey: String): Int = requireNotNull(rules.obstacleSizeByKey[spriteKey]) { "Unknown obstacle sprite key" }
    /** `realmKitObstacleSeat`: the seat tile of a row at (tx, ty) — the row's own tile for a 1×1 tier, the
     * bottom-right tile for the 2×2 tier (the builder seats a w-wide prop on tile tx0 + ⌊w/2⌋, row ty0 + h − 1). */
    fun obstacleSeat(spriteKey: String, tx: Int, ty: Int): RealmKitSeat { val size = obstacleSize(spriteKey); return RealmKitSeat(tx + size / 2, ty + size - 1) }
    /** `realmKitSeatIndex`: "tx,ty" → the placement seated there, first in MANIFEST order when two share a seat
     * (this class keeps placements draw-sorted, so the original index decides). */
    val seatIndex: Map<RealmKitSeat, RealmKitPlacement> by lazy {
        val index = LinkedHashMap<RealmKitSeat, RealmKitPlacement>()
        for (p in placementsInManifestOrder) index.putIfAbsent(placementSeat(p), p)
        index
    }
    /** `realmKitObstacleKindFor` (E-11 expansion obstacles, KIT_OBSTACLES): the server sprite key a kit prop
     * becomes when a claim reaches its seat, or null when it never becomes one. The creature sheet (a cell
     * exactly creatureCellPixels square) never maps; a byProp prefix names its key; else a 1×1 prop is a parity
     * tree on the tall layer or the bush on the low layer and a 2×2 tall prop the large tree. The key's tier size
     * must equal the prop's footprint or the prop never maps — a row never covers a tile the prop does not stand on. */
    fun obstacleKindFor(p: RealmKitPlacement): String? {
        val a = assets.getValue(p.asset); val k = rules.kitObstacles
        if (a.frameWidth == k.creatureCellPixels && a.frameHeight == k.creatureCellPixels) return null
        val (w, h) = p.footprint ?: (1 to 1); val prop = p.prop ?: p.id; val tall = p.layer > 0
        var key: String? = k.byProp.firstOrNull { prop.startsWith(it.first) }?.second
        if (key == null) {
            if (w == 1 && h == 1) {
                key = if (!tall) k.low else { val seat = placementSeat(p); k.tallByParity[(tileHash(seat.tx, seat.ty) % k.tallByParity.size).toInt()] }
            } else if (w == 2 && h == 2 && tall) key = k.tallLarge
        }
        if (key == null || key !in rules.obstacleSpriteKeys) return null
        val size = obstacleSize(key)
        return if (w == size && h == size) key else null
    }
    /** `realmKitObstacleSpriteAt`: the sheet cell a server obstacle row at (tx, ty) draws — while it stands
     * (intact or clearing), the still of the kit prop seated on the row's seat tile when that prop is the one
     * whose kind the row carries (a stale row never borrows a stranger's sprite); otherwise the E-11 twin,
     * which remnants always draw. Null leaves the key to the frozen `dec_` master. */
    fun obstacleSpriteAt(tx: Int, ty: Int, spriteKey: String, state: RealmKitObstacleState): RealmKitObstacleSprite? {
        require(spriteKey in rules.obstacleSpriteKeys) { "Unknown obstacle sprite key" }
        if (state != RealmKitObstacleState.REMNANT) {
            val p = seatIndex[obstacleSeat(spriteKey, tx, ty)]
            if (p != null && obstacleKindFor(p) == spriteKey) return RealmKitObstacleSprite(assets.getValue(p.asset), p.frame)
        }
        return obstacleSprite(spriteKey, state)?.let { RealmKitObstacleSprite(it, 0) }
    }
    /** E-11: the kit draw for a server obstacle row seated exactly like its `dec_` master — the still of
     * [obstacleSpriteAt]'s sheet (the seated prop's own cell, else the twin's frame 0), anchor x on the footprint
     * centre, bottom edge on the footprint's south edge (web BaseScene.styleObstacle + positionBuilding, the
     * deed's baseRender). The footprint is the row's own (from the `dec_` catalogue), never the sheet's. Null when
     * the manifest leaves the key to the frozen `dec_` master (O-7) or the key is not one of the server's eight:
     * the renderer keeps its catalogue art rather than losing the frame, as the web keeps its `dec_rock_s` fallback. */
    fun obstacleDraw(spriteKey: String, state: RealmKitObstacleState, rendererTilePixels: Double,
                     tileX: Double, tileY: Double, footprintWidth: Double, footprintHeight: Double): LayeredGroundDraw? {
        if (spriteKey !in rules.obstacleSpriteKeys) return null
        require(listOf(tileX, tileY, footprintWidth, footprintHeight).all { it.isFinite() } && footprintWidth > 0 && footprintHeight > 0)
        // Rows stand on whole tiles; a fractional tile can seat no prop and draws the twin.
        val sprite = (if (tileX == floor(tileX) && tileY == floor(tileY)) obstacleSpriteAt(tileX.toInt(), tileY.toInt(), spriteKey, state)
            else obstacleSprite(spriteKey, state)?.let { RealmKitObstacleSprite(it, 0) }) ?: return null
        val a = sprite.asset
        val scale = scale(rendererTilePixels)
        val width = a.frameWidth * scale; val height = a.frameHeight * scale
        val destination = LayeredGroundRect((tileX + footprintWidth / 2) * rendererTilePixels - a.anchorX * scale,
            (tileY + footprintHeight) * rendererTilePixels - height, width, height)
        return LayeredGroundDraw("obstacle:$spriteKey", a, sprite.frame, spriteSource(a, sprite.frame), destination)
    }
    /** Where [drawsOverview] allows it, and for thumbnails: one still plus a flat kingdom fill instead of quads. */
    fun overviewPlan(rendererTilePixels: Double, view: LayeredGroundRect, claim: RealmKitClaim): RealmKitOverviewPlan {
        checkView(view); assertClaim(claim)
        val o = requireNotNull(overview) { "Realm kit has no overview still" }
        val scale = scale(rendererTilePixels); val T = rendererTilePixels
        val fieldRect = field.scaled(scale)
        val kingdom = LayeredGroundRect(claim.min * T, claim.min * T, (claim.max - claim.min) * T, (claim.max - claim.min) * T)
        val margin = mutableListOf<LayeredGroundDraw>()
        if (rules.edgeExtendTiles > 0) {
            val px = o.pxPerTile; val still = o.asset.width
            // Per axis: -1 = the margin before the field, 0 = the field itself, +1 = the margin after it.
            fun tiles(s: Int) = if (s < 0) rules.extentOriginTile to rules.fieldOriginTiles else if (s > 0) rules.fieldEndTile to rules.extentEndTile else rules.fieldOriginTiles to rules.fieldEndTile
            fun texels(s: Int) = if (s < 0) 0 to px else if (s > 0) still - px to still else 0 to still
            for (sy in -1..1) for (sx in -1..1) {
                if (sx == 0 && sy == 0) continue
                val (tx0, tx1) = tiles(sx); val (ty0, ty1) = tiles(sy); val (u0, u1) = texels(sx); val (v0, v1) = texels(sy)
                val destination = LayeredGroundRect(tx0 * T, ty0 * T, (tx1 - tx0) * T, (ty1 - ty0) * T)
                if (!destination.intersects(view)) continue
                margin += LayeredGroundDraw("floor-margin-" + listOf("n", "", "s")[sy + 1] + listOf("w", "", "e")[sx + 1], o.asset, 0,
                    LayeredGroundRect(u0.toDouble(), v0.toDouble(), (u1 - u0).toDouble(), (v1 - v0).toDouble()), destination)
            }
        }
        return RealmKitOverviewPlan(farDraw(rendererTilePixels, view),
            if (fieldRect.intersects(view)) LayeredGroundDraw("floor-overview", o.asset, 0, whole(o.asset), fieldRect) else null,
            margin,
            if (kingdom.intersects(view)) RealmKitKingdomFill(kingdom, paddingColor) else null)
    }
    /** E-8's LOD switch for one frame, one rule in every scene: true when [overviewPlan] replaces the tile quads, that
     * is below `REALM_KIT.overviewMaxZoom` AND only where one still texel is at most [MAX_STILL_TEXEL_PX] physical px.
     * Owner 2026-09-25 on his Seeker: "zoomed out does not look good, zoomed in all is ok". A 4 px/tile still texel is
     * 8 art px, 16 world units: 13.6 physical px at the starter kingdom's HOME fit (web 0.284, density 3), a
     * stair-stepped mosaic under full-detail props. A scouted base, a campaign preview, a live raid and a replay are
     * all battle scenes and open at those zooms too (fitExpandedBattleFrame fits a 14-tile defender at the same
     * 0.284), so no scene flag can keep the mosaic away; the texel's size on the glass can. At 2 px a texel is about
     * the kit's own art pixel as the owner accepted it (1.7 px) and nearest-sampled tiles would skip most art pixels
     * anyway, so there the still is the better picture and E-8's quad budget still holds. Floors (D-185, owner
     * 2026-09-27; CameraFraming.drawnWorldFrame): every scene, base or battle, zooms out to its 98-tile field covering the
     * surface, 16 · long side px / (98 · 64): 6.8 px on the Seeker, 2 px or less only on a long side of 784 px or less.
     * Units: `overviewMaxZoom` is a BaseScene camera zoom, the BASE_CAMERA/RAID_CAMERA 0.14..1.6 unit (CSS px per world
     * px of the web's 64-px tile). libGDX zoom is world units per physical px and the native world tile is that same
     * `presentation.tilePixels`, so the web zoom is 1 / (zoom · density), the inverse CameraFraming applies. The kit's
     * 32-px art scale is already in every destination ([scale]); it must not divide in twice. */
    fun drawsOverview(rendererTilePixels: Double, cameraZoom: Double, density: Double): Boolean {
        val o = overview ?: return false
        return 1.0 / (cameraZoom * density) < rules.overviewMaxZoom && rendererTilePixels / o.pxPerTile / cameraZoom <= MAX_STILL_TEXEL_PX
    }
    private fun checkView(view: LayeredGroundRect) {
        require(listOf(view.x, view.y, view.width, view.height).all { it.isFinite() } && view.width > 0 && view.height > 0)
    }
    private fun scale(tile: Double): Double { require(tile.isFinite() && tile > 0); return tile / tilePixels }

    companion object {
        /** The widest still texel, in physical px, that may stand in for the tiles ([drawsOverview]). A display limit of
         * the glass, not a game number: the web draws tiles at every zoom and has no still to switch to. */
        const val MAX_STILL_TEXEL_PX = 2.0
        private val ID = Regex("[a-z][a-z0-9-]{0,63}")
        private fun fail(): Nothing = throw IllegalArgumentException("Invalid realm kit manifest")
        private fun number(v: JsonValue, key: String, lo: Int, hi: Int): Int {
            val n = requireNotNull(v.get(key)); require(n.isLong && n.asLong() in lo.toLong()..hi.toLong())
            return n.asLong().toInt()
        }
        private fun numberLong(v: JsonValue, key: String, lo: Long, hi: Long): Long {
            val n = requireNotNull(v.get(key)); require(n.isLong && n.asLong() in lo..hi); return n.asLong()
        }
        private fun coordinate(v: JsonValue, key: String, lo: Double, hi: Double): Double {
            val n = requireNotNull(v.get(key)); require(n.isNumber)
            return n.asDouble().also { require(it.isFinite() && it in lo..hi) }
        }
        private fun rect(v: JsonValue?): LayeredGroundRect {
            requireNotNull(v); require(v.isObject)
            return LayeredGroundRect(coordinate(v, "x", -4096.0, 4096.0), coordinate(v, "y", -4096.0, 4096.0), coordinate(v, "width", 1.0, 4096.0), coordinate(v, "height", 1.0, 4096.0))
        }
        private fun powerOfTwo(n: Int) = n > 0 && n.countOneBits() == 1
        private fun whole(a: LayeredGroundAsset) = LayeredGroundRect(0.0, 0.0, a.width.toDouble(), a.height.toDouble())
        private fun contains(a: LayeredGroundRect, b: LayeredGroundRect) = a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height
        /** Closed segment p→q against the OPEN rect (separating-axis test, all integer products).
         * Touching the boundary is not entering: a route may hug the frame, never cross it. */
        internal fun segmentEntersOpenRect(p: RealmKitPoint, q: RealmKitPoint, r: LayeredGroundRect): Boolean {
            val x0 = r.x; val x1 = r.x + r.width; val y0 = r.y; val y1 = r.y + r.height
            if (max(p.x, q.x) <= x0 || min(p.x, q.x) >= x1 || max(p.y, q.y) <= y0 || min(p.y, q.y) >= y1) return false
            val nx = (p.y - q.y).toDouble(); val ny = (q.x - p.x).toDouble()
            if (nx == 0.0 && ny == 0.0) return true
            val c = nx * p.x + ny * p.y
            val corners = listOf(nx * x0 + ny * y0, nx * x1 + ny * y0, nx * x0 + ny * y1, nx * x1 + ny * y1)
            return c > corners.min() && c < corners.max()
        }
        /** Corner-Wang mask of an edge-ring tile: NW·8 + NE·4 + SW·2 + SE·1, a bit set when that vertex lies
         * inside the CLOSED claim rect [min,max]² in tile-edge coordinates (kingdom turf is the upper terrain). */
        fun edgeMask(claim: RealmKitClaim, tx: Int, ty: Int): Int {
            fun upper(vx: Int, vy: Int) = if (vx >= claim.min && vx <= claim.max && vy >= claim.min && vy <= claim.max) 1 else 0
            return upper(tx, ty) * 8 + upper(tx + 1, ty) * 4 + upper(tx, ty + 1) * 2 + upper(tx + 1, ty + 1)
        }
        /** 32-bit integer mix of absolute tile coordinates, read unsigned (the documented TS arithmetic:
         * Int wrapping `*`, `xor`, `ushr`). Absolute on purpose: buying an expansion never reshuffles turf. */
        fun tileHash(tx: Int, ty: Int): Long {
            var h = (tx * 0x27d4eb2d) xor (ty * 0x165667b1) xor 0x5bd1e995
            h = h xor (h ushr 15); h *= 0x2c1b3c6d
            h = h xor (h ushr 12); h *= 0x297a2d39
            h = h xor (h ushr 15)
            return h.toLong() and 0xffffffffL
        }
        /** `realmKitIsqrt`: ⌊√n⌋ by integer Newton steps — the TS side uses no Math.sqrt either, so segment lengths agree to the pixel. */
        fun isqrt(n: Long): Long {
            require(n >= 0)
            if (n < 2) return n
            var x = n; var y = (x + 1) / 2
            while (y < x) { x = y; y = (x + n / x) / 2 }
            return x
        }
        /** `realmKitSegmentFacing`: the dominant axis (|dx| ≥ |dy| → left/right, else up/down); a zero segment faces right. */
        fun segmentFacing(dx: Int, dy: Int): RealmKitFacing =
            if (kotlin.math.abs(dx) >= kotlin.math.abs(dy)) (if (dx < 0) RealmKitFacing.LEFT else RealmKitFacing.RIGHT) else (if (dy < 0) RealmKitFacing.UP else RealmKitFacing.DOWN)
        /** `realmKitFacingRow`: 4 rows in facing order; 2 rows [left, right] (up/down borrow the side the x component leans to); 1 row for everything. */
        fun facingRow(directions: Int, facing: RealmKitFacing, dx: Int): Int = when (directions) {
            4 -> facing.ordinal
            2 -> if (facing == RealmKitFacing.LEFT || (facing != RealmKitFacing.RIGHT && dx < 0)) 0 else 1
            else -> 0
        }
        /** Source rect of one cell of a prop sheet: `frameWidth`×`frameHeight` cells, row-major. */
        fun spriteSource(a: LayeredGroundAsset, frame: Int): LayeredGroundRect {
            require(frame in 0 until a.frameCount) { "Invalid realm kit sprite frame" }
            val columns = a.width / a.frameWidth
            return LayeredGroundRect((frame % columns * a.frameWidth).toDouble(), (frame / columns * a.frameHeight).toDouble(), a.frameWidth.toDouble(), a.frameHeight.toDouble())
        }
    }
}
