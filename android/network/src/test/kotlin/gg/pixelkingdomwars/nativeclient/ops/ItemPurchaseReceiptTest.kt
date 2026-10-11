package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner review 2026-10-06 (B1) with the server contract of night/server 231e6cff9 (packages/shared/src/itemPurchase.ts,
 * apps/api/src/game/itemPurchaseReceipt.ts). A shop purchase whose reply was lost could only be resolved by TRY AGAIN, and a
 * replay can be refused before the server looks the key up, so it blocked the shop for good. A CONSENTED purchase (the
 * price the player saw and the exact currency, sent with the order) is recorded with its charge, so GET /items/buy/receipt
 * answers for exactly its key: accepted is hydrated, absent (read the minimum age after the send) can be closed, unknown
 * (a ledger row already holds the key) keeps blocking. A legacy purchase posts a different ledger record, so the route
 * would answer unknown or absent for it falsely: it never uses the route.
 */
class ItemPurchaseReceiptTest {
    private val consent = buildJsonObject { put("version", 1); put("catalogRevision", 2); put("quantity", 1); put("maxCostKeep", "60") }
    private fun consented(key: String = "item-key-0001", baseId: String? = BASE, currency: String = "KEEP") =
        ItemBuySpec.consentedIntent(WALLET, baseId, "keg_of_haste", key, "60", "Keg", catalogRevision = 2, expectedCurrency = currency)
    private fun accepted(intent: PendingIntent, amount: String = "60", currency: String = requireNotNull(intent.expectedCurrency),
                         wallet: String = WALLET) = buildJsonObject {
        put("version", 1); put("status", "accepted"); put("wallet", wallet)
        put("request", buildJsonObject {
            put("itemId", "keg_of_haste"); put("baseId", intent.baseId?.let(::JsonPrimitive) ?: JsonNull); put("idempotencyKey", intent.idempotencyKey)
            put("expectedCurrency", intent.expectedCurrency); put("consent", consent)
        })
        put("receiptId", "00000000-0000-4000-8000-000000000009"); put("acceptedAt", "2026-10-06T12:00:00.000Z")
        put("funding", buildJsonObject { put("currency", currency); put("amount", amount) })
        put("result", buildJsonObject { put("itemId", "keg_of_haste"); put("quantity", 1) })
    }
    private fun unknown(key: String) = buildJsonObject { put("version", 1); put("status", "unknown"); put("idempotencyKey", key) }
    private fun absent(key: String, asOfMs: Long) = buildJsonObject {
        put("version", 1); put("status", "absent"); put("idempotencyKey", key); put("absentAsOf", java.time.Instant.ofEpochMilli(asOfMs).toString())
    }
    /** The production item transport sends the exact currency header; this one records the same POST. */
    private fun currencyTransport(scripted: ScriptedTransport) = object : OpTransport by scripted {
        override suspend fun post(intent: PendingIntent): JsonObject = scripted.post(intent.path, intent.body)
        override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject = post(intent)
    }
    private inner class Harness {
        var now = START
        var hydrated = 0
        val store = PendingIntentStore(MemoryStore())
        val scripted = ScriptedTransport()
        val op = MoneyOp(ItemBuySpec, store, currencyTransport(scripted), clock = { now })
        val observer = ReceiptObserver(store, clock = { now }).apply { register(op) { hydrated += 1 } }
        fun saved() = store.get(IntentKind.ITEM_BUY, WALLET)
        fun postedKeys() = scripted.posts.map { it.second.getValue("idempotencyKey").jsonPrimitive.content }
    }

    @Test fun `a consented purchase sends its frozen price and currency and only it reads the keyed receipt`() {
        val intent = consented()
        assertEquals(buildJsonObject { put("itemId", "keg_of_haste"); put("idempotencyKey", "item-key-0001"); put("baseId", BASE); put("consent", consent) }, intent.body)
        assertEquals("KEEP", intent.expectedCurrency); ItemBuySpec.validateSend(intent)
        assertEquals(ReceiptRequest(ItemBuySpec.RECEIPT, mapOf("itemId" to "keg_of_haste", "idempotencyKey" to "item-key-0001", "baseId" to BASE)),
            ItemBuySpec.receiptRequest(intent))
        assertEquals("a purchase with no base omits it", mapOf("itemId" to "keg_of_haste", "idempotencyKey" to "item-key-0001"),
            ItemBuySpec.receiptRequest(consented(baseId = null))?.query)
        assertTrue(ItemBuySpec.forgetsOnServerAbsent(intent))
        // A legacy purchase posts a different ledger record: the route would answer unknown or absent for it falsely.
        val legacy = ItemBuySpec.intent(WALLET, BASE, "keg_of_haste", "item-key-0002", "60", "Keg")
        assertNull(ItemBuySpec.receiptRequest(legacy)); assertFalse(ItemBuySpec.forgetsOnServerAbsent(legacy))
        assertFalse(ItemBuySpec.unblocksAfterCheck(legacy, Receipt.Absent))
        assertEquals(Receipt.Unsupported, ItemBuySpec.decodeReceipt(legacy, accepted(consented(key = "item-key-0002"))))
        // The proof must be this wallet's original request, paid in the consented currency, within the consented price.
        assertEquals("60", (ItemBuySpec.decodeReceipt(intent, accepted(intent)) as Receipt.Accepted).value.costKeep)
        for (bad in listOf(accepted(intent, amount = "61"), accepted(intent, currency = "GEMS"), accepted(intent, wallet = "another-wallet"),
                accepted(consented(key = "item-key-0003")), JsonObject(accepted(intent) + ("extra" to JsonPrimitive(1))), unknown("item-key-0003")))
            assertThrows(ApiCompatibilityException::class.java) { ItemBuySpec.decodeReceipt(intent, bad) }
        assertEquals(Receipt.Unknown, ItemBuySpec.decodeReceipt(intent, unknown(intent.idempotencyKey)))
    }

