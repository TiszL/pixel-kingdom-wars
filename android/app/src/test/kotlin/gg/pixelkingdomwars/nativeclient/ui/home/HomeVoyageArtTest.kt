package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.charter.CharterGrammar
import gg.pixelkingdomwars.nativeclient.charter.charterObject
import gg.pixelkingdomwars.nativeclient.data.worldContentGroups
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoutes
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** S5: the Lodge, Berth and collect card draw the real island art without keeping world content open. AUTHORED / UNRUN. */
class HomeVoyageArtTest {
    private val vector = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-route-vectors.json")).readText()).jsonObject
    private val catalogue = OrdinaryRoutes.from(vector.charterObject("constants").charterObject("ordinaryRoutes"),
        vector.charterObject("constants").charterObject("vehicles").getValue("tiers").jsonArray.map { CharterGrammar.number(it) })

    @Test fun `art lease is held only while route art is on screen`() {
        // The mount provides this source around the always-composed Home overlay host. Only a card or cutout that still
        // waits for its decode may keep world content open, and the last one leaving must close it again.
        val users = HomeVoyageArtUsers()
        assertFalse("nothing composed, nothing held", users.active)
        val card = users.acquire(); val cutout = users.acquire()
        assertTrue(users.active)
        users.release(card)
        assertTrue("the header cutout still needs the session", users.active)
        users.release(card)
        users.release(Any())
        assertTrue("a repeated or foreign release must not drop another user's hold", users.active)
        users.release(cutout)
        assertFalse(users.active)
        users.release(cutout)
        assertFalse(users.active)
        val again = users.acquire()
        assertTrue("reopening the sheet opens the art again", users.active)
        users.release(again)
        assertFalse(users.active)
    }

    @Test fun `cutout mask sits beside the detail atlas at the same cell`() {
        // SPEC 0.3: a cutout is the route card times its chain mask, texel for texel. The crop loader acquires the one
        // content group that pins the requested path, so the mask must live in the same chain group as the card.
        val render = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/iw3/render-catalog.json"))
            .bufferedReader().use { it.readText() }).jsonObject
        val groups = worldContentGroups(render.charterObject("fantasy"))
        fun group(path: String) = groups.single { g -> g.files.any { it.path == path } }.id
        for (route in catalogue.routes) {
            val card = catalogue.crop(route.id); val mask = voyageCutoutMaskCrop(card)
            assertEquals("atlas/fantasy/globe/generated/${route.chain}-detail-mask.png", mask.path)
            assertEquals(listOf(card.x, card.y, card.cell, card.atlas), listOf(mask.x, mask.y, mask.cell, mask.atlas))
            assertEquals("chain-${route.chain}", group(card.path))
            assertEquals(group(card.path), group(mask.path))
        }
    }

    @Test fun `an unknown route id falls back to the stand-in instead of throwing`() {
        // The catalogue throws for an id it does not know; inside a composable that would take the whole Lodge sheet down,
        // so the source answers null and the stand-in draws.
        assertThrows(RuntimeException::class.java) { catalogue.crop("atlantis-1") }
        assertNull(homeVoyageCrop(catalogue, "atlantis-1"))
        assertNull("no installed catalogue yet", homeVoyageCrop(null, catalogue.routes.first().id))
        for (route in catalogue.routes) assertEquals(catalogue.crop(route.id), homeVoyageCrop(catalogue, route.id))
    }

    @Test fun `only texels the globe calls land keep the island so no card edge shows`() {
        // FantasyGlobeRenderer draws a chain texel as island only when the mask's red byte is exactly 1 (green carries the
        // island index). Everything else must turn fully transparent, or the card's own square sea shows in the header.
        val card = intArrayOf(0xFF21405A.toInt(), 0xFF4E7A35.toInt(), 0xFFD9C48A.toInt(), 0xFF2A5272.toInt())
        val mask = intArrayOf(0xFF000000.toInt(), 0xFF010400.toInt(), 0xFF010000.toInt(), 0xFF020000.toInt())
        assertArrayEquals(intArrayOf(0, card[1], card[2], 0), voyageCutoutPixels(card, mask))
        assertTrue(voyageMaskIsLand(0xFF010300.toInt()))
        assertFalse(voyageMaskIsLand(0xFF000100.toInt()))
        assertThrows(IllegalArgumentException::class.java) { voyageCutoutPixels(card, mask.copyOf(3)) }
    }

    @Test fun `decoded art keeps a whole picker of islands and forgets the least recently shown`() {
        // The picker shows every island at once; a cap below that would decode tiles again on every scroll, and an
        // unbounded cache would keep every 320 px cell for the whole session.
        assertTrue(HOME_VOYAGE_ART_CACHE_SIZE >= catalogue.routes.size)
        val cache = HomeVoyageArtCache<String, Int>(HOME_VOYAGE_ART_CACHE_SIZE)
        repeat(HOME_VOYAGE_ART_CACHE_SIZE) { cache.put("island-$it", it) }
        assertEquals(0, cache["island-0"])
        cache.put("header-cutout", -1)
        assertEquals(HOME_VOYAGE_ART_CACHE_SIZE, cache.size)
        assertNull("the least recently shown island goes first", cache["island-1"])
        assertEquals("an island shown again stays", 0, cache["island-0"])
        assertEquals(-1, cache["header-cutout"])
        cache.clear()
        assertEquals(0, cache.size)
    }

    @Test fun `the overlay host opens no world content until route art asks for it`() {
        // The mount provides this source around the always-composed Home overlay host; opening eagerly would hold a
        // world-content lease for the whole session. The only open sits behind the refcount and the STARTED lifecycle.
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeVoyageArt.kt").readText()
        assertEquals(1, Regex("""worldContent\.open\(""").findAll(source).count())
        val gate = source.indexOf("snapshotFlow { art.users.active }.collectLatest { active ->")
        val open = source.indexOf("if (active) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { art.hold(graph, session) }")
        assertTrue(gate >= 0 && open > gate)
        assertTrue(source.indexOf("graph.worldContent.open(content, session.api)") > source.indexOf("suspend fun hold("))
    }
}
