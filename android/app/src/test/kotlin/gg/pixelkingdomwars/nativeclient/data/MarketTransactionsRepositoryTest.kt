package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal fun marketWire(): JsonObject = Json.parseToJsonElement(requireNotNull(MarketTransactionsRepositoryTest::class.java.getResource("/market-purchase-wire.json")).readText()).jsonObject
internal fun marketQuote() = MarketQuote.from(marketWire().getValue("quote").jsonObject)
internal val MARKET_SIGNATURE = base58(ByteArray(64) { 21 })
/** [serverNow] defaults to what a server answers with: the quote's creation time while the reservation lives, and —
 * for a reservation it already ended — a clock one [UnpaidAttempt] margin past the payment deadline. The tests of the
 * server-clock leg pass their own. */
internal fun marketServerNow(q: MarketQuote, pastDeadlineMs: Long): String = java.time.Instant.parse(q.payableUntil).plusMillis(pastDeadlineMs).toString()
internal fun marketReceipt(q: MarketQuote, state: String = "reserved", payable: Boolean = state == "reserved", signature: String? = null,
    serverNow: String = if (state in setOf("superseded", "cancelled")) marketServerNow(q, UnpaidAttempt.MARGIN_MS) else q.createdAt): MarketReservationReceipt =
    MarketReservationReceipt.from(buildJsonObject {
        put("quote", q.raw); put("serverNow", serverNow); put("payable", payable); put("state", state)
        put("paymentSignature", signature?.let(::JsonPrimitive) ?: JsonNull)
        put("txSignature", if (state == "settled") JsonPrimitive(requireNotNull(signature)) else JsonNull)
        put("resolvedAt", if (state in setOf("settled", "cancelled", "superseded")) JsonPrimitive(q.payableUntil) else JsonNull)
    })

class MarketTransactionsRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val memory = MemoryStore(); val intents = PendingIntentStore(MemoryStore()); val observer = ReceiptObserver(intents)
        val store = MarketPurchaseStore(memory, WALLET, session.origin, "devnet")
        var q = marketQuote(); var row = marketReceipt(q); var selected: String? = q.buyerBaseId; var land = true
        var enabled = true; var now = 0L; var prepared = 0; var hydrated = 0; var offline = false
        var owned: Set<String>? = setOf(q.buyerBaseId!!)
        /** Device wall clock and the cluster's verdict on a recorded signature ([UnpaidAttempt]). */
        var wall = 1_000_000L; var landings = 0; var landing: suspend (String) -> SignatureLanding = { fail("No signature was recorded"); SignatureLanding.PRESENT }
        /** The last-valid block height of the prepared payment's blockhash; null is a payment prepared without one. */
        var lastValid: Long? = 500L
        var beforePrepare: suspend () -> Unit = {}; var beforeReserve: suspend () -> Unit = {}
        val offer get() = MarketOffer(q.listingId, q.seller, q.sourceBaseId, q.itemId, q.priceLamports, q.createdAt)
        fun book() = buildJsonObject {
            put("feeBps", q.feeBps); put("summary", JsonArray(emptyList()))
            put("listings", JsonArray(listOf(buildJsonObject {
                put("id", q.listingId); put("seller", q.seller); put("baseId", JsonPrimitive(q.sourceBaseId!!))
                put("itemId", q.itemId); put("priceLamports", q.priceLamports); put("createdAt", q.createdAt)
            })))
            if (enabled) put("features", json("""{"itemMarket":{"version":1,"listingReceipts":1,"reservationReceipts":1,"cancelReceipts":1}}"""))
        }
        fun repo() = MarketTransactionsRepository(session, holder, api, intents, observer, store, SolanaCluster.DEVNET,
            { selected }, { land }, { MarketTradeBounds(BigInteger("100000"), BigInteger("1000000000000"), 2500, 15000) },
            { prepared++; beforePrepare(); PreparedMarketPurchase(byteArrayOf(1, 2, 3), BigInteger.valueOf(5000), lastValid) },
            { hydrated++; if (offline) throw IOException("account offline") }, {}, { owned }, { now },
            { signature, height -> landings++; assertEquals(MARKET_SIGNATURE, signature); assertEquals("The height saved with THIS payment", store.read()!!.lastValidBlockHeight, height); landing(signature) }, { wall })
        fun installReceipt() { api.onGet("/market/v1/reservations/by-key/${q.key}") { row.raw } }
        init {
            api.onGet(MarketRepository.BOOK) { book() }
            api.onGet(MarketTransactionsRepository.OWN) { json("""{"listings":[]}""") }
            api.onGet("/items") { json("""{"catalog":[{"id":"${q.itemId}","kind":"gear","dropOnly":false}],"owned":[{"itemId":"${q.itemId}","qty":2}]}""") }
            installReceipt()
            api.onPost("/market/v1/listings/${q.listingId}/reserve") { body ->
                q = MarketQuote.from(JsonObject(q.raw + ("idempotencyKey" to body.getValue("idempotencyKey"))))
                row = marketReceipt(q); installReceipt(); beforeReserve(); row.raw
            }
            api.onPost("/market/v1/reservations/${q.reservationId}/paid") { body ->
                assertEquals(q.reference, body.string("reference")); assertEquals(MARKET_SIGNATURE, body.string("signature")); row.raw
            }
            api.onPost("/market/v1/reservations/${q.reservationId}/settle") { body ->
                assertEquals(q.reference, body.string("reference")); row.raw
            }
        }
        suspend fun ready(): MarketTransactionsRepository = repo().also { r -> r.open(); r.reviewPurchase(offer); r.confirm(requireNotNull(r.state.value.review)) }
        fun sender(action: suspend ((String) -> Unit) -> Unit = {}) = MarketPurchaseSender { _, quote, record ->
            assertEquals(q, quote); assertTrue(store.read()!!.attempted); action(record); record(MARKET_SIGNATURE); MARKET_SIGNATURE
        }
    }
    @Test fun `production without all capability versions stays browse only and performs no command`() = runBlocking {
        val f = Fixture(); f.enabled = false; val r = f.repo(); r.open(); r.reviewPurchase(f.offer); r.reviewListing(f.q.itemId, "0.0002")
        assertFalse(r.state.value.supported); assertNull(r.state.value.review); assertTrue(f.api.posts.isEmpty()); assertNull(f.store.read())
    }
    @Test fun `reserve stores every quoted term before retiring command and never opens wallet automatically`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        assertEquals(f.q, f.store.read()!!.quote); assertEquals(0, f.prepared); assertNull(f.intents.get(IntentKind.MARKET_RESERVE, WALLET))
        r.pay(f.sender()); assertTrue(f.store.read()!!.attempted); assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature)
        assertEquals(listOf("/market/v1/listings/${f.q.listingId}/reserve", "/market/v1/reservations/${f.q.reservationId}/paid", "/market/v1/reservations/${f.q.reservationId}/settle"), f.api.posts.map { it.first })
    }
    @Test fun `lost reserve reply recovers exact key without a second POST or mutable book inference`() = runBlocking {
        val f = Fixture(); f.beforeReserve = { throw IOException("lost reply") }; val r = f.ready()
        assertNull(f.store.read()); val pending = f.intents.get(IntentKind.MARKET_RESERVE, WALLET)!!
        assertTrue(pending.attempted); assertEquals(f.q.key, pending.idempotencyKey)
        r.checkCommand(IntentKind.MARKET_RESERVE)
        assertEquals(f.q, f.store.read()!!.quote); assertEquals(1, f.api.posts.size); assertNull(f.intents.get(IntentKind.MARKET_RESERVE, WALLET))
    }
    @Test fun `404 exact key stays unknown and explicit retry retains original body and key`() = runBlocking {
        val f = Fixture(); f.beforeReserve = { throw IOException("lost reply") }; val r = f.ready()
        val original = f.api.posts.single(); f.api.onGet("/market/v1/reservations/by-key/${f.q.key}") { throw ApiException(404, null, "unknown") }
        r.checkCommand(IntentKind.MARKET_RESERVE); assertNotNull(f.intents.get(IntentKind.MARKET_RESERVE, WALLET))
        f.beforeReserve = {}; r.checkCommand(IntentKind.MARKET_RESERVE, retry = true)
        assertEquals(original, f.api.posts.last()); assertEquals(2, f.api.posts.size)
    }
    @Test fun `failed reserve hydration retains quote and command and refuses wallet and close until refresh`() = runBlocking {
        val f = Fixture(); f.offline = true; val r = f.ready()
        assertEquals(f.q, f.store.read()!!.quote); assertNotNull(f.intents.get(IntentKind.MARKET_RESERVE, WALLET)?.receipt)
        r.pay(f.sender { fail("No wallet before reserve handover completes") }); r.closePurchase(); assertNotNull(f.store.read())
        f.offline = false; r.checkCommand(IntentKind.MARKET_RESERVE); assertNull(f.intents.get(IntentKind.MARKET_RESERVE, WALLET))
        assertEquals(1, f.api.posts.size); assertEquals(0, f.prepared)
    }
    @Test fun `positive wallet refusal can retry but an unknown broadcast can never resign or create replacement`() = runBlocking {
        val f = Fixture(); val r = f.ready(); var calls = 0
        r.pay(MarketPurchaseSender { _, _, _ -> calls++; throw WalletPaymentException("refused", true) }); assertFalse(f.store.read()!!.attempted)
        r.pay(MarketPurchaseSender { _, _, _ -> calls++; throw IOException("unknown") }); assertTrue(f.store.read()!!.attempted)
        r.pay(f.sender { calls++ }); r.closePurchase(); r.reviewPurchase(f.offer); r.confirm(requireNotNull(r.state.value.review))
        assertEquals(2, calls); assertEquals(1, f.api.posts.count { it.first.endsWith("/reserve") }); assertNotNull(f.store.read())
    }
    @Test fun `signed payload persisted before failed broadcast remains held even positive prebroadcast error`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(MarketPurchaseSender { _, _, record -> record(MARKET_SIGNATURE); throw WalletPaymentException("window ended after approval", true) })
        assertTrue(f.store.read()!!.attempted); assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature)
        r.pay(f.sender { fail("Saved signature cannot be signed again") }); assertEquals(1, f.prepared)
    }
    /** Seeker incident 2026-09-18 (0.5.2): a plain decline arrived wrapped by ktx, was read as "uncertain" and left the
     * purchase attempted for good ("contact support"). The wallet step now classifies it by stage and unwrapped code;
     * the store must be payable again and the notice must say what happened in one sentence plus its token. */
    @Test fun `a decline in the wallet leaves the purchase payable again and says so with its stage and code`() = runBlocking {
        val f = Fixture(); val r = f.ready(); var calls = 0
        r.pay(MarketPurchaseSender { _, _, _ -> calls++; throw declinedInWallet() })
        val saved = requireNotNull(f.store.read()); assertFalse("a decline is not an attempt", saved.attempted); assertNull(saved.signature)
        assertEquals("Payment was not sent — the request was declined in the wallet. Review the reservation before approving again. [send:-3]", r.state.value.error)
        r.pay(f.sender { calls++ }); assertEquals("the same reservation is paid on the next explicit tap", 2, calls)
    }
    /** The payment window ending between the saved signature and this app's relay is this app's own stop, not the
     * wallet's: 0.5.x showed "the wallet's reply failed this app's checks". It keeps its own text. */
    @Test fun `a payment window that ends after the signature keeps its own text and the saved signature`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(MarketPurchaseSender { _, _, record -> record(MARKET_SIGNATURE); throw WalletPaymentException("The payment window ended. Check the original reservation before continuing.", true) })
        assertEquals("The payment window ended. Check the original reservation before continuing. Check this saved purchase; do not send another transfer.", r.state.value.error)
        assertTrue(f.store.read()!!.attempted); assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature)
        // An uncertain wallet outcome still reads as uncertain, with the classified reason and token.
        val g = Fixture(); val u = g.ready()
        u.pay(MarketPurchaseSender { _, _, _ -> throw WalletPaymentException("x", false, reason = WalletFailureReason(WalletFailureKind.NOT_SUBMITTED, -4, WalletPayStage.SEND)) })
        assertEquals("Payment outcome is uncertain — the wallet signed but reported that it did not send [send:-4]. Check this saved purchase; do not send another transfer.", u.state.value.error)
        assertTrue(g.store.read()!!.attempted)
    }
    @Test fun `process death after handoff recovers old reference after base transfer without requiring current book`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        try { r.pay(MarketPurchaseSender { _, _, _ -> throw CancellationException("process death") }) } catch (_: CancellationException) {}
        f.selected = null; f.land = false; f.owned = emptySet(); f.enabled = false; val restored = f.repo(); restored.open()
        assertTrue(f.store.read()!!.attempted); assertEquals(f.q.buyerBaseId, restored.state.value.saved!!.quote.buyerBaseId)
        f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE); restored.checkPayment()
        assertEquals("settled", restored.state.value.saved!!.receipt.state); assertTrue(restored.state.value.hydrated)
        assertEquals(MarketDestinationRefresh(f.q.buyerBaseId, false, null), restored.state.value.destinationRefresh)
        restored.closePurchase(); assertNull(f.store.read()); assertEquals(1, f.prepared)
    }
    @Test fun `settled proof survives offline hydration restart and needs no further paid or settle request`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.offline = true
        r.pay(f.sender { f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE) })
        assertEquals("settled", f.store.read()!!.receipt.state); assertFalse(r.state.value.hydrated); r.closePurchase(); assertNotNull(f.store.read())
        val postCount = f.api.posts.size; val restored = f.repo(); restored.open(); restored.closePurchase(); assertNotNull(f.store.read())
        f.offline = false; restored.checkPayment(); assertTrue(restored.state.value.hydrated); restored.closePurchase()
        assertNull(f.store.read()); assertEquals(postCount, f.api.posts.size)
    }
    @Test fun `changed quote money custody network or signature can never replace frozen proof`() = runBlocking {
        for ((key, value) in listOf("cluster" to JsonPrimitive("mainnet-beta"), "buyerBaseId" to JsonPrimitive(BASE_ID), "reference" to JsonPrimitive(WALLET))) {
            val f = Fixture(); val r = f.ready(); val old = f.store.read()!!
            val bad = JsonObject(f.row.raw + ("quote" to JsonObject(f.q.raw + (key to value))))
            f.api.onGet("/market/v1/reservations/by-key/${f.q.key}") { bad }
            r.pay(f.sender { fail("Changed quote cannot request payment") }); assertEquals(old, f.store.read()); assertNotNull(r.state.value.error)
        }
    }
    @Test fun `device sleep or slow funding consumes server window and does not open wallet`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.beforePrepare = { f.now += 120000 }
        r.pay(f.sender { fail("No payment after expiry") }); assertFalse(f.store.read()!!.attempted)
        assertEquals(1, f.prepared); assertFalse(r.state.value.quoteFresh)
    }
    @Test fun `base or identity change during preparation cannot reach handoff`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.beforePrepare = { f.selected = BASE_ID }
        r.pay(f.sender { fail("Wrong base") }); assertFalse(f.store.read()!!.attempted)
        val g = Fixture(); val s = g.ready(); g.beforePrepare = { g.holder.replace(null) }
        try { s.pay(g.sender { fail("Wrong identity") }) } catch (_: CancellationException) {}
        assertFalse(g.store.read()!!.attempted)
    }
    @Test fun `close unpaid quote first observes any payment committed elsewhere and refuses forgetting it`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.row = marketReceipt(f.q, "committed", false, MARKET_SIGNATURE)
        r.closePurchase(); assertTrue(f.store.read()!!.attempted); assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature)
    }
    @Test fun `concurrent pay taps share one admission and one transfer`() = runBlocking {
        val f = Fixture(); val r = f.ready(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var calls = 0
        val a = launch { r.pay(f.sender { calls++; entered.complete(Unit); release.await() }) }
        entered.await(); r.pay(f.sender { calls++ }); release.complete(Unit); a.join()
        assertEquals(1, calls); assertEquals(1, f.prepared)
    }
    @Test fun `settlement refreshes original still owned destination A when selected base is B`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(MarketPurchaseSender { _, _, record -> record(MARKET_SIGNATURE); throw IOException("broadcast reply lost") })
        f.selected = BASE_ID; f.owned = setOf(f.q.buyerBaseId!!, BASE_ID); f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE)
        f.api.gets.clear(); r.checkPayment()
        assertTrue(r.state.value.hydrated); assertEquals(f.q.buyerBaseId, r.state.value.destinationRefresh!!.baseId)
        assertEquals(listOf(BASE_ID, f.q.buyerBaseId), f.api.gets.filter { it.first == "/items" }.map { it.second["baseId"] })
        assertEquals(BASE_ID, r.state.value.inventoryBaseId); assertTrue(r.state.value.destinationRefresh!!.stillOwned)
    }
    @Test fun `missing fresh directory never classifies original destination as transferred or completes hydration`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.owned = null
        r.pay(f.sender { f.row = marketReceipt(f.q, "settled", false, MARKET_SIGNATURE) })
        assertFalse(r.state.value.hydrated); assertNull(r.state.value.destinationRefresh); r.closePurchase(); assertNotNull(f.store.read())
    }
    @Test fun `list lost response recovers original source and price after selection changes without relisting`() = runBlocking {
        val f = Fixture(); val r = f.repo(); r.open()
        f.api.onPost(MarketListSpec.PATH) { body ->
            val proof = buildJsonObject { put("version", 1); put("idempotencyKey", body.getValue("idempotencyKey")); put("creator", WALLET)
                put("listingId", f.q.listingId); put("itemId", body.getValue("itemId")); put("sourceBaseId", body.getValue("baseId"))
                put("priceLamports", body.getValue("priceLamports")); put("createdAt", f.q.createdAt) }
            f.api.onGet("/market/v1/list/by-key/${body.string("idempotencyKey")}") { proof }; throw IOException("response lost")
        }
        r.reviewListing(f.q.itemId, "0.0002"); assertNotNull(r.state.value.error, r.state.value.review); r.confirm(requireNotNull(r.state.value.review))
        val pending = f.intents.get(IntentKind.MARKET_LIST, WALLET)!!; assertEquals(f.q.buyerBaseId, pending.baseId)
        f.selected = BASE_ID; r.checkCommand(IntentKind.MARKET_LIST)
        assertNull(f.intents.get(IntentKind.MARKET_LIST, WALLET)); assertEquals(1, f.api.posts.size)
        assertEquals("200000", f.api.posts.single().second.string("priceLamports"))
    }
    @Test fun `drop only or fully equipped inventory cannot produce list consent`() = runBlocking {
        for (variant in listOf("dropOnly", "equipped")) {
            val f = Fixture(); val r = f.repo(); r.open()
            f.api.onGet("/items") { json("""{"catalog":[{"id":"${f.q.itemId}","kind":"gear","dropOnly":${variant == "dropOnly"}}],"owned":[{"itemId":"${f.q.itemId}","qty":1}],"heroLoadouts":[{"hero":"reaper","equipment":{"weapon":"${f.q.itemId}"}}]}""") }
            r.reviewListing(f.q.itemId, "0.0002"); assertNull(r.state.value.review); assertTrue(f.api.posts.isEmpty())
        }
    }
    @Test fun `pending cancellation keeps exact reference and explicit retry after deed transfer only resolves old consent`() = runBlocking {
        val f = Fixture(); val r = f.repo()
        val own = json("""{"listings":[{"id":"${f.q.listingId}","itemId":"${f.q.itemId}","baseId":"${f.q.sourceBaseId}","priceLamports":"${f.q.priceLamports}","status":"reserved","cancelConsent":{"version":1,"status":"reserved","reference":"${f.q.reference}"}}]}""")
        f.api.onGet(MarketTransactionsRepository.OWN) { own }
        var resolved = false; var last: JsonObject? = null
        fun receipt(body: JsonObject) = buildJsonObject {
            put("version", 1); put("idempotencyKey", body.getValue("idempotencyKey")); put("actor", WALLET)
            put("listingId", f.q.listingId); put("itemId", f.q.itemId); put("sourceBaseId", f.q.sourceBaseId)
            put("priceLamports", f.q.priceLamports); put("expectedStatus", "reserved"); put("expectedReference", f.q.reference)
            put("createdAt", f.q.createdAt); put("state", if (resolved) "refused" else "pending")
            put("resolvedAt", if (resolved) JsonPrimitive(f.q.payableUntil) else JsonNull)
            put("refusalCode", if (resolved) JsonPrimitive("NOT_OWNER") else JsonNull); put("settlement", JsonNull)
        }
        f.api.onPost("/market/v1/listings/${f.q.listingId}/cancel") { body ->
            last = body; f.api.onGet("/market/v1/cancellations/by-key/${body.string("idempotencyKey")}") { receipt(body) }; receipt(body)
        }
        r.open(); r.reviewCancellation(f.q.listingId); r.confirm(requireNotNull(r.state.value.review))
        assertNotNull(f.intents.get(IntentKind.MARKET_CANCEL, WALLET)); val original = last
        r.checkCommand(IntentKind.MARKET_CANCEL); assertNotNull(f.intents.get(IntentKind.MARKET_CANCEL, WALLET)); assertEquals(1, f.api.posts.size)
        f.land = false; f.owned = emptySet(); resolved = true
        r.checkCommand(IntentKind.MARKET_CANCEL, retry = true)
        assertEquals(original, last); assertNull(f.intents.get(IntentKind.MARKET_CANCEL, WALLET)); assertEquals(2, f.api.posts.size)
        r.reviewCancellation(f.q.listingId); assertNull(r.state.value.review); assertEquals(2, f.api.posts.size)
    }
    @Test fun `immediate cancellation reports actual attributed cancelled settled or refused receipt`() = runBlocking {
        for (outcome in listOf("cancelled", "settled", "refused")) {
            val f = Fixture(); val r = f.repo()
            f.api.onGet(MarketTransactionsRepository.OWN) { json("""{"listings":[{"id":"${f.q.listingId}","itemId":"${f.q.itemId}","baseId":"${f.q.sourceBaseId}","priceLamports":"${f.q.priceLamports}","status":"reserved","cancelConsent":{"version":1,"status":"reserved","reference":"${f.q.reference}"}}]}""") }
            f.api.onPost("/market/v1/listings/${f.q.listingId}/cancel") { body -> buildJsonObject {
                put("version", 1); put("idempotencyKey", body.getValue("idempotencyKey")); put("actor", WALLET)
                put("listingId", f.q.listingId); put("itemId", f.q.itemId); put("sourceBaseId", f.q.sourceBaseId)
                put("priceLamports", f.q.priceLamports); put("expectedStatus", "reserved"); put("expectedReference", f.q.reference)
                put("createdAt", f.q.createdAt); put("state", outcome); put("resolvedAt", f.q.payableUntil)
                put("refusalCode", if (outcome == "refused") JsonPrimitive("NOT_OWNER") else JsonNull)
                put("settlement", if (outcome == "settled") buildJsonObject { put("reference", f.q.reference); put("txSignature", MARKET_SIGNATURE); put("buyer", f.q.seller); put("buyerBaseId", f.q.buyerBaseId) } else JsonNull)
            } }
            r.open(); r.reviewCancellation(f.q.listingId); r.confirm(requireNotNull(r.state.value.review))
            assertNull(r.state.value.error); assertNull(f.intents.get(IntentKind.MARKET_CANCEL, WALLET))
            val notice = requireNotNull(r.state.value.notice)
            assertTrue(notice, notice.contains(when (outcome) { "settled" -> "the sale stands"; "refused" -> "refused: NOT_OWNER"; else -> "Listing cancelled" }))
            // Owner 2026-09-18: ids live only under DETAILS. The notice still has to be honest about WHERE the item went:
            // back to the kingdom it was listed from (not the selected one), or to the buyer when their payment won.
            assertFalse("No raw deed or listing id in player copy", listOfNotNull(f.q.sourceBaseId, f.q.buyerBaseId, f.q.listingId, f.q.itemId).any(notice::contains))
            if (outcome == "cancelled") assertTrue(notice, notice.contains("the kingdom it was listed from"))
            if (outcome == "settled") assertTrue(notice, notice.contains("the item sold"))
            assertEquals(1, f.api.posts.size)
        }
    }
    /** "4b" (two reviewers, 2026-09-18): a wallet timeout left `attempted` with no signature; once the server
     * superseded the reservation the saved purchase said "contact support" and blocked every later market purchase. */
    @Test fun `an attempt with no signature retires by itself once the server ended it unpaid and the margin passed`() = runBlocking {
        for (state in listOf("superseded", "cancelled")) {
            val f = Fixture(); val r = f.ready()
            r.pay(MarketPurchaseSender { _, _, _ -> throw IOException("wallet timed out") })
            val attempted = f.store.read()!!; assertTrue(attempted.attempted); assertNull(attempted.signature); assertEquals(f.wall, attempted.attemptedAtMs)
            // Old enough, but the server still holds the reservation: a payment could yet settle, so nothing retires.
            f.wall += UnpaidAttempt.MARGIN_MS; r.checkPayment(); assertNotNull(f.store.read()); assertNull(r.state.value.notice)
            val g = Fixture(); val young = g.ready()
            young.pay(MarketPurchaseSender { _, _, _ -> throw IOException("wallet timed out") })
            g.row = marketReceipt(g.q, state, false); young.open()
            assertEquals("The unpaid end is adopted", state, g.store.read()!!.receipt.state)
            g.wall += UnpaidAttempt.MARGIN_MS - 1; young.checkPayment(); young.open()
            assertNotNull("One millisecond before the margin nothing retires", g.store.read()); assertNull(young.state.value.notice)
            val posts = g.api.posts.size
            g.wall += 1; young.checkPayment()
            assertNull(g.store.read()); assertNull(young.state.value.saved); assertEquals(UnpaidAttempt.notice(null), young.state.value.notice)
            assertEquals("Observation only: never /paid, /settle or any other mutation", posts, g.api.posts.size); assertEquals(0, g.landings)
            // The rail accepts a new purchase at once.
            young.reviewPurchase(g.offer); young.confirm(requireNotNull(young.state.value.review))
            assertEquals(2, g.api.posts.count { it.first.endsWith("/reserve") }); assertFalse(g.store.read()!!.attempted)
        }
    }
    @Test fun `process death under the wallet sheet retires on the next open, and a settled receipt is adopted instead`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        try { r.pay(MarketPurchaseSender { _, _, _ -> throw CancellationException("process death") }) } catch (_: CancellationException) {}
        f.wall += UnpaidAttempt.MARGIN_MS; f.row = marketReceipt(f.q, "superseded", false)
        val restored = f.repo(); restored.open()
        assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(null), restored.state.value.notice)
        // The wallet DID send although this app never heard back: the server settles by reference, and that wins.
        val g = Fixture(); val s = g.ready()
        try { s.pay(MarketPurchaseSender { _, _, _ -> throw CancellationException("process death") }) } catch (_: CancellationException) {}
        g.wall += UnpaidAttempt.MARGIN_MS; g.row = marketReceipt(g.q, "settled", false, MARKET_SIGNATURE)
        val paid = g.repo(); paid.open(); paid.checkPayment()
        assertEquals("settled", g.store.read()!!.receipt.state); assertTrue(paid.state.value.hydrated); assertNull(paid.state.value.notice)
        paid.closePurchase(); assertNull(g.store.read())
    }
    /** The sign-only fallback saved a signature and the relay refused it (or timed out): only the cluster can clear it. */
    @Test fun `a recorded signature retires only on the cluster's own proof and fails closed without it`() = runBlocking {
        suspend fun stranded(): Pair<Fixture, MarketTransactionsRepository> {
            val f = Fixture(); val r = f.ready()
            r.pay(MarketPurchaseSender { _, _, record -> record(MARKET_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature)
            // The unpaid end is first seen while the attempt is still young: adopted, never retired, and no RPC is asked.
            f.row = marketReceipt(f.q, "superseded", false); r.open(); assertEquals("superseded", f.store.read()!!.receipt.state); assertEquals(0, f.landings)
            f.wall += UnpaidAttempt.MARGIN_MS
            return f to r
        }
        stranded().let { (f, r) ->
            f.landing = { SignatureLanding.NOT_FOUND }; val posts = f.api.posts.size; r.checkPayment()
            assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(SignatureLanding.NOT_FOUND), r.state.value.notice); assertEquals(1, f.landings)
            assertEquals("A dead reservation is never /paid or /settled again", posts, f.api.posts.size)
        }
        stranded().let { (f, r) ->
            // It landed and succeeded: money moved, the existing support path keeps it.
            f.landing = { SignatureLanding.PRESENT }; r.checkPayment()
            assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature); assertTrue(r.state.value.paymentFound); assertNull(r.state.value.notice)
            r.reviewPurchase(f.offer); r.confirm(requireNotNull(r.state.value.review)); assertEquals(1, f.api.posts.count { it.first.endsWith("/reserve") })
        }
        stranded().let { (f, r) ->
            // Finalized WITH an error: atomic, nothing was transferred, and it can never run again. Only the fee was spent.
            f.landing = { SignatureLanding.FAILED_FINALIZED }; r.checkPayment()
            assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(SignatureLanding.FAILED_FINALIZED), r.state.value.notice)
            assertTrue(r.state.value.notice!!.contains("NETWORK FEE"))
        }
        stranded().let { (f, r) ->
            f.landing = { throw IOException("relay unavailable") }; r.checkPayment()
            assertNotNull("No verdict, no retire", f.store.read()); assertFalse(r.state.value.paymentFound); assertNull(r.state.value.notice)
            f.landing = { SignatureLanding.NOT_FOUND }; r.checkPayment()
            assertNull("A later poll asks again", f.store.read()); assertEquals(2, f.landings)
        }
    }
    /** The double-payment path the first cut left open: association + authorize + sign_and_send may run ~210 s, the
     * wallet may name a FRESH blockhash and land ~330 s after the attempt began, and the app has long recorded a
     * timeout with no signature. Five minutes from the START retired that payment while it could still land. */
    @Test fun `a wallet step that ended late keeps the purchase until the margin has passed since that end`() = runBlocking {
        assertTrue("Above a compliant wallet's worst case: 210 s to broadcast plus ~120 s for a fresh blockhash to land", UnpaidAttempt.MARGIN_MS >= 10 * 60_000L)
        val f = Fixture(); val r = f.ready(); val began = f.wall
        r.pay(MarketPurchaseSender { _, _, _ -> f.wall += 210_000L; throw WalletPaymentException("Wallet did not answer in time.", false) })
        val saved = f.store.read()!!; assertTrue(saved.attempted); assertNull(saved.signature)
        assertEquals(began, saved.attemptedAtMs); assertEquals(began + 210_000L, saved.walletEndedAtMs)
        f.row = marketReceipt(f.q, "superseded", false)
        f.wall = began + UnpaidAttempt.MARGIN_MS; r.checkPayment(); r.open()
        assertNotNull("The margin from the START has passed, but the wallet could broadcast until its step ended", f.store.read()); assertNull(r.state.value.notice)
        f.wall = began + 210_000L + UnpaidAttempt.MARGIN_MS - 1; r.checkPayment(); assertNotNull(f.store.read())
        f.wall += 1; r.checkPayment(); assertNull(f.store.read())
        // With no signature this device cannot speak for the chain: the wallet is the only witness of what it sent.
        val notice = r.state.value.notice!!; assertEquals(UnpaidAttempt.notice(null), notice)
        assertFalse(notice, notice.contains("NOTHING WAS CHARGED")); assertTrue(notice, notice.contains("WALLET") && notice.contains("SUPPORT"))
        assertEquals(notice, notice.uppercase())
    }
    /** The device clock is the player's to move. `payableUntil` is the last moment an attempt can start, so the
     * server's own clock on a FRESH receipt must also be the margin past it; an old saved receipt is re-read first. */
    @Test fun `a device clock that jumped forward retires nothing until the server clock is the margin past the deadline`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(MarketPurchaseSender { _, _, _ -> throw WalletPaymentException("Wallet did not answer in time.", false) })
        f.row = marketReceipt(f.q, "superseded", false, serverNow = marketServerNow(f.q, UnpaidAttempt.MARGIN_MS - 1))
        f.wall += 365L * 24 * 60 * 60_000; r.open(); r.checkPayment()
        assertNotNull("A year ahead on the device, one millisecond short on the server", f.store.read()); assertNull(r.state.value.notice)
        assertFalse(r.state.value.paymentFound)
        // The next slow poll re-reads the receipt; its newer server clock is what completes the margin. GET-only.
        val posts = f.api.posts.size
        f.row = marketReceipt(f.q, "superseded", false, serverNow = marketServerNow(f.q, UnpaidAttempt.MARGIN_MS)); r.checkPayment()
        assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(null), r.state.value.notice); assertEquals(posts, f.api.posts.size)
    }
    /** A lagging or pruned RPC node answers null for a transaction that landed. The height saved with the payment is
     * what lets the RPC layer prove a null final; until it can, or when no height was ever saved, nothing retires. */
    @Test fun `a null signature status that is not proven final never retires the purchase`() = runBlocking {
        suspend fun stranded(lastValid: Long?): Pair<Fixture, MarketTransactionsRepository> {
            val f = Fixture(); f.lastValid = lastValid; val r = f.ready()
            r.pay(MarketPurchaseSender { _, _, record -> record(MARKET_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            assertEquals(lastValid, f.store.read()!!.lastValidBlockHeight); assertEquals(f.wall, f.store.read()!!.walletEndedAtMs)
            f.row = marketReceipt(f.q, "superseded", false); f.wall += UnpaidAttempt.MARGIN_MS
            return f to r
        }
        stranded(500L).let { (f, r) ->
            // The node has not finalized past block 500 yet (or its height read failed): ask again later, no support path.
            f.landing = { SignatureLanding.UNPROVEN }; r.checkPayment()
            assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature); assertFalse(r.state.value.paymentFound); assertNull(r.state.value.notice)
            f.landing = { SignatureLanding.NOT_FOUND }; r.checkPayment()
            assertNull("Proven final on a later poll", f.store.read()); assertEquals(2, f.landings)
        }
        for (verdict in listOf(SignatureLanding.UNPROVEN, SignatureLanding.NOT_FOUND)) stranded(null).let { (f, r) ->
            // Saved without a height (the previous version's journal): a null can never be proven, so it is support's.
            f.landing = { verdict }; r.checkPayment()
            assertEquals(MARKET_SIGNATURE, f.store.read()!!.signature); assertTrue(r.state.value.paymentFound); assertNull(r.state.value.notice)
            r.reviewPurchase(f.offer); r.confirm(requireNotNull(r.state.value.review)); assertEquals(1, f.api.posts.count { it.first.endsWith("/reserve") })
        }
        stranded(null).let { (f, r) ->
            f.landing = { SignatureLanding.FAILED_FINALIZED }; r.checkPayment()
            assertNull("A finalized error needs no height", f.store.read())
        }
    }
    @Test fun `corrupt durable quote is never treated as empty and does not wedge the action lock`() = runBlocking {
        val f = Fixture(); f.memory.value = "broken"; val r = f.repo(); r.open(); r.open()
        assertFalse(r.state.value.loaded); assertFalse(r.state.value.busy); assertEquals("broken", f.memory.value); assertTrue(f.api.posts.isEmpty())
    }
}
