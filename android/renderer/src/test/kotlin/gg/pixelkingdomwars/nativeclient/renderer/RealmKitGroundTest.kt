package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import org.junit.Test
import java.io.File
import kotlin.test.*

/** Parity with `packages/shared/src/realmKit.ts` through the fixture its tests emit
 * (`scripts/src/realm-kit-fixture.ts`): the synthetic revision-5 manifest, ~600 (claim, tile)
 * cell probes and the synthetic sheets. One kingdom must look identical on web, native and deeds. */
class RealmKitGroundTest {
    private val reader = JsonReader()
    private fun resource(name: String) = checkNotNull(javaClass.getResourceAsStream("/realm-kit/$name")) { "missing test resource $name" }.readBytes()
    private val constants = reader.parse(resource("constants.json").decodeToString())
    private val rules = RealmKitRules.read(constants)
    private val fixture = reader.parse(resource("realm-kit-fixture.json").decodeToString())
    private val section = reader.parse(resource("layeredGroundV5.json").decodeToString())
    private val descriptor = section.get("manifests").get(0)
    private val manifestBytes = resource(descriptor.getString("manifestPath"))
    private val realms = setOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall")
    private fun manifest(sizeBytes: Int = manifestBytes.size, mutate: (JsonValue) -> Unit = {}): RealmKitManifest {
        val v = reader.parse(manifestBytes.decodeToString()); mutate(v)
        return RealmKitManifest(v, rules, realms, sizeBytes)
    }
    private val kit by lazy { manifest() }
    private val N = rules.fieldTiles; private val O = rules.fieldOriginTiles
    private fun claim(tiles: Int): RealmKitClaim { val min = 15 - tiles / 2; return RealmKitClaim(min, min + tiles) }
    // Fixture cell ids (packages/shared/src/realmKit.fixture.ts FIXTURE_CELL).
    private val MEADOW = 1; private val MEADOW_ALT = 2; private val TURF = 3; private val TURF_ALT = 4; private val EDGE_FIRST = 5
    private val WATER = 21; private val FLOWER = 22; private val FOREST = 23; private val ROAD = 24; private val BED = 25
    // §2 ring variants (K-131 road end): the base-layer cobbles road and dirt yard, and the first synthetic ring-variant cell.
    private val COBBLES = 26; private val DIRT = 27; private val VARIANT_FIRST = 28
    /** FIXTURE_KINGDOM_ROAD: two cobbles columns on the base layer from the field's south edge to row 20 inside the
     * smallest kingdom, so every claim's south ring crosses it; FIXTURE_YARD: dirt at [20,26)×[3,9) north-east of it. */
    private fun cobblesAt(tx: Int, ty: Int) = tx in 14..15 && ty in 20..63
    private fun dirtAt(tx: Int, ty: Int) = tx in 20..25 && ty in 3..8
    private val ROAD_ROW = 12; private val YARD_MASKS = listOf(3, 2, 10)
    private fun JsonValue.edge(): JsonValue = get("ground").get("state").get("edge")
    private fun JsonValue.variantRow(cell: Int): JsonValue = edge().get("variants").first { it.getInt("cell") == cell }
    private fun grid(fill: (Int, Int) -> Int) = IntArray(N * N) { fill(it % N + O, it / N + O) }
    private fun lcg(length: Int, seed: Int, modulus: Int): IntArray { var s = seed.toLong(); return IntArray(length) { s = (s * 1103515245 + 12345) and 0x7fffffff; ((s shr 8) % modulus).toInt() } }

