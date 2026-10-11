package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.WallRowQuote
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

private const val WALL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private const val WALL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
private fun quoteJson(total: String = "120", canAfford: Boolean = true) = Json.parseToJsonElement("""{"baseId":"$BASE","selectedWallId":"$WALL_A","keepLevel":3,
    "quoteId":"${"ab".repeat(32)}","walls":[{"id":"$WALL_A","tx":5,"ty":5,"level":2,"targetLevel":3,"costShards":72,"excluded":null},
    {"id":"$WALL_B","tx":6,"ty":5,"level":1,"targetLevel":2,"costShards":48,"excluded":null},{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","tx":7,"ty":5,"level":3,"targetLevel":null,"costShards":0,"excluded":"keep_level"}],
    "totalCostShards":$total,"balanceShards":"3520","canAfford":$canAfford}""").jsonObject
private fun rowResult(cost: String = "120", levelA: Int = 3, duplicate: Boolean = false) = Json.parseToJsonElement("""{"upgraded":[{"id":"$WALL_A","level":$levelA},{"id":"$WALL_B","level":2}],"costShards":$cost,"duplicate":$duplicate}""").jsonObject

/** The wall row purchase is exactly the consented quote, replayed by key; a re-priced refusal proves no purchase. */
class WallRowSpecTest {
    private val quote = WallRowQuote.from(quoteJson())
    private val intent = WallRowSpec.intent(WALLET, BASE, quote, "wall-row-key-1")
    @Test fun `the intent carries the frozen quote and posts only its id`() {
        assertEquals("/base/walls/$WALL_A/upgrade-row", intent.path)
        assertEquals(buildJsonObject { put("baseId", BASE); put("idempotencyKey", "wall-row-key-1"); put("quoteId", "ab".repeat(32)) }, intent.body)
        assertEquals(quote.quoteId, WallRowSpec.quote(intent).quoteId)
        assertThrows("A row nothing can upgrade is never an order", IllegalArgumentException::class.java) {
            WallRowSpec.intent(WALLET, BASE, WallRowQuote.from(JsonObject(quoteJson() + ("walls" to buildJsonArray {}))), "wall-row-key-2")
        }
    }
    @Test fun `an acknowledgement must repeat the quoted total and every eligible wall at its target`() {
        val accepted = WallRowSpec.acknowledge(intent, rowResult())
        assertEquals("120", accepted.costShards); assertEquals(2, accepted.upgraded.size); assertFalse(accepted.duplicate)
        assertTrue(WallRowSpec.acknowledge(intent, rowResult(duplicate = true)).duplicate)
        assertEquals(accepted, WallRowSpec.restore(intent, ReceiptDocument.fromPost(rowResult())))
        for (bad in listOf(rowResult(cost = "119"), rowResult(levelA = 4), JsonObject(rowResult() + ("upgraded" to buildJsonArray {})),
            JsonObject(rowResult() + ("upgraded" to buildJsonArray { add(buildJsonObject { put("id", WALL_A); put("level", 3) }) })))) {
            assertThrows(Exception::class.java) { WallRowSpec.acknowledge(intent, bad) }
        }
    }
    @Test fun `a re-priced refusal disproves acceptance while an unknown refusal keeps the intent`() {
        for (code in WallRowSpec.REPRICED) assertTrue(WallRowSpec.disprovesAcceptance(ApiException(409, code, "changed")))
        assertFalse(WallRowSpec.disprovesAcceptance(ApiException(409, "WALL_ROW_KEY_REUSED", "reused")))
        assertFalse(WallRowSpec.disprovesAcceptance(ApiException(500, "WALL_ROW_QUOTE_CHANGED", "broken")))
        assertEquals(Receipt.Unsupported, WallRowSpec.decodeReceipt(intent, buildJsonObject {})); assertNull(WallRowSpec.receiptRequest(intent))
    }
    @Test fun `a lost reply keeps the key for an explicit retry and a re-priced retry retires it`() = runBlocking {
        val store = PendingIntentStore(MemoryStore())
        val transport = ScriptedTransport(onPost = { _, _ -> throw IOException("lost") })
        val op = MoneyOp(WallRowSpec, store, transport)
        assertThrows(IOException::class.java) { runBlocking { op.submit(intent) {} } }
        val saved = requireNotNull(store.get(IntentKind.WALL_ROW, WALLET)); assertTrue(saved.attempted)
        assertTrue(InterruptedIntent(saved).retryable)
        transport.onPost = { _, body -> assertEquals(intent.body, body); rowResult(duplicate = true) }
        var hydrated = 0
        assertTrue(op.retry(WALLET) { hydrated++ }.value.duplicate)
        assertEquals(1, hydrated); assertNull(store.get(IntentKind.WALL_ROW, WALLET))
        // A retry answered with a replacement quote proves the key never purchased: the intent is retired even though it was attempted.
        transport.onPost = { _, _ -> throw IOException("lost") }
        val second = WallRowSpec.intent(WALLET, BASE, quote, "wall-row-key-2")
        assertThrows(IOException::class.java) { runBlocking { op.submit(second) {} } }
        transport.onPost = { _, _ -> throw ApiException(409, "WALL_ROW_QUOTE_CHANGED", "Wall row changed.", buildJsonObject { put("quote", quoteJson("130")) }) }
        assertThrows(ApiException::class.java) { runBlocking { op.retry(WALLET) {} } }
        assertNull(store.get(IntentKind.WALL_ROW, WALLET))
    }
}

