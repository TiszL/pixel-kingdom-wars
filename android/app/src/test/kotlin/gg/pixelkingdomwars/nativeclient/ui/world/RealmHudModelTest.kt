package gg.pixelkingdomwars.nativeclient.ui.world

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The realm-map HUD's pure logic is a port of the approved web ui.js/map.js (D-167). The functions the web exports are
 * compared with golden vectors produced by the pinned modules themselves (tools/world-hud.mjs); the closure-internal
 * ones (tags, search, the next/previous walk) are held to the rules that made the web version approved.
 */
class RealmHudModelTest {
    private val vectors = HudReference.json.getValue("vectors").jsonObject

    @Test fun `scale bar matches the web for every zoom, deeds far and tiles close`() {
        val tiles = vectors.getValue("tiles").jsonPrimitive.int
        assertEquals("98 tiles per deed at the pin (BASE_GROUND_WORLD_GEOMETRY)", 98, tiles)
        val cases = vectors.getValue("scaleBar").jsonArray
        assertTrue(cases.size > 400)
        for (c in cases) {
            val s = c.jsonObject.getValue("s").jsonPrimitive.double
            val out = c.jsonObject.getValue("out").jsonArray
            assertEquals("s=$s", out[0].jsonPrimitive.int to out[1].jsonPrimitive.content, RealmHudModel.scaleBar(s, tiles))
        }
    }

    @Test fun `the base card shows the approved facts in the approved order and fakes none`() {
        // ui.js card(b) at the pin: Trophies (when known), Clan (the tag, or a dash), Claim (plotRule(L).claim squared tiles),
        // Location. The server's parcel read carries player.clanTag; the claim table is the constants catalogue's.
        val all = RealmHudModel.cardFacts(12345, clanInRead = true, clanTag = "ORC", claimTiles = 18, x = 360, y = 180, columns = 720, rows = 360)
        assertEquals(listOf("Trophies", "Clan", "Claim", "Location"), all.map { it.first })
        assertEquals(listOf("12,345", "ORC", "18×18 tiles", RealmHudModel.lonLat(360, 180, 720, 360)), all.map { it.second })
        assertEquals("no clan is a dash, as on the web", "—",
            RealmHudModel.cardFacts(null, clanInRead = true, clanTag = null, claimTiles = 14, x = 0, y = 0, columns = 720, rows = 360).first { it.first == "Clan" }.second)
        assertEquals("a read without the clan field and a catalogue without the claim table show neither (D-169: never faked)",
            listOf("Location"), RealmHudModel.cardFacts(null, clanInRead = false, clanTag = null, claimTiles = null, x = 0, y = 0, columns = 720, rows = 360).map { it.first })
    }

    @Test fun `the Claim fact is the web's plotRule claim, read from the native constants catalogue`() {
        // The card reads CAMPAIGN.claimTilesByKeep[L − 1] from the admitted catalogue (no Kotlin number); the bundled
        // catalogue must give the pinned web plotRule(L).claim at every level NT's contracts golden samples (its plotRule
        // suite probes the edges: L1, L2, L3, L7, L20, with clamped inputs).
        val table = Json.parseToJsonElement(java.io.File("src/main/assets/native/catalogue.json").readText()).jsonObject
            .getValue("constants").jsonObject.getValue("CAMPAIGN").jsonObject.getValue("claimTilesByKeep").jsonArray.map { it.jsonPrimitive.int }
        assertEquals("one claim per keep level", 20, table.size)
        val golden = Json.parseToJsonElement(java.io.File("../renderer/src/test/resources/world/golden/contracts.json").readText()).jsonObject
            .getValue("plotRule").jsonArray.map { it.jsonObject }
            .associate { it.getValue("level").jsonPrimitive.int to it.getValue("claim").jsonPrimitive.int }
        assertTrue("the golden samples the first, a middle and the last level", golden.keys.containsAll(listOf(1, 7, 20)))
        for ((level, claim) in golden) assertEquals("L$level", claim, table[level - 1])
        assertEquals("the card shows that claim squared", "${golden.getValue(20)}×${golden.getValue(20)} tiles",
            RealmHudModel.cardFacts(null, false, null, table[19], 0, 0, 720, 360).first { it.first == "Claim" }.second)
    }

