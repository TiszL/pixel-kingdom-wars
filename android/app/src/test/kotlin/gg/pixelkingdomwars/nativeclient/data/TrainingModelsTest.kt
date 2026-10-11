package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.TrainingQueueRow
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.trainingConfirmation
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.retiredTutorialStep
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Pure training models rewritten from ArmyTrainingComposerTest, TrainingQueueTest and TutorialRecoveryTest. */
class TrainingModelsTest {
    private fun draft(vararg rows: Pair<String, String>) = ArmyTrainingDraft("wallet-A", "base-A", linkedMapOf(*rows))

    @Test fun `requested training order survives quantity edits without local pricing`() {
        val rows = linkedMapOf("bowman" to "2", "highlander" to "3"); rows["bowman"] = "4"
        assertEquals(json("""{"baseId":"base-A","composition":[{"troop":"bowman","count":4},{"troop":"highlander","count":3}]}"""), ArmyTrainingDraft("wallet-A", "base-A", rows).request("wallet-A", "base-A", rows.keys))
    }
    @Test fun `empty zero malformed and overflowing quantities never become a quote`() {
        assertEquals(Json.parseToJsonElement("""[{"troop":"highlander","count":2}]"""), draft("bowman" to "0", "tunneler" to "", "highlander" to "2").composition())
        assertThrows(IllegalArgumentException::class.java) { draft("bowman" to "0").composition() }
        for (value in listOf("-1", "1.5", "1e2", "2147483648", "one")) assertThrows(IllegalArgumentException::class.java) { draft("bowman" to value).composition() }
    }
    @Test fun `stale account base or removed options require a fresh selection`() {
        val old = draft("bowman" to "2")
        for (scope in listOf("wallet-B" to "base-A", "wallet-A" to "base-B", null to null)) assertThrows(IllegalArgumentException::class.java) { old.request(scope.first, scope.second, setOf("bowman")) }
        assertThrows(IllegalArgumentException::class.java) { draft("bowman" to "2", "highlander" to "1").request("wallet-A", "base-A", setOf("bowman")) }
    }
    @Test fun `a partial server quote purchases only included units in server order and exact amount`() {
        val quote = json("""{"requested":[{"troop":"bowman","count":5}],"queueable":[{"troop":"bowman","count":3}],"remaining":[{"troop":"bowman","count":2,"reason":"full"}],"costShards":"9007199254740993"}""")
        val body = trainingConfirmation(quote, "base-A", "original-id")
        assertEquals(quote["queueable"], body["composition"]); assertEquals("9007199254740993", body.string("confirmedCostShards"))
        val store = PendingIntentStore(MemoryStore())
        val intent = PendingIntent(IntentKind.TRAINING_BATCH, "wallet-A", "base-A", "original-id", TrainingBatchSpec.PATH, body, "Train army", quote)
        assertTrue(store.create(intent))
        assertFalse(store.clearIfMatching(intent.copy(idempotencyKey = "replacement-id", body = trainingConfirmation(quote, "base-A", "replacement-id"))))
        assertEquals(body, store.get(IntentKind.TRAINING_BATCH, "wallet-A")!!.body)
    }
    private fun row(id: String = "22222222-2222-4222-8222-222222222222", refund: String? = "9007199254740993", canCancel: Boolean = true) = TrainingQueueRow(id, "highlander", canCancel = canCancel, refundShards = refund)
    private fun army(vararg rows: TrainingQueueRow) = ArmyState.from(armyJson(queue = JsonArray(rows.map { buildJsonObject { put("id", it.id); put("troop", it.troop); put("canCancel", it.canCancel); if (it.refundShards != null) put("refundShards", it.refundShards) else put("refundShards", JsonNull) } }).toString()))

    @Test fun `refund consent keeps the server decimal string without rounding`() {
        val choice = requireNotNull(TrainingCancellationChoice.of("wallet", "base", army(row()), row()))
        assertEquals("9007199254740993", choice.refundShards)
    }
    @Test fun `reordered rows keep identity but a replacement troop cannot receive a stale cancellation`() {
        val original = row(); val other = row(id = "33333333-3333-4333-8333-333333333333")
        val choice = requireNotNull(TrainingCancellationChoice.of("wallet", "base", army(original, other), original))
        choice.requireCurrent("wallet", "base", army(other, original))
        assertTrue(runCatching { choice.requireCurrent("wallet", "base", army(other)) }.isFailure)
    }
    @Test fun `account base and changed refund invalidate an open confirmation`() {
        val choice = requireNotNull(TrainingCancellationChoice.of("wallet", "base", army(row()), row()))
        assertTrue(runCatching { choice.requireCurrent("next", "base", army(row())) }.isFailure)
        assertTrue(runCatching { choice.requireCurrent("wallet", "sold", army(row())) }.isFailure)
        assertTrue(runCatching { choice.requireCurrent("wallet", "base", army(row(refund = "12"))) }.isFailure)
    }
    @Test fun `legacy and malformed refunds never expose an actionable cancellation`() {
        for (candidate in listOf(row(canCancel = false), row(refund = null), row(refund = "1e3"), row(refund = "0"), row(refund = "1".repeat(33))))
            assertNull(TrainingCancellationChoice.of("wallet", "base", army(candidate), candidate))
        assertNull("A row missing from the army is not cancellable", TrainingCancellationChoice.of("wallet", "base", army(), row()))
    }
    @Test fun `legacy deck indices can recover without changing quest guidance preferences`() {
        val ids = Json.parseToJsonElement("""["welcome","camera","quests","done"]""").jsonArray
        assertTrue(retiredTutorialStep(12, false, ids)); assertTrue(retiredTutorialStep(3, false, ids))
        assertFalse(retiredTutorialStep(1, false, ids)); assertFalse(retiredTutorialStep(12, true, ids))
        assertFalse(retiredTutorialStep(12, false, null)); assertFalse(retiredTutorialStep(12, false, buildJsonArray {}))
    }
}
