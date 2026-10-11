package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The card is another player's public face. It is read strictly: a response this client does not fully
 * understand shows "PROFILE UNAVAILABLE", never a half-right card under somebody's name. */
class ChatAuthorCardTest {
    private fun raw(value: String) = Json.parseToJsonElement(value).jsonObject
    private val owner = """{"version":1,"name":"Aldric","avatarUrl":"/api/avatars/3f2b6c1e-9d7a-4c55-8a10-5b7e2f4c9a01.webp","seekerVerified":true,"bases":2,"highestKeepLevel":9,"trophies":340,"clan":{"name":"Iron Crest","tag":"IRON"}}"""
    private val landless = """{"version":1,"name":"Newcomer","avatarUrl":null,"seekerVerified":false,"bases":0,"highestKeepLevel":4,"trophies":0,"clan":null}"""
    private fun rejected(value: String, maxBases: Int? = 5) = runCatching { ChatAuthorCard.from(raw(value), maxBases) }.isFailure

    @Test fun `the contract's two examples decode to exactly what was sent`() {
        assertEquals(ChatAuthorCard("Aldric", "/api/avatars/3f2b6c1e-9d7a-4c55-8a10-5b7e2f4c9a01.webp", true, 2, 9, 340, ChatAuthorClan("Iron Crest", "IRON")), ChatAuthorCard.from(raw(owner), 5))
        assertEquals("a landless player still has the free starter base's Keep", ChatAuthorCard("Newcomer", null, false, 0, 4, 0, null), ChatAuthorCard.from(raw(landless), 5))
        val none = ChatAuthorCard.from(raw(landless.replace("\"highestKeepLevel\":4", "\"highestKeepLevel\":null")), 5)
        assertNull("sold their only deed after sending: no base at all", none.highestKeepLevel)
    }
    @Test fun `a different version is a different shape and is rejected whole`() {
        for (version in listOf("2", "0", "\"1\"", "1.5", "null", "true")) assertTrue(version, rejected(owner.replace("\"version\":1", "\"version\":$version")))
        assertTrue("no version at all", rejected(owner.replace("\"version\":1,", "")))
    }
    @Test fun `a key this client does not know is ignored so an additive field cannot blank every card`() {
        // Policy: the server's allowlist is closed and a new shape is a new version. Ignoring an unknown key means it is
        // never read, shown or stored — the card below has no place to keep it.
        val extended = owner.dropLast(1) + ""","league":"gold","clanExtra":{"rank":1}}"""
        assertEquals(ChatAuthorCard.from(raw(owner), 5), ChatAuthorCard.from(raw(extended), 5))
        val clanExtra = owner.replace("\"tag\":\"IRON\"", "\"tag\":\"IRON\",\"members\":12")
        assertEquals(ChatAuthorClan("Iron Crest", "IRON"), ChatAuthorCard.from(raw(clanExtra), 5).clan)
    }
    @Test fun `every listed key must be present with its exact JSON type`() {
        for (key in listOf("name", "avatarUrl", "seekerVerified", "bases", "highestKeepLevel", "trophies", "clan"))
            assertTrue("missing $key", rejected(JsonObject(raw(owner) - key).toString()))
        assertTrue("a quoted number is not a number", rejected(owner.replace("\"bases\":2", "\"bases\":\"2\"")))
        assertTrue(rejected(owner.replace("\"trophies\":340", "\"trophies\":\"340\"")))
        assertTrue(rejected(owner.replace("\"seekerVerified\":true", "\"seekerVerified\":\"true\"")))
        assertTrue(rejected(owner.replace("\"seekerVerified\":true", "\"seekerVerified\":1")))
        assertTrue(rejected(owner.replace("\"name\":\"Aldric\"", "\"name\":7")))
        assertTrue(rejected(owner.replace("\"name\":\"Aldric\"", "\"name\":null")))
        assertTrue("bases is a count, never a list", rejected(owner.replace("\"bases\":2", "\"bases\":[1,2]")))
        assertTrue(rejected(owner.replace("{\"name\":\"Iron Crest\",\"tag\":\"IRON\"}", "\"IRON\"")))
        assertTrue(rejected(owner.replace("\"tag\":\"IRON\"", "\"tag\":null")))
        assertTrue(rejected(owner.replace(",\"tag\":\"IRON\"", "")))
    }
    @Test fun `out of range numbers are rejected`() {
        assertTrue("more kingdoms than a player may hold", rejected(owner.replace("\"bases\":2", "\"bases\":6")))
        assertFalse("the ceiling is the catalogue's, not this client's", rejected(owner.replace("\"bases\":2", "\"bases\":6"), maxBases = 6))
        assertFalse("a pack without the ceiling still checks the sign only", rejected(owner.replace("\"bases\":2", "\"bases\":6"), maxBases = null))
        for (bases in listOf("-1", "2.5", "1e1", "99999999999")) assertTrue(bases, rejected(owner.replace("\"bases\":2", "\"bases\":$bases"), maxBases = null))
        for (keep in listOf("0", "-3", "1.5")) assertTrue(keep, rejected(owner.replace("\"highestKeepLevel\":9", "\"highestKeepLevel\":$keep")))
        for (trophies in listOf("-1", "0.5", "null")) assertTrue(trophies, rejected(owner.replace("\"trophies\":340", "\"trophies\":$trophies")))
        assertFalse(rejected(owner.replace("\"bases\":2", "\"bases\":5")))
    }
}
