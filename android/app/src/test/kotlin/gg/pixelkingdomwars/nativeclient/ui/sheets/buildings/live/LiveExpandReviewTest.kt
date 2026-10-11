package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LiveExpandReviewTest {
    private val catalogue = Json.parseToJsonElement("""{"constants":{"CAPS":{"expansionsMax":2,
        "claimTilesByExpansion":[14,16,20],"expansionReqKeepLevel":[12,14],"expansionPriceSolByIndex":["0.15","0.45"]}}}""").jsonObject
    private fun state(index: Int = 0, keep: Int = 12, size: Int = 14) = KingdomUiState(catalogue = catalogue,
        home = BaseState(base = BaseSnapshot.from(Json.parseToJsonElement("""{
        "baseId":"11111111-1111-4111-8111-111111111111","player":{"keepLevel":$keep,"expansions":$index},
        "claim":{"min":8,"max":${8 + size}}}""").jsonObject)))
    private fun ui(s: KingdomUiState = state(), enabled: Boolean = true, test: Boolean = false) =
        requireNotNull(liveExpandReview(s, enabled, test))

    @Test fun `current next size gate and SOL quote all use catalogue and existing offer`() {
        val ui = ui()
        assertEquals(14, ui.sizeNow); assertEquals(16, ui.sizeNext); assertEquals(60, ui.newTiles)
        assertEquals(12, ui.reqKeepLevel); assertEquals(14, ui.nextReqKeepLevel)
        assertEquals("0.15", ui.price.amount); assertEquals(Currency.SOL, ui.price.currency)
        assertEquals(RectTiles(7, 7, 16, 16), ui.ring)
        assertNull(ui.obstaclesInRing); assertNull(ui.saved)
        assertEquals(ExpandPrimaryKind.EXPAND, expandPrimary(ui))
    }
    @Test fun `candidate free path stays explicit without fabricating a server zero quote`() {
        val ui = ui(test = true)
        assertTrue(ui.testExpansion)
        assertEquals("0.15", ui.price.amount)
        assertEquals(PriceStatus.OK, ui.price.status)
        assertEquals(ExpandPrimaryKind.EXPAND, expandPrimary(ui))
    }
    @Test fun `Keep lock cannot become a purchase offer`() {
        val ui = ui(state(keep = 11))
        assertEquals(ExpandPrimaryKind.LOCKED, expandPrimary(ui))
        assertEquals(PriceStatus.UNAVAILABLE, ui.price.status)
    }
    @Test fun `full size hides expansion and global admission disables it`() {
        assertEquals(ExpandPrimaryKind.HIDDEN, expandPrimary(ui(state(2, 20, 20))))
        assertEquals(ExpandPrimaryKind.READ_ONLY, expandPrimary(ui(enabled = false)))
    }
    @Test fun `missing or inconsistent claim and catalogue stay unavailable instead of defaulting to first expansion`() {
        assertNull(liveExpandReview(state().copy(catalogue = null), true, false))
        assertNull(liveExpandReview(state(size = 16), true, false))
        val base = state().base!!
        // 25b5b961 F1: a guessed zero index would quote the wrong next ring, even with a known Keep level.
        val noIndex = BaseSnapshot.from(JsonObject(base.raw + ("player" to JsonObject(base.raw.getValue("player").jsonObject - "expansions"))))
        assertNull(liveExpandReview(state().copy(home = BaseState(base = noIndex)), true, false))
        assertNull(liveExpandReview(state().copy(home = BaseState(base = BaseSnapshot.from(JsonObject(base.raw - "claim")))), true, false))
    }
    @Test fun `larger canonical rings never claim a one-tile expansion`() {
        val ui = ui(state(1, 14, 16))
        assertEquals(20, ui.sizeNext)
        assertEquals("Your land grows from 16×16 to 20×20 tiles.", ui.growthLine)
    }
    @Test fun `outside tap gives the registered owner first refusal`() {
        var closed = 0
        assertTrue(consumeExpandTap(true, { true }, { closed++ })); assertEquals(0, closed)
        assertTrue(consumeExpandTap(true, { false }, { closed++ })); assertEquals(1, closed)
        assertFalse(consumeExpandTap(false, { false }, { closed++ }))
    }

    @Test fun `missing pack asks for an update while missing base data asks for refresh`() {
        assertEquals("Expansion details are unavailable. Update the game.", liveExpandUnavailableReason(state().copy(catalogue = null)))
        assertEquals("Expansion details are unavailable. Update the game.", liveExpandUnavailableReason(state().copy(catalogue = JsonObject(emptyMap()))))
        assertEquals("Expansion details are unavailable. Refresh your kingdom.", liveExpandUnavailableReason(state().copy(home = BaseState())))
        assertEquals("Expansion details are unavailable. Refresh your kingdom.", liveExpandUnavailableReason(state(size = 16)))
    }
    @Test fun `candidate free label is only a promise on the admitted EXPAND primary`() {
        val ready = ui(test = true)
        assertTrue(expandTestOnlyVisible(ready, expandPrimary(ready)))
        for (candidate in listOf(ready.copy(readOnly = "Paused"), ready.copy(keepLevel = 1),
            ready.copy(price = ready.price.copy(status = PriceStatus.UNAVAILABLE)), ui(state(2,20,20), test = true))) {
            assertFalse(expandTestOnlyVisible(candidate, expandPrimary(candidate)))
        }
        assertFalse(expandTestOnlyVisible(ready.copy(testExpansion = false), ExpandPrimaryKind.EXPAND))
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/KeepExpandSheet.kt").readText()
        assertTrue(source.contains("Your buildings stay in place. Recorded on your land deed."))
    }
    @Test fun `a live purchase raises the Seal in place while the free test expansion keeps its review screen`() {
        // Added 2026-10-06 (night UI, slice C), the one behaviour change here: with the Home purchase owner, EXPAND, RETRY
        // and CHECK reach that owner on this sheet (no hop to the old purchase screen). The candidate's free test
        // expansion and a mount without the owner still only navigate to the purchase screen, as before.
        val host = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/sheets/buildings/live/LiveExpandHost.kt").readText()
        assertTrue(host.contains("purchase?.takeIf { expandInPlace(true, testExpansion) }"))
        assertTrue(host.contains("onExpand = flow?.primary ?: { if (expandPrimary(ui) == ExpandPrimaryKind.EXPAND) onReview() }"))
        assertTrue(host.contains("onRetry = flow?.retry ?: onReview, onCheck = flow?.check ?: onReview"))
        assertFalse(expandInPlace(hasPurchase = true, testExpansion = true))
        // The live mapper still names the fallback handoff; only the in-place host returns the footer to the Seal hint.
        assertEquals("Review before payment", ui().reviewHint)
    }
}
