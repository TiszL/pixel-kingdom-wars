package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.baseJson
import gg.pixelkingdomwars.nativeclient.data.FantasyCatalog
import gg.pixelkingdomwars.nativeclient.data.LiveWorldRepository
import gg.pixelkingdomwars.nativeclient.data.WorldRealmFeed
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.FantasyGlobe
import gg.pixelkingdomwars.nativeclient.model.FantasyViewport
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.testHolder
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shield domes end to end, from the server's own realm-feed JSON to the flags the BASES lane draws domes from.
 * Code 30 on the owner's Seeker (2026-09-26, QA c9b0a083 with server PR #147): three kingdoms held live 3-day shields,
 * the owner's Sunscar base stood at TRUE ("keeps 1"), and every band line read "domes 0". The owner wants a dome on
 * every kingdom the server calls shielded, his own and his rivals', as the web draws them. A kingdom the feed calls
 * shielded but the map draws bare tells a raider it is open; a dome on a bare kingdom claims a protection the server
 * does not give. Only the server decides a raid; the dome and the UNSHIELDED chip (SHARDKEEP D-191: a raider searches for
 * the kingdoms a raid can reach, so the chip keeps the ones the feed called unshielded and never one whose bit it did
 * not carry) must say what it said.
 */
class WorldShieldFeedTest {
    private val columns = 720
    private val sunscar = "sunscar"
    /** Test geometry: the catalog lattice (720 × 360); row 100, columns 200..260 are Sunscar; tiles 1000..1100 Crownlands. */
    private val catalog = FantasyCatalog.parse(json("""{"membershipSha256":"c147","regions":[
        {"id":"crownlands","runs":[[1000,1100]]},{"id":"sunscar","runs":[[72200,72260]]}]}"""), columns, 360)
    private val ownSunscar = 100 * columns + 201 // p4-sunscar: yours, not the selected base
    private val foreign = 100 * columns + 203    // a rival's kingdom
    private val open = 100 * columns + 205       // a rival without a shield
    private val selectedTile = 1005              // your selected base, in Crownlands
    private val sunscarBaseId = "5a3c0de1-7a52-4c1e-9d0b-2f4e6a8b9c10"
    private val t0 = 7_000_000_000L

    /** Exactly the server's GET /globe/fantasy/parcels body (fantasyGlobe.ts getFantasyViewport after PR #147): worldId,
     *  scope (the zod-parsed rect, keys x0 x1 y0 y1), matched, truncated, and five-field markers. */
    private fun feedBody(shielded: (Int) -> String?): JsonObject {
        fun marker(tile: Int, name: String, avatar: String, level: Int) =
            """{"tileId":$tile,"name":"$name","avatarUrl":$avatar,"keepLevel":$level${shielded(tile)?.let { ""","shielded":$it""" } ?: ""}}"""
        return json("""{"worldId":"fantasy-v1","scope":{"x0":200,"x1":207,"y0":100,"y1":100},"matched":3,"truncated":false,"markers":[""" +
            marker(foreign, "dense-thornwake", "\"/api/avatars/0e7f4a52-9b1c-4d3e-8f6a-1b2c3d4e5f60.webp\"", 12) + "," +
            marker(ownSunscar, "p4", "null", 7) + "," + marker(open, "open-rival", "null", 6) + "]}")
    }

    /** Exactly the server's GET /globe/fantasy `me` (getFantasyGlobe): both your deeds, the Crownlands one selected. */
    private val globe = FantasyGlobe.from(json("""{"worldId":"fantasy-v1","catalogHash":"92a3","ready":true,"warzone":{"active":false},
        "realms":[{"realmId":"sunscar","total":61,"occupied":3,"held":0,"available":58,"anchorTileId":$ownSunscar}],
        "me":{"baseId":"$BASE_ID","selectedTileId":$selectedTile,"ownedTiles":[
        {"baseId":"$sunscarBaseId","tileId":$ownSunscar,"realmId":"sunscar","name":"p4","avatarUrl":null,"keepLevel":7,"active":true,"selected":false},
        {"baseId":"$BASE_ID","tileId":$selectedTile,"realmId":"crownlands","name":"p4","avatarUrl":null,"keepLevel":5,"active":true,"selected":true}]}}"""))

