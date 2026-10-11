package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.economy.MarketTradeViewModel
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MarketTradeViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val q = marketQuote(); val purchase = MarketPurchaseStore(MemoryStore(), WALLET, session.origin, "devnet")
        val intents = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(intents)
        val bounds = MarketTradeBounds(BigInteger.ONE, BigInteger("1000000000000"), 2500, 15000)
        var supported = true; var row = marketReceipt(q)
        val repository = MarketTransactionsRepository(session, holder, api, intents, observer, purchase, SolanaCluster.DEVNET,
            { q.buyerBaseId }, { true }, { bounds }, { error("A lifecycle callback cannot prepare a wallet payment") }, {}, {}, { setOf(q.buyerBaseId!!) }, { 0L })
        val model = MarketTradeViewModel(repository)
        init {
            api.onGet(MarketRepository.BOOK) { buildJsonObject {
                put("feeBps", q.feeBps); put("listings", JsonArray(emptyList())); put("summary", JsonArray(emptyList()))
                if (supported) put("features", json("""{"itemMarket":{"version":1,"listingReceipts":1,"reservationReceipts":1,"cancelReceipts":1}}"""))
            } }
            api.onGet(MarketTransactionsRepository.OWN) { json("""{"listings":[]}""") }
            api.onGet("/items") { json("{}") }
            api.onGet("/market/v1/reservations/by-key/${q.key}") { row.raw }
            api.onPost("/market/v1/reservations/${q.reservationId}/paid") { row.raw }
            api.onPost("/market/v1/reservations/${q.reservationId}/settle") { body ->
                assertEquals(JsonPrimitive(q.reference), body["reference"]); row.raw
            }
        }
        fun attempted() { purchase.adopt(row); purchase.attempted(q, 0L); purchase.recordSignature(q, MARKET_SIGNATURE, 0L) }
    }
    @Test fun `background stops settlement polling and resume keeps exact original signature without wallet action`() = runTest {
        val f = Fixture(); f.attempted()
        var job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        assertTrue(f.api.posts.isEmpty())
        advanceTimeBy(f.bounds.pollMs); runCurrent(); assertEquals(2, f.api.posts.size)
        job.cancelAndJoin(); advanceTimeBy(f.bounds.pollMs * 3); runCurrent(); assertEquals(2, f.api.posts.size)
        f.supported = false; job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        advanceTimeBy(f.bounds.pollMs); runCurrent(); assertEquals(4, f.api.posts.size)
        assertTrue(f.api.posts.all { it.first.contains(f.q.reservationId) && it.second["reference"] == JsonPrimitive(f.q.reference) })
        assertEquals(MARKET_SIGNATURE, f.purchase.read()!!.signature); job.cancelAndJoin()
    }
    @Test fun `unpaid reservation never creates or settles money through lifecycle callbacks`() = runTest {
        val f = Fixture(); f.purchase.adopt(f.row)
        val job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        advanceTimeBy(f.bounds.pollMs * 3); runCurrent(); assertTrue(f.api.posts.isEmpty())
        assertFalse(f.purchase.read()!!.attempted); job.cancelAndJoin()
    }
    /** Rewritten 2026-09-18 (owner: a finished purchase must never block the next BUY). It used to pin "stays saved and
     * hydrated until DONE is tapped"; the rule it protects is unchanged: recovering a settled purchase is GET-only
     * (no settlement POST, no wallet) and it is retired only after its destination was re-read (hydrated). */
    @Test fun `settled process recovery hydrates GET-only, then closes itself so the next BUY is not blocked`() = runTest {
        val f = Fixture(); f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE); f.purchase.adopt(f.row)
        // The repositories hop to Dispatchers.IO for their journals, so a test waits on state, never on virtual time alone.
        val job = launch { f.model.foreground(f.bounds) { "Warden's Helm" } }; runCurrent(); f.model.state.first { it.loaded && !it.busy && it.saved == null }; runCurrent()
        advanceTimeBy(f.bounds.pollMs * 3); runCurrent()
        assertTrue(f.api.posts.isEmpty())
        assertEquals("Hydrated from the original destination before closing", f.q.buyerBaseId, f.model.state.value.destinationRefresh!!.baseId)
        assertNull("The finished purchase retired itself", f.purchase.read()); assertNull(f.model.state.value.saved)
        assertTrue(Toasts.queue.items.value.any { it.message == "BOUGHT! WARDEN'S HELM IS IN YOUR BAG" }); job.cancelAndJoin()
    }
    @Test fun `a settled purchase whose refresh failed stays saved and is never closed unhydrated`() = runTest {
        val f = Fixture(); f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE); f.purchase.adopt(f.row)
        f.api.onGet("/items") { throw java.io.IOException("inventory offline") }
        val job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        advanceTimeBy(f.bounds.pollMs * 3); runCurrent(); f.model.state.first { !it.busy }
        assertFalse(f.model.state.value.hydrated); assertNotNull("The store's own guard keeps it", f.purchase.read()); assertTrue(f.api.posts.isEmpty())
        job.cancelAndJoin()
    }
    @Test fun `pending cancellation receipt check never retries cancellation automatically`() = runTest {
        val f = Fixture(); val listing = OwnMarketListing(f.q.listingId, f.q.itemId, f.q.sourceBaseId, f.q.priceLamports, "reserved")
        val intent = MarketCancelSpec.intent(WALLET, "00000000-0000-4000-8000-000000000077", MarketCancelConsent(listing, f.q.reference)).copy(attempted = true)
        assertTrue(f.intents.create(intent))
        f.api.onGet("/market/v1/cancellations/by-key/${intent.idempotencyKey}") { buildJsonObject {
            put("version", 1); put("idempotencyKey", intent.idempotencyKey); put("actor", WALLET); put("listingId", f.q.listingId)
            put("itemId", f.q.itemId); put("sourceBaseId", f.q.sourceBaseId); put("priceLamports", f.q.priceLamports)
            put("expectedStatus", "reserved"); put("expectedReference", f.q.reference); put("createdAt", f.q.createdAt)
            put("state", "pending"); put("resolvedAt", JsonNull); put("refusalCode", JsonNull); put("settlement", JsonNull)
        } }
        val job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        advanceTimeBy(f.bounds.pollMs * 3); runCurrent()
        assertTrue(f.api.posts.isEmpty()); assertEquals(intent, f.intents.get(IntentKind.MARKET_CANCEL, WALLET)); job.cancelAndJoin()
    }
    /** The BUY chain needs a wallet payload; the lifecycle fixture above deliberately cannot prepare one. */
    private class BuyFixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        var q = marketQuote(); val rows = mutableMapOf<String, MarketReservationReceipt>()
        /** The server's current receipt for the newest reservation; older keys keep answering with their own last row. */
        var row: MarketReservationReceipt = marketReceipt(q); set(value) { field = value; value.quote.key?.let { rows[it] = value } }
        val purchase = MarketPurchaseStore(MemoryStore(), WALLET, session.origin, "devnet")
        val intents = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(intents)
        val bounds = MarketTradeBounds(BigInteger.ONE, BigInteger("1000000000000"), 2500, 15000)
        var prepared = 0; var sends = 0; var reserveFails = false; var wall = 1_000_000L
        val repository = MarketTransactionsRepository(session, holder, api, intents, observer, purchase, SolanaCluster.DEVNET,
            { q.buyerBaseId }, { true }, { bounds }, { prepared++; PreparedMarketPurchase(byteArrayOf(1, 2, 3), BigInteger.valueOf(5000)) }, {}, {}, { setOf(q.buyerBaseId!!) }, { 0L },
            wallClockMs = { wall })
        val model = MarketTradeViewModel(repository)
        val offer get() = MarketOffer(q.listingId, q.seller, q.sourceBaseId, q.itemId, q.priceLamports, q.createdAt)
        fun reserves() = api.posts.count { it.first.endsWith("/reserve") }
        init {
            api.onGet(MarketRepository.BOOK) { buildJsonObject {
                put("feeBps", q.feeBps); put("summary", JsonArray(emptyList()))
                put("listings", JsonArray(listOf(buildJsonObject {
                    put("id", q.listingId); put("seller", q.seller); put("baseId", q.sourceBaseId); put("itemId", q.itemId)
                    put("priceLamports", q.priceLamports); put("createdAt", q.createdAt)
                })))
                put("features", json("""{"itemMarket":{"version":1,"listingReceipts":1,"reservationReceipts":1,"cancelReceipts":1}}"""))
            } }
            api.onGet(MarketTransactionsRepository.OWN) { json("""{"listings":[]}""") }
            api.onGet("/items") { json("{}") }
            api.onPost("/market/v1/listings/${q.listingId}/reserve") { body ->
                if (reserveFails) throw ApiException(409, null, "just sold to another buyer")
                q = MarketQuote.from(JsonObject(q.raw + ("idempotencyKey" to body.getValue("idempotencyKey"))))
                row = marketReceipt(q); val key = requireNotNull(q.key); api.onGet("/market/v1/reservations/by-key/$key") { rows.getValue(key).raw }
                row.raw
            }
            api.onPost("/market/v1/reservations/${q.reservationId}/paid") { row.raw }
            api.onPost("/market/v1/reservations/${q.reservationId}/settle") { row.raw }
        }
        fun approve() = MarketPurchaseSender { _, quote, record -> sends++; assertEquals(q, quote); assertTrue(purchase.read()!!.attempted); record(MARKET_SIGNATURE); MARKET_SIGNATURE }
        suspend fun review(): MarketReview.Purchase { model.reviewPurchase(offer)?.join(); return model.state.value.review as MarketReview.Purchase }
    }

    /** Rewritten 2026-09-18. It used to pin the three-step flow ("confirming a reservation only prepares an unpaid
     * quote"; the wallet needed a second tap). Owner: "flow should be simple, as in most games, but secure" — one gold
     * tap now drives reserve -> pay. What must still hold, and why: Back from the confirm plate sends nothing; one tap
     * creates exactly one reservation and at most one wallet prompt; a reservation that failed never opens a wallet. */
    @Test fun `Back from the confirm plate sends nothing, and one gold tap reserves then opens the wallet exactly once`() = runTest {
        val f = BuyFixture()
        f.review(); f.model.dismiss(); assertNull(f.model.state.value.review); assertTrue(f.api.posts.isEmpty()); assertEquals(0, f.prepared)
        f.model.buy(f.review(), f.approve())?.join()
        assertEquals(1, f.reserves()); assertEquals(1, f.prepared); assertEquals(1, f.sends)
        assertEquals(listOf("reserve", "paid", "settle"), f.api.posts.map { it.first.substringAfterLast('/') })
        val saved = f.purchase.read()!!; assertTrue(saved.attempted); assertEquals(MARKET_SIGNATURE, saved.signature)
        assertNotNull("The dialog keeps following this purchase while it confirms", f.model.buying.value); assertFalse(f.model.paying.value)
    }
    @Test fun `a reservation that fails never opens the wallet or saves a purchase`() = runTest {
        val f = BuyFixture(); f.reserveFails = true
        f.model.buy(f.review(), f.approve())?.join()
        assertEquals(0, f.sends); assertEquals(0, f.prepared); assertNull(f.purchase.read()); assertNotNull(f.model.state.value.error)
    }
    @Test fun `a wallet decline returns to a re-payable plate, RETRY is one explicit tap, and nothing is stranded`() = runTest {
        val f = BuyFixture(); var declines = 0
        f.model.buy(f.review(), MarketPurchaseSender { _, _, _ -> declines++; throw WalletPaymentException("declined", true) })?.join()
        val declined = f.purchase.read()!!
        assertFalse("A provable refusal before broadcast is not an attempted payment", declined.attempted); assertNull(declined.signature)
        assertNotNull("The repository's sentence is the one failure line", f.model.state.value.error); assertTrue(f.model.state.value.canPay)
        assertEquals("Declining never retries by itself", 1, declines)
        // The next BUY is not blocked by the unpaid reservation: it is left through the store's own guard, then a fresh one is made.
        f.model.closeBuyDialog(); f.model.buy(f.review(), f.approve())?.join()
        assertEquals(2, f.reserves()); assertEquals(1, f.sends); assertNotEquals(declined.quote.key, f.purchase.read()!!.quote.key)
    }
    @Test fun `RETRY after a decline pays the same saved reservation and a settled purchase closes itself`() = runTest {
        val f = BuyFixture()
        f.model.buy(f.review(), MarketPurchaseSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        val key = f.purchase.read()!!.quote.key
        f.model.retryPay(MarketPurchaseSender { _, quote, record -> f.sends++; assertEquals(key, quote.key); record(MARKET_SIGNATURE); f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE); MARKET_SIGNATURE })?.join()
        assertEquals(1, f.reserves()); assertEquals(1, f.sends)
        assertNull("Settled and hydrated: retired by itself", f.purchase.read()); assertNull(f.model.buying.value)
    }
    @Test fun `an uncertain wallet reply enters auto-checking, never re-prompts, and finishes by itself when the server settles`() = runTest {
        // Joining BUY does not join the derived payment-message collector. Queue it explicitly so this
        // test must await the visible failure and its later retirement, independent of IO scheduling.
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val f = BuyFixture(); var prompts = 0
        val uncertain = MarketPurchaseSender { _, _, _ -> prompts++; throw java.io.IOException("wallet connection lost") }
        f.model.buy(f.review(), uncertain)?.join()
        assertTrue("Uncertain stays attempted", f.purchase.read()!!.attempted); assertNotNull(f.model.state.value.error)
        val sentence = requireNotNull(f.model.payFailure.first { it != null }); assertTrue(sentence.contains("uncertain"))
        f.model.retryPay(uncertain)?.join(); assertEquals("RETRY is refused for an attempted payment", 1, prompts)
        f.model.reviewPurchase(f.offer)?.join(); (f.model.state.value.review as? MarketReview.Purchase)?.let { f.model.buy(it, uncertain)?.join() }
        assertEquals("A second BUY cannot open a wallet while one payment is unconfirmed", 1, prompts); assertEquals(1, f.reserves())
        val before = f.api.posts.size
        val job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        assertEquals("Opening only observes", before, f.api.posts.size)
        advanceTimeBy(f.bounds.pollMs); runCurrent()
        assertTrue("Auto-checking settles by reference, never by wallet", f.api.posts.size > before && f.api.posts.drop(before).all { it.first.endsWith("/settle") })
        // Review 2026-09-18: the poll clears state.error; the PAY tap's sentence must outlive it until the purchase moves on.
        assertNull(f.model.state.value.error); assertEquals("One poll later the player can still read why", sentence, f.model.payFailure.value)
        f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE); f.model.state.first { it.saved == null && !it.busy }
        assertNull(f.purchase.read()); assertEquals(1, prompts); assertEquals(1, f.reserves())
        f.model.payFailure.first { it == null }; assertNull(f.model.payFailure.value); job.cancelAndJoin()
    }
    /** "4b" (2026-09-18): the player left the wallet sheet open too long. The payment stayed `attempted` with no
     * signature, the server superseded the reservation, and the saved purchase blocked every market purchase with
     * "contact support". It now clears itself within the visit and the next BUY goes straight through. */
    @Test fun `an attempted payment the server ended unpaid clears itself in the visit and the next BUY is not blocked`() = runTest {
        val f = BuyFixture(); var prompts = 0
        f.model.buy(f.review(), MarketPurchaseSender { _, _, _ -> prompts++; throw IOException("wallet timed out") })?.join()
        assertTrue(f.purchase.read()!!.attempted); assertNull(f.purchase.read()!!.signature)
        val job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && !it.busy }; runCurrent()
        // The settlement poll learns the unpaid end from the server's own receipt.
        f.row = marketReceipt(f.q, "superseded", false)
        advanceTimeBy(f.bounds.pollMs + 1); runCurrent(); f.model.state.first { it.saved?.receipt?.state == "superseded" && !it.busy }
        assertEquals("superseded", f.purchase.read()!!.receipt.state); val posts = f.api.posts.size
        f.model.buy(f.review(), MarketPurchaseSender { _, _, _ -> prompts++; error("Still inside the transport margin: no second wallet") })?.join()
        assertEquals(1, prompts); assertEquals(1, f.reserves())
        f.wall += UnpaidAttempt.MARGIN_MS
        advanceTimeBy(f.bounds.pollMs * 12); runCurrent(); f.model.state.first { it.saved == null && !it.busy }
        assertNull(f.purchase.read()); assertEquals(UnpaidAttempt.notice(null), f.model.state.value.notice)
        assertEquals("A dead reservation is never /paid or /settled again", posts, f.api.posts.size)
        f.model.buy(f.review(), MarketPurchaseSender { _, _, record -> prompts++; record(MARKET_SIGNATURE); MARKET_SIGNATURE })?.join()
        assertEquals("The rail is open again", 2, prompts); assertEquals(2, f.reserves()); job.cancelAndJoin()
    }
    @Test fun `an unpaid reservation the server ended closes itself on open and is never polled`() = runTest {
        val f = BuyFixture()
        f.model.buy(f.review(), MarketPurchaseSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        val posts = f.api.posts.size
        f.row = marketReceipt(f.q, "cancelled", false)
        val job = launch { f.model.foreground(f.bounds) }; runCurrent(); f.model.state.first { it.loaded && it.saved == null && !it.busy }
        assertNull(f.purchase.read()); assertEquals("GET-only: no settle or paid for a never-attempted reservation", posts, f.api.posts.size); job.cancelAndJoin()
    }
}
