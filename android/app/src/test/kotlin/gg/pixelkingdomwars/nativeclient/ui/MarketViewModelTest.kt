package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.economy.MarketViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MarketViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    @Test fun `background and resume prevent an earlier link request opening the browser`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val model = MarketViewModel(MarketRepository(signedIn(holder), holder, api) { marketDestinations })
        var foreground = launch(start = CoroutineStart.UNDISPATCHED) { model.foreground(null) }
        val release = CompletableDeferred<Unit>(); var opened: String? = null
        api.onGet(MarketRepository.COLLECTION) { release.await(); marketCollection() }
        val request = model.open(ExternalMarket.TENSOR, null) { opened = it }
        foreground.cancelAndJoin()
        // Even returning before the old HTTP request completes must require a fresh tap.
        foreground = launch(start = CoroutineStart.UNDISPATCHED) { model.foreground(null) }
        release.complete(Unit); request?.join()
        assertNull(opened); assertTrue(model.notice.value!!.error)
        model.open(ExternalMarket.TENSOR, null) { opened = it }?.join()
        assertEquals("https://www.tensor.trade/trade/$WALLET", opened)
        foreground.cancelAndJoin()
    }
    @Test fun `resume preserves an explicitly changed item filter even if the book is offline`() = runBlocking {
        val holder = testHolder(); val api = marketApi(); val model = MarketViewModel(MarketRepository(signedIn(holder), holder, api) { marketDestinations })
        var foreground = launch(start = CoroutineStart.UNDISPATCHED) { model.foreground("wardens_helm") }
        api.onGet(MarketRepository.BOOK) { error("Offline") }
        model.filter("keg_of_haste")?.join(); foreground.cancelAndJoin()
        foreground = launch(start = CoroutineStart.UNDISPATCHED) { model.foreground("wardens_helm") }
        assertEquals("keg_of_haste", model.state.value.query.itemId)
        foreground.cancelAndJoin()
    }
}
