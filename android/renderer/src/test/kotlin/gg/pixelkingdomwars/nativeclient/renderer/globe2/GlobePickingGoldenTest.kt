package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.GlobeIsland
import java.security.MessageDigest
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Globe picking against the web's frozen geography (GLOBE-NATIVE-PLAN §7 "globe realm/island/chain pick at 5,000
 * points, never a tile"): the client pack's two masks, read by [GlobeGeography], give the concept's tap rule (a realm on
 * visible land, else nothing) and the exploration code at every golden point, exactly. Why: a tap must open the realm
 * the player sees on the painted globe, and the realm the map will open; a mismatch would open the wrong realm's panel.
 */
class GlobePickingGoldenTest {
    private val g = Goldens.json("picking.json")
    private val geography = requireNotNull(GlobeGeography.fromMasks(Goldens.bytes("surface-mask.png"), Goldens.bytes("realm-mask.png")))

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    @Test fun `the masks are the pack's, and the realm order is REALMS`() {
        assertEquals(g.get("masks").getString("surface-mask.png"), sha(Goldens.bytes("surface-mask.png")))
        assertEquals(g.get("masks").getString("realm-mask.png"), sha(Goldens.bytes("realm-mask.png")))
        assertEquals(g.get("regionIds").asStringArray().toList(), GlobeV2Pin.REALMS.map { it.id })
        assertEquals(GlobeV2Pin.GEO_W, geography.width); assertEquals(GlobeV2Pin.GEO_H, geography.height)
    }

    @Test fun `realm and exploration codes match the web at 5,000 points`() {
        var land = 0; var explore = 0
        for (p in g.get("picks")) {
            val lon = p.getDouble(0); val lat = p.getDouble(1)
            assertEquals(p.getInt(2), geography.realmAt(lon, lat), "realm at ($lon, $lat)")
            assertEquals(p.getInt(3), geography.exploreAt(lon, lat), "exploration code at ($lon, $lat)")
            if (p.getInt(2) >= 0) land++; if (p.getInt(3) > 0) explore++
        }
        assertTrue(land > 1000 && explore > 5, "both kinds are sampled: $land realm points, $explore exploration points")
    }

    @Test fun `the picker answers the web's realm rule far from the islands`() {
        val picking = GlobePicking(geography, GlobeV2Pin.REALMS.map { it.id }, null, null)
        for (p in g.get("picks")) {
            val r = p.getInt(2); val pick = picking.pick(p.getDouble(0), p.getDouble(1), 1.0)
            if (p.getInt(3) > 0) { assertIs<GlobePickV2.Exploration>(pick); continue }
            if (r < 0) assertIs<GlobePickV2.Nothing>(pick) else assertEquals(GlobeV2Pin.REALMS[r].id, assertIs<GlobePickV2.Realm>(pick).id)
        }
    }

    @Test fun `realm framing geometry matches main js realmGeom`() {
        for ((r, w) in g.get("geoms").withIndex()) {
            val geom = geography.realmGeom(r)
            assertEquals(w.getString("id"), GlobeV2Pin.REALMS[r].id)
            assertEquals(w.getInt("pts"), geom.count, "${w.getString("id")} outline points")
            for (i in 0 until 3) assertTrue(abs(w.get("c").getDouble(i) - geom.c[i]) < 1e-9, "${w.getString("id")} frame centre")
            val head = w.get("ptsHead")
            for (k in 0 until head.size) for (i in 0 until 3) assertTrue(abs(head.get(k).getDouble(i) - geom.pts[k * 3 + i]) < 1e-9, "${w.getString("id")} outline point $k")
            val sum = DoubleArray(3); for (k in 0 until geom.count) for (i in 0 until 3) sum[i] += geom.pts[k * 3 + i]
            for (i in 0 until 3) assertTrue(abs(w.get("ptsSum").getDouble(i) - sum[i]) < 1e-6, "${w.getString("id")} outline sum")
        }
    }

