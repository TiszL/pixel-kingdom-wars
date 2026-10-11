package gg.pixelkingdomwars.nativeclient.ops

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Intents saved by the pre-shell builds (four separate encrypted journals) must recover through
 * the unified journal after the upgrade: an interrupted purchase is never lost by a refactor. */
class LegacyPendingIntentsTest {
    private val body = trainingBody()
    private val quote = buildJsonObject { put("costShards", "9007199254740993") }
    private fun trainingV1() = buildJsonObject { put("schemaVersion", 1); put("requests", buildJsonObject { put(WALLET, buildJsonObject { put("body", body); put("quote", quote) }) }) }.toString()
    private fun constructionV1(path: String = ConstructionSpec.PLACE, body: JsonObject = placementBody()) = buildJsonObject {
        put("schemaVersion", 1); put("requests", buildJsonObject { put(WALLET, buildJsonObject { put("path", path); put("label", "Build mine"); put("body", body) }) })
    }.toString()
    private fun cancellationV1(attempted: Boolean, receipt: JsonObject? = null, baseId: String? = CANCEL_BASE) = buildJsonObject {
        put("schemaVersion", 1); put("requests", buildJsonObject { put(WALLET, buildJsonObject {
            put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull); put("queueId", QUEUE); put("idempotencyKey", "cancel-original-key")
            put("troop", "highlander"); put("refundShards", "90071992547409931234567890123456"); put("attempted", attempted); put("receipt", receipt ?: JsonNull)
        }) })
    }.toString()
    private val researchTarget = Json.parseToJsonElement("""{"action":"start","troop":"unit","level":"1","toLevel":2,"price":"91","baseId":"base-a"}""").jsonObject
    private val researchBody = Json.parseToJsonElement("""{"baseId":"base-a","troop":"unit","idempotencyKey":"fixed-order-key"}""").jsonObject
    private fun researchV1() = buildJsonObject { put(WALLET, buildJsonObject { put("target", researchTarget); put("body", researchBody) }) }.toString()

    @Test fun `a version one training request recovers as an attempted training intent`() {
        val decoded = LegacyPendingIntents.decodeTraining(trainingV1()).single()
        assertEquals(IntentKind.TRAINING_BATCH, decoded.kind); assertEquals(WALLET, decoded.wallet)
        assertEquals(body, decoded.body); assertEquals(quote, decoded.quote); assertEquals("original-receipt", decoded.idempotencyKey)
        assertEquals(TrainingBatchSpec.PATH, decoded.path); assertEquals(BASE, decoded.baseId)
        assertTrue("A saved request may already have been sent; recovery must observe, never resend", decoded.attempted)
    }
    @Test fun `the first preview training format recovers the same original purchase`() {
        val preview = buildJsonObject { put("wallet", WALLET); put("body", body); put("quote", quote) }.toString()
        assertEquals(LegacyPendingIntents.decodeTraining(trainingV1()), LegacyPendingIntents.decodeTraining(preview))
    }
    @Test fun `construction orders keep their exact path body and label`() {
        val placement = LegacyPendingIntents.decodeConstruction(constructionV1()).single()
        assertEquals(ConstructionSpec.PLACE, placement.path); assertEquals(placementBody(), placement.body); assertEquals("Build mine", placement.label)
        val upgrade = LegacyPendingIntents.decodeConstruction(constructionV1("/base/buildings/00000000-0000-4000-8000-000000000002/upgrade",
            buildJsonObject { put("idempotencyKey", "upgrade-key-1"); put("baseId", BASE) })).single()
        assertEquals(IntentKind.CONSTRUCTION, upgrade.kind); assertTrue(upgrade.attempted)
        assertThrows(IllegalArgumentException::class.java) { LegacyPendingIntents.decodeConstruction(constructionV1("/base/other", placementBody())) }
    }
    @Test fun `a cancellation with its receipt recovers as a proven intent and without one as attempted`() {
        val proven = LegacyPendingIntents.decodeCancellation(cancellationV1(true, cancelReceipt())).single()
        assertEquals(cancelIntent().copy(attempted = true, receipt = ReceiptDocument.fromReceiptRoute(cancelReceipt())), proven)
        val attempted = LegacyPendingIntents.decodeCancellation(cancellationV1(true)).single()
        assertEquals(cancelIntent().copy(attempted = true), attempted)
        val legacyNull = LegacyPendingIntents.decodeCancellation(cancellationV1(false, baseId = null)).single()
        assertNull(legacyNull.baseId); assertFalse(legacyNull.body.containsKey("baseId"))
        assertEquals("90071992547409931234567890123456", TrainingCancelSpec.refundShards(legacyNull))
    }
    @Test fun `a research order recovers with its target and derived route`() {
        val decoded = LegacyPendingIntents.decodeResearch(researchV1()).single()
        assertEquals(IntentKind.RESEARCH, decoded.kind); assertEquals("/army/research", decoded.path)
        assertEquals(researchTarget, decoded.quote); assertEquals(researchBody, decoded.body); assertEquals("base-a", decoded.baseId)
    }
    @Test fun `malformed legacy records fail loudly instead of vanishing`() {
        assertThrows(Exception::class.java) { LegacyPendingIntents.decodeTraining("""{"schemaVersion":2,"requests":{}}""") }
        assertThrows(Exception::class.java) { LegacyPendingIntents.decodeCancellation("""{"schemaVersion":1,"requests":{"$WALLET":null}}""") }
        assertThrows(Exception::class.java) { LegacyPendingIntents.decodeConstruction("""{"schemaVersion":2,"requests":{}}""") }
        assertThrows(Exception::class.java) { LegacyPendingIntents.decodeResearch("""{"$WALLET":{"target":{"action":"explode","troop":"unit"},"body":{}}}""") }
    }
    @Test fun `migration writes the unified journal before clearing the four legacy stores`() {
        val training = MemoryStore(trainingV1()); val construction = MemoryStore(constructionV1())
        val cancellation = MemoryStore(cancellationV1(true, cancelReceipt())); val research = MemoryStore(researchV1())
        val unified = MemoryStore()
        val store = PendingIntentStore(unified, LegacyPendingStores(training, construction, cancellation, research))
        val all = store.all(WALLET)
        assertEquals(setOf(IntentKind.TRAINING_BATCH, IntentKind.CONSTRUCTION, IntentKind.TRAINING_CANCEL, IntentKind.RESEARCH), all.map { it.kind }.toSet())
        assertNotNull(unified.value)
        for (legacy in listOf(training, construction, cancellation, research)) { assertNull(legacy.value); assertEquals(1, legacy.clears) }
        assertEquals("A fresh store reads the migrated journal without legacy input", all, PendingIntentStore(MemoryStore(unified.value)).all(WALLET))
    }
    @Test fun `a crash between the unified write and the legacy clear reconciles on the next read`() {
        val unified = MemoryStore(); val training = MemoryStore(trainingV1())
        PendingIntentStore(unified, LegacyPendingStores(training = training)).all(WALLET)
        training.value = trainingV1() // The clear never landed; both copies exist after restart.
        val again = PendingIntentStore(unified, LegacyPendingStores(training = training)).all(WALLET)
        assertEquals(1, again.size); assertNull(training.value)
        val conflicting = MemoryStore(buildJsonObject { put("wallet", WALLET); put("body", trainingBody(key = "different-key")); put("quote", quote) }.toString())
        assertThrows(IllegalArgumentException::class.java) { PendingIntentStore(unified, LegacyPendingStores(training = conflicting)).all(WALLET) }
        assertNotNull("A conflicting legacy record is never silently dropped", conflicting.value)
    }
    @Test fun `unreadable legacy storage fails closed rather than reporting nothing pending`() {
        val training = MemoryStore(trainingV1()).apply { unreadable = true }
        val store = PendingIntentStore(MemoryStore(), LegacyPendingStores(training = training))
        assertThrows(gg.pixelkingdomwars.nativeclient.network.SecretStorageException::class.java) { store.all(WALLET) }
        assertThrows(gg.pixelkingdomwars.nativeclient.network.SecretStorageException::class.java) { store.create(placementIntent()) }
    }
}
