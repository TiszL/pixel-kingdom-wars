package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure rules of the Gold Forge LEGACY tab, round 2 (design/final/goldforge/SPEC.md "E1.1 Gold Forge LEGACY tab"). */
class LegacyLogicTest {
    private fun w(id: String, state: WithdrawalState, canReturn: Boolean = false, proof: String? = null, line: String = "", busy: Boolean = false) =
        LegacyWithdrawalUi(id, "200", state, line, canReturn, proof, busy)

    private val base = LegacyV2Ui("1,820", null, "Each KEEP becomes a Gem", emptyList(), null, live = true)

    // D-009: an unknown balance is "…", never 0; only a server zero says "Nothing saved here".
    @Test fun `the well never turns an unknown balance into zero`() {
        assertEquals(LegacyWellState.SAVED, legacyWellState(base))
        assertEquals(LegacyWellState.SAVED, legacyWellState(base.copy(saved = null)))
        assertEquals(LegacyWellState.SAVED, legacyWellState(base.copy(saved = "…")))
        assertEquals("…", legacySavedText(null))
        assertEquals(LegacyWellState.NOTHING_SAVED, legacyWellState(base.copy(saved = "0")))
        assertEquals(LegacyWellState.NOTHING_SAVED, legacyWellState(base.copy(saved = "0.00")))
        assertFalse(isServerZero("1,820"))
        assertFalse(isServerZero("10"))
        assertEquals(LegacyWellState.CONVERTED, legacyWellState(base.copy(convertedLine = "Turned into 1,820 Gems on 14 Oct")))
        assertEquals("as of 14:20", legacySavedCaption("14:20"))
        assertEquals("yours, kept safe", legacySavedCaption(null))
    }

    // D-152: nothing to do; no date is invented; after the update every step is done.
    @Test fun `the steps and the note never invent a date`() {
        val steps = legacySteps(base)
        assertEquals(listOf("Saved here", "Gems on", "1,820 Gems"), steps.map { it.title })
        assertEquals(listOf(StepState.NOW, StepState.TODO, StepState.TODO), steps.map { it.state })
        assertTrue(legacySteps(base.copy(convertedLine = "x")).all { it.state == StepState.DONE })
        assertEquals("Each KEEP becomes a Gem. The date comes to your Mail first.", legacyRateNote("Each KEEP becomes a Gem", null))
        assertEquals("Each KEEP becomes a Gem on 14 Oct. Your Mail has the details.", legacyRateNote("Each KEEP becomes a Gem.", "14 Oct"))
    }

    // The summary says "being checked" whenever a row is CHECKING and never "failed"; a refused return still pays out.
    @Test fun `the summary counts honestly and never says failed`() {
        val list = listOf(w("1", WithdrawalState.UNLOCKING), w("2", WithdrawalState.CHECKING), w("3", WithdrawalState.SENT),
            w("4", WithdrawalState.REFUSED), w("5", WithdrawalState.RETURNED))
        val s = legacySummary(list)
        assertEquals(LegacySummary(onTheWay = 3, arrived = 1, checking = 1), s)
        assertEquals("3 on the way · 1 arrived", legacySummaryTitle(s))
        assertEquals("Next in 2d 4h · 1 being checked", legacySummaryLine(s, "2d 4h"))
        assertEquals("1 arrived", legacySummaryTitle(LegacySummary(0, 1, 0)))
        assertEquals("Nothing on the way", legacySummaryTitle(LegacySummary(0, 0, 0)))
        assertNull(legacySummaryLine(LegacySummary(1, 0, 0), null))
        val lines = listOf(legacySummaryTitle(s), legacySummaryLine(s, "2d 4h")!!) + list.map { withdrawalLook(it).line } +
            returnConfirmLine("200") + legacyRateNote("Each KEEP becomes a Gem", null)
        lines.forEach { line -> LEGACY_FORBIDDEN_WORDS.forEach { word -> assertFalse("'$line' says '$word'", line.contains(word, ignoreCase = true)) } }
    }

