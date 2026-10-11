package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal const val MARKET_ID = "11111111-1111-4111-8111-111111111111"
internal val marketDestinations = MarketDestinations("https://www.tensor.trade", "https://magiceden.io")
internal fun marketCollection(enabled: Boolean = true) = json("""{"collection":"$WALLET","feeBps":500,"tradingEnabled":$enabled,
    "links":{"tensor":"https://www.tensor.trade/trade/$WALLET","magicEden":"https://magiceden.io/marketplace/$WALLET"}}""")
internal fun marketAssets(frozen: Boolean = false, enabled: Boolean = true, present: Boolean = true, tensor: String = "https://www.tensor.trade/item/$WALLET") = json("""{"tradingEnabled":$enabled,"dasConfigured":true,"assets":[${if (!present) "" else """{"id":"$WALLET","name":"A deed","image":null,"frozen":$frozen,"kind":"deed","links":{"tensor":"$tensor","magicEden":"https://magiceden.io/item-details/$WALLET"}}"""}]}""")
internal fun marketBook(item: String = "wardens_helm") = json("""{"feeBps":250,"listings":[{"id":"$MARKET_ID","seller":"$WALLET","baseId":"$BASE_ID","itemId":"$item","priceLamports":"123456789","createdAt":"2026-09-12T00:00:00Z"}],
    "summary":[{"itemId":"keg_of_haste","floorLamports":"100000","listed":105}]}""")
internal fun marketApi() = FakeApiClient().apply {
    onGet(MarketRepository.BOOK) { marketBook(it["itemId"] ?: "wardens_helm") }
    onGet(MarketRepository.OWN) { json("""{"listings":[{"id":"$MARKET_ID","itemId":"wardens_helm","baseId":"$BASE_ID","priceLamports":"123456789","status":"reserved"}]}""") }
    onGet(MarketRepository.COLLECTION) { marketCollection() }
    onGet(MarketRepository.ASSETS) { marketAssets() }
}