    @Test fun `cluster counters match the web exactly on every golden case`() {
        for (case in vectors.getValue("clusters").jsonArray.map { it.jsonObject }) {
            val name = case.getValue("name").jsonPrimitive.content
            val bases = case.getValue("bases").jsonArray.map { it.jsonArray }
            val n = bases.size
            val bx = IntArray(n) { bases[it][0].jsonPrimitive.int }; val by = IntArray(n) { bases[it][1].jsonPrimitive.int }
            val mine = BooleanArray(n) { bases[it][2].jsonPrimitive.int == 1 }
            val cam = case.getValue("cam").jsonObject
            val chrome = case.getValue("chrome").jsonArray.map { r -> r.jsonArray.map { it.jsonPrimitive.double }.toDoubleArray() }
            val box = case.getValue("box").jsonArray.map { it.jsonPrimitive.double }.toDoubleArray()
            val res = RealmHudModel.clusterCounters(bx, by, mine, n, cam.getValue("x").jsonPrimitive.double, cam.getValue("y").jsonPrimitive.double,
                case.getValue("s").jsonPrimitive.double, case.getValue("W").jsonPrimitive.double, case.getValue("H").jsonPrimitive.double, chrome, box)
            val want = case.getValue("list").jsonArray.map { it.jsonObject }
            assertEquals("$name on screen", case.getValue("onScreen").jsonPrimitive.int, res.onScreen)
            assertEquals("$name counters", want.size, res.list.size)
            want.zip(res.list).forEachIndexed { i, (w, c) ->
                assertEquals("$name[$i].n", w.getValue("n").jsonPrimitive.int, c.n)
                assertEquals("$name[$i].mine", w.getValue("mine").jsonPrimitive.boolean, c.mine)
                for ((k, v) in listOf("px" to c.px, "py" to c.py, "w" to c.w, "u" to c.u, "v" to c.v))
                    assertEquals("$name[$i].$k", w.getValue(k).jsonPrimitive.double, v, 1e-9 * maxOf(1.0, kotlin.math.abs(v)))
            }
            // The web's own invariant (V1): every on-screen base is counted exactly once.
            assertEquals(name, res.onScreen, res.list.sumOf { it.n })
        }
    }

    @Test fun `your kingdom's counter stays gold through a cell and a merge, and the count is kept`() {
        // D-177 landing (owner 2026-09-26: no names when not zoomed in, the web's photo-1 counters): a counter carries only
        // the web's fields, the count and whether yours is inside. That gold is how the player finds their own kingdom at
        // the globe's scale, so no cell or merge may drop it, and no merge may lose a kingdom from the count.
        // (Rewritten from da1b7ee's top-base ranking test: the overview no longer names a cluster by its top base.)
        val W = 400.0; val H = 800.0; val box = doubleArrayOf(0.0, 0.0, W, H)
        // one cell of four bases around the centre (s = 10: a 5.66-deed cell), yours the last
        val cell = RealmHudModel.clusterCounters(intArrayOf(0, 2, 1, 3), intArrayOf(0, 2, 3, 1), booleanArrayOf(false, false, false, true), 4, 2.5, 2.5, 10.0, W, H, emptyList(), box)
        assertEquals("one counter holds all four", listOf(4), cell.list.map { it.n })
        assertTrue("yours is inside: gold", cell.list.single().mine)
        // two cells whose counters merge (10 dp apart at s = 10), yours in the second
        val merged = RealmHudModel.clusterCounters(intArrayOf(5, 6), intArrayOf(0, 0), booleanArrayOf(false, true), 2, 5.0, 0.0, 10.0, W, H, emptyList(), box)
        assertEquals("the merge keeps both kingdoms", listOf(2), merged.list.map { it.n })
        assertTrue("the merged counter is gold: yours is inside", merged.list.single().mine)
        val rival = RealmHudModel.clusterCounters(intArrayOf(5, 6), intArrayOf(0, 0), booleanArrayOf(false, false), 2, 5.0, 0.0, 10.0, W, H, emptyList(), box)
        assertFalse("a cluster without yours is not gold", rival.list.single().mine)
    }

    @Test fun `hypot follows V8 so distance thresholds agree to the bit`() {
        assertEquals(5.0, RealmHudModel.jsHypot(3.0, 4.0), 0.0)
        assertEquals(0.0, RealmHudModel.jsHypot(0.0, -0.0), 0.0)
        assertEquals(Double.POSITIVE_INFINITY, RealmHudModel.jsHypot(Double.NEGATIVE_INFINITY, Double.NaN), 0.0)
    }

    @Test fun `the filter combines one kind with the level range, and the sliders never cross`() {
        val a = RealmHudBase(1, 0, 0, "Ann", 5, mine = true); val b = RealmHudBase(2, 1, 0, "Bo", 12, mine = false, shield = true)
        assertTrue(RealmFilter().passes(a, null) && RealmFilter().passes(b, null))
        assertFalse(RealmFilter("mine").passes(b, null))
        // SHARDKEEP D-191: the shield chip is Unshielded, a raider's search; it keeps a shield bit the read carried as false
        assertTrue(RealmFilter("unshielded").passes(a.copy(shield = false), null)); assertFalse(RealmFilter("unshielded").passes(b, null))
        assertFalse("an unknown shield is never unshielded: an older server's read is hidden, not faked (D-169 / D-181)", RealmFilter("unshielded").passes(a, null))
        assertFalse(RealmFilter(lo = 6).passes(a, null))
        assertEquals(RealmFilter(lo = 15, hi = 15), RealmFilter(hi = 10).withLevel(0, 15))
        assertEquals(RealmFilter(lo = 3, hi = 3), RealmFilter(lo = 8).withLevel(1, 3))
        assertEquals("Level 3–9" to "Lv 3–9", RealmFilter(lo = 3, hi = 9).levelLabels())
        assertTrue(RealmFilter(lo = 2).active); assertFalse(RealmFilter().active)
    }

