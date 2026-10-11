package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.model.FantasyMarker
import gg.pixelkingdomwars.nativeclient.model.FantasyOwnedTile
import gg.pixelkingdomwars.nativeclient.model.FantasyViewport
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Shield domes "just like web" on EVERY shielded kingdom (owner, 2026-09-26; D-181), plus the UNSHIELDED chip (SHARDKEEP
 * D-191, owner 2026-09-28 on a player's word: the map is searched for a raid target, so the chip keeps the kingdoms a
 * raid can reach). On the owner's Seeker every realm read "domes 0" while only your own Home read carried a shield bit.
 * The realm feed's markers now carry `shielded` (server PR #147, the raid gate's own answer), so every kingdom it calls
 * shielded asks the BASES lane for a dome, and every one it calls unshielded passes the chip; a kingdom whose bit the
 * feed did not carry is unknown, never a raid target. Your own base's Home read (`/base`) still times your dome, so it
 * goes the moment your shield ends. A dome that outlives the shield, shows for a warzone-suppressed one, or lands on an
 * unshielded base would claim a protection the server does not give.
 */
class WorldOwnShieldTest {
    private fun raw(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject
    private val t0 = 5_000_000_000L
    private fun ms(v: Long) = v * 1_000_000L

    @Test fun `your active shield is a dome until its server time runs out on the monotonic clock`() {
        val own = WorldOwnShield.from("base-a", raw("""{"shield":{"active":true,"expiresAt":"2026-09-26T10:00:00.000Z","remainingMs":90000,"suppressedByWarzone":false}}"""), t0)!!
        assertEquals(true, own.shielded("base-a", t0))
        assertEquals("base ids compare like the server's", true, own.shielded("BASE-A", t0 + ms(89_999)))
        assertEquals(false, own.shielded("base-a", t0 + ms(90_000)))
        assertEquals(90_000L, own.remainingMs(t0)); assertNull("nothing to time after it ends", own.remainingMs(t0 + ms(90_000)))
        assertNull("another base's shield stays unknown", own.shielded("base-b", t0))
    }

    @Test fun `no shield, a suppressed one and an unknown read draw no dome`() {
        assertEquals(false, WorldOwnShield.from("base-a", raw("""{"shield":null}"""), t0)!!.shielded("base-a", t0))
        val suppressed = raw("""{"shield":{"active":false,"expiresAt":"2026-09-26T10:00:00.000Z","remainingMs":90000,"suppressedByWarzone":true}}""")
        assertEquals("a warzone-suppressed shield protects nothing", false, WorldOwnShield.from("base-a", suppressed, t0)!!.shielded("base-a", t0))
        assertEquals("a spent clock", false, WorldOwnShield.from("base-a", raw("""{"shield":{"active":true,"remainingMs":0}}"""), t0)!!.shielded("base-a", t0))
        assertNull("a read without the field says nothing", WorldOwnShield.from("base-a", raw("""{"player":{}}"""), t0))
        assertNull("no Home read yet", WorldOwnShield.from(null, null, t0))
    }

    @Test fun `every kingdom the feed calls shielded carries the dome flag, and your Home read times your own`() {
        // Rewritten from "only your own base whose Home read is known carries the shield flag" (the rule before the feed
        // carried `shielded`); the owner wants a dome on every shielded kingdom, as the web draws.
        val columns = 720
        val realm = "crownlands"
        val mineTile = 6 * columns + 200; val otherMine = 9 * columns + 210; val rival = 7 * columns + 205; val plain = 8 * columns + 206; val elsewhere = 100 * columns + 5
        val markers = listOf(FantasyMarker(mineTile, "Me", 7, shielded = false), FantasyMarker(rival, "Rival", 9, shielded = true),
            FantasyMarker(plain, "Plain", 5, shielded = false), FantasyMarker(elsewhere, "Far", 3, shielded = true))
        val owned = listOf(FantasyOwnedTile("base-a", mineTile, realm, "Me", 7, active = true, selected = true),
            FantasyOwnedTile("base-b", otherMine, realm, "Second", 4, active = true))
        val realmOf = { tile: Int -> if (tile == elsewhere) "sunscar" else realm }
        val own = WorldOwnShield.from("base-a", raw("""{"shield":{"active":true,"remainingMs":60000}}"""), t0)
        val bases = realmHudBases(realm, markers, owned, realmOf, columns, own, t0)
        assertEquals(listOf(mineTile, rival, plain, otherMine), bases.map { it.tileId })
        assertEquals("your read (fresher than the poll) says yours is shielded; the feed decides every other kingdom",
            listOf(true, true, false, null), bases.map { it.shield })
        val flags = WorldHudFlow.basesSnapshot(1, realm, bases, RealmFilter(), null, null).flags
        assertTrue("your shielded base asks the BASES lane for a dome", flags[0] and HudFlag.SHIELD != 0)
        assertTrue("a rival the feed calls shielded gets a dome too", flags[1] and HudFlag.SHIELD != 0)
        assertTrue("an unshielded rival draws none", flags[2] and HudFlag.SHIELD == 0)
        assertTrue("your other base, which the feed did not carry and whose read is not loaded, draws none", flags[3] and HudFlag.SHIELD == 0)
        val later = realmHudBases(realm, markers, owned, realmOf, columns, own, t0 + ms(60_000))
        assertEquals("your dome goes when your shield ends, before the feed's next poll", false, later.first().shield)
        assertEquals("without your read the feed decides yours too", listOf(false, true, false, null),
            realmHudBases(realm, markers, owned, realmOf, columns, null, t0).map { it.shield })
        val old = markers.map { FantasyMarker(it.tileId, it.name, it.keepLevel) }
        // D-191: a bit the feed did not carry stays unknown (null): no dome, and never "unshielded". Before D-191 it read
        // false, which the Unshielded chip would have taken for an open kingdom. Your own read still answers for yours.
        assertEquals("an older server without the field: no dome anywhere but your timed own, the rest unknown", listOf(true, null, null, null),
            realmHudBases(realm, old, owned, realmOf, columns, own, t0).map { it.shield })
        assertEquals("your own Home read without a shield answers for your base: known, clear", listOf(false, null, null, null),
            realmHudBases(realm, old, owned, realmOf, columns, WorldOwnShield.from("base-a", raw("""{"shield":null}"""), t0), t0).map { it.shield })
    }

    @Test fun `the Unshielded chip waits for a feed that carries the bit, and an older server never gets it`() {
        // Production may serve this APK before server PR #147 is deployed. Its markers omit `shielded`, so no rival's
        // shield is known: an UNSHIELDED chip would keep nobody (D-191 never reads an absent bit as open), drop every
        // kingdom from the map and the count, and tell players no one can be raided, which the server never said.
        // D-169: hidden, not faked, until a read carries the bit.
        val columns = 720; val realm = "crownlands"
        val mineTile = 10 * columns + 100; val rivalA = mineTile + 1; val rivalB = mineTile + 2
        fun read(list: String) = FantasyViewport.from(raw("""{"worldId":"fantasy-v1","matched":3,"truncated":false,"markers":$list}"""))
        val older = read("""[{"tileId":$mineTile,"name":"Me","keepLevel":7},{"tileId":$rivalA,"name":"A","keepLevel":5},{"tileId":$rivalB,"name":"B","keepLevel":6}]""")
        assertFalse("an older server's read cannot say who is shielded", older.carriesShielded)
        assertEquals("so the realm map offers All, Mine and Level only", listOf("all", "mine", "lvl"), HudChips.realm(older.carriesShielded).map { it.id })
        val owned = listOf(FantasyOwnedTile("base-a", mineTile, realm, "Me", 7, active = true, selected = true))
        val own = WorldOwnShield.from("base-a", raw("""{"shield":{"active":true,"remainingMs":60000}}"""), t0)
        val oldBases = realmHudBases(realm, older.markers, owned, { realm }, columns, own, t0)
        assertEquals("the wrong answer the hidden chip prevents: nobody would pass", emptyList<Int>(),
            oldBases.filter { RealmFilter(kind = "unshielded").passes(it, null) }.map { it.tileId })
        assertEquals("the domes still read as before: yours by your Home read, none on the rivals, whose bit is unknown", listOf(true, null, null), oldBases.map { it.shield })
        val fed = read("""[{"tileId":$mineTile,"name":"Me","keepLevel":7,"shielded":false},{"tileId":$rivalA,"name":"A","keepLevel":5,"shielded":true},{"tileId":$rivalB,"name":"B","keepLevel":6,"shielded":false}]""")
        assertTrue("a PR #147 read carries the bit", fed.carriesShielded)
        assertEquals("then the chip shows", listOf("all", "mine", "unshielded", "lvl"), HudChips.realm(fed.carriesShielded).map { it.id })
        assertEquals("and keeps every kingdom the feed called unshielded; your fresh shield (your Home read) takes yours out", listOf(rivalB),
            realmHudBases(realm, fed.markers, owned, { realm }, columns, own, t0).filter { RealmFilter(kind = "unshielded").passes(it, null) }.map { it.tileId })
        assertEquals("without your read the feed decides yours too, and it is a target like any other", listOf(mineTile, rivalB),
            realmHudBases(realm, fed.markers, owned, { realm }, columns, null, t0).filter { RealmFilter(kind = "unshielded").passes(it, null) }.map { it.tileId })
        assertFalse("an empty read cannot say either", read("[]").carriesShielded)
    }

    @Test fun `the Unshielded chip keeps exactly the kingdoms the feed called unshielded, on the HUD and in the engine`() {
        // D-169 hid the chip while no feed carried the bit; a feed that carries it (server PR #147) brings it back, as
        // Unshielded since D-191 (the Shielded chip it replaced kept the kingdoms a raider cannot reach).
        assertTrue("a fed realm map shows the Unshielded chip", HudChips.realm(shieldFed = true).any { it.id == "unshielded" })
        val columns = 720; val realm = "crownlands"
        val markers = (0 until 6).map { FantasyMarker(10 * columns + 100 + it, "K$it", 1 + it, shielded = it % 3 == 0) } +
            FantasyMarker(10 * columns + 106, "K6", 7) // one marker of the same read without the bit (never a target)
        val bases = realmHudBases(realm, markers, emptyList(), { realm }, columns, null, t0)
        val chip = RealmFilter(kind = "unshielded")
        assertEquals("the chip keeps the unshielded ones, never the unknown one", listOf(1, 2, 4, 5), bases.filter { chip.passes(it, null) }.map { it.tileId - (10 * columns + 100) })
        val snap = WorldHudFlow.basesSnapshot(1, realm, bases, chip, null, null)
        assertEquals("FILTERED_IN only on the unshielded (the engine hides the rest, D-191)", listOf(false, true, true, false, true, true, false),
            snap.flags.map { it and HudFlag.FILTERED_IN != 0 })
        assertEquals("the engine learns which bits the read carried", listOf(true, true, true, true, true, true, false), snap.shieldKnown!!.toList())
        assertEquals(WorldFilterKind.UNSHIELDED, WorldHudFlow.engineFilter(chip).kind)
        val levels = RealmFilter(kind = "unshielded", lo = 4, hi = 20)
        assertEquals("with the level range too", listOf(4, 5), bases.filter { levels.passes(it, null) }.map { it.tileId - (10 * columns + 100) })
    }

    @Test fun `a malformed shielded bit is unknown - no dome, never a raid target, and no Unshielded chip on its word`() {
        // SHARDKEEP D-191 made `false` a positive claim (an explicitly unshielded kingdom is a raid target). Before it a
        // present-but-malformed value read false, the safe side while false only meant "no dome"; now it must read unknown
        // (D-169 / D-181: hidden, never faked), so the chip never offers a target the server did not name.
        val columns = 720; val realm = "crownlands"; val t = 10 * columns + 100
        val read = FantasyViewport.from(raw("""{"worldId":"fantasy-v1","matched":3,"truncated":false,"markers":[{"tileId":$t,"name":"K0","keepLevel":3,"shielded":1},{"tileId":${t + 1},"name":"K1","keepLevel":4,"shielded":"yes"},{"tileId":${t + 2},"name":"K2","keepLevel":5,"shielded":false}]}"""))
        assertEquals(listOf(null, null, false), read.markers.map { it.shielded })
        val odd = FantasyViewport(read.worldId, read.matched, read.truncated, read.markers.take(2), read.scope)
        assertFalse("two malformed bits cannot say who is shielded", odd.carriesShielded)
        assertTrue("so no Unshielded chip on their word", HudChips.realm(shieldFed = odd.carriesShielded).none { it.id == "unshielded" })
        val bases = realmHudBases(realm, read.markers, emptyList(), { realm }, columns, null, t0)
        assertEquals("the HUD keeps them unknown", listOf(null, null, false), bases.map { it.shield })
        val chip = RealmFilter(kind = "unshielded")
        assertEquals("only the kingdom the server called unshielded is a target", listOf(t + 2), bases.filter { chip.passes(it, null) }.map { it.tileId })
        val snap = WorldHudFlow.basesSnapshot(1, realm, bases, chip, null, null)
        assertEquals("the engine learns only the third bit was carried", listOf(false, false, true), snap.shieldKnown!!.toList())
        assertEquals(listOf(false, false, true), snap.flags.map { it and HudFlag.FILTERED_IN != 0 })
    }
}
