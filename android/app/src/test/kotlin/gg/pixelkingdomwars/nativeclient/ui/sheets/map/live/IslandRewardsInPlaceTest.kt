package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RecoveryUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.islandRewardsSheetTopDp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MATERIALS / SHARDS claim in place on ISLAND REWARDS: CLAIM reviews only a row with something due, a claim whose outcome
 * is unknown is only ever checked (never reviewed or sent again), and the Seal says exactly what the original review dialog
 * said, so moving the claim onto the designed sheet adds no consent wording and never arms while an order is running. */
class IslandRewardsInPlaceTest {
    private val resourceLine = "The server calculates the current share when accepted. No wallet approval is needed."
    private val shardsLine = "The server calculates your current share when accepted. No wallet approval is needed."
    private fun seal(shards: Boolean = false, busy: Boolean = false, canConfirm: Boolean = true) = shareClaimSealUi(shards, "1,840",
        "21 Sep 2026, 00:00 UTC – 28 Sep 2026, 00:00 UTC", "base-1", armedAtMs = 5_000L, busy = busy, canConfirm = canConfirm,
        item = if (shards) "Spot 7" else "Heartwood Beams · Spot 7")

    @Test fun `CLAIM skips rows with nothing due because the owner refuses a zero claim and the review is wasted`() {
        val rows = listOf("a" to "0", "b" to "0", "c" to "3", "d" to "9")
        assertEquals("c", firstDue(rows) { it.second }?.first)
        assertNull(firstDue(listOf("a" to "0")) { it.second })
        assertNull(firstDue(emptyList<Pair<String, String>>()) { it.second })
    }

    @Test fun `a claim with an unknown outcome is only checked and never reviewed or sent again`() {
        assertEquals(SavedClaimStep.CHECK, savedClaimStep(hasReceipt = false, attempted = true))
        assertNotEquals(SavedClaimStep.REVIEW_DRAFT, savedClaimStep(hasReceipt = false, attempted = true))
        // A receipt always wins: the claim went through, so the only step left is saving it into the kingdom.
        assertEquals(SavedClaimStep.SAVE_RECEIPT, savedClaimStep(hasReceipt = true, attempted = true))
        assertEquals(SavedClaimStep.SAVE_RECEIPT, savedClaimStep(hasReceipt = true, attempted = false))
        // Only a review that was never sent may be reopened.
        assertEquals(SavedClaimStep.REVIEW_DRAFT, savedClaimStep(hasReceipt = false, attempted = false))
    }

    @Test fun `the recovery row names what its button does and keeps the saved request key`() {
        val rec = RecoveryUi("key-1", "Your original claim is being checked.", "CHECK SAVED RECEIPT", busy = true)
        SavedClaimStep.entries.forEach { step ->
            val shown = savedClaimRecovery(rec, step)
            // The tap must reach the same saved request, and a running check stays unpressable.
            assertEquals("key-1", shown.key); assertTrue(shown.busy)
        }
        assertEquals("SAVE RECEIPT", savedClaimRecovery(rec, SavedClaimStep.SAVE_RECEIPT).actionLabel)
        assertEquals("CHECK SAVED RECEIPT", savedClaimRecovery(rec, SavedClaimStep.CHECK).actionLabel)
        assertEquals("REVIEW SAVED CLAIM", savedClaimRecovery(rec, SavedClaimStep.REVIEW_DRAFT).actionLabel)
        assertEquals(rec.line, savedClaimRecovery(rec, SavedClaimStep.CHECK).line)
    }

    @Test fun `a claim tap explains itself while an order runs or the owner would refuse it`() {
        // A running order wins, so a double tap never reads as a refusal of the claim itself.
        assertEquals(SHARE_CLAIM_WORKING_LINE, shareClaimRefusal(busy = true, hasDueRow = true, canReview = true, drawnReason = null))
        assertNull(shareClaimRefusal(busy = false, hasDueRow = true, canReview = true, drawnReason = null))
        // The owner's rule at the moment of the tap decides, even when the drawn button was enabled.
        assertEquals("Paused.", shareClaimRefusal(busy = false, hasDueRow = true, canReview = false, drawnReason = "Paused."))
        assertEquals("Paused.", shareClaimRefusal(busy = false, hasDueRow = false, canReview = true, drawnReason = "Paused."))
        assertTrue(shareClaimRefusal(busy = false, hasDueRow = true, canReview = false, drawnReason = null)!!.isNotBlank())
    }

