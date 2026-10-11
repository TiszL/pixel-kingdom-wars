package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CyclicBarrier
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The realm pack loader (web `loader.js` + native CLAUDE.md "content activates only after hash verification"), on the
 * synthetic fixture packs of `tools/world-fixtures.mjs`. The rule under test: a realm whose bytes do not match what
 * pins them, or whose mask disagrees with its own declared deed count, never opens, and the catalog (not the pack)
 * decides which deeds exist.
 */
class RealmLoaderTest {
    private val config = RealmWebPin.CONFIG

    @Test fun `a verified pack lists its realms and decodes the first-frame set with its mip chain and minimap fields`() {
        val loader = RealmLoader(FixturePack("overview"), PNG_DECODER)
        val index = loader.index()
        assertEquals(listOf("alpha", "wrap"), index.map { it.id })
        assertEquals(listOf("ready", "preview"), index.map { it.status })
        for (id in listOf("alpha", "wrap")) {
            val fs = loader.firstSet(id, config, null)
            assertEquals(fs.meta.deeds, fs.deeds.count { (it.toInt() and 0xff) == 255 }, "$id deed count")
            assertEquals(fs.grid.cols * fs.grid.rows, fs.deeds.size)
            assertFalse(fs.catalogUsed); assertEquals(0, fs.maskMismatch)
            val top = fs.chartLevels.first(); val last = fs.chartLevels.last()
            assertEquals(fs.meta.chartW, top.width); assertEquals(fs.meta.chartH, top.height)
            assertEquals(1, last.width); assertEquals(1, last.height)
            for (i in 1 until fs.chartLevels.size) assertEquals(maxOf(1, fs.chartLevels[i - 1].width / 2), fs.chartLevels[i].width)
            for (i in fs.deeds.indices) if ((fs.deeds[i].toInt() and 0xff) == 255) assertEquals(0, fs.far[i].toInt(), "$id: own deeds are distance 0")
            assertTrue(fs.sea.all { it in 0f..1f })
        }
    }

    @Test fun `the dateline realm's grid wraps to the east edge of the catalog lattice`() {
        val fs = RealmLoader(FixturePack("overview"), PNG_DECODER).firstSet("wrap", config, null)
        assertTrue(fs.grid.x0 < 0)
        val t = fs.grid.tileId(0, 0)
        assertEquals(RealmGrid.LATTICE_W + fs.grid.x0, t % RealmGrid.LATTICE_W, "column x0 < 0 is the lattice's east end")
        assertEquals(0, fs.grid.deedX(t)); assertEquals(0, fs.grid.deedY(t))
        // a point just east of the antimeridian enters inside the realm instead of clamping to its edge
        val lon = fs.grid.lonAt(0.5)
        assertTrue(lon > 170, "lon $lon")
        assertEquals(0.5, fs.grid.xAtLon(lon), 1e-9)
    }

    @Test fun `a byte that does not match the sha256 its realm json pins refuses the realm`() {
        val e = assertFailsWith<RealmPackException> { RealmLoader(FixturePack("tampered"), PNG_DECODER).firstSet("alpha", config, null) }
        assertContains(e.message!!, "sha256")
    }

    @Test fun `a mask whose deed count disagrees with realm json refuses the realm`() {
        val e = assertFailsWith<RealmPackException> { RealmLoader(FixturePack("miscounted"), PNG_DECODER).firstSet("wrap", config, null) }
        assertContains(e.message!!, "deeds")
    }

    @Test fun `the outer content manifest is checked on top of the pack's own hashes`() {
        val wrong = "0".repeat(64)
        val e = assertFailsWith<RealmPackException> {
            RealmLoader(FixturePack("overview", mapOf("realm/alpha/realm.json" to wrong)), PNG_DECODER).firstSet("alpha", config, null)
        }
        assertContains(e.message!!, "content manifest")
        val pack = FixturePack("overview")
        RealmLoader(pack, PNG_DECODER).firstSet("alpha", config, null)
        assertEquals(listOf("realm/alpha/realm.json", "realm/alpha/chart8.png", "realm/alpha/deeds.png"), pack.reads, "only the first-frame set is read")
    }

    @Test fun `with a catalog the engine's mask is the catalog's and the pack's disagreement is counted, not trusted`() {
        val loader = RealmLoader(FixturePack("overview"), PNG_DECODER)
        val plain = loader.firstSet("alpha", config, null)
        val g = plain.grid
        // the catalog: every deed the pack paints as alpha's, except one, plus one deed the pack paints as none
        val tiles = ArrayList<Int>()
        var dropped = -1; var added = -1
        for (dy in 0 until g.rows) for (dx in 0 until g.cols) {
            val v = plain.packDeeds[dy * g.cols + dx].toInt() and 0xff
            val t = g.tileId(dx, dy)
            if (v == 255) { if (dropped < 0) { dropped = t; continue }; tiles += t } else if (v == 0 && added < 0) { added = t; tiles += t }
        }
        tiles.sort()
        val runs = IntArray(tiles.size * 2) { tiles[it / 2] }
        val fs = loader.firstSet("alpha", config, RealmCatalog(mapOf("alpha" to runs)))
        assertTrue(fs.catalogUsed)
        assertEquals(2, fs.maskMismatch)
        assertEquals(0, fs.deeds[g.deedY(dropped) * g.cols + g.deedX(dropped)].toInt(), "the catalog's missing deed is not drawn as alpha's")
        assertEquals(255, fs.deeds[g.deedY(added) * g.cols + g.deedX(added)].toInt() and 0xff, "the catalog's extra deed is")
        // picking reads the engine's mask: the pack-only deed is not an open deed
        val pack = plain.packDeeds.copyOf()
        assertEquals(255, pack[g.deedY(dropped) * g.cols + g.deedX(dropped)].toInt() and 0xff)
    }

