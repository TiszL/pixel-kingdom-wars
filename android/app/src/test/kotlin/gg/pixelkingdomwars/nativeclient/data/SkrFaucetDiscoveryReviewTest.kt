package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Source-review regression: profile alone cannot enable an unconfigured faucet. */
class SkrFaucetDiscoveryReviewTest {
    @Test fun `profile without pack policy hides a new entry and preserves saved recovery discovery`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet")
        val repo = SkrFaucetRepository(session, holder, api, journal,
            { SkrIdentity("11111111111111111111111111111112", 6) }, { null }, { null },
            { _, _, _ -> error("No wallet prompt") }, {})
        repo.refresh()
        assertFalse(repo.state.value.available); assertTrue(api.gets.isEmpty()); assertTrue(api.posts.isEmpty())
        val saved = journal.beginIfEmpty("11111111-1111-4111-8111-111111111111")
        repo.refresh()
        assertTrue(repo.state.value.available); assertEquals(saved, journal.read())
        assertTrue(api.gets.isEmpty()); assertTrue(api.posts.isEmpty())
    }
}
