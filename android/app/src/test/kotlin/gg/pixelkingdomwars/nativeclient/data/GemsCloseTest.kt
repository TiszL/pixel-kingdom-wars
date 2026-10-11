package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.BaseCapabilities
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.goldforge.goldForgeConvertFace
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * Owner 2026-10-06 dead-end sweep: a saved Gems request the server had no record of refused every new Gems action for good,
 * because CHECK only repeated `unknown` and RETRY could be refused forever. Owner review the same day set the way out so it
 * can neither charge twice nor hide a charge: the Gold Forge SAVED card offers CLOSE only on the server's `absent` answer for
 * exactly that key, once the last attempt is [SAVED_REQUEST_MIN_AGE_MS] old; the close reads once more, honours an acceptance
 * found there, and otherwise ARCHIVES the request on this device (re-read on every Home resume), sending nothing. An
 * `unknown` answer never offers CLOSE, but once settled it stops shutting the Gems door; a new request parks it.
 * (Fixture data mirrors GemsRepositoryTest, whose fixture is private.)
 */
class GemsCloseTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val store = PendingIntentStore(MemoryStore())
        val directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1)))
        val receipts = mutableMapOf<String, JsonObject>()
        var lose = true
        val repo = GemsRepository(session, holder, api, store, ReceiptObserver(store), { BASE_ID }, { 0L }, { directory }, {}, {})

        init {
            api.onGet("/native/capabilities") { json("""{"protocolVersion":1,"simVersion":14,"economy":{"gems":{
                "enabled":true,"exactConsent":1,"sources":["ledger-keep"],"gemsPerKeep":2,"shardsPerGem":3,
                "minConvertKeep":1,"maxConvertKeepPerTx":1000}}}""") }
            api.onGet("/gems") {
                json("""{"features":{"gems":{"version":1,"receipts":1,"exactConsent":1}},"gems":"100","tasks":[
                    {"id":"starter-task","gems":"5","claimed":false}],"sources":["ledger-keep"],
                    "minConvertKeep":1,"maxConvertKeepPerTx":1000,"gemsPerKeep":2,"shardsPerGem":3,
                    "serverNow":"2026-09-21T00:00:00Z"}""")
            }
            api.onGet("/balances") {
                json("""{"shards":"300","keep":"100","keepRate":1,"gems":"100",
                    "gemsRate":{"gemsPerKeep":2,"shardsPerGem":3},"features":{"gems":{"version":1,"receipts":1}}}""")
            }
            api.onPost(GemsFromKeepSpec.PATH) { body ->
                val saved = requireNotNull(saved())
                assertTrue("The attempted marker must reach storage before POST", saved.attempted); assertEquals(saved.body, body)
                if (lose) throw IOException("reply lost")
                receipts[saved.idempotencyKey] = accepted(saved)
                buildJsonObject { put("gems", "20") }
            }
        }

        fun saved() = store.get(IntentKind.GEMS_FROM_KEEP, WALLET)
        /** The server's answer that it holds no ledger row for exactly this key (owner review 2026-10-06). */
        fun absent(key: String) = buildJsonObject { put("version", 1); put("status", "absent"); put("idempotencyKey", key) }

        /** Reviews and confirms 10 KEEP into Gems through the owner, binding the exact by-key receipt route first. */
        suspend fun buy() {
            repo.review(IntentKind.GEMS_FROM_KEEP, "10")
            val review = requireNotNull(repo.state.value.review)
            val request = GemsFromKeepSpec.receiptRequest(review.intent)
            api.onGet(request.path) { receipts[review.intent.idempotencyKey] ?: envelope(review.intent, "unknown", JsonNull) }
            repo.confirm(review)
        }

        fun accepted(intent: PendingIntent) = envelope(intent, "accepted", buildJsonObject {
            put("version", 1); put("status", "accepted"); put("wallet", intent.wallet)
            put("receiptId", "a7000000-0000-4000-8000-000000000001"); put("acceptedAt", "2026-09-21T00:00:00Z")
            put("request", intent.body)
            put("funding", buildJsonObject { put("currency", "KEEP"); put("amount", "10") })
            put("result", buildJsonObject { put("gems", "20"); put("rate", 2) })
        })

        private fun envelope(intent: PendingIntent, status: String, proof: JsonElement) = buildJsonObject {
            put("wallet", intent.wallet); put("idempotencyKey", intent.idempotencyKey); put("status", status)
            put("receipt", proof); put("serverNow", "2026-09-21T00:00:00Z")
        }
    }

    @Test fun `a saved Gems request the server has no record of is archived from the Gold Forge card and Gems open again`() = runBlocking {
        val f = Fixture()
        try { f.buy(); fail("the reply was lost") } catch (_: IOException) { }
        val saved = requireNotNull(f.saved()); assertTrue(saved.attempted)
        assertTrue("no CLOSE before the server has answered", f.repo.state.value.serverUnknownKeys.isEmpty())
        assertFalse(goldForgeConvertFace(f.repo.state.value, false, "1").savedClosable)
        assertEquals(Receipt.Unknown, f.repo.check(IntentKind.GEMS_FROM_KEEP))
        assertTrue("unknown is not absent: no CLOSE", f.repo.state.value.serverUnknownKeys.isEmpty())
        f.receipts[saved.idempotencyKey] = f.absent(saved.idempotencyKey)
        assertEquals(Receipt.Absent, f.repo.check(IntentKind.GEMS_FROM_KEEP))
        assertTrue("a fresh absent answer offers no CLOSE yet", f.repo.state.value.serverUnknownKeys.isEmpty())
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        assertEquals(Receipt.Absent, f.repo.check(IntentKind.GEMS_FROM_KEEP))
        assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKeys[IntentKind.GEMS_FROM_KEEP])
        assertTrue("the SAVED card offers CLOSE for exactly this key", goldForgeConvertFace(f.repo.state.value, false, "1").savedClosable)
        assertTrue(f.repo.close(IntentKind.GEMS_FROM_KEEP) is Receipt.Closed)
        assertNull(f.saved()); assertTrue("the Gems door is open", f.repo.state.value.pending.isEmpty())
        assertEquals("closing sent nothing", 1, f.api.posts.size)
        assertEquals("archived on this device, never deleted", listOf(KeptIntent(saved, closed = true)), f.store.kept(WALLET))
        assertTrue(f.repo.state.value.serverUnknownKeys.isEmpty())
        f.lose = false; f.buy()
        assertEquals("a new Gems request is admitted again", 2, f.api.posts.size)
        assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
    }

    @Test fun `a Gems request the server has not confirmed stops shutting Gems once settled and is parked by the next one`() = runBlocking {
        val f = Fixture()
        try { f.buy(); fail("the reply was lost") } catch (_: IOException) { }
        val saved = requireNotNull(f.saved())
        assertEquals(Receipt.Unknown, f.repo.check(IntentKind.GEMS_FROM_KEEP))
        assertThrows("a fresh check keeps Gems shut", IllegalStateException::class.java) { runBlocking { f.repo.review(IntentKind.GEMS_FROM_KEEP, "10") } }
        f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS) // the last attempt is now older than the minimum age
        assertEquals(Receipt.Unknown, f.repo.check(IntentKind.GEMS_FROM_KEEP))
        assertTrue("still no CLOSE", f.repo.state.value.serverUnknownKeys.isEmpty())
        f.lose = false; f.buy()
        assertEquals("a new Gems request is admitted", 2, f.api.posts.size); assertNotNull(f.repo.state.value.receipt)
        assertEquals("the original stays on this device, parked and never resent", listOf(saved), f.store.parked(WALLET))
    }

    @Test fun `a Gems close honours an acceptance its fresh read finds`() = runBlocking {
        val f = Fixture()
        try { f.buy(); fail("the reply was lost") } catch (_: IOException) { }
        val saved = requireNotNull(f.saved()); f.receipts[saved.idempotencyKey] = f.absent(saved.idempotencyKey); f.store.recordAttempt(saved, System.currentTimeMillis() - SAVED_REQUEST_MIN_AGE_MS)
        f.repo.check(IntentKind.GEMS_FROM_KEEP)
        assertEquals(saved.idempotencyKey, f.repo.state.value.serverUnknownKeys[IntentKind.GEMS_FROM_KEEP])
        f.receipts[saved.idempotencyKey] = f.accepted(saved) // the server committed after the card last looked
        assertTrue(f.repo.close(IntentKind.GEMS_FROM_KEEP) is Receipt.Accepted)
        assertNull(f.saved()); assertNotNull("the accepted receipt is shown, not dropped", f.repo.state.value.receipt)
        assertEquals("20", f.repo.state.value.receipt?.amount); assertEquals(1, f.api.posts.size)
    }
}