    @Test fun `exploration islands pick as the legacy globe does (RG-1 picking unchanged)`() {
        val islands = Goldens.json("islands.json")
        val shape = islands.get("shape")
        val list = ArrayList<GlobeIsland>()
        islands.get("chains").forEachIndexed { c, chain -> chain.get("islands").forEachIndexed { s, i -> list += GlobeIsland(c, s, i.getDouble("lon"), i.getDouble("lat"), i.getDouble("rx"), i.getDouble("ry")) } }
        assertEquals(32, list.size, "the 32 exploration islands")
        val art = GlobeArt(islands.get("chains").map { it.getString("id") }, list, shape.getInt("cell"), shape.getInt("atlas"), shape.getDouble("extent"),
            "", 1, 1, emptyList(), "", 1, 1, emptyList(), "", 720, 360, { false }, { false }, { _, _ -> false })
        // precise masks: land only at the island's own centre texel, so the rule is visible
        val land = Array(art.chainIds.size) { java.util.BitSet(art.atlas * art.atlas) }
        for (isle in list) art.islandAt(isle.lon, isle.lat)?.let { land[it.island.chain].set(it.y * art.atlas + it.x) }
        val picking = GlobePicking(geography, GlobeV2Pin.REALMS.map { it.id }, art, land)
        for (isle in list) {
            val close = assertIs<GlobePickV2.Exploration>(picking.pick(isle.lon, isle.lat, 4.0))
            val hit = art.islandAt(isle.lon, isle.lat)!!
            assertEquals(hit.island.chain, close.chain); assertEquals(hit.island.slot, close.island, "close zoom picks the island by its art")
        }
        // off the art's land texel but inside its box, close zoom picks nothing (the legacy precise-mask rule)
        val first = list.first()
        assertIs<GlobePickV2.Nothing>(picking.pick(first.lon + first.rx * 0.6, first.lat, 4.0))
        // Phase E stays inert while its layer is off (RG-3)
        for (p in GlobeV2Pin.PHASE_E) assertTrue(picking.pick(p.lon, p.lat, 1.0) !is GlobePickV2.PhaseE)
        picking.phaseE = true
        for (p in GlobeV2Pin.PHASE_E) assertEquals(p.id, assertIs<GlobePickV2.PhaseE>(picking.pick(p.lon, p.lat, 1.0)).id)
    }

    /** D-172: with the layer live, a tap anywhere inside an island's D-165 tap ellipse (main.js tap: dx·cos(lat)/rx,
     *  dy/ry, both in degrees of arc) opens that island, at any zoom, before any realm or exploration island under it;
     *  just outside it the tap falls through to what is there. Why: the owner taps the island they see. */
    @Test fun `with the Phase E layer live every tap inside a D-165 ellipse picks that island, and none outside it`() {
        val picking = GlobePicking(geography, GlobeV2Pin.REALMS.map { it.id }, null, null)
        var inside = 0
        for (p in GlobeV2Pin.PHASE_E) {
            val cl = kotlin.math.cos(p.lat * V.RAD)
            for (a in 0 until 36) for (k in listOf(0.0, 0.3, 0.6, 0.95, 1.05)) {
                val lon = p.lon + kotlin.math.cos(a * 10 * V.RAD) * p.rx * k / cl; val lat = p.lat + kotlin.math.sin(a * 10 * V.RAD) * p.ry * k
                picking.phaseE = false
                assertTrue(picking.pick(lon, lat, 4.0) !is GlobePickV2.PhaseE, "off (RG-3): never an island")
                assertEquals(null, picking.phaseEAt(lon, lat))
                picking.phaseE = true
                for (footprint in listOf(0.5, 4.0)) {
                    val pick = picking.pick(lon, lat, footprint)
                    if (k < 1) { assertEquals(p.id, assertIs<GlobePickV2.PhaseE>(pick, "${p.id} k=$k a=$a").id); inside++ }
                    else assertTrue(pick !is GlobePickV2.PhaseE || pick.id != p.id, "${p.id}: just outside its ellipse (k=$k, a=$a) is not the island")
                }
                if (k < 1) assertEquals(p.id, picking.phaseEAt(lon, lat))
            }
        }
        assertEquals(3 * 36 * 4 * 2, inside)
    }
}
