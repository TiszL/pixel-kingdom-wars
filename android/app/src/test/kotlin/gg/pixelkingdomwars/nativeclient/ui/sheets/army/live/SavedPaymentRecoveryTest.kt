package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.PendingIntent
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Saved-payment recovery moved from the old ArmyScreen / ResearchScreen onto the designed sheets (c-gap-army). The split
 * is a money rule, not a layout choice: a modern saved finish payment must be a card whose only actions are a receipt
 * CHECK and a re-review through the existing consent, never the herald's RETRY, which would resend a money request
 * without showing its price again. These cases fail if the split, the wallet filter or the review gates drift.
 */
class SavedPaymentRecoveryTest {
    private val wallet = "Wa11et1111111111111111111111111111111111111"
    private fun intent(kind: String, currency: String?, baseId: String = "base-1", owner: String = wallet, proven: Boolean = false) =
        InterruptedIntent(PendingIntent(kind, owner, baseId, "saved-key-$kind-$currency", "/army/saved", JsonObject(emptyMap()), "Saved $kind",
            attempted = proven, receipt = if (proven) JsonObject(mapOf("ok" to JsonPrimitive(true))) else null, expectedCurrency = currency))
    private fun state(vararg items: InterruptedIntent) = ArmyUiState(wallet = wallet, baseId = "base-1", interrupted = items.toList())

    @Test fun `a modern saved training finish is a card and older training requests stay heralds`() {
        val modern = intent(IntentKind.TRAINING_FINISH, "GEMS")
        val legacyFinish = intent(IntentKind.TRAINING_FINISH, null)
        val batch = intent(IntentKind.TRAINING_BATCH, null)
        val rows = trainingSavedPayments(state(modern, legacyFinish, batch))
        assertEquals(listOf(modern), rows.saved)
        assertEquals(listOf(legacyFinish, batch), rows.heralds)
        assertFalse(rows.isEmpty)
    }

    @Test fun `a training request of another wallet is never shown on this sheet`() {
        val other = intent(IntentKind.TRAINING_FINISH, "GEMS", owner = "Other111111111111111111111111111111111111111")
        assertTrue(trainingSavedPayments(state(other)).isEmpty)
    }

    @Test fun `research splits on saved currency terms exactly like the old screen`() {
        val modern = intent(IntentKind.RESEARCH, "KEEP")
        val legacy = intent(IntentKind.RESEARCH, null)
        val training = intent(IntentKind.TRAINING_FINISH, "GEMS")
        val rows = researchSavedPayments(state(modern, legacy, training))
        assertEquals(listOf(modern), rows.saved)
        assertEquals(listOf(legacy), rows.heralds)
    }

    @Test fun `a proven payment is never offered for review and another kingdom cannot review it`() {
        assertFalse(savedPaymentReviewShown(intent(IntentKind.TRAINING_FINISH, "GEMS", proven = true)))
        assertFalse(savedPaymentReviewShown(intent(IntentKind.TRAINING_BATCH, null)))
        val elsewhere = intent(IntentKind.RESEARCH, "GEMS", baseId = "base-2")
        assertFalse(savedPaymentReviewEnabled(state(elsewhere), elsewhere, busy = false, actionsAllowed = true))
        val here = intent(IntentKind.RESEARCH, "GEMS")
        assertTrue(savedPaymentReviewEnabled(state(here), here, busy = false, actionsAllowed = true))
        assertFalse("Nothing is reviewed while an order is in flight", savedPaymentReviewEnabled(state(here), here, busy = true, actionsAllowed = true))
        val training = intent(IntentKind.TRAINING_FINISH, "GEMS")
        assertFalse("A retired build cannot re-review a training payment",
            savedPaymentReviewEnabled(state(training).copy(ordersAllowed = false), training, busy = false, actionsAllowed = true))
    }
}
