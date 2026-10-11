package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LegacyMarketRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val q = marketQuote()
        val purchase = LegacyMarketPurchase(q.listingId, q.itemId, q.reference, q.priceLamports, q.buyerBaseId)
        var owned: Set<String>? = setOf(q.buyerBaseId!!)
        var refreshed = 0
        val repository = LegacyMarketRepository(session, holder, api, { refreshed++ }, { owned }, {})
        fun page(next: String? = null) = buildJsonObject {
            put("purchases", JsonArray(listOf(buildJsonObject {
                put("listingId", purchase.listingId); put("itemId", purchase.itemId); put("reference", purchase.reference)
                put("priceLamports", purchase.priceLamports); put("buyerBaseId", purchase.buyerBaseId?.let(::JsonPrimitive) ?: JsonNull)
            }))); put("next", next?.let(::JsonPrimitive) ?: JsonNull)
        }
        init {
            api.onGet(LegacyMarketRepository.PENDING) { page() }
            api.onGet(LegacyMarketRepository.HISTORY) { json("""{"trades":[],"hasMore":false}""") }
            api.onGet("/items") { json("{}") }
            api.onPost("/market/purchases/${q.listingId}/check") { json("""{"settled":true,"itemId":"${q.itemId}"}""") }
        }
    }
    @Test fun `opening and resuming discovers original references with GET only without v1 keys`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.refresh()
        assertEquals(listOf(f.purchase), f.repository.state.value.page!!.purchases)
        assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.refreshed)
        assertEquals(listOf(LegacyMarketRepository.PENDING, LegacyMarketRepository.HISTORY).repeat(2), f.api.gets.map { it.first })
    }
    @Test fun `explicit check sends only original reference and refreshes original destination`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.api.gets.clear(); f.repository.check(f.purchase)
        assertEquals(listOf("/market/purchases/${f.q.listingId}/check" to buildJsonObject { put("reference", f.q.reference) }), f.api.posts)
        assertEquals(listOf(mapOf("baseId" to f.q.buyerBaseId!!)), f.api.gets.filter { it.first == "/items" }.map { it.second })
        assertEquals(f.q.buyerBaseId, f.repository.state.value.destination!!.baseId)
        assertEquals(1, f.refreshed)
    }
    @Test fun `transferred original deed still settles but never reads another owners inventory`() = runBlocking {
        val f = Fixture(); f.owned = emptySet(); f.repository.refresh(); f.repository.check(f.purchase)
        assertEquals(MarketDestinationRefresh(f.q.buyerBaseId, false, null), f.repository.state.value.destination)
        assertTrue(f.api.gets.none { it.first == "/items" }); assertEquals(1, f.api.posts.size)
    }
    @Test fun `deed change during original inventory hydration cannot publish success`() = runBlocking {
        val f = Fixture(); f.api.onGet("/items") { f.owned = emptySet(); json("{}") }
        f.repository.refresh(); f.repository.check(f.purchase)
        assertNull(f.repository.state.value.destination)
        assertTrue(f.repository.state.value.notice!!.contains("changed ownership"))
    }
    @Test fun `uncertain or not finalized checks retain original row and never retry a mutation on refresh`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        f.api.onPost("/market/purchases/${f.q.listingId}/check") { error("Reply lost") }
        f.repository.check(f.purchase); f.repository.refresh()
        assertEquals(1, f.api.posts.size); assertEquals(f.purchase, f.repository.state.value.page!!.purchases.single())
        assertNull(f.repository.state.value.destination); assertEquals(0, f.refreshed)
        f.api.onPost("/market/purchases/${f.q.listingId}/check") { json("""{"settled":false}""") }
        f.repository.check(f.purchase)
        assertTrue(f.repository.state.value.notice!!.contains("not finalized")); assertEquals(0, f.refreshed)
    }
    @Test fun `stale replaced or forged references cannot reach CHECK`() = runBlocking {
        val f = Fixture(); f.repository.refresh()
        f.repository.check(f.purchase.copy(reference = WALLET)); assertTrue(f.api.posts.isEmpty())
        f.api.onGet(LegacyMarketRepository.PENDING) { error("Offline") }; f.repository.refresh()
        f.repository.check(f.purchase); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `superseded identity cannot publish private reads or settlement response`() = runBlocking {
        val f = Fixture(); f.api.onGet(LegacyMarketRepository.PENDING) { signedIn(f.holder); f.page() }
        assertTrue(runCatching { f.repository.refresh() }.isFailure); assertNull(f.repository.state.value.page)
        val g = Fixture(); g.repository.refresh()
        g.api.onPost("/market/purchases/${g.q.listingId}/check") { signedIn(g.holder); json("""{"settled":true,"itemId":"${g.q.itemId}"}""") }
        assertTrue(runCatching { g.repository.check(g.purchase) }.isFailure)
        assertNull(g.repository.state.value.destination); assertEquals(0, g.refreshed)
    }
    @Test fun `concurrent taps perform one check and pagination uses only supplied server cursor`() = runBlocking {
        val f = Fixture(); f.api.onGet(LegacyMarketRepository.PENDING) { f.page(f.q.listingId) }; f.repository.refresh()
        val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.api.onPost("/market/purchases/${f.q.listingId}/check") { started.complete(Unit); release.await(); json("""{"settled":false}""") }
        val first = launch { f.repository.check(f.purchase) }; started.await()
        f.repository.check(f.purchase); release.complete(Unit); first.join(); assertEquals(1, f.api.posts.size)
        f.api.onGet(LegacyMarketRepository.PENDING) { query -> assertEquals(mapOf("after" to f.q.listingId), query); json("""{"purchases":[],"next":null}""") }
        f.repository.page(f.q.listingId); assertTrue(f.repository.state.value.page!!.purchases.isEmpty())
        assertTrue(runCatching { f.repository.page(BASE_ID) }.isFailure)
    }
    private fun <T> List<T>.repeat(count: Int) = (1..count).flatMap { this }
}