    /** The selected base's Home read (`GET /base`) with [shield] as the server sends it. */
    private fun homeRead(baseId: String, shield: String): WorldOwnShield? {
        val body = JsonObject(baseJson(baseId) + ("shield" to (if (shield == "null") JsonNull else json(shield))))
        val snapshot = BaseSnapshot.from(body)
        return WorldOwnShield.from(snapshot.baseId, snapshot.raw, t0)
    }

    /** The realm map's read through the live repository (its scope pin, frozen-catalog and field filters). */
    private fun read(body: JsonObject): FantasyViewport = runBlocking {
        val api = FakeApiClient(); val holder = testHolder(); val session = signedIn(holder)
        api.onGet("/globe/fantasy/parcels") { body }
        LiveWorldRepository(session, holder, api, { BASE_ID }, { null }, { catalog }).markers(200, 100, 207, 100)
    }

    /** The screen's chain: the feed's kingdoms of this realm + your deeds, then the snapshot the engine receives. */
    private fun snapshot(viewport: FantasyViewport, own: WorldOwnShield?, owned: List<gg.pixelkingdomwars.nativeclient.model.FantasyOwnedTile> = globe.me!!.ownedTiles,
                         filter: RealmFilter = RealmFilter()): Pair<List<RealmHudBase>, WorldBases> {
        val bases = realmHudBases(sunscar, viewport.markers, owned, { catalog.tile(it)?.realmId }, catalog.columns, own, t0)
        return bases to WorldHudFlow.basesSnapshot(1, sunscar, bases, filter, null, null)
    }

    private fun domed(s: WorldBases): Set<Int> =
        (0 until s.size).filter { s.flags[it] and RealmBases.FLAG_SHIELD != 0 }.mapTo(HashSet()) { s.deedY[it] * columns + s.deedX[it] }

    /** The renderer's side: the engine keeps the snapshot's flags per base (what BasesLane reads for its domes) and its
     *  UNSHIELDED filter keeps exactly the kingdoms the feed called unshielded (D-191). Test plot tables: the lane's
     *  geometry is not under test here. */
    private fun engine(s: WorldBases): RealmBases = RealmBases(RealmEngineWiring.plots(IntArray(20) { 10 + it }, IntArray(20) { 1 + it / 4 }, 98)).also {
        it.reset(columns, 360); it.set(s)
    }

    @Test fun `every kingdom the real feed calls shielded reaches the BASES snapshot as a dome, your unselected base included`() {
        val viewport = read(feedBody { tile -> if (tile == open) "false" else "true" })
        assertEquals("the repository keeps all three kingdoms of the window", setOf(foreign, ownSunscar, open), viewport.markers.mapTo(HashSet()) { it.tileId })
        assertTrue("the read carries the bit", viewport.carriesShielded)
        // Your Home read is the SELECTED base's (Crownlands, unshielded): it says nothing about Sunscar.
        val (bases, s) = snapshot(viewport, homeRead(BASE_ID, "null"))
        assertEquals("your Sunscar base is the feed's kingdom, marked yours", true, bases.single { it.tileId == ownSunscar }.mine)
        assertEquals("two domes: your unselected Sunscar base and the rival's", setOf(ownSunscar, foreign), domed(s))
        assertEquals("the lane's flag is the HUD's", HudFlag.SHIELD, RealmBases.FLAG_SHIELD)
        val e = engine(s)
        assertEquals("the engine keeps both dome flags", setOf(ownSunscar, foreign),
            (0 until e.size).filter { e.flags[it] and RealmBases.FLAG_SHIELD != 0 }.mapTo(HashSet()) { e.deedY[it] * columns + e.deedX[it] })
        assertTrue("the engine knows every feed kingdom's bit (D-191)", (0 until e.size).all { e.shieldKnown[it] })
        val chip = WorldFilter(WorldFilterKind.UNSHIELDED)
        assertEquals("the engine's UNSHIELDED filter keeps exactly the one the feed called unshielded (D-191)", setOf(open),
            (0 until e.size).filter { e.passes(it, chip) }.mapTo(HashSet()) { e.deedY[it] * columns + e.deedX[it] })
        assertEquals("the HUD offers the chip once the feed carries the bit", true, HudChips.realm(viewport.carriesShielded).any { it.id == "unshielded" })
        assertEquals("and the chip keeps the same one on the HUD", setOf(open),
            bases.filter { RealmFilter(kind = "unshielded").passes(it, null) }.mapTo(HashSet()) { it.tileId })
        assertEquals("FILTERED_IN follows the chip in the snapshot", setOf(open),
            snapshot(viewport, null, filter = RealmFilter(kind = "unshielded")).second.let { f ->
                (0 until f.size).filter { f.flags[it] and HudFlag.FILTERED_IN != 0 }.mapTo(HashSet()) { f.deedY[it] * columns + f.deedX[it] } })
    }