    @Test fun `a saved review reopens only while claims are open and only into the kingdom it was reviewed for`() {
        assertNull(savedDraftRefusal(allowed = true, savedBase = "base-1", selectedBase = "base-1"))
        assertTrue(savedDraftRefusal(allowed = false, savedBase = "base-1", selectedBase = "base-1")!!.contains("paused"))
        assertTrue(savedDraftRefusal(allowed = true, savedBase = "base-1", selectedBase = "base-2")!!.contains("original destination kingdom"))
        assertTrue(savedDraftRefusal(allowed = true, savedBase = "base-1", selectedBase = null)!!.contains("original destination kingdom"))
    }

    @Test fun `the resource seal holds the original dialog strings verbatim`() {
        val s = seal()
        assertEquals("CLAIM RESOURCE SHARE", s.title)
        assertEquals(listOf("Heartwood Beams · Spot 7", "1,840 currently available", "21 Sep 2026, 00:00 UTC – 28 Sep 2026, 00:00 UTC"), s.lines)
        assertEquals("Destination: base-1", s.secondary)
        assertEquals(listOf(resourceLine), s.finePrint)
        assertEquals("CLAIM RESOURCES", s.confirmLabel); assertEquals("BACK", s.backLabel)
        // Nothing is paid: no get side, and the token never reads as a cost to a screen reader.
        assertNull(s.gets)
        assertEquals(Currency.ITEM, s.pay.currency); assertEquals("bag", s.pay.icon)
        assertEquals("1,840 currently available", priceDescription(s.pay))
        assertFalse(priceDescription(s.pay).contains("Costs"))
    }

    @Test fun `the shards seal holds the original dialog strings verbatim`() {
        val s = seal(shards = true)
        assertEquals("CLAIM YOUR SHARDS SHARE", s.title)
        assertEquals(listOf("Spot 7", "1,840 SHARDS currently available", "21 Sep 2026, 00:00 UTC – 28 Sep 2026, 00:00 UTC"), s.lines)
        assertEquals("Destination: base-1", s.secondary)
        assertEquals(listOf(shardsLine), s.finePrint)
        assertTrue(s.finePrint.single().endsWith("No wallet approval is needed."))
        assertEquals("CLAIM SHARDS", s.confirmLabel)
        assertEquals(Currency.SHARDS, s.pay.currency); assertNull(s.gets)
        assertFalse(priceDescription(s.pay).contains("Costs"))
    }

    @Test fun `the seal never arms while the claim is running or new claims are paused`() {
        val ready = seal()
        assertTrue(ready.canArm); assertEquals(MoneyStage.READY, ready.stage); assertNull(ready.waitLine)
        assertEquals(5_000L, ready.armedAtMs)
        // While the owner's order runs the primary is the money sequence's Sending: no second submission can arm.
        val busy = seal(busy = true, canConfirm = true)
        assertFalse(busy.canArm); assertEquals(MoneyStage.SENDING, busy.stage); assertNull(busy.waitLine)
        // Paused: the primary stays unarmed and the Seal says why instead of ignoring the tap.
        val paused = seal(canConfirm = false)
        assertFalse(paused.canArm); assertEquals(MoneyStage.READY, paused.stage)
        assertTrue(paused.waitLine!!.contains("paused"))
    }

    @Test fun `the rewards sheet starts at 254 on the designed phone and keeps its height on shorter screens`() {
        assertEquals(254f, islandRewardsSheetTopDp(915f), 0f)
        // A taller screen never pushes the sheet below the designed edge.
        assertEquals(254f, islandRewardsSheetTopDp(1200f), 0f)
        assertEquals(139f, islandRewardsSheetTopDp(800f), 0f)
        // Never above the system tall-sheet top, however short the screen.
        assertEquals(104f, islandRewardsSheetTopDp(640f), 0f)
    }
}
