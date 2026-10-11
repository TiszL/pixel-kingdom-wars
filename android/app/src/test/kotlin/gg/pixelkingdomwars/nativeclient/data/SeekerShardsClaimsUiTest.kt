package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerShardsClaimsUiTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/seeker-shards-claims.json")!!.readText()).jsonObject
    private val policy = SeekerShardsClaimsPolicy.from(fixture.getValue("policy").jsonObject)
    private val page = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy)
    private val journal = SeekerShardsClaimJournal(1, StarterIdentity("https://game.test", "devnet", page.wallet), 0, null, emptyList())
    @Test fun `paused source pages history and storage uncertainty remain visible`() {
        assertTrue(seekerShardsEntryAvailable(SeekerShardsClaimsState(journal, page)))
        assertTrue(seekerShardsEntryAvailable(null, true)); assertFalse(seekerShardsEntryAvailable(null))
        assertTrue(seekerShardsEntryAvailable(SeekerShardsClaimsState(journal, page.copy(rows = emptyList(), nextCursor = null, status = "unavailable", reason = "SOURCE_INTEGRITY"))))
    }
    @Test fun `review requires selected destination current orders and explicit server admission`() {
        val state = SeekerShardsClaimsState(journal, page.copy(claimsEnabled = true))
        assertTrue(seekerShardsCanReview(state, "base", true)); assertFalse(seekerShardsCanReview(state, null, true))
        assertFalse(seekerShardsCanReview(state.copy(busy = true), "base", true)); assertFalse(seekerShardsCanReview(state, "base", false))
        assertFalse(seekerShardsCanReview(state.copy(view = page), "base", true))
    }
    @Test fun `unknown outcome offers GET recovery without another claim action`() {
        val request = SeekerShardsClaimRequest.from(fixture.getValue("request").jsonObject, policy)
        val op = SeekerShardsClaimOperation(SeekerShardsClaimCommand(request, page.rows.single().termHash, null, policy), 1, null)
        val state = SeekerShardsClaimsState(journal.copy(revision = 1, operation = op), page.copy(claimsEnabled = true))
        assertFalse(seekerShardsCanReview(state, request.baseId, true)); assertEquals("CHECKING", seekerShardsPill(op).label)
    }
    @Test fun `whole SHARDS display preserves exact large integers and never shows historical balance as current`() {
        assertEquals("9,223,372,036,854,775,807", seekerShardsAmount("9223372036854775807"))
        assertEquals("0", seekerShardsAmount("0")); assertTrue(runCatching { seekerShardsAmount("01") }.isFailure)
    }
}
