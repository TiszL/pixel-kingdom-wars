package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import java.io.IOException
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class GemsBuyBalancesTest {
    private val wallet = WalletFunds("0.25", mapOf("KEEP" to "20", "SKR" to null), 1)
    private fun walletJson() = json("""{"sol":"0.25","tokens":{"KEEP":"20","SKR":null},"asOf":1}""")

    @Test fun `wallet purchase refresh publishes authenticated wallet funds before account refresh without requiring a selected base`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val calls = mutableListOf<String>()
        api.onGet("/wallet/balances") { query ->
            assertTrue("A wallet read has no selected-base parameter", query.isEmpty())
            calls += "wallet"; walletJson()
        }
        lateinit var balances: GemsBuyBalances
        balances = GemsBuyBalances(session, holder, api,
            { calls += "account"; assertEquals("Wallet evidence remains useful before base hydration", wallet, balances.state.value) },
            { calls += "has-selected"; false },
            { fail("A deedless account must not request selected-base balances or hit BASE_ID_REQUIRED") })
        balances.refresh()
        assertEquals(wallet, balances.state.value)
        assertEquals(listOf("wallet", "account", "has-selected"), calls)
        assertEquals(listOf("/wallet/balances"), api.gets.map { it.first }); assertTrue(api.posts.isEmpty())
    }

    @Test fun `selected base refresh failure keeps the independently refreshed wallet snapshot and still fails hydration`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val calls = mutableListOf<String>(); val unavailable = IOException("selected base unavailable")
        api.onGet("/wallet/balances") { calls += "wallet"; walletJson() }
        lateinit var balances: GemsBuyBalances
        balances = GemsBuyBalances(session, holder, api,
            { calls += "account" }, { calls += "has-selected"; true },
            { calls += "selected"; assertEquals(wallet, balances.state.value); throw unavailable })
        assertSame("Hydration failure must keep the purchase recoverable", unavailable, runCatching { balances.refresh() }.exceptionOrNull())
        assertEquals(wallet, balances.state.value)
        assertEquals(listOf("wallet", "account", "has-selected", "selected"), calls)
    }

    @Test fun `a late wallet response cannot publish or hydrate after account replacement including same wallet reauthentication`() = runBlocking {
        withTimeout(5_000) {
            for (nextWallet in listOf(WALLET, DEPOSIT_REFERENCE)) {
                val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
                val entered = CompletableDeferred<Unit>(); val response = CompletableDeferred<Unit>()
                var callbacks = 0
                api.onGet("/wallet/balances") { entered.complete(Unit); response.await(); walletJson() }
                val balances = GemsBuyBalances(session, holder, api,
                    { callbacks++ }, { callbacks++; true }, { callbacks++ })
                val result = async { runCatching { balances.refresh() } }
                entered.await(); signedIn(holder, nextWallet); response.complete(Unit)
                assertTrue(result.await().exceptionOrNull() is CancellationException)
                assertNull("Old authenticated wallet data must not enter the replacement session", balances.state.value)
                assertEquals(0, callbacks)
            }
        }
    }

    @Test fun `account replacement during account refresh prevents selected base lookup and hydration`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        api.onGet("/wallet/balances") { walletJson() }
        var selectedCallbacks = 0
        val balances = GemsBuyBalances(session, holder, api,
            { signedIn(holder, DEPOSIT_REFERENCE) },
            { selectedCallbacks++; true }, { selectedCallbacks++ })
        assertTrue(runCatching { balances.refresh() }.exceptionOrNull() is CancellationException)
        assertEquals("Previously published funds belong only to the original repository", wallet, balances.state.value)
        assertEquals(0, selectedCallbacks)
    }
}
