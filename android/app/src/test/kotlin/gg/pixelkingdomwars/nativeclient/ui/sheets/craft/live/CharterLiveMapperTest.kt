package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.charter.CharterActivity
import gg.pixelkingdomwars.nativeclient.data.CharterJournal
import gg.pixelkingdomwars.nativeclient.data.CharterRecord
import gg.pixelkingdomwars.nativeclient.data.CharterState
import gg.pixelkingdomwars.nativeclient.data.RetirementJournal
import gg.pixelkingdomwars.nativeclient.data.RetirementRecord
import gg.pixelkingdomwars.nativeclient.data.RetirementState
import gg.pixelkingdomwars.nativeclient.model.ClanMember
import gg.pixelkingdomwars.nativeclient.model.MyClan
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live CHARTER tab is read-only while the money lane (MS-M3) owns charter creation, leadership sale, INVITE ONLY and
 * dissolution: the captain tools must render locked with the wiring reason and their callbacks must never start a
 * request, while every saved request stays visible (money moved is money honoured). Authored for the Codex integrator;
 * not run in this lane (no build tool).
 */
class CharterLiveMapperTest {
    private val captain = "DaEy4YZ9xwiGzw1nTQVB1vxCTZRBQJhbmLU55BXQ2jgi"
    private val member = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
    private val clanId = "12345678-1234-4678-9abc-def012345678"
    private val identity = StarterIdentity("https://api.example.gg", "devnet", captain)
    private fun clan(inviteMode: String = "open") = MyClan(clanId, "Iron Wardens", "IRN", inviteMode, captain, null, listOf(
        ClanMember(captain, "2030-01-01T00:00:00Z", "Mira", 7, 1200, false),
        ClanMember(member, "2030-01-02T00:00:00Z", null, 3, 300, false)))
    private fun activity(status: String, kind: String = "creation", sale: Boolean = true) = CharterActivity.from(Json.parseToJsonElement("""
        {"version":1,"actor":"$captain","newActions":{"creation":true,"sale":$sale},
         "items":[{"kind":"$kind","key":"12345678-1234-4678-9abc-def012345690","status":"$status","clanId":"$clanId",
                   "participantRole":"${if (kind == "creation") "creator" else "seller"}","name":"Iron Wardens","tag":"IRN"}],
         "nextCursor":null}""").jsonObject)

    @Test fun `the captain sees the facts but the tools stay locked with the money-lane reason`() {
        val ui = charterLiveUi(clan("invite"), captain, CharterState(loaded = true, activity = activity("activated")), null,
            captainTier = 3, rosterMax = 30, allowed = true)!!
        assertTrue(ui.registered)
        assertTrue(ui.amCaptain)
        assertTrue(ui.inviteOnly)
        assertEquals("By invite", ui.joining)
        assertEquals("Mira", ui.captainName)
        assertEquals("2 of 30", ui.roster)
        assertEquals("no founding date exists in client state, so it reads unknown", UNKNOWN, ui.founded)
        assertEquals(MONEY_WIRING_PENDING, ui.pausedReason)
    }

    @Test fun `paused orders and a server pause outrank the wiring reason`() {
        assertEquals("Game orders are paused. History stays available.", charterPausedReason(false, activity("activated"), moneyWired = false))
        assertEquals("Charter changes are paused", charterPausedReason(true, activity("activated", sale = false), moneyWired = false))
        assertNull("only a wired, unpaused sheet unlocks the tools", charterPausedReason(true, activity("activated"), moneyWired = true))
    }

    @Test fun `without server evidence the clan is not claimed as registered, and an unknown cap reads as unknown`() {
        val ui = charterLiveUi(clan(), member, CharterState(loaded = true), null, captainTier = null, rosterMax = null, allowed = true)!!
        assertFalse(ui.registered)
        assertFalse(ui.amCaptain)
        assertEquals("2 of $UNKNOWN", ui.roster)
        assertEquals(1, ui.captainTier)
        assertTrue("a migrated clan is registered by the host's migration evidence", charterRegistered(clanId, null, null, migrated = true))
        assertFalse("an unfinished creation does not register the clan", charterRegistered(clanId, activity("issuing"), null))
    }

    @Test fun `saved charter requests and unfinished dissolutions stay listed, finished server items do not`() {
        val held = CharterRecord("12345678-1234-4678-9abc-def012345691", "sale", null, held = true)
        val charter = CharterState(loaded = true, journal = CharterJournal(identity = identity, records = listOf(held)), activity = activity("members_paid", kind = "sale"))
        val retirement = RetirementState(loaded = true, journal = RetirementJournal(identity = identity,
            records = listOf(RetirementRecord("12345678-1234-4678-9abc-def012345692", clanId))))
        val pending = charterPending(charter, retirement, captain, "Iron Wardens")
        assertEquals(listOf("charter:12345678-1234-4678-9abc-def012345691", "charter:12345678-1234-4678-9abc-def012345690",
            "retirement:12345678-1234-4678-9abc-def012345692"), pending.map { it.id })
        assertEquals("Outcome being checked", pending[0].sub)
        assertEquals("Dissolve Iron Wardens", pending[2].title)
        val done = CharterState(loaded = true, activity = activity("completed", kind = "sale"))
        assertTrue(charterPending(done, null, captain, "Iron Wardens").isEmpty())
    }

    @Test fun `no clan, no CHARTER tab`() {
        assertNull(charterLiveUi(null, captain, null, null, null, null, allowed = true))
    }

    @Test fun `mint, transfer and invite-only only explain, history and pending rows only navigate`() {
        val explained = mutableListOf<String>()
        var opened = 0
        val on = charterLiveActions(openHistory = { opened++ }, explain = { explained += it })
        on.onRegister(); on.onHandOver(); on.onInviteOnly(true)
        assertEquals(List(3) { MONEY_WIRING_PENDING }, explained)
        on.onHistory(); on.onPending("charter:x")
        assertEquals(2, opened)
    }
}