    @Test fun `search lists prefix matches first, then substrings, at most eight`() {
        val bases = listOf("alpha", "Albert", "palace", "Al", "zeta", "ball", "alabaster", "halo", "al2", "al3", "al4", "al5").mapIndexed { i, n -> RealmHudBase(i, i, 0, n, 1, false) }
        val r = RealmHudModel.search(bases, " AL ")
        assertEquals(8, r.size)
        assertEquals(listOf("al", "al2", "al3", "al4", "al5", "alabaster", "albert", "alpha"), r.map { it.name.lowercase() })
        assertEquals(listOf("alabaster", "palace"), RealmHudModel.search(bases, "ala").map { it.name })
        assertTrue(RealmHudModel.search(bases, "").isEmpty())
        assertEquals(listOf("palace", "ball", "halo").sorted(), RealmHudModel.search(bases.filterNot { it.name.lowercase().startsWith("al") }, "al").map { it.name }.sorted())
    }

    @Test fun `next and previous walk to the nearest base on that side, wrapping to the far end`() {
        val bases = listOf(RealmHudBase(1, 10, 10, "a", 1, false), RealmHudBase(2, 12, 10, "b", 1, false), RealmHudBase(3, 11, 30, "c", 1, false), RealmHudBase(4, 20, 10, "d", 1, false))
        assertEquals(2, RealmHudModel.step(bases, bases[0], 0.0, 0.0, 1)?.tileId)
        assertEquals("nothing further east: the westmost", 1, RealmHudModel.step(bases, bases[3], 0.0, 0.0, 1)?.tileId)
        assertEquals(1, RealmHudModel.step(bases, bases[1], 0.0, 0.0, -1)?.tileId)
        assertEquals("no selection walks from the camera", 1, RealmHudModel.step(bases, null, 9.0, 10.0, 1)?.tileId)
        assertNull(RealmHudModel.step(emptyList(), null, 0.0, 0.0, 1))
    }

    @Test fun `name tags never touch a control, stay in the safe box and cap at sixteen`() {
        val chrome = listOf(doubleArrayOf(0.0, 0.0, 400.0, 120.0), doubleArrayOf(330.0, 300.0, 400.0, 500.0))
        val box = doubleArrayOf(2.0, 2.0, 398.0, 888.0)
        val cands = (0 until 60).map { i -> RealmHudModel.TagCandidate(RealmHudBase(i, i, 0, "Keeper$i", 1 + i % 20, i == 7), 20.0 + (i * 37) % 380, 60.0 + (i * 53) % 820, i.toDouble()) }
        val tags = RealmHudModel.placeTags(cands, null, false, false, chrome, box, 16.0, 18.0)
        assertTrue(tags.size <= 16)
        for (t in tags) {
            val r = t.rect
            assertTrue(r[0] >= box[0] && r[1] >= box[1] && r[2] <= box[2] && r[3] <= box[3])
            for (c in chrome) assertFalse(r[0] < c[2] && r[2] > c[0] && r[1] < c[3] && r[3] > c[1])
        }
        for (i in tags.indices) for (j in i + 1 until tags.size) { val a = tags[i].rect; val b = tags[j].rect; assertFalse(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) }
        // The open card already names the selected base; in TRUE only the selected tag shows.
        val sel = cands[40].base
        assertTrue(RealmHudModel.placeTags(cands, sel, cardOpen = true, trueBand = false, chrome, box, 16.0, 18.0).none { it.base == sel })
        assertTrue(RealmHudModel.placeTags(cands, sel, cardOpen = false, trueBand = true, chrome, box, 16.0, 18.0).all { it.base == sel })
    }

    @Test fun `the title line quotes the server's counts with en-US separators`() {
        assertEquals("12,958 deeds · 1,204 kingdoms", RealmHudModel.subtitle(12958, 1204, 30, false))
        assertEquals("12,958 deeds · 1,204 kingdoms · 30 shown", RealmHudModel.subtitle(12958, 1204, 30, true))
        assertEquals("— deeds · — kingdoms", RealmHudModel.subtitle(null, null, 0, false))
        assertEquals("89.75°N 179.75°W", RealmHudModel.lonLat(0, 0, 720, 360))
        assertEquals(28.0, RealmHudModel.counterW(9), 0.0); assertEquals(32.0, RealmHudModel.counterW(99), 0.0); assertEquals(40.0, RealmHudModel.counterW(999), 0.0)
    }
}