class MarketRepositoryTest {
    @Test fun `landless browsing uses exact filter and sort with all own source deeds and independent fees`() = runBlocking {
        val holder = testHolder(); val api = marketApi()
        val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        repository.refresh(MarketQuery("wardens_helm", MarketSort.NEWEST))
        val state = repository.state.value
        assertEquals(mapOf("itemId" to "wardens_helm", "sort" to "newest"), api.gets.first().second)
        assertTrue(api.gets.single { it.first == MarketRepository.OWN }.second.isEmpty())
        assertEquals(105, state.book!!.summary.single().listed)
        assertEquals(BASE_ID, state.own!!.single().baseId)
        assertEquals(250, state.book.feeBps); assertEquals(500, state.collection!!.royaltyBps)
        assertEquals(4, state.fresh.size)
        assertTrue(api.posts.isEmpty() && api.puts.isEmpty() && api.deletes.isEmpty())
    }
    @Test fun `offline book retains marked stale observations while independent collection reads continue`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        repository.refresh(); val old = repository.state.value.book
        api.onGet(MarketRepository.BOOK) { error("Offline") }
        repository.refresh()
        assertEquals(old, repository.state.value.book)
        assertEquals("Offline", repository.state.value.errors[MarketRepository.BOOK])
        assertFalse(MarketRepository.BOOK in repository.state.value.fresh)
        assertTrue(MarketRepository.ASSETS in repository.state.value.fresh)
        repository.refresh(MarketQuery("keg_of_haste"))
        assertNull(repository.state.value.book)
    }
    @Test fun `mismatched filtered response is unavailable rather than relabelled as the selected item`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        api.onGet(MarketRepository.BOOK) { marketBook("wardens_helm") }
        repository.refresh(MarketQuery("keg_of_haste"))
        assertNull(repository.state.value.book)
        assertTrue(MarketRepository.BOOK in repository.state.value.errors)
        assertNotNull(repository.state.value.own)
    }
    @Test fun `an older slow query cannot overwrite a later filter`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        api.onGet(MarketRepository.BOOK) { query ->
            if (query["itemId"] == "wardens_helm") { started.complete(Unit); release.await() }
            marketBook(requireNotNull(query["itemId"]))
        }
        val old = launch { repository.refresh(MarketQuery("wardens_helm")) }; started.await()
        repository.refresh(MarketQuery("keg_of_haste")); release.complete(Unit); old.join()
        assertEquals("keg_of_haste", repository.state.value.book!!.offers.single().itemId)
        assertFalse(repository.state.value.loading)
        assertEquals(1, api.gets.count { it.first == MarketRepository.OWN })
    }
    @Test fun `superseded identity cannot publish a completed read or reuse the repository`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        api.onGet(MarketRepository.BOOK) { signedIn(holder); marketBook() }
        assertTrue(runCatching { repository.refresh() }.isFailure)
        assertNull(repository.state.value.book)
        assertTrue(runCatching { repository.externalLink(ExternalMarket.TENSOR) }.isFailure)
        assertEquals(1, api.gets.size)
    }
    @Test fun `external link uses a new trading read and the canonical item or collection target`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        repository.refresh(); api.gets.clear()
        assertEquals("https://magiceden.io/item-details/$WALLET", repository.externalLink(ExternalMarket.MAGIC_EDEN, WALLET))
        assertEquals(listOf(MarketRepository.COLLECTION, MarketRepository.ASSETS), api.gets.map { it.first })
        api.gets.clear()
        assertEquals("https://www.tensor.trade/trade/$WALLET", repository.externalLink(ExternalMarket.TENSOR))
        assertEquals(listOf(MarketRepository.COLLECTION), api.gets.map { it.first })
    }
    @Test fun `cached enabled links never bypass new disabled offline frozen or missing ownership responses`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        repository.refresh()
        api.onGet(MarketRepository.COLLECTION) { marketCollection(false) }
        assertTrue(runCatching { repository.externalLink(ExternalMarket.TENSOR, WALLET) }.isFailure)
        api.onGet(MarketRepository.COLLECTION) { error("Offline") }
        assertTrue(runCatching { repository.externalLink(ExternalMarket.TENSOR, WALLET) }.isFailure)
        api.onGet(MarketRepository.COLLECTION) { marketCollection() }
        listOf(marketAssets(frozen = true), marketAssets(enabled = false), marketAssets(present = false)).forEach { response ->
            api.onGet(MarketRepository.ASSETS) { response }
            assertTrue(runCatching { repository.externalLink(ExternalMarket.TENSOR, WALLET) }.isFailure)
        }
    }
    @Test fun `external navigation refuses changed asset URLs content destinations and identities`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val repository = MarketRepository(signedIn(holder), holder, api) { marketDestinations }
        api.onGet(MarketRepository.ASSETS) { marketAssets(tensor = "https://www.tensor.trade/item/11111111111111111111111111111111") }
        assertTrue(runCatching { repository.externalLink(ExternalMarket.TENSOR, WALLET) }.isFailure)
        api.onGet(MarketRepository.ASSETS) { signedIn(holder); marketAssets() }
        assertTrue(runCatching { repository.externalLink(ExternalMarket.TENSOR, WALLET) }.isFailure)
        val fresh = MarketRepository(signedIn(holder), holder, api) { null }
        assertTrue(runCatching { fresh.externalLink(ExternalMarket.TENSOR) }.isFailure)
    }
    @Test fun `external destinations are read from current catalogue and malformed bases remain disabled`() {
        fun content(base: String) = json("""{"constants":{"MARKETPLACE":{"tensorBase":"$base","magicEdenBase":"https://magiceden.io"}}}""")
        assertEquals(marketDestinations, MarketDestinations.from(content("https://www.tensor.trade")))
        listOf("http://www.tensor.trade", "https://www.tensor.trade/?token=x", "https://secret@www.tensor.trade", "https://www.tensor.trade/item").forEach {
            assertNull(MarketDestinations.from(content(it)))
        }
        assertNull(MarketDestinations.from(null))
    }
}