    @Test fun `farDeeds is the web's chamfer distance in Float32 and its R8 bytes round like Math round`() {
        val deeds = byteArrayOf(255.toByte(), 0, 0, 0, 0, 0)
        val d = RealmLoader.farDeeds(deeds, 3, 2, 255)
        assertEquals(listOf(0f, 1f, 2f, 1f, Math.sqrt(2.0).toFloat()), d.toList().take(5))
        assertEquals(1 + Math.sqrt(2.0), d[5].toDouble(), 1e-6, "two relaxations meet at a Float32 tie here: bytes below decide")
        val bytes = RealmLoader.farBytes(deeds, 3, 2, 255)
        assertEquals(listOf(0, 16, 32, 16, 23, 39), bytes.map { it.toInt() and 0xff }) // 22.627 → 23, 38.627 → 39
        assertEquals(255, RealmLoader.farBytes(ByteArray(4), 2, 2, 255)[0].toInt() and 0xff, "no own deed: the far cap")
    }

    @Test fun `the mip chain box-averages down to one texel and the ring sea prefers blue-dominant rim pixels`() {
        val img = RgbaImage(3, 2, byteArrayOf(0, 0, 0, 0, 100, 100, 100, 100, 50, 50, 50, 50, 200.toByte(), 200.toByte(), 200.toByte(), 200.toByte(), 100, 100, 100, 100, 0, 0, 0, 0))
        val chain = RealmLoader.mipChain(img)
        assertEquals(2, chain.size)
        assertEquals(100, chain[1].rgba[0].toInt() and 0xff, "(0 + 100 + 200 + 100 + 2) / 4")
        val blue = RgbaImage(8, 8, ByteArray(8 * 8 * 4) { i -> when (i % 4) { 0 -> 20; 1 -> 40; 2 -> 120; else -> -1 }.toByte() })
        val sea = RealmLoader.ringSea(blue)
        assertEquals(20 / 255.0, sea[0].toDouble(), 1e-6); assertEquals(120 / 255.0, sea[2].toDouble(), 1e-6)
        val red = RgbaImage(8, 8, ByteArray(8 * 8 * 4) { i -> when (i % 4) { 0 -> 200.toByte(); 3 -> -1; else -> 10 } })
        assertEquals(200 / 255.0, RealmLoader.ringSea(red)[0].toDouble(), 1e-6, "no blue rim: the mean of the whole ring")
    }

    /**
     * P0 (2026-09-26): LIFE's and BASES' loads parse realm.json on the host's two world-load threads at once, and a realm's
     * first set can still be parsing on one when a context restore or the next prepare starts another on the other. A
     * JsonReader keeps its parse state in fields, so one reader shared by both threads read one realm as another or threw.
     */
    @Test fun `two world-load threads parse realm json at once and each reads its own realm`() {
        val files = object : RealmPackFiles { override fun read(path: String): ByteArray? = RealmTestData.resource("/world/fixtures/packs/overview/$path") }
        val loader = RealmLoader(files, PNG_DECODER); val pack = LanePack(files) { _, _ -> null }
        val cols = mapOf("alpha" to loader.meta("alpha").cols, "wrap" to loader.meta("wrap").cols)
        assertTrue(cols.getValue("alpha") != cols.getValue("wrap"), "the two fixture realms must differ, or a mix-up goes unseen")
        val errors = ConcurrentLinkedQueue<String>()
        val start = CyclicBarrier(2)
        val threads = listOf("alpha", "wrap").map { id ->
            Thread {
                start.await()
                repeat(500) {
                    try {
                        val m = loader.meta(id)
                        if (m.id != id || m.cols != cols[id]) errors += "RealmLoader read $id as ${m.id} (${m.cols} columns)"
                        val j = pack.realmJson(id)
                        if (j.getString("id", null) != id || j.get("grid").getInt("cols") != cols[id]) errors += "LanePack read $id as ${j.getString("id", null)}"
                    } catch (e: Exception) { errors += "$id: $e" }
                }
            }
        }
        threads.forEach { it.start() }; threads.forEach { it.join() }
        assertTrue(errors.isEmpty(), "${errors.size} bad parses, e.g. ${errors.take(3)}")
    }
}
