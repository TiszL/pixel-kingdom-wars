package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetWalletAvailabilityTest {
    @Test fun `embedded or missing sign only wallet refuses before every mutation`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val repo = SkrFaucetRepository(session, holder, api,
            SkrFaucetJournal(MemoryStore(), WALLET, session.origin, "devnet"),
            { SkrIdentity("11111111111111111111111111111112", 6) }, { SkrFaucetBounds(5000, "1000") },
            { "11111111-1111-4111-8111-111111111111" }, { _, _, _ -> error("wallet must not prompt") }, {},
            walletAvailable = { error("This wallet cannot claim yet") })
        repo.claim(); repo.prepareAndSign(); repo.recover()
        assertTrue(api.posts.isEmpty()); assertNotNull(repo.state.value.error)
    }
}
