package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): a grant-less faucet intent saved without a claim day (version-1 journal)
 *  could never be matched or released, so CLAIM stayed shut on this device forever. A complete guarded grants scan in
 *  which every page holds zero requested grants now releases it; any requested grant keeps it. Hand-built wire shapes,
 *  so this runs without the P5 discovery vectors. */
class SkrFaucetNoDayReleaseTest {
    private val mint = "11111111111111111111111111111112"
    private val base = "11111111-1111-4111-8111-111111111111"
    private fun status() = buildJsonObject {
        put("cluster", "devnet"); put("isTestToken", true); put("enabled", true); put("eligible", true); put("reason", "ok")
        put("label", "SKR"); put("symbol", "SKR"); put("mint", mint); put("decimals", 6); put("grantSkr", "1000"); put("grantRaw", "1000000000")
        put("day", "2026-10-06"); put("nextEligibleAt", "2026-10-07T00:00:00.000Z"); put("today", JsonNull)
    }
    private fun page(vararg items: JsonObject) = buildJsonObject { put("items", JsonArray(items.toList())); put("nextCursor", JsonNull) }
    private fun requested() = buildJsonObject {
        put("id", "22222222-2222-4222-8222-222222222222"); put("status", "requested"); put("mint", mint); put("decimals", 6)
        put("amountRaw", "1000000000"); put("error", JsonNull); put("requestedAt", "2026-10-01T09:00:00.000Z"); put("sentAt", JsonNull); put("attempt", JsonNull)
    }
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet")
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(mint, 6) },
            { SkrFaucetBounds(5000, "1000", 20) }, { base }, { _, _, _ -> error("Release never signs") }, {})
        init { api.onGet("/devnet-skr-faucet/status") { status() }; journal.beginIfEmpty(base, null) }
    }

    @Test fun `a saved no-day faucet intent the server has no pending grant for cannot block CLAIM forever`() = runBlocking {
        val f = Fixture(); f.api.onGet("/devnet-skr-faucet/grants") { throw java.io.IOException("scan interrupted") }
        f.repo.refresh()
        assertNotNull("an incomplete scan never releases", f.journal.read()); assertFalse(f.repo.state.value.canClaim)
        f.api.onGet("/devnet-skr-faucet/grants") { page() }
        f.repo.refresh()
        assertNull(f.journal.read()); assertFalse(f.repo.state.value.uncertain)
        f.repo.refresh(); assertTrue(f.repo.state.value.canClaim)
        assertTrue("release never claims, prepares or submits", f.api.posts.isEmpty())
    }

    @Test fun `a no-day faucet intent is kept while any requested grant remains`() = runBlocking {
        val f = Fixture(); val saved = f.journal.read()
        f.api.onGet("/devnet-skr-faucet/grants") { page(requested()) }
        f.repo.refresh()
        assertEquals(saved, f.journal.read()); assertTrue(f.repo.state.value.uncertain); assertFalse(f.repo.state.value.canClaim)
        assertTrue(f.api.posts.isEmpty())
    }
}
