package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class EconomyMoneyTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val disk = MemoryStore(); val intents = PendingIntentStore(disk); val observer = ReceiptObserver(intents)
        var base: String? = BASE_ID; var land = false; var support = true
        val repository = LiveEconomyRepository(session, holder, api, { base }, { land }, intents, observer)
        init {
            api.onGet("/balances") { funds() }
            api.onGet("/forge") { forge() }
        }
        fun funds() = JsonObject(balancesJson("100", "100") + if (support) mapOf("features" to json("""{"conversionReceipts":{"version":1},"forgeContributionReceipts":{"version":1}}""")) else emptyMap())
        fun forge() = json("""{"day":"2026-09-12","cycleEndsAt":"2026-09-13T00:00:00Z","dailyEmissionKeep":"100","totalShards":"50","myShards":"10","myShardBalance":"100","goldforgeLevel":1,"myDailyCapShards":"100","claimable":{"totalKeep":"0","count":0}}""")
        fun receipt(spec: EconomySpec, body: JsonObject) = buildJsonObject {
            put("version", 1); put("status", "accepted"); put("wallet", session.wallet); put("baseId", body["baseId"] ?: JsonNull); put("request", body)
            put("receiptId", "65ae967a-bf89-4e01-bcae-52a48ffdc768"); put("acceptedAt", "2026-09-12T00:00:00.000Z")
            val amount = body[if (spec == KeepConversionSpec) "keep" else "shards"]!!.jsonPrimitive.content
            put("funding", buildJsonObject { put("currency", if (spec == KeepConversionSpec) "KEEP" else "SHARDS"); put("amount", amount) })
            put("result", if (spec == KeepConversionSpec) buildJsonObject { put("converted", amount); put("shards", (amount.toBigInteger() * 3.toBigInteger()).toString()); put("rate", 3) }
                else buildJsonObject { put("day", "2026-09-13"); put("contributedShards", amount) })
        }
        fun accepting(spec: EconomySpec) {
            api.onPost(spec.path) { body ->
                val saved = requireNotNull(intents.get(spec.kind, session.wallet))
                assertTrue(saved.attempted); assertEquals(body, saved.body); assertNotNull(disk.value)
                // Deliberately not an immutable receipt. The repository must obtain GET proof.
                json("""{"day":"2026-09-12","myShards":"999","converted":"10","shards":"10","rate":1}""")
            }
            api.onGet("${spec.path}/receipt") { q -> receipt(spec, JsonObject(q.mapValues { JsonPrimitive(it.value) })) }
        }
    }
    @Test fun `unsupported old server and capability loss at confirmation never persist or post`() = runBlocking {
        val f = Fixture(); f.support = false
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.review(EconomyAction.CONVERT, "10") } }
        f.support = true; val review = f.repository.review(EconomyAction.CONVERT, "10"); f.support = false
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.confirm(review) } }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.disk.value)
    }
    @Test fun `key is durable before POST and exact receipt is durable before hydration then retired`() = runBlocking {
        val f = Fixture(); f.accepting(KeepConversionSpec); var reads = 0
        f.api.onGet("/balances") {
            if (++reads == 3) {
                val saved = requireNotNull(f.intents.get(IntentKind.KEEP_CONVERSION, f.session.wallet))
                assertEquals(ReceiptDocument.SOURCE_RECEIPT, ReceiptDocument.source(requireNotNull(saved.receipt)))
                assertNull(f.repository.state.value.accepted)
            }
            f.funds()
        }
        f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10"))
        assertEquals(1, f.api.posts.size); assertEquals("30", f.repository.state.value.accepted!!.outputShards)
        assertEquals(3L, f.repository.state.value.accepted!!.rate); assertNull(f.disk.value)
    }
    @Test fun `receipt GET 401 or 404 after successful POST remains attempted unknown and never resends`() = runBlocking {
        for (status in listOf(401, 404)) {
            val f = Fixture(); f.accepting(KeepConversionSpec)
            f.api.onGet("/forge/convert/receipt") { throw ApiException(status, null, "receipt unavailable") }
            assertThrows(IOException::class.java) { runBlocking { f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10")) } }
            val pending = requireNotNull(f.intents.get(IntentKind.KEEP_CONVERSION, f.session.wallet))
            assertTrue(pending.attempted); assertNull(pending.receipt)
            f.api.onGet("/forge/convert/receipt") { json("""{"version":1,"status":"unknown","idempotencyKey":"${pending.idempotencyKey}"}""") }
            assertEquals(Receipt.Unknown, f.repository.check(IntentKind.KEEP_CONVERSION))
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repository.review(EconomyAction.CONVERT, "10") } }
            assertEquals(1, f.api.posts.size); assertNotNull(f.disk.value)
        }
    }
    @Test fun `timeout retains key and process reconstruction recovers original base through GET only`() = runBlocking {
        val f = Fixture(); f.api.onPost("/forge/convert") { throw IOException("lost response") }
        assertThrows(IOException::class.java) { runBlocking { f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10")) } }
        val saved = requireNotNull(f.intents.get(IntentKind.KEEP_CONVERSION, f.session.wallet)); f.base = "e67903da-9f8b-44b4-bfa8-4a60976356c0"
        val reopenedStore = PendingIntentStore(f.disk); val reopened = LiveEconomyRepository(f.session, f.holder, f.api, { f.base }, { f.land }, reopenedStore, ReceiptObserver(reopenedStore))
        f.api.onGet("/forge/convert/receipt") { q -> assertEquals(BASE_ID, q["baseId"]); assertEquals(saved.idempotencyKey, q["idempotencyKey"]); f.receipt(KeepConversionSpec, saved.body) }
        reopened.check(IntentKind.KEEP_CONVERSION)
        assertEquals(BASE_ID, reopened.state.value.accepted!!.baseId); assertEquals(f.base, reopened.state.value.baseId)
        assertEquals(1, f.api.posts.size); assertNull(f.disk.value)
    }
    @Test fun `failed hydration retains immutable proof and next check needs no POST or receipt refetch`() = runBlocking {
        val f = Fixture(); f.accepting(KeepConversionSpec); var reads = 0
        f.api.onGet("/balances") { if (++reads == 3) throw IOException("offline hydration"); f.funds() }
        assertThrows(IOException::class.java) { runBlocking { f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10")) } }
        assertNotNull(f.intents.get(IntentKind.KEEP_CONVERSION, f.session.wallet)!!.receipt)
        val receiptReads = f.api.gets.count { it.first == "/forge/convert/receipt" }
        f.repository.check(IntentKind.KEEP_CONVERSION)
        assertEquals(receiptReads, f.api.gets.count { it.first == "/forge/convert/receipt" }); assertEquals(1, f.api.posts.size); assertNull(f.disk.value)
    }
    @Test fun `fresh user review after definitive first refusal gets a fresh key`() = runBlocking {
        val f = Fixture(); f.api.onPost("/forge/convert") { throw ApiException(422, null, "refused") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10")) } }
        assertNull(f.disk.value); val first = f.api.posts.single().second["idempotencyKey"]
        f.accepting(KeepConversionSpec); f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10"))
        assertNotEquals(first, f.api.posts.last().second["idempotencyKey"]); assertEquals(2, f.api.posts.size)
    }
    @Test fun `base change after confirmation review posts nothing and late identity cannot publish acceptance`() = runBlocking {
        val f = Fixture(); val review = f.repository.review(EconomyAction.CONVERT, "10"); f.base = null
        assertThrows(CancellationException::class.java) { runBlocking { f.repository.confirm(review) } }; assertTrue(f.api.posts.isEmpty())
        f.base = BASE_ID; f.accepting(KeepConversionSpec)
        f.api.onGet("/forge/convert/receipt") { q -> signedIn(f.holder, "another-wallet"); f.receipt(KeepConversionSpec, JsonObject(q.mapValues { JsonPrimitive(it.value) })) }
        assertThrows(Exception::class.java) { runBlocking { f.repository.confirm(f.repository.review(EconomyAction.CONVERT, "10")) } }
        assertNull(f.repository.state.value.accepted); assertNotNull(f.intents.get(IntentKind.KEEP_CONVERSION, f.session.wallet))
    }
    @Test fun `contribution uses exact SHARDS and acceptance day without mistaking aggregate POST result for proof`() = runBlocking {
        val f = Fixture(); f.land = true; f.accepting(ForgeContributionSpec)
        f.repository.confirm(f.repository.review(EconomyAction.CONTRIBUTE, "10"))
        val body = f.api.posts.single().second; assertEquals(JsonPrimitive("10"), body["shards"]); assertFalse(body.containsKey("day"))
        assertEquals("2026-09-13", f.repository.state.value.accepted!!.day); assertNotNull(f.repository.state.value.forge)
        assertNull(f.disk.value)
    }
}