    // BACK TO FORGE only when the server says it is safe; CHECK AGAIN re-reads, never re-sends; frozen = no actions.
    @Test fun `row actions follow the server and the freeze`() {
        assertEquals(WithdrawalAction.BACK_TO_FORGE, withdrawalLook(w("1", WithdrawalState.UNLOCKING, canReturn = true)).action)
        assertEquals(WithdrawalAction.NONE, withdrawalLook(w("1", WithdrawalState.UNLOCKING, canReturn = false)).action)
        val checking = withdrawalLook(w("2", WithdrawalState.CHECKING))
        assertEquals(WithdrawalAction.CHECK_AGAIN, checking.action)
        assertTrue(checking.tinted)
        // Rewritten 2026-10-06 (S4): this pinned the SPEC tail "Being checked · stays saved". Nothing tells the client the
        // KEEP stayed saved while a status is unconfirmed, so the fallback keeps the SPEC opening with a provable tail.
        assertEquals("Being checked · original record kept", checking.line)
        assertEquals(WithdrawalAction.PROOF, withdrawalLook(w("3", WithdrawalState.SENT, proof = "h")).action)
        assertEquals(WithdrawalAction.NONE, withdrawalLook(w("3", WithdrawalState.SENT)).action)
        val refused = withdrawalLook(w("4", WithdrawalState.REFUSED))
        assertEquals("NOT RETURNED" to Verb.STONE, refused.tag to refused.verb)
        assertEquals("The payout had already started. It reaches your wallet.", refused.line)
        assertEquals("RETURNED" to Verb.MOSS, withdrawalLook(w("5", WithdrawalState.RETURNED)).let { it.tag to it.verb })
        assertEquals(WithdrawalAction.NONE, withdrawalLook(w("1", WithdrawalState.UNLOCKING, canReturn = true, busy = true)).action)
        assertEquals(WithdrawalAction.NONE, withdrawalLook(w("2", WithdrawalState.CHECKING), frozen = true).action)
    }

    @Test fun `the return confirm is not a money Seal`() {
        assertEquals("Bring 200 KEEP back to the forge? The forge checks this one again first. No wallet step.", returnConfirmLine("200"))
    }

    // legacy.png's card: "2 on the way · 1 arrived" over "Next in 2d 4h · 1 being checked". The live adapter has no arrival
    // time (unbondsAt is not one), so the line must read "1 being checked" alone, never a guessed "Next in".
    @Test fun `the summary card reads like the frame and never guesses the next arrival`() {
        val s = legacySummary(listOf(w("1", WithdrawalState.UNLOCKING), w("2", WithdrawalState.CHECKING), w("3", WithdrawalState.SENT)))
        assertEquals("2 on the way · 1 arrived", legacySummaryTitle(s))
        assertEquals("1 being checked", legacySummaryLine(s, null))
        assertEquals("1 being checked", legacySummaryLine(s, " "))
        assertFalse(legacySummaryLine(s, null)!!.contains("Next in"))
        assertEquals("Next in 2d 4h · 1 being checked", legacySummaryLine(s, "2d 4h"))
        // No CHECKING row and no arrival time: the card shows only its title and "Tap to see each one."
        assertNull(legacySummaryLine(legacySummary(listOf(w("1", WithdrawalState.UNLOCKING), w("3", WithdrawalState.SENT))), null))
    }

    // legacy.png draws "1,820". The adapter hands over the raw server decimal, so the figure is grouped here with every digit
    // kept (never rounded); unknown stays "…", a server zero stays "0" and a figure already formatted is drawn as given.
    @Test fun `saved figures are grouped exactly and unknown stays an ellipsis`() {
        assertEquals("1,820", legacySavedText("1820"))
        assertEquals("1,234,567.000001", legacySavedText("1234567.000001"))
        assertEquals("1,820", legacySavedText("1,820"))
        assertEquals("0", legacySavedText("0"))
        assertEquals("…", legacySavedText("…"))
        assertEquals("…", legacySavedText(" "))
        assertEquals("1,820 Gems", legacySteps(base.copy(saved = "1820"))[2].title)
        assertEquals(LegacyWellState.NOTHING_SAVED, legacyWellState(base.copy(saved = "0")))
    }
}