    @Test fun `your selected base's Home read never hides a dome the feed shows`() {
        // Sunscar selected. A Home read without a shield can predate the shield (QA's fixtures were written after the app
        // read /base; a raid-loss shield lands without any Home refresh); the feed is the raid gate's answer at its read.
        val owned = globe.me!!.ownedTiles.map { it.copy(selected = it.tileId == ownSunscar) }
        val shieldedFeed = read(feedBody { tile -> if (tile == open) "false" else "true" })
        for (home in listOf("null", """{"active":false,"expiresAt":null,"remainingMs":0,"suppressedByWarzone":false}""")) {
            val (_, s) = snapshot(shieldedFeed, homeRead(sunscarBaseId, home), owned)
            assertEquals("Home shield=$home must not remove your feed dome", setOf(ownSunscar, foreign), domed(s))
        }
        // The Home read still ADDS your dome the feed has not polled yet (a shield you just bought), timed by its countdown.
        val bareFeed = read(feedBody { "false" })
        val bought = homeRead(sunscarBaseId, """{"active":true,"expiresAt":"2026-09-29T08:11:00.000Z","remainingMs":60000,"suppressedByWarzone":false}""")
        assertEquals("your fresh shield shows before the next poll", setOf(ownSunscar), domed(snapshot(bareFeed, bought, owned).second))
        val later = realmHudBases(sunscar, bareFeed.markers, owned, { catalog.tile(it)?.realmId }, columns, bought, t0 + 60_000L * 1_000_000L)
        assertEquals("and goes when it ends, if the feed agrees", false, later.single { it.tileId == ownSunscar }.shield)
    }

    @Test fun `an older server's feed draws no dome, offers no chip, and would name no raid target`() {
        val old = read(feedBody { null })
        assertEquals("its kingdoms still load", 3, old.markers.size)
        assertFalse("it cannot say who is shielded", old.carriesShielded)
        val (bases, s) = snapshot(old, homeRead(BASE_ID, "null"))
        assertEquals("no dome on any feed kingdom", emptySet<Int>(), domed(s))
        assertFalse("and no UNSHIELDED chip", HudChips.realm(old.carriesShielded).any { it.id == "unshielded" })
        // D-191: its kingdoms' shields are unknown, not "unshielded": were the chip pressed anyway, it would keep nobody,
        // on the HUD and in the engine, rather than promise raid targets the server never named.
        assertEquals(listOf(null, null, null), bases.map { it.shield })
        assertEquals(emptyList<Int>(), bases.filter { RealmFilter(kind = "unshielded").passes(it, null) }.map { it.tileId })
        val e = engine(s)
        assertTrue("the engine learnt no bit", (0 until e.size).none { e.shieldKnown[it] })
        assertTrue((0 until e.size).none { e.passes(it, WorldFilter(WorldFilterKind.UNSHIELDED)) })
    }

    @Test fun `the feed diagnostic is one line per read with the kingdoms and the shielded ones`() {
        val viewport = read(feedBody { tile -> if (tile == open) "false" else "true" })
        assertEquals("[world-feed] realm sunscar markers 3 shielded 2", WorldRealmFeed.feedLine("sunscar", viewport.markers))
        assertEquals("[world-feed] realm sunscar markers 3 shielded 0", WorldRealmFeed.feedLine("sunscar", read(feedBody { null }).markers))
        // The Seeker's evidence: printed through the one world gate (release prints nothing), once per completed read.
        val vm = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/world/WorldViewModel.kt").readText()
        assertEquals("one feed line in the view model", 1, Regex("""WorldRealmFeed\.feedLine\(""").findAll(vm).count())
        assertTrue("through WorldLog, gated", Regex("""if \(WorldLog\.enabled\) WorldLog\.line\(WorldRealmFeed\.feedLine\(""").containsMatchIn(vm))
    }
}