    @Test fun `catalogue constants pin the same geometry and limits the fixture and the shared tests use`() {
        assertEquals(kit.tilePixels, rules.tilePixels); assertEquals(kit.field, rules.field); assertEquals(kit.protectedFrame, rules.protectedFrame)
        assertEquals(LayeredGroundRect(-1088.0, -1088.0, 3136.0, 3136.0), rules.field)
        assertEquals(LayeredGroundRect(-320.0, -320.0, 1600.0, 1600.0), rules.protectedFrame)
        assertEquals(98, rules.fieldTiles); assertEquals(-34, rules.fieldOriginTiles); assertEquals(64, rules.fieldEndTile)
        // Edge clamp (owner 2026-09-21: "waters are cut off … fill that till the end"): the drawable extent is the field
        // plus REALM_KIT.edgeExtendTiles on every side, and the limits split the field's bake from one plan over that extent.
        assertEquals(64, rules.edgeExtendTiles); assertEquals(-98, rules.extentOriginTile); assertEquals(128, rules.extentEndTile); assertEquals(226, rules.extentTiles)
        assertEquals(16384, rules.bakedTiles); assertEquals(6780, rules.bakedTiles - N * N, "the bake stays a full base layer plus ≤6780 water/overlay cells")
        assertEquals(110000, rules.floorTiles)
        // §2 ring variants (K-131 road end): the row cap is a hard wall on the builder's bake, one row per in-frame base
        // cell a reachable ring crosses — well under the cell table, never a second table.
        assertEquals(512, rules.edgeVariants); assertTrue(rules.edgeVariants < rules.cells / 4)
        assertTrue(rules.floorTiles >= 2 * rules.extentTiles * rules.extentTiles + (rules.bakedTiles - N * N), "water + base over the extent plus the field's water/overlay share fit one plan")
        assertTrue(rules.floorTiles < 2 * rules.extentTiles * rules.extentTiles + N * N, "never three full extent layers")
        assertEquals((rules.dimension / rules.tilePixels) * (rules.dimension / rules.tilePixels), rules.cells)
        assertEquals(512 * 1024, rules.manifestBytes); assertEquals(2048, rules.placements)
        assertEquals(RealmKitClaim(8, 22), rules.smallestKingdom, "GRID.claimTiles centred on GRID.plotTiles: the claim every base starts with")
        assertEquals(listOf("bush", "stump", "rock_s", "pine1", "pine2", "rock_l", "tree_old", "boulder"), rules.obstacleSpriteKeys)
        assertEquals(mapOf("bush" to 1, "stump" to 1, "rock_s" to 1, "pine1" to 1, "pine2" to 1, "rock_l" to 1, "tree_old" to 2, "boulder" to 2), rules.obstacleSizeByKey)
        // KIT_OBSTACLES as constants.ts publishes it (E-11 expansion obstacles): byProp in declaration order.
        assertEquals(KitObstacleRules(listOf("rock-l" to "rock_l", "rock-s" to "rock_s", "stump" to "stump", "canopy-log" to "stump", "boulder" to "boulder"),
            listOf("pine1", "pine2"), "tree_old", "bush", 32), rules.kitObstacles)
        assertEquals(8, rules.footprintTiles)
        assertEquals(0.35, rules.overviewMaxZoom)
        // D-153 creature paths: the route and sheet caps the roaming animals needed, and the air layer that
        // splits the painter's band (everything below it) from what flies over it.
        assertEquals(96, rules.paths); assertEquals(32, rules.assets); assertEquals(2, rules.airLayer)
        assertEquals(listOf(0, 0, 2, 3), listOf(0, 1, 2, 3).map(rules::drawBand))
        assertEquals(rules.field, kit.floorBounds(32.0)); assertEquals(rules.field.scaled(2.0), kit.floorBounds(64.0))
        assertFailsWith<IllegalArgumentException> { RealmKitRules.read(reader.parse("""{"REALM_KIT":{}}""")) }
        assertFailsWith<IllegalArgumentException>("a pack without GRID cannot place the smallest kingdom") { RealmKitRules.read(reader.parse(constants.toJson(JsonWriter.OutputType.json)).also { it.remove("GRID") }) }
    }
    /** The locked pack (`client-pack.lock.json`, sourceCommit 65b7f936) predates the edge clamp and the limits split
     * (monorepo a8a29923): it carries neither `edgeExtendTiles` nor `bakedTiles`. The reader must take it as it was
     * validated — no margin, `floorTiles` as the bake cap — or `prepareGround` throws on device and no revision-5 base
     * can draw its ground at all. A pack carrying only one of the two keys is drift and still fails loud. */
    @Test fun `a pack from before the edge clamp reads with no margin and floorTiles as its bake cap`() {
        fun copy() = reader.parse(constants.toJson(JsonWriter.OutputType.json))
        val legacy = copy()
        legacy.get("REALM_KIT").remove("edgeExtendTiles")
        legacy.get("LAYERED_GROUND_LIMITS_R5").also { it.remove("bakedTiles"); it.get("floorTiles").set(16384L, null); it.remove("edgeVariants") }
        val old = RealmKitRules.read(legacy)
        assertEquals(0, old.edgeExtendTiles, "no key, no margin: the pack was validated without one")
        // §2 ring variants (monorepo 343a391a) came later still: a pack without `edgeVariants` was validated with no
        // rows, so it admits none — a manifest carrying rows under it is drift between the catalogue and the manifest.
        assertEquals(0, old.edgeVariants, "no key, no rows: the pack was validated without ring variants")
        assertEquals(old.fieldOriginTiles, old.extentOriginTile); assertEquals(old.fieldEndTile, old.extentEndTile); assertEquals(old.fieldTiles, old.extentTiles)
        assertEquals(16384, old.bakedTiles, "floorTiles was the bake cap before the split"); assertEquals(16384, old.floorTiles)
        assertEquals(rules.field, old.field); assertEquals(rules.protectedFrame, old.protectedFrame); assertEquals(rules.smallestKingdom, old.smallestKingdom)
        // A manifest validated under the old cap still loads, draws nothing beyond the field and keeps its whole-field plan under the wall.
        assertFailsWith<IllegalArgumentException>("variant rows under a pack validated without them is drift") { RealmKitManifest(reader.parse(manifestBytes.decodeToString()), old, realms, manifestBytes.size) }
        val oldKit = RealmKitManifest(reader.parse(manifestBytes.decodeToString()).also { it.edge().remove("variants") }, old, realms, manifestBytes.size)
        assertEquals(emptyMap(), oldKit.edgeVariants); assertEquals(EDGE_FIRST + ROAD_ROW, oldKit.cell(claim(14), RealmKitLayerId.BASE, 15, 22), "no rows: the default ring, as that pack always drew it")
        assertEquals(0, oldKit.cell(claim(14), RealmKitLayerId.BASE, old.fieldEndTile, 0), "no margin: the tile past the field is the far repeat")
        assertTrue(oldKit.floorPlan(32.0, old.field, claim(14), 0, true).tiles.size <= old.floorTiles)
        assertEquals((old.fieldTiles + 15) / 16, RealmKitChunkCache(oldKit, 32.0).chunksPerAxis, "the chunk cache covers exactly the field when there is no margin")
        assertFailsWith<IllegalArgumentException>("edgeExtendTiles without bakedTiles is drift") { RealmKitRules.read(copy().also { it.get("LAYERED_GROUND_LIMITS_R5").remove("bakedTiles") }) }
        assertFailsWith<IllegalArgumentException>("bakedTiles without edgeExtendTiles is drift") { RealmKitRules.read(copy().also { it.get("REALM_KIT").remove("edgeExtendTiles") }) }
        // The bundled pack's own catalogue is what NativeGameRenderer.realmKitRules evaluates in prepareGround: whichever
        // schema it carries, it must read here, on the same field the fixture pins.
        val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
        val bundled = RealmKitRules.read(assertNotNull(reader.parse(root.resolve("catalogue.json").readText()).get("constants"), "the bundled pack has constants"))
        assertEquals(rules.field, bundled.field); assertEquals(rules.protectedFrame, bundled.protectedFrame)
        assertTrue(bundled.floorTiles >= bundled.bakedTiles && bundled.bakedTiles >= bundled.fieldCells)
    }
    @Test fun `run-length codec round-trips byte-exactly and canonically so a baked layer survives the manifest hash`() {
        val grids = listOf(IntArray(0), IntArray(N * N), IntArray(N * N) { 65535 }, IntArray(300) { it % 2 }, IntArray(200) { it },
            lcg(N * N, 7, 3), lcg(N * N, 11, 4096), lcg(5000, 13, 65536), intArrayOf(0, 0, 0, 7, 7, 1, 65535, 65535))
        for (g in grids) {
            val rle = RealmKitRle.encode(g)
            assertFalse(rle.contains(Regex("[,A-Z\\s]")))
            val back = RealmKitRle.decode(rle, g.size, N * N)
            assertContentEquals(g, back); assertEquals(rle, RealmKitRle.encode(back))
        }
        assertEquals("0:3;7:2;1;1ekf:2", RealmKitRle.encode(intArrayOf(0, 0, 0, 7, 7, 1, 65535, 65535)))
        assertEquals("0:7es", RealmKitRle.encode(IntArray(N * N)))
        for (layer in fixture.get("manifest").get("ground").get("layers")) {
            val rle = layer.getString("rle")
            assertEquals(rle, RealmKitRle.encode(RealmKitRle.decode(rle, N * N, N * N)), layer.getString("id"))
        }
    }
    @Test fun `run-length decoder rejects malformed non-canonical or mis-sized input so a corrupt manifest fails admission`() {
        for ((rle, length) in listOf("0:3" to 2, "0:3" to 4, "0:2;" to 2, ";0:2" to 2, "0:2;;1" to 3, "1,2" to 2, "A" to 1, "01" to 1, "0:01" to 1,
            "1:1" to 1, "1;1" to 2, "1ekg" to 1, "zzzz" to 1, "a:" to 1, ":3" to 3, "0:0" to 0, "-1" to 1, "1.5" to 1, "1 " to 1,
            "" to 1, "0" to 0, "0:2" to -2, "0:7et" to N * N + 1, "zzzzzzzzzzzzzzzzzzzzzzzz" to 1, "1:zzzzzzzzzzzzzzzzzzzzzz" to 5)) {
            assertEquals("Invalid realm kit manifest", assertFailsWith<IllegalArgumentException>("$rle @ $length") { RealmKitRle.decode(rle, length, N * N) }.message)
        }
        assertContentEquals(IntArray(0), RealmKitRle.decode("", 0, N * N))
    }
    @Test fun `validator accepts the synthetic fixture including its optional shapes`() {
        // 31 cells (was 25): cobbles, dirt and the four ring-variant cells the fixture's reachable rings put on them (§2).
        assertEquals("crownlands", kit.realmId); assertEquals("preview-only", kit.status); assertEquals(31, kit.cells.size)
        // §2 ring variants parse keyed by base cell: the dirt yard under masks 3 (north run), 2 (NE corner) and 10 (east
        // run), the cobbles road under mask 12 (south run); every other mask 0 = the default ring cell.
        val dirt = List(16) { 0 }.toMutableList().also { it[3] = VARIANT_FIRST; it[2] = VARIANT_FIRST + 1; it[10] = VARIANT_FIRST + 2 }
        val road = List(16) { 0 }.toMutableList().also { it[12] = VARIANT_FIRST + 3 }
        assertEquals(mapOf(DIRT to dirt, COBBLES to road), kit.edgeVariants)
        assertEquals(setOf(ROAD_ROW), kit.edgeVariants.getValue(COBBLES).withIndex().filter { it.value != 0 }.map { it.index }.toSet())
        assertEquals(YARD_MASKS.toSet(), kit.edgeVariants.getValue(DIRT).withIndex().filter { it.value != 0 }.map { it.index }.toSet())
        // Additive: a kit baked before §2 (no `variants`) or one with an empty list still admits and draws the default ring.
        assertEquals(emptyMap(), manifest { it.edge().remove("variants") }.edgeVariants)
        assertEquals(emptyMap(), manifest { it.edge().replaceArray("variants", emptyList()) }.edgeVariants)
        assertEquals(listOf(RealmKitLayerId.WATER, RealmKitLayerId.BASE, RealmKitLayerId.OVERLAY), kit.layers.map { it.id })
        assertEquals(0x6f7a3a, kit.paddingColor); assertEquals(2, kit.overview?.pxPerTile); assertEquals("tiles", kit.tileset.id)
        // Rewritten for D-153 creature paths (was "layer ascending, then manifest order"): one painter's band by the anchor
        // row (stump −600, dead oak 200, frame oak 512, east oak 1500) — the web depth and the deed use the same key.
        assertEquals(listOf("stump-north", "oak-dead-west", "oak-frame-east", "oak-east"), kit.placements.map { it.id }, "draw band, then the anchor row, then manifest order")
        // E-6 amended: a prop may stand inside the protected frame (oak-frame-east sits on frame tile 30,15) and
        // anywhere the smallest kingdom's ring does not already hide it — here tile (7,6), one north of the ring's corner.
        manifest { it.placement(0).get("x").set(7L * 32 + 16, null); it.placement(0).get("y").set(7L * 32, null) }
        manifest { it.get("status").set("accepted") }
        manifest { it.get("ground").remove("overview") }
        manifest { it.get("placements").get(2).remove("frame"); it.get("placements").get(0).get("frame").set(2L, null) }
        // E-11 expansion obstacles: the builder's `prop` id and `footprint` are optional, validated shapes.
        val tagged = manifest { it.placement(0).addChild("prop", JsonValue("oak")); it.placement(0).addChild("footprint", reader.parse("[1,1]"))
            it.placement(1).addChild("prop", JsonValue("canopy-log")); it.placement(1).addChild("footprint", reader.parse("[${rules.footprintTiles},1]")) }
        assertEquals("oak" to (1 to 1), tagged.placements.first { it.id == "oak-east" }.let { it.prop to it.footprint })
        assertEquals("canopy-log" to (rules.footprintTiles to 1), tagged.placements.first { it.id == "stump-north" }.let { it.prop to it.footprint })
        assertEquals(null to null, kit.placements.first { it.id == "oak-east" }.let { it.prop to it.footprint })
    }
    private fun reject(rule: String, sizeBytes: Int = manifestBytes.size, mutate: (JsonValue) -> Unit) {
        val failure = runCatching { manifest(sizeBytes, mutate) }.exceptionOrNull()
        assertNotNull(failure, "accepted a manifest where $rule")
        assertTrue(failure is IllegalArgumentException || failure is IllegalStateException || failure is NullPointerException, "$rule: $failure")
    }
    private fun full(id: Int) = RealmKitRle.encode(IntArray(N * N) { id })
    private fun JsonValue.setRle(layer: Int, rle: String) { get("ground").get("layers").get(layer).get("rle").set(rle) }
    private fun JsonValue.cell(i: Int): JsonValue = get("ground").get("cells").get(i)
    private fun JsonValue.asset(i: Int): JsonValue = get("assets").get(i)
    private fun JsonValue.placement(i: Int): JsonValue = get("placements").get(i)
    private fun JsonValue.setDims(vararg keys: String, value: Long) { for (k in keys) get(k).set(value, null) }
    private fun copy(v: JsonValue): JsonValue = reader.parse(v.toJson(JsonWriter.OutputType.json))
    private fun JsonValue.replaceArray(name: String, items: List<JsonValue>) {
        remove(name); val array = JsonValue(JsonValue.ValueType.array); items.forEach { array.addChild(copy(it)) }; addChild(name, array)
    }
    private fun point(x: Long, y: Long) = reader.parse("""{"x":$x,"y":$y}""")
    /** The shared test's `grow`: a 2048×1024 tileset carrying 2048 cells, so caps counted in cells can be reached. */
    private fun grow(v: JsonValue) {
        v.asset(0).setDims("width", "frameWidth", value = 2048L); v.asset(0).setDims("height", "frameHeight", value = 1024L)
        v.get("ground").replaceArray("cells", (0 until 2048).map { i -> reader.parse("""{"asset":"tiles","x":${(i % 64) * 32},"y":${(i / 64) * 32}}""") })
    }
    private fun variantRows(n: Int): List<JsonValue> = (0 until n).map { i -> reader.parse("""{"cell":${i + 1},"cells":[${List(16) { 0 }.joinToString(",")}]}""") }
    @Test fun `validator rejects every rule of the shared mutation table so no client admits what another refuses`() {
        reject("schemaVersion is pinned to 3") { it.get("schemaVersion").set(2L, null) }
        reject("groundRevision is pinned to 5") { it.get("groundRevision").set(4L, null) }
        reject("realmId must be a known realm") { it.get("realmId").set("atlantis") }
        reject("status is preview-only or accepted") { it.get("status").set("draft") }
        reject("tilePixels is 32") { it.get("tilePixels").set(64L, null) }
        reject("field is pinned to the 98-tile world") { it.get("field").get("x").set(-1056L, null) }
        reject("protectedFrame is pinned to the 50×50 clearing") { it.get("protectedFrame").setDims("width", "height", value = 1472L) }
        reject("ground kind is tiles") { it.get("ground").get("kind").set("painting") }
        reject("paddingColor is #rrggbb") { it.get("ground").get("paddingColor").set("olive") }
        reject("a layer may only reference cell ids in the table") { it.setRle(1, full(99)) }
        reject("a layer grid is exactly 98×98 cells") { it.setRle(1, RealmKitRle.encode(IntArray(N * N - 1) { 1 })) }
        reject("a layer grid must decode") { it.setRle(1, "1,2") }
        reject("layer ids are unique") { it.get("ground").get("layers").get(0).get("id").set("base") }
        reject("layer ids come from the three draw layers") { it.get("ground").get("layers").get(2).get("id").set("shadow") }
        reject("the base layer is required") { it.get("ground").get("layers").remove(1) }
        reject("the base layer has no holes") { val g = IntArray(N * N) { 1 }; g[0] = 0; it.setRle(1, RealmKitRle.encode(g)) }
        reject("water never enters the 50×50 frame") { it.setRle(0, RealmKitRle.encode(grid { tx, ty -> if (tx == 0 && ty == 0) WATER else 0 })) }
        reject("water stays out of the meadow rings outside the frame") { it.setRle(0, RealmKitRle.encode(grid { tx, ty -> if (tx == -11 && ty == 15) WATER else 0 })) }
        reject("water stays out of the meadow rings on the far side too") { it.setRle(0, RealmKitRle.encode(grid { tx, ty -> if (tx == 20 && ty == 41) WATER else 0 })) }
        reject("baked non-empty tiles stay under the bake cap (LAYERED_GROUND_LIMITS_R5.bakedTiles, not the extent-wide floorTiles)") { it.setRle(2, full(FLOWER)) }
        reject("layers are listed in draw order") { val g = it.get("ground"); g.replaceArray("layers", g.get("layers").toList().reversed()) }
        reject("layers are listed in draw order even when only two are present") { val g = it.get("ground"); val l = g.get("layers").toList(); g.replaceArray("layers", listOf(l[1], l[0])) }
        reject("layer count is capped") { it.get("ground").replaceArray("layers", emptyList()) }
        reject("at least one cell exists") { it.get("ground").replaceArray("cells", emptyList()) }
        reject("cells sit on the 32-px grid") { it.cell(0).get("x").set(5L, null) }
        reject("every cell addresses the one tileset") { it.cell(3).get("asset").set("far") }
        reject("the tileset is a power-of-two single-frame sheet") { it.asset(0).setDims("width", "frameWidth", value = 320L) }
        reject("the tileset is not the far asset") { it.asset(1).setDims("width", "height", "frameWidth", "frameHeight", value = 256L); for (c in it.get("ground").get("cells")) c.get("asset").set("far") }
        reject("an animated cell needs frameDurationMs") { it.cell(WATER - 1).remove("frameDurationMs") }
        reject("frameDurationMs is 50..10000") { it.cell(WATER - 1).get("frameDurationMs").set(20L, null) }
        reject("frames is ≥1") { it.cell(WATER - 1).get("frames").set(0L, null) }
        reject("animated frames fit inside the tileset") { it.cell(WATER - 1).get("x").set(224L, null) }
        reject("a cell fits inside the tileset vertically") { it.cell(0).get("y").set(256L, null) }
        reject("edge.cells has exactly 16 corner-Wang entries") { val e = it.get("ground").get("state").get("edge"); e.get("cells").remove(15) }
        reject("edge.cells entries are cell ids") { it.get("ground").get("state").get("edge").get("cells").get(3).set(0L, null) }
        // §2 ring variants: a malformed row would draw garbage on the ring of one client and be refused by the other.
        reject("edge.variants, when given, is an array") { it.edge().remove("variants"); it.edge().addChild("variants", JsonValue(JsonValue.ValueType.`object`)) }
        reject("edge.variants null is malformed, not absent") { it.edge().remove("variants"); it.edge().addChild("variants", JsonValue(JsonValue.ValueType.nullValue)) }
        reject("edge.variants rows are objects") { it.edge().replaceArray("variants", listOf(JsonValue(7L))) }
        reject("edge.variants row cell is a cell id (not 0)") { it.variantRow(COBBLES).get("cell").set(0L, null) }
        reject("edge.variants row cell is a cell id (inside the table)") { v -> v.variantRow(COBBLES).get("cell").set(v.get("ground").get("cells").size + 1L, null) }
        reject("edge.variants row cell is an integer") { it.variantRow(COBBLES).get("cell").set(26.5, null) }
        reject("edge.variants rows are unique per base cell (two rows for one cell would race)") { v -> v.edge().replaceArray("variants", v.edge().get("variants").toList() + v.variantRow(COBBLES)) }
        reject("edge.variants row cells has exactly 16 masks (one short)") { it.variantRow(COBBLES).get("cells").remove(15) }
        reject("edge.variants row cells has exactly 16 masks (one over)") { it.variantRow(COBBLES).get("cells").addChild(JsonValue(0L)) }
        reject("edge.variants row cells is an array") { it.variantRow(COBBLES).remove("cells"); it.variantRow(COBBLES).addChild("cells", JsonValue("x".repeat(16))) }
        reject("edge.variants entries are 0 or a cell id (outside the table)") { v -> v.variantRow(COBBLES).get("cells").get(12).set(v.get("ground").get("cells").size + 1L, null) }
        reject("edge.variants entries are 0 or a cell id (negative)") { it.variantRow(DIRT).get("cells").get(3).set(-1L, null) }
        reject("edge.variants entries are integers") { it.variantRow(DIRT).get("cells").get(3).set(1.5, null) }
        reject("edge.variants row count is capped (LAYERED_GROUND_LIMITS_R5.edgeVariants)") { grow(it); it.edge().replaceArray("variants", variantRows(rules.edgeVariants + 1)) }
        reject("turf has at least one variant") { it.get("ground").get("state").replaceArray("turf", emptyList()) }
        reject("turf entries are cell ids") { it.get("ground").get("state").get("turf").get(0).set(999L, null) }
        reject("clearInside is true") { it.get("ground").get("state").get("clearInside").set(false) }
        reject("the far asset exists") { it.get("ground").get("far").get("asset").set("nope") }
        reject("the far asset is power-of-two") { it.asset(1).setDims("width", "frameWidth", value = 48L) }
        reject("the far period is at least one tile") { it.get("ground").get("far").get("period").get("width").set(16L, null) }
        reject("the far origin is finite") { it.get("ground").get("far").get("origin").get("x").set(Double.POSITIVE_INFINITY, null) }
        reject("the overview covers the field at pxPerTile") { it.asset(2).setDims("width", "frameWidth", value = 200L) }
        reject("the overview pxPerTile is 1..32") { it.get("ground").get("overview").get("pxPerTile").set(0L, null) }
        reject("the overview asset exists") { it.get("ground").get("overview").get("asset").set("nope") }
        // The count comes from the catalogue: the cap moved 24 → 32 for the creature sheets (D-153 creature paths).
        reject("asset count is capped (LAYERED_GROUND_LIMITS_R5.assets)") { v -> val rows = v.get("assets").toList().toMutableList(); for (i in 0 until rules.assets) {
            val sha = (0x20 + i).toString(16).repeat(32); val extra = copy(rows[5]); extra.get("id").set("extra-$i"); extra.get("sha256").set(sha)
            extra.get("path").set("atlas/fantasy/layered-ground/assets/$sha.png"); rows.add(extra) }; v.replaceArray("assets", rows) }
        reject("asset paths are hash-addressed under layered-ground/assets") { it.asset(0).get("path").set("../escape.png") }
        reject("asset sha256 is 64 hex") { it.asset(0).get("sha256").set("wrong") }
        reject("asset ids are unique") { it.asset(1).get("id").set("tiles") }
        reject("asset dimensions are capped") { it.asset(3).setDims("height", "frameHeight", value = 4096L) }
        reject("decoded RGBA stays within 16 MiB") { for (i in 0..1) it.asset(i).setDims("width", "height", "frameWidth", "frameHeight", value = 2048L) }
        reject("compressed bytes include the manifest itself") { it.asset(0).get("size").set(rules.compressedBytes - 500, null) }
        reject("the manifest JSON fits the 512 KiB download cap", sizeBytes = rules.manifestBytes + 1) {}
        manifest(sizeBytes = rules.manifestBytes) // exactly at the cap still admits
        reject("a frame grid must tile the sheet") { it.asset(3).get("frameCount").set(3L, null) }
        reject("reducedMotionFrame is 0") { it.asset(3).get("reducedMotionFrame").set(1L, null) }
        // E-6 amended: a prop may stand in the frame, but never where the smallest claim's ring already hides it.
        reject("placements are not seated inside the smallest kingdom or its ring") { it.placement(0).get("x").set(15L * 32 + 16, null); it.placement(0).get("y").set(16L * 32, null) }
        reject("placements on the smallest ring itself are hidden too") { it.placement(0).get("x").set(7L * 32 + 16, null); it.placement(0).get("y").set(23L * 32, null) }
        reject("placements stay inside the field") { it.placement(0).get("x").set(-2000L, null) }
        reject("placements cannot draw the tileset, far or overview sheets") { it.placement(1).get("asset").set("tiles") }
        reject("placement phaseFrame is 0 (the loop starts at frame, never an r4 phase)") { it.placement(0).get("phaseFrame").set(1L, null) }
        reject("placement frame is a cell of its sheet") { it.placement(2).get("frame").set(4L, null) }
        reject("placement frame is a non-negative integer") { it.placement(2).get("frame").set(-1L, null) }
        reject("placement frame is an integer") { it.placement(2).get("frame").set(1.5, null) }
        reject("placement clip is an object") { it.placement(0).remove("clip"); it.placement(0).addChild("clip", JsonValue(2L)) }
        reject("placement clip has at least two frames") { it.placement(0).get("clip").get("frames").set(1L, null) }
        reject("placement clip fits the sheet after its start cell") { it.placement(0).get("frame").set(3L, null) }
        reject("placement clip frameDurationMs is at least 50") { it.placement(0).get("clip").get("frameDurationMs").set(20L, null) }
        reject("placement clip frameDurationMs is at most 10000") { it.placement(0).get("clip").get("frameDurationMs").set(20000L, null) }
        reject("placement animated is true iff clip is present (animated without a clip)") { it.placement(2).get("animated").set(true) }
        reject("placement animated is true iff clip is present (clip without animated)") { it.placement(0).get("animated").set(false) }
        reject("placements stay non-interactive") { it.placement(0).get("interactive").set(true) }
        reject("placement ids are unique") { it.placement(1).get("id").set("oak-east") }
        reject("placement states name existing sprite assets") { it.placement(0).get("states").get("remnant").set("nope") }
        reject("placement states.intact is the placement asset") { it.placement(0).get("states").get("intact").set("oak-stump") }
        reject("placement prop, when given, is a kit id") { it.placement(0).addChild("prop", JsonValue("Oak Tree")) }
        reject("placement prop is a string") { it.placement(0).addChild("prop", JsonValue(7L)) }
        reject("placement footprint, when given, is a [w, h] pair") { it.placement(0).addChild("footprint", reader.parse("[1]")) }
        reject("placement footprint tiles are positive integers") { it.placement(0).addChild("footprint", reader.parse("[0,1]")) }
        reject("placement footprint tiles are integers") { it.placement(0).addChild("footprint", reader.parse("[1.5,1]")) }
        reject("placement footprint tiles are capped (LAYERED_GROUND_LIMITS_R5.footprintTiles)") { it.placement(0).addChild("footprint", reader.parse("[1,${rules.footprintTiles + 1}]")) }
        reject("placement count is capped") { v -> val rows = v.get("placements").toList().toMutableList(); for (i in 0 until rules.placements) {
            val extra = copy(rows[1]); extra.get("id").set("s-$i"); extra.get("x").set(400L + i % 1000, null); rows.add(extra) }; v.replaceArray("placements", rows) }
        reject("obstacleSprites keys are the eight server sprite keys") { it.get("obstacleSprites").addChild("dragon", reader.parse("""{"intact":"oak","remnant":"oak-stump"}""")) }
        reject("obstacleSprites values are existing sprite assets") { it.get("obstacleSprites").get("stump").get("intact").set("tiles") }
        reject("obstacleSprites clearing, when given, is a sprite asset") { it.get("obstacleSprites").get("stump").addChild("clearing", JsonValue("far")) }
        reject("path vertices stay outside the frame (sprite bounds included)") { it.get("paths").get(0).replaceArray("points", listOf(point(1400, -900), point(1287, 500), point(1900, 1900))) }
        reject("path vertices stay outside the frame") { it.get("paths").get(0).replaceArray("points", listOf(point(1400, -900), point(500, 500), point(1900, 1900))) }
        reject("path segments cannot cross the frame between two outside vertices") { it.get("paths").get(0).replaceArray("points", listOf(point(-900, 500), point(1900, 500))) }
        reject("path segments cannot cut a frame corner diagonally") { it.get("paths").get(0).replaceArray("points", listOf(point(1200, 1350), point(1350, 1200))) }
        reject("path vertices stay inside the field") { it.get("paths").get(0).replaceArray("points", listOf(point(1400, -900), point(1900, -600), point(2045, 1900))) }
        reject("a path needs at least two vertices") { it.get("paths").get(0).replaceArray("points", listOf(point(1400, -900))) }
        reject("path vertex count is capped") { it.get("paths").get(0).replaceArray("points", (0 until 65).map { k -> point(1400L + k, -900) }) }
        reject("path speed is 1..4096 art px/s") { it.get("paths").get(0).get("speed").set(0L, null) }
        reject("path assets are sprite assets") { it.get("paths").get(0).get("asset").set("overview") }
        reject("path ids are unique") { v -> v.replaceArray("paths", listOf(v.get("paths").get(0), v.get("paths").get(0))) }
        reject("path count is capped (LAYERED_GROUND_LIMITS_R5.paths, raised to 96 for the roaming creatures)") { v -> v.replaceArray("paths", (0..rules.paths).map { i -> copy(v.get("paths").get(0)).also { it.get("id").set("p-$i") } }) }
        // D-153 creature paths: a facing row that does not tile the sheet would draw another facing's cells on one client.
        // The gull sheet has 3 cells, so `directions: 3, frames: 1` tiles it exactly: only the [1, 2, 4] membership rule can
        // reject it (on the hare, 3 × 2 ≠ 8 tripped the tiling rule first and hid a dropped membership check; facingRow(3, …)
        // answers row 0 for every facing, so such a creature would walk every side with its down-facing cycle).
        assertEquals(3, kit.assets.getValue(kit.paths[0].asset).frameCount, "the mutation below must pass the tiling rule")
        reject("path directions is 1, 2 or 4") { it.get("paths").get(0).addChild("directions", JsonValue(3L)); it.get("paths").get(0).addChild("frames", JsonValue(1L)) }
        reject("path directions × frames tiles the sheet exactly (frames too many)") { it.get("paths").get(1).get("frames").set(3L, null) }
        reject("path directions × frames tiles the sheet exactly (directions too few for the frames given)") { it.get("paths").get(1).get("directions").set(2L, null) }
        reject("path directions × frames tiles the sheet exactly (default frames must divide the sheet)") { it.get("paths").get(0).addChild("directions", JsonValue(2L)) }
        reject("path frames is a positive integer") { it.get("paths").get(1).get("frames").set(0L, null) }
        reject("path frameDurationMs is at least 50") { it.get("paths").get(1).get("frameDurationMs").set(20L, null) }
        reject("path frameDurationMs is at most 10000") { it.get("paths").get(1).get("frameDurationMs").set(10001L, null) }
        reject("path dwellMs is a non-negative integer") { it.get("paths").get(1).get("dwellMs").set(-1L, null) }
        reject("path dwellMs is at most 60000") { it.get("paths").get(1).get("dwellMs").set(60001L, null) }
        reject("path dwellMs is an integer") { it.get("paths").get(1).get("dwellMs").set(0.5, null) }
        reject("path loop is cycle or pingpong") { it.get("paths").get(1).get("loop").set("bounce") }
        reject("path layer is a ground-band layer 0..15") { it.get("paths").get(0).get("layer").set(16L, null) }
        reject("creature path vertices stay outside the frame (sprite bounds included)") { it.get("paths").get(1).get("points").get(1).let { pt -> pt.get("x").set(1287L, null); pt.get("y").set(500L, null) } }
        // A path may hug the frame and cut past a corner without entering (authored routes are not rejected for touching).
        manifest { it.get("paths").get(0).replaceArray("points", listOf(point(-900, -400), point(1900, -400), point(1900, 1300), point(1500, 1900))) }
    }
    @Test fun `admits exactly edgeVariants rows and refuses one more so the cap is the row count and nothing else`() {
        val atCap = manifest { grow(it); it.edge().replaceArray("variants", variantRows(rules.edgeVariants)) }
        assertEquals(rules.edgeVariants, atCap.edgeVariants.size); assertEquals((1..rules.edgeVariants).toList(), atCap.edgeVariants.keys.toList(), "rows keep their order and their cells")
        reject("one row over the cap") { grow(it); it.edge().replaceArray("variants", variantRows(rules.edgeVariants + 1)) }
    }
    @Test fun `ring variants draw the baked cell's own ring cell over the road and the yard and the default ring everywhere else`() {
        // §2 (K-131 road end): the road used to stop in the meadow because every ring tile drew the turf↔meadow family
        // whatever lay under it; now a ring tile over a cell the builder gave a row takes that cell's composite for the
        // mask. A mirror that ignores the rows answers 17 (EDGE_FIRST + 12) at (14,22) and fails here.
        val road = kit.edgeVariants.getValue(COBBLES); val dirt = kit.edgeVariants.getValue(DIRT)
        fun d(mask: Int) = kit.edgeCells[mask]
        val c14 = claim(14); val B = RealmKitLayerId.BASE
        // Claim 14 [8,22): its south ring (row 22, mask 12) crosses the road at 14 and 15; either side is meadow → default.
        assertEquals(road[12], kit.cell(c14, B, 14, 22)); assertEquals(road[12], kit.cell(c14, B, 15, 22))
        assertEquals(VARIANT_FIRST + 3, road[12]); assertNotEquals(d(12), road[12])
        assertEquals(d(12), kit.cell(c14, B, 13, 22)); assertEquals(d(12), kit.cell(c14, B, 16, 22)); assertEquals(EDGE_FIRST + 12, d(12))
        // Its north ring (row 7, mask 3), north-east corner (22,7 → mask 2) and east ring (22,8 → mask 10) cross the yard.
        assertEquals(dirt[3], kit.cell(c14, B, 20, 7)); assertEquals(dirt[3], kit.cell(c14, B, 21, 7))
        assertEquals(dirt[2], kit.cell(c14, B, 22, 7)); assertEquals(dirt[10], kit.cell(c14, B, 22, 8))
        assertEquals(d(3), kit.cell(c14, B, 19, 7)); assertEquals(d(10), kit.cell(c14, B, 22, 9)); assertEquals(d(1), kit.cell(c14, B, 7, 7))
        assertEquals(4, setOf(road[12], dirt[3], dirt[2], dirt[10]).size)
        // Every claim's south ring meets the road: 26 at row 28, 50 at row 40 (the first exterior ring, no longer pure meadow).
        assertEquals(road[12], kit.cell(claim(26), B, 15, 28)); assertEquals(road[12], kit.cell(claim(50), B, 14, 40))
        assertEquals(d(12), kit.cell(claim(26), B, 16, 28)); assertEquals(d(12), kit.cell(claim(50), B, 13, 40))
        // The same tiles off the ring resolve the baked cell: turf inside the claim (the claim overwrites ground-level
        // terrain), cobbles outside it and on through the edge clamp, dirt north of the yard's ring — a variant cell only ever sits on a ring tile.
        assertTrue(kit.cell(c14, B, 15, 21) in kit.turf); assertTrue(kit.cell(c14, B, 14, 20) in kit.turf)
        val E = rules.edgeExtendTiles
        for (ty in listOf(23, 63, 64, 63 + E)) assertEquals(COBBLES, kit.cell(c14, B, 15, ty), "15,$ty")
        assertEquals(COBBLES, kit.cell(claim(50), B, 15, 41)); assertEquals(DIRT, kit.cell(c14, B, 22, 6))
        // A 0 entry means "no variant for this mask": the default draws, whatever the baked cell.
        val zeroed = manifest { it.variantRow(COBBLES).get("cells").get(12).set(0L, null) }
        assertEquals(d(12), zeroed.cell(c14, B, 15, 22))
        // No rows at all (a kit baked before §2) or an empty list: the default ring everywhere, as before.
        val bare = manifest { it.edge().remove("variants") }
        assertEquals(d(12), bare.cell(c14, B, 15, 22)); assertEquals(d(2), bare.cell(c14, B, 22, 7))
        assertEquals(d(12), manifest { it.edge().replaceArray("variants", emptyList()) }.cell(c14, B, 15, 22))
        // Every centred claim from the smallest to the whole frame (a superset of the reachable rings): a variant cell never
        // leaves the ring, a ring tile over cobbles or dirt carries its row's cell, every other ring tile the default, and
        // water and overlay stay 0 on the ring.
        val centre = rules.plotTiles / 2
        for (tiles in rules.claimTiles..(rules.frameMaxTile - rules.frameMinTile) step 2) {
            val c = RealmKitClaim(centre - tiles / 2, centre - tiles / 2 + tiles)
            for (ty in -12 until 42) for (tx in -12 until 42) {
                val cell = kit.cell(c, B, tx, ty); val state = kit.tileState(c, tx, ty)
                if (cell >= VARIANT_FIRST) assertEquals(RealmKitTileState.EDGE, state, "${c.min}..${c.max} @ $tx,$ty")
                if (state != RealmKitTileState.EDGE) continue
                val row = if (cobblesAt(tx, ty)) road else if (dirtAt(tx, ty)) dirt else null; val mask = RealmKitManifest.edgeMask(c, tx, ty)
                assertEquals(row?.get(mask) ?: d(mask), cell, "${c.min}..${c.max} @ $tx,$ty")
                if (row != null) assertTrue(cell >= VARIANT_FIRST, "${c.min}..${c.max} @ $tx,$ty")
                assertEquals(0, kit.cell(c, RealmKitLayerId.WATER, tx, ty)); assertEquals(0, kit.cell(c, RealmKitLayerId.OVERLAY, tx, ty))
            }
        }
        // A decal baked onto a ring tile over the road stays cleared: only the base layer draws the ring. Water cannot be
        // baked there at all — admission keeps the frame and its two wild rings dry — so its 0 on the ring is the
        // validator's, not the cell rule's (the shared test bypasses its validator to pin both; this mirror cannot).
        val decal = manifest { it.setRle(2, RealmKitRle.encode(grid { tx, ty -> if (tx == 15 && ty in 22..23) FLOWER else 0 })) }
        assertEquals(0, decal.cell(c14, RealmKitLayerId.OVERLAY, 15, 22)); assertEquals(road[12], decal.cell(c14, B, 15, 22))
        assertEquals(FLOWER, decal.cell(c14, RealmKitLayerId.OVERLAY, 15, 23), "the same decal draws one tile south, off the ring")
        assertEquals(listOf(B to road[12]), decal.floorPlan(32.0, LayeredGroundRect(15 * 32.0, 22 * 32.0, 32.0, 32.0), c14, 0, true).tiles.map { it.layer to it.cell })
        reject("water on a ring tile inside the frame is refused at admission") { it.setRle(0, RealmKitRle.encode(grid { tx, ty -> if (tx == 15 && ty == 22) WATER else 0 })) }
        // The floor plan and the chunk batch take the same cell as `cell` (one rule, every surface): the crossing is two
        // variant quads in chunk (7,7), which covers tiles [14,30)² from the extent origin.
        assertEquals(listOf(road[12], road[12]), kit.floorPlan(32.0, LayeredGroundRect(14 * 32.0, 22 * 32.0, 64.0, 32.0), c14, 0, true).tiles.filter { it.layer == B }.map { it.cell })
        val T = 64.0; val chunk = RealmKitChunkCache(kit, T).vertices(7, 7, c14, 0, true)
        assertEquals(14, chunk.tx0); assertEquals(14, chunk.ty0)
        val crossing = (0 until chunk.quads).map { q -> q * 20 }.filter { o -> chunk.vertices[o + 1] == (22 * T).toFloat() && chunk.vertices[o] in (14 * T).toFloat()..(15 * T).toFloat() }
        assertEquals(2, crossing.size)
        val source = kit.cellSource(road[12], 0)
        for (o in crossing) { assertEquals((source.x / kit.tileset.width).toFloat(), chunk.vertices[o + 3]); assertEquals((source.y / kit.tileset.height).toFloat(), chunk.vertices[o + 4]) }
    }
    @Test fun `tile state edge masks and the tile hash match the shared pins so raids deeds and both clients agree`() {
        val c = RealmKitClaim(10, 14)
        for (t in 10..13) { assertEquals(3, RealmKitManifest.edgeMask(c, t, 9)); assertEquals(12, RealmKitManifest.edgeMask(c, t, 14)); assertEquals(5, RealmKitManifest.edgeMask(c, 9, t)); assertEquals(10, RealmKitManifest.edgeMask(c, 14, t)) }
        assertEquals(listOf(1, 2, 4, 8), listOf(RealmKitManifest.edgeMask(c, 9, 9), RealmKitManifest.edgeMask(c, 14, 9), RealmKitManifest.edgeMask(c, 9, 14), RealmKitManifest.edgeMask(c, 14, 14)))
        val reached = mutableSetOf<Int>()
        for (ty in 5..18) for (tx in 5..18) {
            val inside = tx in 10..13 && ty in 10..13; val state = kit.tileState(c, tx, ty)
            assertEquals(inside, state == RealmKitTileState.KINGDOM, "$tx,$ty")
            assertEquals(!inside && tx in 9..14 && ty in 9..14, state == RealmKitTileState.EDGE, "$tx,$ty")
            if (state == RealmKitTileState.EDGE) reached += RealmKitManifest.edgeMask(c, tx, ty)
            if (inside) assertEquals(15, RealmKitManifest.edgeMask(c, tx, ty))
        }
        assertEquals(setOf(1, 2, 3, 4, 5, 8, 10, 12), reached)
        assertEquals(EDGE_FIRST + 1, kit.cell(c, RealmKitLayerId.BASE, 9, 9)); assertEquals(EDGE_FIRST + 12, kit.cell(c, RealmKitLayerId.BASE, 11, 14))
        assertEquals(0, kit.cell(c, RealmKitLayerId.OVERLAY, 9, 9)); assertEquals(0, kit.cell(c, RealmKitLayerId.WATER, 9, 9))
        for ((tx, ty, pinned) in listOf(Triple(0, 0, 851924796L), Triple(-34, -34, 4209988391L), Triple(63, 63, 2185463103L), Triple(15, 15, 1044870719L), Triple(-10, 40, 2091324121L), Triple(1, -1, 2225299044L)))
            assertEquals(pinned, RealmKitManifest.tileHash(tx, ty), "$tx,$ty")
        val full = claim(50); val seen = mutableSetOf<Int>()
        for (ty in -10 until 40) for (tx in -10 until 40) {
            val cell = kit.cell(full, RealmKitLayerId.BASE, tx, ty); assertTrue(cell in kit.turf); seen += cell
            if (tx in 8..21 && ty in 8..21) assertEquals(cell, kit.cell(claim(14), RealmKitLayerId.BASE, tx, ty), "buying an expansion never reshuffles turf")
            assertEquals(0, kit.cell(full, RealmKitLayerId.OVERLAY, tx, ty)); assertEquals(0, kit.cell(full, RealmKitLayerId.WATER, tx, ty))
        }
        assertEquals(setOf(TURF, TURF_ALT), seen)
        for (ty in -34 until 64) for (tx in -34 until 64) {
            val s = kit.tileState(full, tx, ty)
            assertEquals(when { tx in -10..39 && ty in -10..39 -> RealmKitTileState.KINGDOM; tx in -11..40 && ty in -11..40 -> RealmKitTileState.EDGE; else -> RealmKitTileState.EXTERIOR }, s, "$tx,$ty")
        }
        val c14 = claim(14)
        assertEquals(MEADOW, kit.cell(c14, RealmKitLayerId.BASE, 0, 0)); assertEquals(MEADOW_ALT, kit.cell(c14, RealmKitLayerId.BASE, 1, 0))
        assertEquals(FOREST, kit.cell(c14, RealmKitLayerId.BASE, -34, -34)); assertEquals(FOREST, kit.cell(c14, RealmKitLayerId.BASE, 63, 63))
        assertEquals(WATER, kit.cell(c14, RealmKitLayerId.WATER, 55, 55)); assertEquals(BED, kit.cell(c14, RealmKitLayerId.BASE, 55, 55))
        assertEquals(ROAD, kit.cell(c14, RealmKitLayerId.OVERLAY, 20, 45))
        // Edge clamp (REALM_KIT.edgeExtendTiles, owner: "waters are cut off … fill that till the end"): within the margin a tile
        // carries the nearest field tile's water and base cell and never a decal; beyond the extent everything is 0 (far repeat).
        val E = rules.edgeExtendTiles
        for (ty in listOf(-34, 10, 45, 63)) {
            for (id in listOf(RealmKitLayerId.WATER, RealmKitLayerId.BASE)) {
                assertEquals(kit.cell(c14, id, 63, ty), kit.cell(c14, id, 64, ty), "$id 64,$ty clamps to 63,$ty")
                assertEquals(kit.cell(c14, id, O, ty), kit.cell(c14, id, O - 1, ty), "$id ${O - 1},$ty clamps to $O,$ty")
                assertEquals(kit.cell(c14, id, 63, ty), kit.cell(c14, id, 63 + E, ty), "$id the last margin tile still clamps")
            }
            assertEquals(0, kit.cell(c14, RealmKitLayerId.OVERLAY, 64, ty)); assertEquals(0, kit.cell(c14, RealmKitLayerId.OVERLAY, O - 1, ty))
            for (id in RealmKitLayerId.entries) { assertEquals(0, kit.cell(c14, id, O - E - 1, ty), "$id beyond the extent"); assertEquals(0, kit.cell(c14, id, 64 + E, ty)) }
        }
        assertEquals(FOREST, kit.cell(c14, RealmKitLayerId.BASE, 64, 10)); assertEquals(FOREST, kit.cell(c14, RealmKitLayerId.BASE, O - E, O - E))
        assertEquals(ROAD, kit.cell(c14, RealmKitLayerId.OVERLAY, 63, 45)); assertEquals(0, kit.cell(c14, RealmKitLayerId.OVERLAY, 64, 45), "the road does not repeat outward")
        for ((tx, ty) in listOf(-35 - E to 0, 0 to -35 - E, 64 + E to 0, 0 to 64 + E, 1000 to 1000)) for (id in RealmKitLayerId.entries) assertEquals(0, kit.cell(c14, id, tx, ty))
        // A river reaching the field's east edge runs on through the whole margin: the water layer clamps like the base.
        val river = manifest { it.setRle(0, RealmKitRle.encode(grid { tx, _ -> if (tx >= 50) WATER else 0 })) }
        assertEquals(WATER, river.cell(c14, RealmKitLayerId.WATER, 63, 10)); assertEquals(WATER, river.cell(c14, RealmKitLayerId.WATER, 64, 10))
        assertEquals(WATER, river.cell(c14, RealmKitLayerId.WATER, 63 + E, 10)); assertEquals(0, river.cell(c14, RealmKitLayerId.WATER, 64 + E, 10))
        assertEquals(0, river.cell(c14, RealmKitLayerId.WATER, O - 1, 10), "the west edge clamps to a dry field tile")
        for (bad in listOf(RealmKitClaim(-11, 4), RealmKitClaim(0, 41), RealmKitClaim(5, 5), RealmKitClaim(6, 5), RealmKitClaim(40, 41)))
            assertFailsWith<IllegalArgumentException> { kit.cell(bad, RealmKitLayerId.BASE, 0, 0) }
        assertEquals(LayeredGroundRect(96.0, 96.0, 32.0, 32.0), kit.cellSource(WATER, 3))
        assertFailsWith<IllegalArgumentException> { kit.cellSource(WATER, 4) }; assertFailsWith<IllegalArgumentException> { kit.cellSource(0, 0) }
    }
    @Test fun `every parity probe resolves to the cell ids the shared function returned`() {
        val probes = fixture.get("probes").toList()
        assertTrue(probes.size >= 500); assertEquals(3, probes.map { it.get("claim").getInt("min") }.toSet().size)
        for (p in probes) {
            val c = RealmKitClaim(p.get("claim").getInt("min"), p.get("claim").getInt("max")); val tx = p.getInt("tx"); val ty = p.getInt("ty")
            for (id in RealmKitLayerId.entries) assertEquals(p.get("cells").getInt(id.id), kit.cell(c, id, tx, ty), "${c.min}..${c.max} @ $tx,$ty ${id.id}")
        }
        assertTrue(probes.any { it.get("cells").getInt("water") == WATER })
        assertTrue(probes.any { it.get("cells").getInt("base") in EDGE_FIRST until EDGE_FIRST + 16 })
        // §2 ring variants: the road crossing is probed under every claim (a regenerated fixture without the rows would
        // silently stop pinning the mirror's variant lookup), and the default ring is probed either side of it.
        for (min in probes.map { it.get("claim").getInt("min") }.toSet()) {
            val max = probes.first { it.get("claim").getInt("min") == min }.get("claim").getInt("max")
            for (tx in 14..15) assertTrue(probes.any { it.get("claim").getInt("min") == min && it.getInt("tx") == tx && it.getInt("ty") == max && it.get("cells").getInt("base") == kit.edgeVariants.getValue(COBBLES)[ROAD_ROW] }, "$min..$max road @ $tx,$max")
            for (tx in listOf(13, 16)) assertTrue(probes.any { it.get("claim").getInt("min") == min && it.getInt("tx") == tx && it.getInt("ty") == max && it.get("cells").getInt("base") == EDGE_FIRST + ROAD_ROW }, "$min..$max default @ $tx,$max")
        }
        for (p in probes) if (kit.tileState(RealmKitClaim(p.get("claim").getInt("min"), p.get("claim").getInt("max")), p.getInt("tx"), p.getInt("ty")) != RealmKitTileState.EDGE)
            assertTrue(p.get("cells").getInt("base") < VARIANT_FIRST, "off the ring no probe carries a variant cell")
        // The lattice steps one tile before and one past the field on both axes, and to the last margin tile and the first
        // tile past the extent: within the margin a probe carries the NEAREST field tile's water/base cell (clamped on both
        // sides) and no overlay, past the extent every layer is 0 — so the mirror's clamps and cut-off are pinned by data,
        // not assumed. The fixture's river arms reach the field edge, so the water clamp is pinned against WATER, not 0 == 0.
        val E = rules.edgeExtendTiles; val extentEnd = O + N + E
        val outside = probes.filter { it.getInt("tx") < O || it.getInt("ty") < O || it.getInt("tx") >= O + N || it.getInt("ty") >= O + N }
        val beyond = outside.filter { it.getInt("tx") < extentEnd && it.getInt("ty") < extentEnd }
        val cut = outside.filter { it.getInt("tx") >= extentEnd || it.getInt("ty") >= extentEnd }
        for (t in listOf(O - 1, O + N, extentEnd - 1)) { assertTrue(beyond.any { it.getInt("tx") == t }, "tx $t"); assertTrue(beyond.any { it.getInt("ty") == t }, "ty $t") }
        assertTrue(cut.any { it.getInt("tx") == extentEnd }); assertTrue(cut.any { it.getInt("ty") == extentEnd })
        for (p in beyond) {
            val c = RealmKitClaim(p.get("claim").getInt("min"), p.get("claim").getInt("max"))
            val ftx = p.getInt("tx").coerceIn(O, O + N - 1); val fty = p.getInt("ty").coerceIn(O, O + N - 1)
            assertEquals(kit.cell(c, RealmKitLayerId.WATER, ftx, fty), p.get("cells").getInt("water")); assertEquals(kit.cell(c, RealmKitLayerId.BASE, ftx, fty), p.get("cells").getInt("base"))
            assertEquals(0, p.get("cells").getInt("overlay"))
        }
        assertTrue(beyond.all { it.get("cells").getInt("base") != 0 }, "every margin probe resolves to a baked base cell")
        assertTrue(beyond.any { it.getInt("tx") == O + N && it.get("cells").getInt("water") == WATER }, "a river leaving the field's east edge runs on")
        assertTrue(beyond.any { it.getInt("ty") == extentEnd - 1 && it.get("cells").getInt("water") == WATER }, "…to the last margin tile")
        assertTrue(beyond.any { it.getInt("tx") == O - 1 && it.get("cells").getInt("base") == FOREST }, "the west clamp reaches the field's forest edge")
        for (p in cut) for (id in RealmKitLayerId.entries) assertEquals(0, p.get("cells").getInt(id.id), "past the extent @ ${p.getInt("tx")},${p.getInt("ty")} ${id.id}")
    }
    @Test fun `floor plan lists every intersecting tile layer-major then row-major with frame 0 under reduced motion`() {
        val T = 64.0; val c = claim(14); val view = LayeredGroundRect(3000.0, 3000.0, 1000.0, 700.0)
        val plan = kit.floorPlan(T, view, c, 260, false)
        assertEquals("floor-far", plan.far.id); assertEquals(view, plan.far.destination); assertNotNull(plan.far.repeat)
        val seen = mutableSetOf<String>()
        for (t in plan.tiles) {
            assertTrue(t.destination.intersects(view)); assertTrue(seen.add("${t.layer}:${t.tx}:${t.ty}"))
            assertEquals(kit.cell(c, t.layer, t.tx, t.ty), t.cell); assertEquals(LayeredGroundRect(t.tx * T, t.ty * T, T, T), t.destination)
            assertEquals(if (t.cell == WATER) 1 else 0, t.frame)
        }
        var expected = 0
        val E = rules.edgeExtendTiles // the plan covers the edge-clamped margin as well as the field
        for (id in RealmKitLayerId.entries) for (ty in O - E until O + N + E) for (tx in O - E until O + N + E)
            if (LayeredGroundRect(tx * T, ty * T, T, T).intersects(view) && kit.cell(c, id, tx, ty) != 0) { expected++; assertTrue("$id:$tx:$ty" in seen) }
        assertEquals(expected, plan.tiles.size)
        // A view across the field's east edge lists the margin's clamped base tiles (never an overlay) up to the extent, then nothing.
        val margin = kit.floorPlan(T, LayeredGroundRect(63 * T, 10 * T, (E + 4) * T, 2 * T), c, 0, false).tiles
        assertEquals((E + 1) * 2, margin.count { it.layer == RealmKitLayerId.BASE }, "tiles 63..63+E on two rows")
        assertTrue(margin.none { it.layer == RealmKitLayerId.OVERLAY && it.tx >= 64 }); assertTrue(margin.none { it.tx > 63 + E })
        for (t in margin.filter { it.tx >= 64 }) assertEquals(kit.cell(c, t.layer, 63, t.ty), t.cell)
        for (i in 1 until plan.tiles.size) {
            val a = plan.tiles[i - 1]; val b = plan.tiles[i]
            assertTrue(a.layer.ordinal < b.layer.ordinal || (a.layer == b.layer && (a.ty < b.ty || (a.ty == b.ty && a.tx < b.tx))))
        }
        assertTrue(plan.tiles.any { it.layer == RealmKitLayerId.WATER })
        assertEquals(0, kit.floorPlan(T, view, c, 260, true).tiles.first { it.layer == RealmKitLayerId.WATER }.frame)
        assertEquals(3, kit.floorPlan(T, view, c, 999, false).tiles.first { it.layer == RealmKitLayerId.WATER }.frame)
        assertEquals(0, kit.floorPlan(T, view, c, 1000, false).tiles.first { it.layer == RealmKitLayerId.WATER }.frame)
        assertEquals(listOf("floor-far"), listOf(kit.floorPlan(T, LayeredGroundRect(100000.0, 100000.0, 10.0, 10.0), c, 0, false)).map { it.far.id })
        assertTrue(kit.floorPlan(T, LayeredGroundRect(100000.0, 100000.0, 10.0, 10.0), c, 0, false).tiles.isEmpty())
        assertFailsWith<IllegalArgumentException> { kit.floorPlan(T, view.copy(x = Double.NaN), c, 0, false) }
        assertFailsWith<IllegalArgumentException> { kit.floorPlan(T, view, c, -1, false) }
        // Rewritten for §2 ring variants (was "edgeCells[mask] on every ring tile"): where the ring crosses the road or the
        // yard it draws the baked cell's own variant for the mask, so the road meets the land through turf-road instead of
        // stopping in the meadow (K-131 road end); the default ring stays everywhere else.
        val ring = kit.floorPlan(T, LayeredGroundRect(-400.0, -400.0, 2400.0, 2400.0), c, 0, false).tiles
        var variants = 0
        for (t in ring) when (kit.tileState(c, t.tx, t.ty)) {
            RealmKitTileState.KINGDOM -> { assertEquals(RealmKitLayerId.BASE, t.layer); assertTrue(t.cell in kit.turf) }
            RealmKitTileState.EDGE -> {
                assertEquals(RealmKitLayerId.BASE, t.layer)
                val mask = RealmKitManifest.edgeMask(c, t.tx, t.ty); val row = kit.edgeVariants[if (cobblesAt(t.tx, t.ty)) COBBLES else if (dirtAt(t.tx, t.ty)) DIRT else 0]
                assertEquals(row?.get(mask)?.takeIf { it != 0 } ?: kit.edgeCells[mask], t.cell, "${t.tx},${t.ty}")
                if (row != null) { assertTrue(t.cell >= VARIANT_FIRST); variants++ }
            }
            else -> {}
        }
        assertEquals(2 + 4, variants, "the two road tiles on the south ring, the yard's two north, one corner and one east tile")
    }
    @Test fun `props draw the still at frame a clip at frame plus elapsed over duration and stay pinned under reduced motion or background`() {
        val T = 64.0; val all = LayeredGroundRect(-3000.0, -3000.0, 9000.0, 9000.0); val c = claim(14)
        val plan = kit.propPlan(T, all, c, 0, false)
        // D-153 creature paths: one painter's band by the anchor row (see the validator test), the east oak last.
        assertEquals(listOf("stump-north", "oak-dead-west", "oak-frame-east", "oak-east"), plan.map { it.id })
        val oak = plan[3]
        assertEquals(LayeredGroundRect((1500 - 16) * 2.0, (1500 - 48) * 2.0, 64.0, 96.0), oak.destination, "bottom-centre seat, scaled to renderer tiles")
        assertEquals(LayeredGroundRect(0.0, 0.0, 32.0, 48.0), oak.source); assertEquals(0, oak.frame)
        assertEquals(1, kit.propPlan(T, all, c, 100, false)[3].frame); assertEquals(0, kit.propPlan(T, all, c, 200, false)[3].frame)
        assertEquals(LayeredGroundRect(32.0, 0.0, 32.0, 48.0), kit.propPlan(T, all, c, 100, false)[3].source)
        assertEquals(0, kit.propPlan(T, all, c, 150, true)[3].frame); assertEquals(0, kit.propPlan(T, all, c, 150, false, background = true)[3].frame)
        assertEquals(2, plan[1].frame); assertEquals(LayeredGroundRect(0.0, 48.0, 32.0, 48.0), plan[1].source, "a still names its sheet cell")
        assertEquals(listOf("oak-east"), kit.propPlan(T, LayeredGroundRect(2900.0, 2900.0, 100.0, 100.0), c, 0, false).map { it.id }, "culled to the scaled bounds")
        assertEquals(3, kit.placementFrame(kit.placements[3].copy(frame = 2), 100, false)); assertEquals(2, kit.placementFrame(kit.placements[3].copy(frame = 2), 100, true))
        assertFailsWith<IllegalArgumentException> { kit.propPlan(T, all, c, -1, false) }
        assertFailsWith<IllegalArgumentException> { kit.propPlan(T, all, RealmKitClaim(5, 5), 0, false) }
        // E-6 amended: the frame-seated oak (tile 30,15) shows under claims whose ring stops short of tile 30 and vanishes once it is owned or ringed.
        val framed = kit.placements[2]; assertEquals("oak-frame-east", framed.id)
        assertEquals(RealmKitSeat(30, 15), kit.placementSeat(framed))
        assertEquals(RealmKitSeat(32, 16), kit.placementSeat(framed.copy(x = 31.0 * 32 + 32, y = 17.0 * 32)), "2×2 footprint → right column, last row")
        assertTrue(kit.placementHidden(framed, RealmKitClaim(14, 30)), "the ring reaches tile 30"); assertFalse(kit.placementHidden(framed, RealmKitClaim(14, 29)), "ring ends at 29")
        assertTrue("oak-frame-east" in kit.propPlan(T, all, claim(26), 0, false).map { it.id })
        assertFalse("oak-frame-east" in kit.propPlan(T, all, claim(30), 0, false).map { it.id })
        assertEquals(listOf("stump-north", "oak-dead-west", "oak-east"), kit.propPlan(T, all, claim(50), 0, false).map { it.id })
        assertEquals(LayeredGroundRect(16.0, 0.0, 16.0, 16.0), RealmKitManifest.spriteSource(kit.asset("gull"), 1))
        assertFailsWith<IllegalArgumentException> { RealmKitManifest.spriteSource(kit.asset("gull"), 3) }
        // The band is one painter's order: a low prop seated south of a tall one draws over it, a tie keeps manifest
        // order, and only the air layer lifts a prop over the band — the same stacking the web depth and the deed use.
        val south = manifest { it.placement(1).get("y").set(1600L, null); it.placement(1).get("x").set(1500L, null) } // the stump one row south of the oak
        assertEquals(listOf("oak-dead-west", "oak-frame-east", "oak-east", "stump-north"), south.propPlan(T, all, c, 0, false).map { it.id })
        val tied = manifest { it.placement(1).get("y").set(1500L, null); it.placement(1).get("x").set(1500L, null) }
        assertEquals(listOf("oak-dead-west", "oak-frame-east", "oak-east", "stump-north"), tied.propPlan(T, all, c, 0, false).map { it.id })
        val air = manifest { it.placement(1).get("layer").set(rules.airLayer.toLong(), null) }
        assertEquals(listOf("oak-dead-west", "oak-frame-east", "oak-east", "stump-north"), air.propPlan(T, all, c, 0, false).map { it.id })
    }
    /** D-153 creature paths, owner 2026-09-21 ("animals … animated and moving to all sides"): the parity pin for
     * `realmKitPathPlan` / `realmKitGroundBandPlan` — every probe clock's poses, sheet cells, facings, destinations
     * and the merged band order are the shared functions' answers, so a deer stands on the same pixel, faces the
     * same way and slips behind the same tree on native as on web and the deed. */
    @Test fun `every path probe poses cells faces and stacks the creatures exactly as the shared rule at the same clock`() {
        val T = 32.0; val whole = rules.field; val c = claim(14)
        assertEquals(listOf("gulls", "hare-walk", "hare-pace", "hare-corner", "hare-side"), kit.paths.map { it.id })
        val walk = kit.paths[1]; val pace = kit.paths[2]; val gulls = kit.paths[0]; val corner = kit.paths[3]; val side = kit.paths[4]
        assertEquals(RealmKitPath("hare-walk", "hare", walk.points, 100, 4, 2, 100, 500, false, 1), walk)
        assertEquals(RealmKitPath("hare-pace", "hare", pace.points, 100, 4, 2, 100, 0, true, 1), pace)
        assertEquals(RealmKitPath("gulls", "gull", gulls.points, 40, 1, 3, 100, 0, false, 2), gulls, "the one-row default: frames = frameCount, the asset's frame time, no dwell, cycle")
        assertEquals(RealmKitPath("hare-corner", "hare", corner.points, 100, 4, 2, 100, 250, true, 1), corner); assertEquals(3, corner.points.size, "a pingpong the unfold must actually unfold")
        assertEquals(RealmKitPath("hare-side", "hare", side.points, 100, 2, 4, 100, 0, false, 1), side, "a two-row [left, right] sheet on a real draw")
        val probes = fixture.get("pathProbes").toList()
        assertTrue(probes.size >= 15); assertEquals(1, probes.count { it.getBoolean("reducedMotion") })
        for (probe in probes) {
            val elapsed = probe.getLong("elapsedMs"); val reduced = probe.getBoolean("reducedMotion")
            val draws = kit.pathPlan(T, whole, elapsed, reduced)
            val expected = probe.get("draws").toList()
            assertEquals(expected.map { it.getString("id") }, draws.map { it.draw.id }, "clock $elapsed")
            for ((want, got) in expected.zip(draws)) {
                val label = "${want.getString("id")} @ $elapsed${if (reduced) " (reduced)" else ""}"
                assertEquals(want.getInt("frame"), got.draw.frame, "$label frame")
                assertEquals(want.getString("facing").uppercase(), got.facing.name, "$label facing")
                assertEquals(RealmKitPoint(want.get("anchor").getInt("x"), want.get("anchor").getInt("y")), got.anchor, "$label anchor")
                val d = want.get("destination")
                assertEquals(LayeredGroundRect(d.getDouble("x"), d.getDouble("y"), d.getDouble("width"), d.getDouble("height")), got.draw.destination, "$label destination")
                assertEquals(RealmKitManifest.spriteSource(kit.asset(got.draw.asset.id), got.draw.frame), got.draw.source, "$label source")
            }
            assertEquals(probe.get("band").map { it.asString() }, kit.groundBandPlan(T, whole, c, elapsed, reduced).map { it.draw.id }, "band @ $elapsed")
        }
        // The pinned numbers behind the probes, so a failure names the rule: hare-walk is a 200-px square at 100 px/s with a
        // 500 ms dwell per corner (period 10 000 ms); hare-pace paces 316 px (⌊√100000⌋) each way, no dwell (period 6 320 ms).
        assertEquals(RealmKitPathPose(1500, -900, RealmKitFacing.RIGHT, 200, 0, true), kit.pathPose(walk, 0, false))
        assertEquals(RealmKitPathPose(1520, -900, RealmKitFacing.RIGHT, 200, 0, false), kit.pathPose(walk, 700, false))
        assertEquals(RealmKitPathPose(1573, -900, RealmKitFacing.RIGHT, 200, 0, false), kit.pathPose(walk, 1234, false))
        assertEquals(RealmKitPathPose(1700, -900, RealmKitFacing.DOWN, 0, 200, true), kit.pathPose(walk, 2500, false))
        assertEquals(RealmKitPathPose(1700, -700, RealmKitFacing.LEFT, -200, 0, true), kit.pathPose(walk, 5000, false))
        assertEquals(RealmKitPathPose(1500, -700, RealmKitFacing.UP, 0, -200, true), kit.pathPose(walk, 7777, false))
        assertEquals(RealmKitPathPose(1500, -900, RealmKitFacing.UP, 0, -200, false), kit.pathPose(walk, 9999, false), "floorDiv(−200 · 1999, 2000) = −200: home a millisecond early, as on web")
        assertEquals(kit.pathPose(walk, 0, false), kit.pathPose(walk, 10000, false)); assertEquals(kit.pathPose(walk, 1234, false), kit.pathPose(walk, 61234, false))
        assertEquals(kit.pathPose(walk, 0, false), kit.pathPose(walk, 7777, true), "reduced motion: the first vertex facing the first segment")
        assertEquals(RealmKitPathPose(1622, 1566, RealmKitFacing.DOWN, 100, 300, false), kit.pathPose(pace, 700, false))
        assertEquals(RealmKitPathPose(1700, 1800, RealmKitFacing.UP, -100, -300, false), kit.pathPose(pace, 3160, false))
        assertEquals(RealmKitPathPose(1641, 1625, RealmKitFacing.UP, -100, -300, false), kit.pathPose(pace, 5000, false), "floorDiv, never truncation")
        assertEquals(kit.pathPose(pace, 0, false), kit.pathPose(pace, 6320, false))
        // hare-corner unfolds A B C B A (250 ms per vertex, period 9 000 ms): 5432 is 682 ms up the C→B return leg and 7777 is 777 ms
        // along B→A — a mirror that walks C twice (A B C C B A) or drops A (A B C A B) puts both legs somewhere else.
        assertEquals(RealmKitPathPose(-500, 531, RealmKitFacing.UP, 0, -200, false), kit.pathPose(corner, 5432, false), "floorDiv(−200 · 682, 2000) = −69")
        assertEquals(RealmKitPathPose(-578, 400, RealmKitFacing.LEFT, -200, 0, false), kit.pathPose(corner, 7777, false))
        assertEquals(RealmKitPathPose(-500, 400, RealmKitFacing.DOWN, 0, 200, false), kit.pathPose(corner, 2500, false), "the middle vertex, leaving it the first time")
        assertEquals(kit.pathPose(corner, 0, false), kit.pathPose(corner, 9000, false))
        // hare-side draws the two-row sheet: down leaning west → row 0, right → row 1, up with no lean → row 1 (the tie), left → row 0.
        assertEquals(listOf(0 * 4 + 3, 1 * 4 + 1, 1 * 4 + 2, 0 * 4 + 1), listOf(700L, 2500L, 5432L, 7777L).map { kit.pathPlan(T, whole, it, false)[4].draw.frame })
        // Sheet cell = facing row × frames + walk frame (frame 0 while dwelling, ⌊elapsed / 100⌋ mod 2 on the move).
        assertEquals(listOf(4, 5, 5, 4, 0, 0, 1, 2, 6, 7), listOf(0L, 500L, 700L, 1234L, 2500L, 3000L, 3100L, 5000L, 7777L, 9999L).map { kit.pathPlan(T, whole, it, false)[1].draw.frame })
        assertEquals(listOf(0, 4, 0, 4, 0), kit.pathPlan(T, whole, 5000, true).map { it.draw.frame }); assertEquals(listOf(0, 4, 0, 4, 0), kit.pathPlan(T, whole, 5000, false, background = true).map { it.draw.frame })
        // Culled by the scaled sprite bounds; the renderer scale moves the destination, never the pose.
        assertEquals(listOf("hare-walk"), kit.pathPlan(T, LayeredGroundRect(1510.0, -915.0, 10.0, 10.0), 700, false).map { it.draw.id })
        assertEquals(emptyList(), kit.pathPlan(T, LayeredGroundRect(1510.0, -930.0, 10.0, 10.0), 700, false).map { it.draw.id })
        assertEquals(LayeredGroundRect((1520 - 8) * 2.0, (-900 - 16) * 2.0, 32.0, 32.0), kit.pathPlan(64.0, LayeredGroundRect(-3000.0, -3000.0, 9000.0, 9000.0), 700, false)[1].draw.destination)
        assertFailsWith<IllegalArgumentException> { kit.pathPlan(T, whole, -1, false) }
        // Facing and row rules: the dominant axis, ties to the sides; two rows borrow the side the x component leans to.
        assertEquals(RealmKitFacing.RIGHT, RealmKitManifest.segmentFacing(3, 3)); assertEquals(RealmKitFacing.LEFT, RealmKitManifest.segmentFacing(-3, 3))
        assertEquals(RealmKitFacing.DOWN, RealmKitManifest.segmentFacing(2, 3)); assertEquals(RealmKitFacing.UP, RealmKitManifest.segmentFacing(2, -3)); assertEquals(RealmKitFacing.RIGHT, RealmKitManifest.segmentFacing(0, 0))
        assertEquals(listOf(0, 1, 2, 3), RealmKitFacing.entries.map { RealmKitManifest.facingRow(4, it, 0) })
        assertEquals(0, RealmKitManifest.facingRow(2, RealmKitFacing.DOWN, -1)); assertEquals(1, RealmKitManifest.facingRow(2, RealmKitFacing.DOWN, 0)); assertEquals(1, RealmKitManifest.facingRow(2, RealmKitFacing.UP, 3))
        assertEquals(0, RealmKitManifest.facingRow(2, RealmKitFacing.LEFT, 5)); assertEquals(0, RealmKitManifest.facingRow(1, RealmKitFacing.UP, -9))
        for ((n, root) in listOf(0L to 0L, 1L to 1L, 3L to 1L, 4L to 2L, 99L to 9L, 100000L to 316L, 340000L to 583L, (1L shl 40) - 1 to (1L shl 20) - 1, (1L shl 40) to (1L shl 20))) assertEquals(root, RealmKitManifest.isqrt(n), "isqrt($n)")
        // A creature one row north of a low prop hides behind it; the birds fly a band above everything.
        val behind = manifest { it.get("paths").get(1).replaceArray("points", listOf(point(400, -610), point(400, -700))) }
        assertEquals(listOf("hare-walk", "stump-north", "oak-dead-west", "hare-corner", "oak-frame-east", "hare-side", "oak-east", "hare-pace", "gulls"), behind.groundBandPlan(T, whole, c, 0, false).map { it.draw.id })
        val bandAt700 = kit.groundBandPlan(T, whole, c, 700, false)
        assertEquals(listOf(1 to -900.0, 0 to -600.0, 1 to 200.0, 1 to 400.0, 1 to 512.0, 1 to 1470.0, 1 to 1500.0, 1 to 1566.0, 2 to -886.0), bandAt700.map { it.layer to it.bottom })
        assertEquals(RealmKitFacing.DOWN, bandAt700[7].facing); assertNull(bandAt700[6].facing, "a prop carries no facing")
        assertEquals(listOf("oak-east", "hare-pace"), kit.groundBandPlan(T, LayeredGroundRect(1480.0, 1480.0, 140.0, 40.0), c, 0, false).map { it.draw.id }, "culled through one view")
        assertFalse("oak-frame-east" in kit.groundBandPlan(T, whole, claim(30), 0, false).map { it.draw.id }, "the claim still hides its props")
    }
    /** The parity pin for E-6 (amended): `propProbes` is which placements `realmKitPlacementHidden` leaves visible
     * under the 14/26/30/50-tile claims, in manifest order; `propPlan` lists the same props in draw order. */
    @Test fun `every prop probe lists exactly the placements the shared rule leaves visible under its claim`() {
        val T = 64.0; val all = LayeredGroundRect(-3000.0, -3000.0, 9000.0, 9000.0)
        val manifestOrder = fixture.get("manifest").get("placements").map { it.getString("id") }
        assertEquals(manifestOrder.toSet(), kit.placements.map { it.id }.toSet(), "the resource manifest is the fixture manifest")
        val probes = fixture.get("propProbes").toList()
        assertEquals(listOf(14, 26, 30, 50), probes.map { it.get("claim").getInt("max") - it.get("claim").getInt("min") })
        for (probe in probes) {
            val c = RealmKitClaim(probe.get("claim").getInt("min"), probe.get("claim").getInt("max"))
            val visible = probe.get("visible").map { it.asString() }
            val drawn = kit.propPlan(T, all, c, 0, false).map { it.id }
            assertEquals(visible, manifestOrder.filter { it in drawn }, "claim ${c.min}..${c.max}"); assertEquals(visible.size, drawn.size, "claim ${c.min}..${c.max}")
            for (p in kit.placements) assertEquals(p.id !in visible, kit.placementHidden(p, c), "${p.id} under ${c.min}..${c.max}")
        }
        assertTrue(probes.any { it.get("visible").size == manifestOrder.size }, "some claim leaves every prop visible")
        assertTrue(probes.any { it.get("visible").size < manifestOrder.size }, "some claim hides a prop")
    }
    /** E-8 under E-6 amended: the zoom-floor frame is the overview plan (far, tile-only still, kingdom fill) plus the
     * same culled prop plan the tile LOD draws. The still carries no prop and no placement may draw the still sheet,
     * so a prop the claim hides has no way onto the screen below `overviewMaxZoom` — before the amendment nothing
     * stood inside the frame and a prop-baked still agreed with every claim; now it would strand hidden trees. */
    @Test fun `the zoom floor frame lists far still fill and exactly the props each probe claim leaves visible`() {
        val T = 64.0; val all = LayeredGroundRect(-5000.0, -5000.0, 12000.0, 12000.0)
        val still = checkNotNull(kit.overview).asset
        assertTrue(kit.placements.none { it.asset == still.id || it.asset == kit.tileset.id || it.asset == kit.far.asset.id }, "no placement draws a floor sheet")
        for (probe in fixture.get("propProbes").toList()) {
            val c = RealmKitClaim(probe.get("claim").getInt("min"), probe.get("claim").getInt("max"))
            val visible = probe.get("visible").map { it.asString() }.toSet()
            val plan = kit.overviewPlan(T, all, c); val props = kit.propPlan(T, all, c, 0, false)
            assertEquals(listOf("floor-far", "floor-overview"), listOfNotNull(plan.far, plan.overview).map { it.id }, "claim ${c.min}..${c.max}")
            assertEquals(still.id, plan.overview?.asset?.id); assertNotNull(plan.kingdom, "claim ${c.min}..${c.max}")
            assertEquals(visible, props.map { it.id }.toSet(), "claim ${c.min}..${c.max}: the zoom floor draws the visible props and nothing the claim hides")
            assertEquals(props.size, visible.size, "claim ${c.min}..${c.max}: each visible prop once")
        }
    }
    @Test fun `obstacle rows map to kit sprites by state keep the dec fallback for unmapped keys and reject unknown keys`() {
        assertEquals("oak", kit.obstacleSprite("tree_old", RealmKitObstacleState.INTACT)?.id)
        assertEquals("oak", kit.obstacleSprite("tree_old", RealmKitObstacleState.CLEARING)?.id)
        assertEquals("oak-stump", kit.obstacleSprite("tree_old", RealmKitObstacleState.REMNANT)?.id)
        assertNull(kit.obstacleSprite("bush", RealmKitObstacleState.INTACT))
        assertFailsWith<IllegalArgumentException> { kit.obstacleSprite("dragon", RealmKitObstacleState.INTACT) }
        val clearing = manifest { it.get("obstacleSprites").get("tree_old").addChild("clearing", JsonValue("gull")) }
        assertEquals("gull", clearing.obstacleSprite("tree_old", RealmKitObstacleState.CLEARING)?.id)
    }
    /** E-11 twins: the home scene draws a mapped server row from the kit sheet at the SAME seat the web scene
     * and the deed use for its `dec_` master (anchor x on the footprint centre, bottom edge on its south edge,
     * the row's own footprint), so one plot shows one tree everywhere. Unmapped or unknown keys answer null
     * and the renderer keeps its catalogue drawable — never a throw mid-frame. */
    @Test fun `obstacle draws seat the mapped kit still on the row footprint and leave unmapped keys to the dec master`() {
        val T = 64.0
        // A 2×2 tree_old at tile (8,8): the oak's 32×48 cell 0 at ×2, bottom-centre anchor (16,48) → left = 9·64 − 32, top = 10·64 − 96.
        val oak = assertNotNull(kit.obstacleDraw("tree_old", RealmKitObstacleState.INTACT, T, 8.0, 8.0, 2.0, 2.0))
        assertEquals("oak", oak.asset.id); assertEquals(0, oak.frame)
        assertEquals(LayeredGroundRect(0.0, 0.0, 32.0, 48.0), oak.source, "the still is sheet cell 0")
        assertEquals(LayeredGroundRect(9 * 64.0 - 32, 10 * 64.0 - 96, 64.0, 96.0), oak.destination)
        // The footprint is the row's (dec_ catalogue), not the sheet's: a 1×1 stump seats its 16×16 cell on one tile.
        val stump = assertNotNull(kit.obstacleDraw("stump", RealmKitObstacleState.INTACT, T, 12.0, 12.0, 1.0, 1.0))
        assertEquals("oak-stump", stump.asset.id)
        assertEquals(LayeredGroundRect(12.5 * 64 - 16, 13 * 64.0 - 32, 32.0, 32.0), stump.destination)
        // A clear job shows the clearing state, which falls back to intact; the remnant draws the stump sheet.
        assertEquals(oak.copy(id = oak.id), kit.obstacleDraw("tree_old", RealmKitObstacleState.CLEARING, T, 8.0, 8.0, 2.0, 2.0))
        assertEquals("oak-stump", kit.obstacleDraw("tree_old", RealmKitObstacleState.REMNANT, T, 8.0, 8.0, 2.0, 2.0)?.asset?.id)
        // Unmapped (`bush`) and unknown (`dragon`) keys: the catalogue `dec_` drawable stays, no exception.
        assertNull(kit.obstacleDraw("bush", RealmKitObstacleState.INTACT, T, 10.0, 10.0, 1.0, 1.0))
        assertNull(kit.obstacleDraw("dragon", RealmKitObstacleState.INTACT, T, 10.0, 10.0, 1.0, 1.0))
        assertFailsWith<IllegalArgumentException> { kit.obstacleDraw("tree_old", RealmKitObstacleState.INTACT, T, 8.0, 8.0, 0.0, 2.0) }
    }
    /** E-11 expansion obstacles (D-153): a kit prop the claim reaches becomes a server row of the tier the shared
     * rule names and every surface draws that row as the prop's own still — the species never changes because
     * land was bought. The fixture's obstacle probes are what packages/shared answers today. */
    @Test fun `every obstacle probe maps to the kind and the sprite the shared rule returned so a felled tree keeps its species on native`() {
        val probes = fixture.get("obstacleProbes")
        val kinds = probes.get("kinds").toList()
        assertEquals(kit.placements.size, kinds.size)
        for (k in kinds) {
            val p = kit.placements.first { it.id == k.getString("id") }
            assertEquals(RealmKitSeat(k.get("seat").getInt("tx"), k.get("seat").getInt("ty")), kit.placementSeat(p), p.id)
            assertEquals(k.get("kind").takeUnless { it.isNull }?.asString(), kit.obstacleKindFor(p), p.id)
        }
        assertEquals(listOf("pine2", "stump", "pine1", "pine2"), kinds.map { it.getString("kind") })
        val sprites = probes.get("sprites").toList(); assertTrue(sprites.size >= 12)
        for (s in sprites) {
            val state = RealmKitObstacleState.valueOf(s.getString("state").uppercase())
            val draw = kit.obstacleSpriteAt(s.getInt("tx"), s.getInt("ty"), s.getString("spriteKey"), state)
            val expected = s.get("asset").takeUnless { it.isNull }?.asString()
            assertEquals(expected, draw?.asset?.id, "${s.getString("spriteKey")} at ${s.getInt("tx")},${s.getInt("ty")} $state")
            assertEquals(s.get("frame").takeUnless { it.isNull }?.asInt(), draw?.frame, "${s.getString("spriteKey")} at ${s.getInt("tx")},${s.getInt("ty")} $state")
        }
        // The frame oak (sheet cell 3 on 30,15) is a pine2 row that draws the OAK's cell 3, not a twin's frame 0.
        assertEquals(RealmKitObstacleSprite(kit.asset("oak"), 3), kit.obstacleSpriteAt(30, 15, "pine2", RealmKitObstacleState.INTACT))
        assertEquals(RealmKitObstacleSprite(kit.asset("oak"), 3), kit.obstacleSpriteAt(30, 15, "pine2", RealmKitObstacleState.CLEARING))
        assertNull(kit.obstacleSpriteAt(30, 15, "pine2", RealmKitObstacleState.REMNANT), "remnants draw the twin (unmapped here → dec_)")
        assertNull(kit.obstacleSpriteAt(30, 15, "pine1", RealmKitObstacleState.INTACT), "a row of another kind never borrows the oak")
        assertEquals(RealmKitObstacleSprite(kit.asset("oak"), 0), kit.obstacleSpriteAt(10, 10, "tree_old", RealmKitObstacleState.INTACT), "plot rows keep the twin")
        assertFailsWith<IllegalArgumentException> { kit.obstacleSpriteAt(10, 10, "dragon", RealmKitObstacleState.INTACT) }
        assertEquals(listOf(RealmKitSeat(46, 46), RealmKitSeat(12, -19), RealmKitSeat(-22, 6), RealmKitSeat(30, 15)), kit.seatIndex.keys.toList(), "manifest order")
    }
    private fun JsonValue.addPlacement(id: String, seatX: Int, seatY: Int, layer: Int = 1, footprint: String? = null, prop: String? = null, asset: String = "oak", frame: Int = 0) {
        val w = footprint?.let { reader.parse(it).get(0).asInt() } ?: 1
        val x = (seatX - w / 2) * 32 + w * 32 / 2; val y = (seatY + 1) * 32
        val extra = reader.parse("""{"id":"$id","asset":"$asset","x":$x,"y":$y,"width":32,"height":48,"layer":$layer,"phaseFrame":0,"animated":false,"interactive":false,"frame":$frame}""")
        footprint?.let { extra.addChild("footprint", reader.parse(it)) }; prop?.let { extra.addChild("prop", JsonValue(it)) }
        get("placements").addChild(extra)
    }
    @Test fun `obstacle kinds prefer the builder prop honour the footprint against the tier size and never map the creature sheet`() {
        val m = manifest { v ->
            v.addPlacement("oak-9", 46, 40, prop = "rock-l"); v.addPlacement("rock-s-3", 47, 40, layer = 0); v.addPlacement("canopy-log-3", 48, 40, layer = 0)
            v.addPlacement("boulder-mossy-1", 49, 40, layer = 0, footprint = "[2,1]"); v.addPlacement("boulder-mossy-2", 52, 40, layer = 0, footprint = "[2,2]")
            v.addPlacement("stump-9", 55, 40, layer = 0, footprint = "[2,2]")
            v.addPlacement("bush-1", 46, 42, layer = 0); v.addPlacement("hero-oak-1", 48, 42, footprint = "[2,2]"); v.addPlacement("tent-1", 51, 42, layer = 0, footprint = "[2,2]")
            v.addPlacement("log-1", 54, 42, layer = 0, footprint = "[2,1]"); v.addPlacement("windmill-1", 58, 42, footprint = "[3,3]"); v.addPlacement("spring-rock-1", 46, 46, footprint = "[4,3]")
            // A 32×32-cell creature sheet: the fixture has none, so add one (real hashes are irrelevant to the rule).
            val deer = reader.parse("""{"id":"deer","path":"atlas/fantasy/layered-ground/assets/${"f".repeat(64)}.png","sha256":"${"f".repeat(64)}","size":100,"width":64,"height":32,"frameWidth":32,"frameHeight":32,"frameCount":2,"frameDurationMs":100,"anchor":{"x":16,"y":32},"reducedMotionFrame":0}""")
            v.get("assets").addChild(deer)
            v.addPlacement("deer-graze-1", 50, 46, layer = 0, asset = "deer"); v.addPlacement("deer-graze-2", 52, 46, layer = 1, asset = "deer")
        }
        fun kind(id: String) = m.obstacleKindFor(m.placements.first { it.id == id })
        assertEquals("rock_l", kind("oak-9"), "prop beats the id prefix"); assertEquals("rock_s", kind("rock-s-3")); assertEquals("stump", kind("canopy-log-3"))
        assertNull(kind("boulder-mossy-1"), "a 2×1 rock cannot be the 2×2 boulder tier"); assertEquals("boulder", kind("boulder-mossy-2")); assertNull(kind("stump-9"))
        assertEquals("bush", kind("bush-1")); assertEquals("tree_old", kind("hero-oak-1")); assertNull(kind("tent-1")); assertNull(kind("log-1")); assertNull(kind("windmill-1")); assertNull(kind("spring-rock-1"))
        assertNull(kind("deer-graze-1")); assertNull(kind("deer-graze-2"))
        // A 2×2 row is looked up by its SEAT: the hero oak seated on (48,42) is the row at (47,41).
        assertEquals(RealmKitObstacleSprite(m.asset("oak"), 0), m.obstacleSpriteAt(47, 41, "tree_old", RealmKitObstacleState.INTACT))
        assertEquals(RealmKitSeat(48, 42), m.obstacleSeat("tree_old", 47, 41)); assertEquals(RealmKitSeat(7, 9), m.obstacleSeat("bush", 7, 9))
        assertEquals(2, m.obstacleSize("boulder")); assertEquals(1, m.obstacleSize("pine1")); assertFailsWith<IllegalArgumentException> { m.obstacleSize("dragon") }
    }
    @Test fun `obstacle draws seat the seated prop's own cell on the row tile and fall back to the twin off whole tiles`() {
        val T = 64.0
        // The pine2 row on (30,15): the oak's cell 3 (column 1, row 1 of the 2×2-cell sheet) at ×2, bottom-centre on the 1×1 footprint.
        val seated = assertNotNull(kit.obstacleDraw("pine2", RealmKitObstacleState.INTACT, T, 30.0, 15.0, 1.0, 1.0))
        assertEquals("oak", seated.asset.id); assertEquals(3, seated.frame)
        assertEquals(LayeredGroundRect(32.0, 48.0, 32.0, 48.0), seated.source)
        assertEquals(LayeredGroundRect(30.5 * 64 - 32, 16 * 64.0 - 96, 64.0, 96.0), seated.destination)
        assertEquals(seated.copy(id = seated.id), kit.obstacleDraw("pine2", RealmKitObstacleState.CLEARING, T, 30.0, 15.0, 1.0, 1.0))
        // The remnant, a row of another kind and a row one tile over all leave pine2/pine1 to the dec_ master here.
        assertNull(kit.obstacleDraw("pine2", RealmKitObstacleState.REMNANT, T, 30.0, 15.0, 1.0, 1.0))
        assertNull(kit.obstacleDraw("pine1", RealmKitObstacleState.INTACT, T, 30.0, 15.0, 1.0, 1.0))
        assertNull(kit.obstacleDraw("pine2", RealmKitObstacleState.INTACT, T, 31.0, 15.0, 1.0, 1.0))
        // A fractional tile seats no prop: the mapped twin draws (tree_old → oak cell 0), an unmapped key nothing.
        assertEquals(0, kit.obstacleDraw("tree_old", RealmKitObstacleState.INTACT, T, 8.5, 8.0, 2.0, 2.0)?.frame)
        assertNull(kit.obstacleDraw("pine2", RealmKitObstacleState.INTACT, T, 30.5, 15.0, 1.0, 1.0))
    }
    @Test fun `overview plan draws the still over the field plus a paddingColor kingdom fill culled to the view`() {
        val T = 64.0; val c = claim(26)
        val plan = kit.overviewPlan(T, LayeredGroundRect(-5000.0, -5000.0, 12000.0, 12000.0), c)
        assertEquals("floor-far", plan.far.id); assertEquals("floor-overview", plan.overview?.id)
        assertEquals(rules.field.scaled(2.0), plan.overview?.destination); assertEquals(LayeredGroundRect(0.0, 0.0, 196.0, 196.0), plan.overview?.source)
        assertEquals(RealmKitKingdomFill(LayeredGroundRect(2 * 64.0, 2 * 64.0, 26 * 64.0, 26 * 64.0), 0x6f7a3a), plan.kingdom)
        val far = kit.overviewPlan(T, LayeredGroundRect(50000.0, 50000.0, 10.0, 10.0), c)
        assertNull(far.overview); assertNull(far.kingdom)
        assertNull(kit.overviewPlan(T, LayeredGroundRect(-2000.0, -2000.0, 100.0, 100.0), c).kingdom)
        assertEquals(emptyList(), far.margin)
        assertFailsWith<IllegalArgumentException> { manifest { it.get("ground").remove("overview") }.overviewPlan(T, LayeredGroundRect(0.0, 0.0, 1.0, 1.0), c) }
    }
    /** Owner: "waters are cut off, we need to fill that till the end". The tile LOD clamps every margin tile to its
     * nearest field tile ([RealmKitManifest.cell]); before this the still covered the field only, so below
     * `overviewMaxZoom` — exactly the band where a phone view reaches past the 98-tile field — the margin was the
     * far repeat again and every river leaving the field stopped dead on device while web ran it on. */
    @Test fun `overview plan draws the edge-clamped margin from the still's outer rows and columns so a river runs on at the zoom floor`() {
        val T = 64.0; val c = claim(26); val E = rules.edgeExtendTiles; val O = rules.fieldOriginTiles; val N = rules.fieldTiles
        val px = checkNotNull(kit.overview).pxPerTile; val still = N * px
        assertTrue(E > 0, "the fixture pack carries a margin")
        val extent = LayeredGroundRect((O - E) * T, (O - E) * T, (N + 2 * E) * T, (N + 2 * E) * T)
        val plan = kit.overviewPlan(T, extent, c)
        assertEquals(listOf("floor-margin-nw", "floor-margin-n", "floor-margin-ne", "floor-margin-w", "floor-margin-e", "floor-margin-sw", "floor-margin-s", "floor-margin-se"), plan.margin.map { it.id })
        // The eight rects plus the field tile the extent exactly: same area, no two overlap.
        val rects = listOf(checkNotNull(plan.overview).destination) + plan.margin.map { it.destination }
        assertEquals(extent.width * extent.height, rects.sumOf { it.width * it.height })
        for ((i, a) in rects.withIndex()) for ((j, b) in rects.withIndex()) if (i != j) assertFalse(a.intersects(b), "$i overlaps $j")
        for (d in plan.margin) assertEquals(checkNotNull(plan.overview).asset, d.asset)
        // Tile for tile the strips are cell()'s clamp: on an axis outside the field a margin tile draws the block of
        // the field's edge tile on that side; on the axis inside the field the strip spans the whole still over the field.
        fun clamp(t: Int) = if (t < O) O else if (t >= O + N) O + N - 1 else t
        fun covering(tx: Int, ty: Int) = plan.margin.filter { it.destination.intersects(LayeredGroundRect(tx * T, ty * T, T, T)) }
        for ((tx, ty) in listOf(O - E to O - E, O - 1 to O + 10, O + N to O + N - 1, O + 40 to O - E, O + 3 to O + N + E - 1, O + N + E - 1 to O + N + E - 1, O - E to O + N + 1)) {
            val d = covering(tx, ty).single()
            for ((t, axis) in listOf(tx to Triple(d.destination.x to d.destination.width, d.source.x, d.source.width), ty to Triple(d.destination.y to d.destination.height, d.source.y, d.source.height))) {
                val (span, sLo, sSize) = axis
                if (t < O || t >= O + N) { assertEquals((if (t < O) (O - E) * T else (O + N) * T) to E * T, span); assertEquals(((clamp(t) - O) * px).toDouble() to px.toDouble(), sLo to sSize) }
                else { assertEquals(O * T to N * T, span); assertEquals(0.0 to still.toDouble(), sLo to sSize) }
            }
        }
        // Beyond the extent nothing but the far repeat; a view over the east margin alone still gets its strip.
        assertEquals(emptyList(), covering(O + N + E, O))
        val east = kit.overviewPlan(T, LayeredGroundRect((O + N + 5) * T, (O + 20) * T, 10 * T, 10 * T), c)
        assertNull(east.overview); assertEquals(listOf("floor-margin-e"), east.margin.map { it.id })
    }
    @Test fun `chunk batches equal the floor plan tile for tile and rebuild only on claim change or an animation frame swap`() {
        val T = 64.0; val cache = RealmKitChunkCache(kit, T); val c = claim(14)
        // Rewritten for the edge clamp (was 7 chunks over the field from tile -34): the cache tiles the whole extent
        // from tile -98, so the margin draws on device; 64 is a multiple of 16, so every field chunk keeps its rect.
        val E = rules.edgeExtendTiles; val EO = O - E
        assertEquals(15, cache.chunksPerAxis)
        val view = LayeredGroundRect(2944.0, 2944.0, 1100.0, 1100.0) // chunk 9 starts at tile 46 = 2944 world px; the field ends at 4096
        val visible = cache.visibleChunks(view)
        assertEquals(listOf(9 to 9, 10 to 9, 9 to 10, 10 to 10), visible, "row-major chunks intersecting the view")
        assertEquals(listOf(4 to 4), cache.visibleChunks(LayeredGroundRect(-2176.0, -2176.0, 10.0, 10.0)), "the field's origin tile")
        assertEquals(listOf(0 to 0), cache.visibleChunks(LayeredGroundRect(EO * T, EO * T, 10.0, 10.0)), "the extent's origin tile")
        assertTrue(cache.visibleChunks(LayeredGroundRect(100000.0, 100000.0, 10.0, 10.0)).isEmpty())
        assertTrue(cache.visibleChunks(LayeredGroundRect((EO - 1) * T, 0.0, 10.0, 10.0)).isEmpty(), "west of the extent only the far repeat draws")
        assertEquals(225, cache.visibleChunks(LayeredGroundRect(-9000.0, -9000.0, 30000.0, 30000.0)).size)
        fun decode(chunk: RealmKitChunkCache.Chunk): List<RealmKitTileDraw> {
            val out = mutableListOf<RealmKitTileDraw>(); val v = chunk.vertices
            for (q in 0 until chunk.quads) {
                val o = q * 20
                assertEquals(v[o], v[o + 5]); assertEquals(v[o + 1], v[o + 16]); assertEquals(com.badlogic.gdx.graphics.Color.WHITE_FLOAT_BITS, v[o + 2])
                assertEquals(v[o + 4], v[o + 19], "world top samples one texture row, whatever the quad height")
                val tx = Math.round(v[o] / T).toInt(); val ty = Math.round(v[o + 1] / T).toInt()
                val sx = Math.round(v[o + 3] * kit.tileset.width).toInt(); val sy = Math.round(v[o + 4] * kit.tileset.height).toInt()
                val cell = kit.cells.indexOfFirst { it.y == sy && sx >= it.x && sx < it.x + it.frames * kit.tilePixels } + 1
                assertTrue(cell >= 1, "quad $q addresses no cell")
                out += RealmKitTileDraw(RealmKitLayerId.BASE, tx, ty, cell, (sx - kit.cells[cell - 1].x) / kit.tilePixels, LayeredGroundRect(v[o].toDouble(), v[o + 1].toDouble(), (v[o + 10] - v[o]).toDouble(), (v[o + 11] - v[o + 1]).toDouble()))
            }
            return out
        }
        for (elapsed in listOf(0L, 260L)) {
            val drawn = visible.flatMap { (cx, cy) -> decode(cache.vertices(cx, cy, c, elapsed, false)) }
            val expected = kit.floorPlan(T, LayeredGroundRect((9 * 16 + EO) * T, (9 * 16 + EO) * T, 32 * T, 32 * T), c, elapsed, false).tiles
            assertEquals(expected.size, drawn.size, "every non-empty tile of the chunks' area is one quad")
            assertEquals(expected.map { Triple(it.tx, it.ty, it.cell) }.toSet(), drawn.map { Triple(it.tx, it.ty, it.cell) }.toSet())
            assertEquals(expected.map { "${it.tx}:${it.ty}:${it.cell}:${it.frame}" }.sorted(), drawn.map { "${it.tx}:${it.ty}:${it.cell}:${it.frame}" }.sorted())
            for (d in drawn) assertEquals(LayeredGroundRect(d.tx * T, d.ty * T, T, T), d.destination)
        }
        val lake = cache.chunk(9, 9); val forest = cache.chunk(10, 10)
        assertContentEquals(intArrayOf(WATER), lake.animatedCells); assertContentEquals(IntArray(0), forest.animatedCells)
        val before = cache.rebuilds
        cache.vertices(9, 9, c, 260, false); cache.vertices(10, 10, c, 260, false)
        assertEquals(before, cache.rebuilds, "same claim and same frames: a memcpy, no rebuild")
        cache.vertices(9, 9, c, 499, false); assertEquals(before, cache.rebuilds, "still frame 1")
        val lakeArray = lake.vertices
        cache.vertices(9, 9, c, 500, false); assertEquals(before + 1, cache.rebuilds, "frame 2 rebuilds the lake chunk")
        // Zoomed out, a base or battle draws dozens of chunks and every water chunk swaps frame each animation step, so a
        // frame swap must rewrite the chunk's own array (no GC churn on the GL thread), to exactly what a fresh build draws.
        assertSame(lakeArray, lake.vertices, "a frame swap rewrites the chunk's vertex array in place")
        assertContentEquals(RealmKitChunkCache(kit, T).vertices(9, 9, c, 500, false).vertices, lake.vertices, "the rewrite equals a fresh build of frame 2")
        cache.vertices(10, 10, c, 500, false); assertEquals(before + 1, cache.rebuilds, "a still chunk ignores the clock")
        cache.vertices(9, 9, c, 900, true); assertEquals(before + 2, cache.rebuilds, "reduced motion pins frame 0")
        cache.vertices(9, 9, c, 5000, true); assertEquals(before + 2, cache.rebuilds)
        val kingdom = cache.chunk(6, 6); cache.vertices(6, 6, c, 0, true)
        val stamped = cache.rebuilds
        cache.vertices(6, 6, claim(26), 0, true); assertEquals(stamped + 1, cache.rebuilds, "a claim change rebuilds the chunks it touches")
        // Chunk 6 covers tiles [-2,14): the claim's north-west quadrant, its north run (mask 3), west run (5) and corner (1), and three wilderness columns.
        assertEquals(setOf(TURF, TURF_ALT, EDGE_FIRST + 1, EDGE_FIRST + 3, EDGE_FIRST + 5, MEADOW, MEADOW_ALT, FLOWER), decode(kingdom).map { it.cell }.toSet())
        assertTrue(decode(kingdom).count { it.cell in kit.turf } > decode(cache.vertices(6, 6, c, 0, true)).count { it.cell in kit.turf }, "26 tiles of turf beat 14")
        // The margin chunks draw the clamped edge: the extent's north-west corner is 16² forest quads on the base
        // alone (no decal repeats outward), and the last chunk is the extent's 2-tile remainder, again forest.
        val corner = decode(cache.vertices(0, 0, c, 0, true)); assertEquals(256, corner.size); assertTrue(corner.all { it.cell == FOREST })
        assertEquals(LayeredGroundRect(EO * T, EO * T, T, T), corner.first().destination)
        val remainder = decode(cache.vertices(14, 14, c, 0, true)); assertEquals(4, remainder.size); assertTrue(remainder.all { it.cell == FOREST && it.tx in 126..127 && it.ty in 126..127 })
        assertEquals(kit.floorPlan(T, LayeredGroundRect(126 * T, 126 * T, 2 * T, 2 * T), c, 0, true).tiles.map { Triple(it.tx, it.ty, it.cell) }.toSet(), remainder.map { Triple(it.tx, it.ty, it.cell) }.toSet())
        assertFailsWith<IllegalArgumentException> { cache.vertices(15, 0, c, 0, false) }
        assertFailsWith<IllegalArgumentException> { cache.vertices(0, 0, RealmKitClaim(0, 0), 0, false) }
        cache.clear(); assertEquals(0, cache.cachedChunks)
    }
}