/** The second layout slot is one SHARD spend replayed by key; `chargedShards: "0"` is the server's replay. */
class LayoutUnlockSpecTest {
    private val intent = LayoutUnlockSpec.intent(WALLET, BASE, "layout-unlock-key")
    private fun result(charged: String = "500", locked: Boolean = false, base: String = BASE) = Json.parseToJsonElement("""{"baseId":"$base","slot":"FARM","locked":$locked,"chargedShards":"$charged","balanceShards":"3020"}""").jsonObject
    @Test fun `the intent names the base and the acknowledgement must unlock that base's slot`() {
        assertEquals(LayoutUnlockSpec.PATH, intent.path); assertEquals(BASE, intent.baseId)
        assertEquals(LayoutUnlockAcceptance("500", "3020"), LayoutUnlockSpec.acknowledge(intent, result()))
        assertEquals("An already unlocked slot replays as a zero charge", "0", LayoutUnlockSpec.acknowledge(intent, result("0")).chargedShards)
        assertThrows(IllegalArgumentException::class.java) { LayoutUnlockSpec.acknowledge(intent, result(locked = true)) }
        assertThrows(IllegalArgumentException::class.java) { LayoutUnlockSpec.acknowledge(intent, result(base = "00000000-0000-4000-8000-00000000ffff")) }
        assertThrows(IllegalArgumentException::class.java) { LayoutUnlockSpec.intent(WALLET, "not-a-uuid", "layout-unlock-key") }
        assertEquals(Receipt.Unsupported, LayoutUnlockSpec.decodeReceipt(intent, buildJsonObject {})); assertTrue(InterruptedIntent(intent.copy(attempted = true)).retryable)
    }
    @Test fun `a definitive first refusal clears the intent and a lost reply keeps it`() = runBlocking {
        val store = PendingIntentStore(MemoryStore())
        val transport = ScriptedTransport(onPost = { _, _ -> throw ApiException(422, "INSUFFICIENT_SHARDS", "unlocking this layout slot costs 500 shards") })
        val op = MoneyOp(LayoutUnlockSpec, store, transport)
        assertThrows(ApiException::class.java) { runBlocking { op.submit(intent) {} } }
        assertNull(store.get(IntentKind.LAYOUT_UNLOCK, WALLET))
        transport.onPost = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { op.submit(intent) {} } }
        assertNotNull(store.get(IntentKind.LAYOUT_UNLOCK, WALLET))
        transport.onPost = { _, _ -> result("0") }
        assertEquals("0", op.retry(WALLET) {}.value.chargedShards); assertNull(store.get(IntentKind.LAYOUT_UNLOCK, WALLET))
    }
}
