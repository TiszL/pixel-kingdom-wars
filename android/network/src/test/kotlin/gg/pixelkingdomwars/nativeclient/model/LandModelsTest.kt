package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Fantasy world and land deposit decoding: exact decimal text for the frozen price, strict
 * availability vocabulary, and the reservation identity the checkout pins before any wallet prompt. */
class LandModelsTest {
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test fun `the fantasy globe decodes realm counts and the viewer's parcels`() {
        val globe = FantasyGlobe.from(json("""{"worldId":"fantasy-v1","catalogHash":"92a3","ready":true,"warzone":{"active":false},
            "realms":[{"realmId":"frostveil","total":13126,"occupied":12,"held":1,"available":13113,"anchorTileId":14742},{"realmId":"cinderfall","total":4237,"occupied":0,"held":0,"available":4237,"anchorTileId":null}],
            "me":{"baseId":null,"selectedTileId":null,"ownedTiles":[]}}"""))
        assertEquals(2, globe.realms.size); assertEquals(13113, globe.realms[0].available); assertNull(globe.realms[1].anchorTileId); assertTrue(globe.ready)
        assertThrows(IllegalArgumentException::class.java) { FantasyGlobe.from(json("""{"worldId":"legacy-earth","ready":true}""")) }
    }
    @Test fun `parcel availability is a closed vocabulary and the tile keeps its exact coordinates`() {
        val parcel = FantasyParcel.from(json("""{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":14742,"realmId":"frostveil","allocation":"ordinary","lon":-172.75,"lat":80.25},"availability":"available","detail":null}"""))
        assertTrue(parcel.available); assertEquals("-172.75", parcel.tile.lon); assertEquals("80.25", parcel.tile.lat); assertTrue(parcel.tile.ordinary)
        assertFalse(FantasyParcel.from(json("""{"worldId":"fantasy-v1","tile":{"tileId":1,"realmId":"seeker-reach","allocation":"seeker"},"availability":"reserved"}""")).tile.ordinary)
        assertThrows(IllegalArgumentException::class.java) { FantasyParcel.from(json("""{"worldId":"fantasy-v1","tile":{"tileId":1,"realmId":"x"},"availability":"sold"}""")) }
        val viewport = FantasyViewport.from(json("""{"worldId":"fantasy-v1","scope":{"x0":0,"x1":1,"y0":0,"y1":1},"matched":1,"truncated":false,"markers":[{"tileId":5,"name":"A","avatarUrl":null,"keepLevel":3}]}"""))
        assertEquals(5, viewport.markers.single().tileId)
    }
    @Test fun `a marker's shielded flag decodes, an older server's marker is not carried, and a malformed flag is unknown and never drops the read`() {
        // D-NEXT (server PR #147): every realm-feed marker carries `shielded`, the raid gate's own answer; the realm map
        // draws a dome on each shielded kingdom. A server before that PR omits it: those markers must still decode, draw
        // no dome, and say the key was NOT carried, so the HUD does not offer the Unshielded chip on a read that cannot
        // answer. An odd value must cost only that flag, never the whole viewport (the map would go empty) — and since
        // SHARDKEEP D-191 made `false` a positive claim (an explicitly unshielded kingdom is a raid target), an odd value
        // reads UNKNOWN (null), never false: the map offers only the targets the server named (D-169 / D-181).
        fun viewport(list: String) = FantasyViewport.from(json("""{"worldId":"fantasy-v1","scope":{"x0":0,"x1":1,"y0":0,"y1":1},"matched":2,"truncated":false,"markers":$list}"""))
        fun markers(list: String) = viewport(list).markers
        val fed = viewport("""[{"tileId":5,"name":"A","avatarUrl":null,"keepLevel":3,"shielded":true},{"tileId":6,"name":"B","avatarUrl":null,"keepLevel":4,"shielded":false}]""")
        assertEquals(listOf(true, false), fed.markers.map { it.shielded })
        assertEquals(listOf(true, false), fed.markers.map { it.shieldUp })
        assertTrue("a PR #147 read carries the key, even where every flag is false", viewport("""[{"tileId":6,"name":"B","keepLevel":4,"shielded":false}]""").carriesShielded)
        assertTrue(fed.carriesShielded)
        assertEquals("the other fields are untouched", listOf(5 to 3, 6 to 4), fed.markers.map { it.tileId to it.keepLevel })
        val older = viewport("""[{"tileId":5,"name":"A","avatarUrl":null,"keepLevel":3}]""")
        assertNull("an older server omits it: not carried", older.markers.single().shielded)
        assertFalse("and no dome", older.markers.single().shieldUp)
        assertFalse("so the read cannot say who is shielded", older.carriesShielded)
        assertFalse("nor can an empty read", viewport("[]").carriesShielded)
        for (odd in listOf("1", "0", "\"yes\"", "{}", "[true]")) {
            val one = markers("""[{"tileId":5,"name":"A","keepLevel":3,"shielded":$odd},{"tileId":6,"name":"B","keepLevel":4,"shielded":true}]""")
            assertEquals("shielded=$odd is unknown (never a raid target, D-191) and keeps the read", listOf(null, true), one.map { it.shielded })
            assertFalse("and draws no dome", one[0].shieldUp)
            assertFalse("a read whose only bit is malformed cannot say who is shielded", viewport("""[{"tileId":5,"name":"A","keepLevel":3,"shielded":$odd}]""").carriesShielded)
        }
        val nulled = markers("""[{"tileId":5,"name":"A","keepLevel":3,"shielded":null},{"tileId":6,"name":"B","keepLevel":4,"shielded":true}]""")
        assertEquals("shielded=null is not carried, draws no dome, and keeps the read", listOf(null, true), nulled.map { it.shielded })
        assertTrue("the text form of true is still true", markers("""[{"tileId":5,"name":"A","keepLevel":3,"shielded":"true"}]""").single().shieldUp)
        assertEquals("and the text form of false is an explicit false (carried)", false, markers("""[{"tileId":5,"name":"A","keepLevel":3,"shielded":"false"}]""").single().shielded)
    }
    @Test fun `a marker and an owned deed carry the player's profile image for the realm map's name tag`() {
        // Owner 2026-09-26 (Seeker code 31): at map zoom "only player profile picture and name should be visible". The
        // server sends each kingdom's picture as avatarUrl; dropping it left every tag the same castle art.
        val pic = "/api/avatars/3f2b6c1e-9d7a-4c55-8a10-5b7e2f4c9a01.webp"
        val viewport = FantasyViewport.from(json("""{"worldId":"fantasy-v1","matched":2,"truncated":false,"markers":[{"tileId":5,"name":"A","avatarUrl":"$pic","keepLevel":3},{"tileId":6,"name":"B","avatarUrl":null,"keepLevel":4}]}"""))
        assertEquals(listOf(pic, null), viewport.markers.map { it.avatarUrl })
        val globe = FantasyGlobe.from(json("""{"worldId":"fantasy-v1","ready":true,"realms":[],"me":{"baseId":"b","selectedTileId":7,"ownedTiles":[{"baseId":"b","tileId":7,"realmId":"sunscar","name":"","avatarUrl":"$pic","keepLevel":20,"active":true,"selected":true}]}}"""))
        assertEquals(pic, globe.me!!.ownedTiles.single().avatarUrl)
    }
    @Test fun `a land deposit keeps the frozen lamports as text and derives the fantasy reservation identity`() {
        val deposit = LandDeposit.from(json("""{"id":"0f3a3a4e-2b1f-4a1e-9c3b-4d0d5e6f7a8b","kind":"entry","status":"pending","reference":"5Mx9","txSignature":null,"paymentSignature":null,"amount":null,
            "baseId":"b86b557b-bb8f-488b-8b18-035600ba0e4a","landAddress":{"kind":"fantasy","worldId":"fantasy-v1","tileId":14742},"fantasyLocation":{"worldId":"fantasy-v1","tileId":14742,"realmId":"frostveil","allocation":"ordinary","lon":-172.75,"lat":80.25},
            "amountLamports":200000000,"serverNow":"2026-09-11T10:00:00.000Z","payableUntil":"2026-09-11T10:25:00.000Z","retryAt":"2026-09-11T10:30:00.000Z","createdAt":"2026-09-11T10:00:00.000Z","finalizedAt":null}"""))
        assertEquals("200000000", deposit.amountLamports); assertEquals("fantasy-v1:14742", deposit.reservationIdentity); assertFalse(deposit.terminal)
        assertSame(deposit, deposit.requireReservation("entry"))
        assertThrows(IllegalArgumentException::class.java) { deposit.requireReservation("deed") }
        assertNull("A legacy Earth address is not a native reservation", deposit.copy(landAddress = LandAddress("legacy-earth", earthCell = 9)).reservationIdentity)
        assertNull("A location that disagrees with the address is refused", deposit.copy(fantasyLocation = deposit.fantasyLocation!!.copy(tileId = 1)).reservationIdentity)
        assertTrue(LandDeposit.from(json("""{"id":"x","status":"credited"}""")).credited)
        assertTrue(LandDeposit.from(json("""{"alreadyPaid":true,"kind":"entry"}""")).alreadyPaid)
        assertEquals(LandAddress("fantasy", "fantasy-v1", 3), LandAddress.fantasy(3)); assertTrue(LandAddress.fantasy(null).fantasy)
    }
}
