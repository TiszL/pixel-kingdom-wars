package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.SecretStorageException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The unified journal keeps every money intent exact across restarts, wallet switches and sign-out. */
class PendingIntentStoreTest {
    @Test fun `saved currency consent cannot be changed dropped or added to a legacy intent`() {
        for (currency in listOf(null, "GEMS", "KEEP")) {
            val store = PendingIntentStore(MemoryStore())
            val intent = HeroUpgradeSpec.intent(WALLET, BASE, "vex", "hero-currency-cas", 2, "10", currency)
            store.create(intent)
            for (replacement in listOf(null, "GEMS", "KEEP").filter { it != currency }) {
                assertThrows(IllegalArgumentException::class.java) {
                    store.replaceIfMatching(intent, intent.copy(expectedCurrency = replacement))
                }
            }
            assertEquals(intent, store.get(intent.kind, WALLET))
            assertTrue(store.replaceIfMatching(intent, intent.copy(attempted = true)))
        }
    }
    @Test fun `switching wallets preserves each interrupted intent without exposing the other`() {
        val memory = MemoryStore(); val store = PendingIntentStore(memory)
        assertTrue(store.create(trainingIntent()))
        assertNull(store.get(IntentKind.TRAINING_BATCH, "walletB"))
        assertTrue(store.create(trainingIntent().copy(wallet = "walletB", idempotencyKey = "other-receipt")))
        val restored = PendingIntentStore(memory)
        assertEquals(trainingIntent(), restored.get(IntentKind.TRAINING_BATCH, WALLET))
        assertTrue(restored.clearIfMatching(requireNotNull(restored.get(IntentKind.TRAINING_BATCH, "walletB"))))
        assertEquals(trainingIntent(), restored.get(IntentKind.TRAINING_BATCH, WALLET))
        assertEquals(listOf(trainingIntent()), restored.all(WALLET))
    }
    @Test fun `one outstanding intent per kind blocks a second of that kind but not another kind`() {
        val store = PendingIntentStore(MemoryStore())
        assertTrue(store.create(trainingIntent()))
        assertFalse("A second training purchase cannot replace an unresolved one", store.create(trainingIntent().copy(idempotencyKey = "replacement-key")))
        assertTrue(store.create(placementIntent()))
        assertEquals(2, store.all(WALLET).size)
    }
    @Test fun `compare and swap retires or replaces only the exact saved record`() {
        val store = PendingIntentStore(MemoryStore()); val intent = trainingIntent()
        store.create(intent)
        val attempted = intent.copy(attempted = true)
        assertFalse("A stale record cannot be swapped", store.replaceIfMatching(intent.copy(label = "Other"), attempted))
        assertTrue(store.replaceIfMatching(intent, attempted))
        assertFalse("An attempted record cannot revert to unsent", runCatching { store.replaceIfMatching(attempted, intent) }.isSuccess)
        assertFalse(store.clearIfMatching(intent))
        assertTrue(store.clearIfMatching(attempted))
        assertNull(store.get(IntentKind.TRAINING_BATCH, WALLET))
    }
    @Test fun `a proven receipt cannot be changed or dropped by a later write`() {
        val memory = MemoryStore(); val store = PendingIntentStore(memory); val attempted = trainingIntent().copy(attempted = true)
        store.create(attempted)
        val proven = attempted.copy(receipt = ReceiptDocument.fromPost(buildJsonObject { put("costShards", "9007199254740993") }))
        assertTrue(store.replaceIfMatching(attempted, proven))
        assertThrows(IllegalArgumentException::class.java) { store.replaceIfMatching(proven, proven.copy(receipt = null)) }
        assertThrows(IllegalArgumentException::class.java) { store.replaceIfMatching(proven, proven.copy(receipt = ReceiptDocument.fromPost(buildJsonObject {}))) }
        assertEquals("A restart reads the proven record back", proven, PendingIntentStore(MemoryStore(memory.value)).get(IntentKind.TRAINING_BATCH, WALLET))
    }
    @Test fun `corrupt or foreign journals fail closed without erasing bytes`() {
        for (value in listOf("broken", """{"schemaVersion":1,"intents":[]}""", """{"schemaVersion":2,"intents":[{"kind":"training-batch"}]}""",
            """{"schemaVersion":2}""")) {
            val memory = MemoryStore(value); val store = PendingIntentStore(memory)
            assertThrows(Exception::class.java) { store.get(IntentKind.TRAINING_BATCH, WALLET) }
            assertThrows(Exception::class.java) { store.create(trainingIntent()) }
            assertEquals(value, memory.value); assertEquals(0, memory.writes); assertEquals(0, memory.clears)
        }
    }
    @Test fun `transient storage failure cannot discard or replace an ambiguous purchase`() {
        val memory = MemoryStore(); val store = PendingIntentStore(memory)
        store.create(trainingIntent())
        val saved = memory.value
        memory.unreadable = true
        assertThrows(SecretStorageException::class.java) { store.get(IntentKind.TRAINING_BATCH, WALLET) }
        assertThrows(SecretStorageException::class.java) { store.create(trainingIntent().copy(idempotencyKey = "duplicate-key")) }
        assertEquals(saved, memory.value); assertEquals(1, memory.writes); assertEquals(0, memory.clears)
        memory.unreadable = false
        assertEquals(trainingIntent(), PendingIntentStore(memory).get(IntentKind.TRAINING_BATCH, WALLET))
    }
    @Test fun `intent invariants refuse malformed keys paths and receipts`() {
        assertThrows(IllegalArgumentException::class.java) { trainingIntent().copy(idempotencyKey = "short") }
        assertThrows(IllegalArgumentException::class.java) { trainingIntent().copy(path = "/army/../base") }
        assertThrows(IllegalArgumentException::class.java) { trainingIntent().copy(kind = "unknown-kind") }
        assertThrows(IllegalArgumentException::class.java) { trainingIntent().copy(receipt = buildJsonObject {}) }
    }
    @Test fun `the journal survives a round trip with exact decimal bodies`() {
        val memory = MemoryStore(); val intent = trainingIntent(trainingBody(cost = "90071992547409931234567890123456"))
        PendingIntentStore(memory).create(intent)
        val restored = PendingIntentStore(memory).get(IntentKind.TRAINING_BATCH, WALLET)
        assertEquals("90071992547409931234567890123456", (restored!!.body["confirmedCostShards"] as JsonPrimitive).content)
        assertEquals(intent, restored)
    }
}
