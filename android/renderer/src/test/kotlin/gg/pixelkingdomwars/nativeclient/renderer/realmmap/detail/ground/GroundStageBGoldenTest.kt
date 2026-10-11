package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.bits
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.hx
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * GROUND's stage B rules (web 205b6326: ground.js waterPhaseStep, famClamp, waterGems, gemDrift, deepTint, gemHighlight,
 * gemColours and the fieldsA.baked key order) against the pinned web functions (`classify-common.json` → `stageB`: synthetic
 * loops and overrides with JS coercion edge cases; `classify-<realm>.json` → `stageB`: each real realm.json, and Solana
 * Reach's gem colours measured on its exact ground.png), plus the native wiring the goldens cannot see. Why it matters:
 * these numbers are what makes the three new realms and Solana's gem sea look as the owner approved them on the web —
 * Solana's 16-frame gem loop needs phase step 4 (at 2 its gem rows cluster), its MAP sea sparkles only with the web's share
 * and drift, a gem-sea realm takes a third of the depth tint (its teal read navy), and the three darker MAP arts need the
 * wider grade (at 1.8 their d 48 hand-over left ΔE up to 22.4). A value that differs draws a different realm on the Seeker.
 */
class GroundStageBGoldenTest {
    private val common = GroundGolden.suite("classify-common").get("stageB")

    /** A golden input value as the web held it: "undefined" = absent (null here), "NaN" = the number NaN, else as parsed. */
    private fun input(v: JsonValue): JsonValue? = when {
        v.isString && v.asString() == "undefined" -> null
        v.isString && v.asString() == "NaN" -> JsonValue(Double.NaN)
        v.isArray -> JsonValue(JsonValue.ValueType.array).also { a -> for (c in list(v)) a.addChild(input(c) ?: JsonValue(JsonValue.ValueType.nullValue)) }
        else -> copy(v)
    }
    /** A detached copy (adding a node of the cached golden tree to another parent would relink it). */
    private fun copy(v: JsonValue): JsonValue = when {
        v.isObject || v.isArray -> JsonReader().parse(v.toJson(JsonWriter.OutputType.json))
        v.isString -> JsonValue(v.asString())
        v.isDouble -> JsonValue(v.asDouble())
        v.isLong -> JsonValue(v.asLong())
        v.isBoolean -> JsonValue(v.asBoolean())
        else -> JsonValue(JsonValue.ValueType.nullValue)
    }
    private fun obj(vararg kv: Pair<String, JsonValue?>) = JsonValue(JsonValue.ValueType.`object`).also { o -> for ((k, v) in kv) if (v != null) o.addChild(k, v) }
    /** `{ id, map: { <key>: override } }` as the generator built it (the key absent when the override is "undefined"). */
    private fun metaWith(id: String, key: String, override: JsonValue): JsonValue = obj("id" to JsonValue(id), "map" to obj(key to input(override)))

    // ---------------------------------------------------------------- the pinned functions on synthetic inputs

    @Test fun `waterPhaseStep, famClamp, waterGems, gemHighlight and gemDrift equal the web's on every synthetic row, JS coercion included`() {
        var rows = 0
        for (r in list(common.get("waterPhaseStep"))) {
            val w = r.get(0).takeUnless { it.isNull }?.let { copy(it) }
            assertEquals(r.getInt(1), GroundTables.waterPhaseStep(w), "waterPhaseStep(${r.get(0)})"); rows++
        }
        for (r in list(common.get("famClamp"))) {
            val got = GroundTables.famClamp(metaWith(r.getString(0), "famClamp", r.get(1)))
            assertEquals(list(r.get(2)).map { it.asString() }, got.map { bits(it) }, "famClamp(${r.getString(0)}, ${r.get(1)})"); rows++
        }
        for (r in list(common.get("waterGems"))) {
            assertEquals(r.getString(2), bits(GroundTables.waterGems(metaWith(r.getString(0), "waterGems", r.get(1)))), "waterGems(${r.getString(0)}, ${r.get(1)})"); rows++
        }
        for (r in list(common.get("gemHighlight"))) { assertEquals(r.getString(1), bits(GroundTables.gemHighlight(obj("id" to JsonValue(r.getString(0)))))); rows++ }
        for (r in list(common.get("gemDrift"))) {
            val w = r.get(0).takeUnless { it.isNull }?.let { copy(it) }
            assertEquals(list(r.get(1)).map { it.asString() }, GroundTables.gemDrift(w).map { bits(it) }, "gemDrift(${r.get(0)})"); rows++
        }
        assertEquals(18 + 60 + 48 + 6 + 6, rows)
        // the rows bite: a phaseStep of 4 on a 16-frame loop (Solana), a clamp to the frames, a truncated fraction, a numeric
        // string, and an override outside 0…0.2 / (0, 1) × (1, 4] are all in them
        assertTrue(list(common.get("waterPhaseStep")).map { it.getInt(1) }.toSet().containsAll(listOf(1, 2, 3, 4, 8)))
    }

    // ---------------------------------------------------------------- per realm, from its own realm.json

    @Test fun `every realm's loops, phase steps, grade clamp, gem share, drift, highlight and deep tint are the web's`() {
        var realms = 0; var gemRealms = 0
        for (id in GroundGolden.REALMS) {
            val g = GroundGolden.suite("classify-$id"); val s = g.get("stageB"); val meta = g.get("laneMeta")
            // the loops GROUND draws: the sea loop (SEA ?? DEEP ?? water), the inland loop (WATER ?? water), and every loop's step
            val tt = assertNotNull(GroundTables.trueTables(meta), "$id: TRUE tables")
            val loops = s.get("loops")
            for ((name, loop) in listOf("sea" to tt.water, "inland" to tt.inland)) {
                val row = loops.get(name)
                assertEquals(row.getInt(0) + tt.off, loop.first, "$id $name loop first layer"); assertEquals(row.getInt(1), loop.frames, "$id $name frames")
                assertEquals(row.getInt(4), loop.step, "$id $name phase step (uTg${if (name == "sea") "Water" else "Water2"}.w)")
            }
            val wbc = meta.get("true").get("waterByClass")
            for (e in list(loops.get("waterByClass"))) assertEquals(e.getInt(4), GroundTables.waterPhaseStep(wbc.get(e.name)), "$id waterByClass.${e.name} step")
            loops.get("water")?.takeUnless { it.isNull }?.let { assertEquals(it.getInt(4), GroundTables.waterPhaseStep(meta.get("true").get("water")), "$id true.water step") }
            // (laneMeta.map is trimmed by the generator; a pack that adds map.famClamp / map.waterGems fails here until the
            // generator carries those keys, never silently)
            assertEquals(list(s.get("famClamp")).map { it.asString() }, GroundTables.famClamp(meta).map { bits(it) }, "$id famClamp")
            assertEquals(s.getString("waterGems"), bits(GroundTables.waterGems(meta)), "$id waterGems")
            assertEquals(s.getString("gemHighlight"), bits(GroundTables.gemHighlight(meta)), "$id gemHighlight")
            assertEquals(list(s.get("gemD")).map { it.asDouble() }, listOf(GroundTables.GEM_D0, GroundTables.GEM_D1), "GEM_D")
            assertEquals(list(s.get("gemDrift")).map { it.asString() }, GroundTables.gemDrift(GroundTables.gemDriftLoop(meta)).map { bits(it) }, "$id gemDrift (the SEA loop)")
            for (r in list(s.get("deepTint"))) {
                val deep = DoubleArray(3) { hx(r.getString(it)) }
                assertEquals((3 until 6).map { r.getString(it) }, GroundTables.deepTint(deep, meta).map { bits(it) }, "$id deepTint(${deep.toList()})")
            }
            s.get("gems")?.takeUnless { it.isNull }?.let { gems ->
                gemRealms++
                // the cell GROUND measures: the sea loop's PACK first layer (trueSetup's wSea.first, before the reserved layer 0)
                val atlas = meta.get("true").get("atlas"); val cell = atlas.getInt("cell", 32); val colsA = atlas.getInt("cols")
                assertEquals(listOf(gems.getInt("cell"), gems.getInt("colsA")), listOf(cell, colsA), "$id gem atlas layout")
                assertEquals(GroundGolden.ints(gems.get("cellOrigin")).toList(), listOf((tt.waterSeaFirstPack % colsA) * cell, (tt.waterSeaFirstPack / colsA) * cell), "$id gem cell")
                // gemK from the measured colours and the loop mean, bit for bit (ground.png is a PNG: the web's exact decode)
                val colours = Array(2) { k -> DoubleArray(3) { hx(gems.get("colours").get(k).getString(it)) } }
                val kitWater = DoubleArray(3) { hx(gems.get("kitWater").getString(it)) }
                val k = assertNotNull(GroundTables.gemK(colours, kitWater))
                assertEquals(list(gems.get("gemK")).map { c -> list(c).map { it.asString() } }, k.map { c -> c.map { bits(it) } }, "$id gemK")
                // and those are the uMpGemCol the web's MAP frame drew with (the lane trace; float32)
                val trace = g.get("lane").get("frames").get("map").get("last").get("rm-map").get("uMpGemCol")
                assertEquals(list(trace).map { it.asFloat() }, k.flatMap { c -> c.map { it.toFloat() } }, "$id uMpGemCol is the golden's gemK")
            }
            realms++
        }
        assertEquals(8, realms); assertEquals(1, gemRealms, "Solana Reach is the one gem-sea realm at the pin")
    }

    // ---------------------------------------------------------------- rules the goldens do not pin

    /** Why: the web reads `fields.fieldsA.baked` first (where realm.json describes fieldsA) and the top-level key only when that
     *  one is absent or null — a pack could carry both (an empty list under fields means "nothing baked"). */
    @Test fun `fieldsA baked passes follow ground js key order, fields first, the top-level key only when that one is absent`() {
        fun list(vararg v: String) = JsonValue(JsonValue.ValueType.array).also { a -> for (x in v) a.addChild(JsonValue(x)) }
        fun meta(fields: JsonValue?, top: JsonValue?) = obj("fields" to fields?.let { obj("fieldsA" to obj("baked" to it)) }, "fieldsA" to top?.let { obj("baked" to it) })
        assertEquals(setOf("foreignSea", "clipTarns"), GroundLoad.bakedPasses(meta(list("foreignSea", "clipTarns"), null)))
        assertEquals(setOf("foreignSea"), GroundLoad.bakedPasses(meta(null, list("foreignSea"))), "the top-level key alone")
        assertEquals(setOf("clipTarns"), GroundLoad.bakedPasses(meta(list("clipTarns"), list("foreignSea", "clipTarns"))), "fields wins")
        assertEquals(emptySet(), GroundLoad.bakedPasses(meta(list(), list("foreignSea", "clipTarns"))), "an empty list under fields bakes nothing (JS ?? keeps [])")
        assertEquals(setOf("foreignSea"), GroundLoad.bakedPasses(meta(JsonValue(JsonValue.ValueType.nullValue), list("foreignSea"))), "a null under fields falls through")
        assertEquals(emptySet(), GroundLoad.bakedPasses(meta(null, null)))
        assertEquals(emptySet(), GroundLoad.bakedPasses(meta(null, JsonValue("foreignSea"))).intersect(setOf("foreignSea", "clipTarns")), "a string iterates characters")
        assertFailsWith<IllegalStateException>("a number is not iterable (ground.js throws; the MAP band stays down)") { GroundLoad.bakedPasses(meta(JsonValue(5L), null)) }
    }

    /** Why: the two gem colours are what MAP multiplies its sea by; the rules (opaque texels only, strictly more than 30 over
     *  the mean luma, r > g warm else cool, one group repeated) decide whether Solana's shards read violet and cyan. */
    @Test fun `gemColours takes the highlight texels of the cell, split warm and cool, as ground js does`() {
        val w = 40; val cell = 32; val ox = 4; val oy = 2
        fun image(f: (Int, Int) -> IntArray?): ByteArray = ByteArray(w * 40 * 4).also { px ->
            for (y in 0 until 40) for (x in 0 until w) { val c = f(x - ox, y - oy) ?: intArrayOf(0, 0, 0, 0); for (k in 0 until 4) px[(y * w + x) * 4 + k] = c[k].toByte() } }
        val body = intArrayOf(40, 120, 160, 255); val warm = intArrayOf(230, 150, 250, 255); val cool = intArrayOf(150, 240, 250, 255)
        val lum = { c: IntArray -> 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] }
        // 1,000 body texels, 12 warm and 12 cool shards; outside the cell a bright frame that must not count
        val px = image { x, y -> if (x !in 0 until cell || y !in 0 until cell) intArrayOf(255, 255, 255, 255) else if (y == 5 && x < 12) warm else if (y == 9 && x < 12) cool else body }
        val got = assertNotNull(GroundTables.gemColours(px, w, ox, oy, cell))
        assertEquals(warm.take(3).map { it / 255.0 }, got[0].toList()); assertEquals(cool.take(3).map { it / 255.0 }, got[1].toList())
        // only one group lit → both colours are that group
        val one = assertNotNull(GroundTables.gemColours(image { x, y -> if (x !in 0 until cell || y !in 0 until cell) null else if (y == 5 && x < 12) cool else body }, w, ox, oy, cell))
        assertEquals(one[0].toList(), one[1].toList())
        // more than 30 over the mean luma (≈ 100.03 here): grey 131 is a gem, grey 129 is not
        val grey = intArrayOf(100, 100, 100, 255)
        fun one(v: Int) = GroundTables.gemColours(image { x, y -> if (x !in 0 until cell || y !in 0 until cell) null else if (x == 0 && y == 0) intArrayOf(v, v, v, 255) else grey }, w, ox, oy, cell)
        assertTrue(lum(intArrayOf(131, 131, 131)) > 130.05 && lum(intArrayOf(129, 129, 129)) < 130.0)
        assertNotNull(one(131), "31 over the mean is a gem"); assertNull(one(129), "29 over the mean is not")
        assertNull(one(100), "a flat cell has no gems")
        // translucent texels (alpha < 128) neither count for the mean nor as gems
        val glass = GroundTables.gemColours(image { x, y -> if (x !in 0 until cell || y !in 0 until cell) null else if (y == 5 && x < 12) intArrayOf(250, 10, 10, 127) else if (y == 9 && x < 12) cool else body }, w, ox, oy, cell)
        assertNotNull(glass); assertEquals(cool.take(3).map { it / 255.0 }, glass[0].toList(), "a translucent warm shard counted")
        assertNull(GroundTables.gemColours(image { _, _ -> intArrayOf(250, 250, 250, 0) }, w, ox, oy, cell), "no opaque texel")
        // gemK: colour ÷ max(mean, 0.02), clamped 0…8
        val k = assertNotNull(GroundTables.gemK(arrayOf(doubleArrayOf(0.5, 0.9, 0.001), doubleArrayOf(1.0, 0.0, 0.3)), doubleArrayOf(0.25, 0.1, 0.0)))
        assertEquals(listOf(2.0, 8.0, 0.05), k[0].map { Math.round(it * 1e9) / 1e9 }); assertEquals(listOf(4.0, 0.0, 8.0), k[1].toList())
        assertNull(GroundTables.gemK(null, doubleArrayOf(1.0, 1.0, 1.0))); assertNull(GroundTables.gemK(arrayOf(doubleArrayOf(1.0, 1.0, 1.0)), null))
    }

    /** Why: the gems are measured on the SEA loop's first cell as the PACK numbers it (before the reserved layer 0); the next
     *  cell would give another realm's colours. Only a gem-sea realm measures (the others keep MAP's ones). */
    @Test fun `the TRUE atlas measures the gem colours on the sea loop's first cell in a gem-sea realm only`() {
        val cell = 32; val colsA = 16
        val body = intArrayOf(45, 124, 166); val warm = intArrayOf(220, 170, 250); val cool = intArrayOf(170, 240, 245)
        class Pack(id: String) : GroundSource {
            private val inner = SyntheticGroundPack(id)
            val seaFirst = GroundTables.trueTables(inner.realmJson())!!.waterSeaFirstPack
            override fun realmJson(): JsonValue = inner.realmJson()
            override fun bytes(key: String): ByteArray? = inner.bytes(key)
            override fun image(bytes: ByteArray, key: String): RgbaImage? = inner.image(bytes, key)
            override fun png(key: String): RgbaImage? = if (key != "ground.png") inner.png(key) else {
                val g = inner.png(key)!!; val sx = (seaFirst % colsA) * cell; val sy = (seaFirst / colsA) * cell
                for (y in 0 until cell) for (x in 0 until cell) {
                    val c = if (y == 3 && x < 10) warm else if (y == 7 && x < 10) cool else body; val o = ((sy + y) * g.width + sx + x) * 4
                    for (k in 0 until 3) g.rgba[o + k] = c[k].toByte(); g.rgba[o + 3] = 255.toByte()
                }
                g
            }
        }
        val sr = Pack("seeker-reach"); val gem = assertNotNull(GroundLoad.trueAtlas(sr, sr.realmJson(), "seeker-reach"))
        val col = assertNotNull(gem.gemCol, "Solana Reach measures its gems")
        assertEquals(warm.map { it / 255.0 }, col[0].toList()); assertEquals(cool.map { it / 255.0 }, col[1].toList())
        val kit = assertNotNull(gem.kitWater)
        assertEquals(GroundTables.gemK(col, kit)!!.map { it.toList() }, gem.gemK!!.map { it.toList() })
        val cl = Pack("crownlands"); val plain = assertNotNull(GroundLoad.trueAtlas(cl, cl.realmJson(), "crownlands"))
        assertNull(plain.gemCol); assertNull(plain.gemK)
    }

    /** Why: GA2-05's clamp held five realms; the three darker MAP arts need 2.4 or their d 48 grade stops short of the
     *  painting. A slot whose painting/art ratio is 3 must stop at the realm's own upper bound. */
    @Test fun `the MAP family grade clamps each channel to the realm's famClamp`() {
        val cell = 32; val img = RgbaImage(cell * 16, cell * 6, ByteArray(cell * 16 * cell * 6 * 4) { if (it % 4 == 3) 255.toByte() else 40 })
        val atlas = JsonReader().parse("""{"wild":[0,4],"families":{"M1":0,"M2":16,"M3":32,"M4":48,"M5":64}}""")
        val meta = GroundGolden.suite("classify-crownlands").get("laneMeta")
        val mapT = assertNotNull(GroundTables.mapTables(meta))
        val bright = DoubleArray(3) { 120.0 / 255 } // 3 × the art's 40
        val pal = GroundPalette(Array(14) { bright }, IntArray(14) { 100 }, bright, bright, bright, bright, bright, bright, bright, bright, bright, bright, bright,
            arrayOf(bright, bright, bright), bright, arrayOf(doubleArrayOf(0.0, 0.0, 0.0, 0.0)), bright)
        for ((fc, hi) in listOf(GroundTables.famClamp(obj("id" to JsonValue("crownlands"))) to 1.8, GroundTables.famClamp(obj("id" to JsonValue("thornwake"))) to 2.4)) {
            val k = GroundLoad.familyGrade(img, atlas, 96, cell, 16, mapT, pal, fc)
            val graded = (0 until 6).filter { sl -> k[sl * 3] != 1.0 }
            assertTrue(graded.isNotEmpty(), "no slot was graded")
            for (sl in graded) for (i in 0 until 3) assertEquals(hi, k[sl * 3 + i], "slot $sl channel $i")
        }
    }
}