    @Test fun `a purchase whose reply was lost keeps its key through a 401 retry and closes only on a settled absent answer`() = runBlocking {
        // The double-charge sequence: BUY commits, the reply is lost, TRY AGAIN gets 401 (the session expired before the
        // server looked the key up). A new purchase would carry a new key and could charge twice, so the shop stays shut;
        // only this key's own receipt can open it.
        val h = Harness()
        h.scripted.onPost = { _, _ -> throw IOException("committed, reply lost") }
        assertThrows(IOException::class.java) { runBlocking { h.op.submit(consented()) {} } }
        h.scripted.onPost = { _, _ -> throw ApiException(401, null, "session expired") }
        assertThrows(ApiException::class.java) { runBlocking { h.op.retry(WALLET) {} } }
        h.observer.refresh(WALLET)
        assertTrue("a 401 cannot prove the original never committed", h.observer.blocks(IntentKind.ITEM_BUY))
        assertThrows(IllegalStateException::class.java) { runBlocking { h.op.submit(consented(key = "item-key-0002")) {} } }
        // `unknown` on this route means a ledger row already holds the key: it keeps blocking, however old.
        h.scripted.onGet = { path, query ->
            assertEquals(ItemBuySpec.RECEIPT, path); assertEquals(mapOf("itemId" to "keg_of_haste", "idempotencyKey" to "item-key-0001", "baseId" to BASE), query)
            unknown("item-key-0001")
        }
        h.now += SAVED_REQUEST_MIN_AGE_MS
        assertEquals(Receipt.Unknown, h.observer.check(IntentKind.ITEM_BUY, WALLET))
        assertTrue(h.observer.blocks(IntentKind.ITEM_BUY)); assertFalse(h.observer.interrupted.value.single().closable)
        // An absence the server took before the minimum age had passed since the send may miss a request still in transit.
        h.scripted.onGet = { _, _ -> absent("item-key-0001", h.now - 1) }
        assertEquals(Receipt.Unknown, h.observer.check(IntentKind.ITEM_BUY, WALLET)); assertTrue(h.observer.blocks(IntentKind.ITEM_BUY))
        // No row holds the key the minimum age after the last send: the purchase never committed. CLOSE archives it.
        h.scripted.onGet = { _, _ -> absent("item-key-0001", h.now) }
        assertEquals(Receipt.Absent, h.observer.check(IntentKind.ITEM_BUY, WALLET))
        val herald = h.observer.interrupted.value.single()
        assertTrue(herald.closable); assertFalse(herald.blocking)
        assertTrue(h.observer.close(IntentKind.ITEM_BUY, WALLET) is Receipt.Closed)
        assertNull(h.saved()); assertEquals(1, h.store.kept(WALLET).count { it.closed })
        assertEquals("no new key ever left the device", listOf("item-key-0001", "item-key-0001"), h.postedKeys())
        assertEquals(0, h.hydrated)
    }

    @Test fun `a consented purchase whose reply was lost is hydrated from its keyed receipt and never resent`() = runBlocking {
        val h = Harness()
        h.scripted.onPost = { _, _ -> throw IOException("committed, reply lost") }
        assertThrows(IOException::class.java) { runBlocking { h.op.submit(consented()) {} } }
        val saved = requireNotNull(h.saved())
        h.scripted.onGet = { _, _ -> accepted(saved) }
        val found = h.observer.check(IntentKind.ITEM_BUY, WALLET)
        assertTrue(found is Receipt.Accepted); assertEquals("60", ((found as Receipt.Accepted<*>).value as ItemPurchaseAcceptance).costKeep)
        assertEquals("the charge is hydrated, never hidden", 1, h.hydrated); assertNull(h.saved())
        assertEquals("never resent", 1, h.scripted.posts.size)
    }

    @Test fun `a legacy purchase never reads the keyed receipt and keeps blocking until TRY AGAIN`() = runBlocking {
        val h = Harness()
        h.scripted.onPost = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { h.op.submit(ItemBuySpec.intent(WALLET, BASE, "keg_of_haste", "item-key-0001", "60", "Keg")) {} } }
        h.now += SAVED_REQUEST_MIN_AGE_MS
        assertEquals(Receipt.Unsupported, h.observer.check(IntentKind.ITEM_BUY, WALLET))
        assertTrue("no GET was made for a legacy purchase", h.scripted.gets.isEmpty())
        assertTrue(h.observer.blocks(IntentKind.ITEM_BUY)); assertFalse(h.observer.interrupted.value.single().closable)
        assertTrue(h.observer.interrupted.value.single().retryable)
    }

    private companion object { const val START = 1_000_000_000L }
}
