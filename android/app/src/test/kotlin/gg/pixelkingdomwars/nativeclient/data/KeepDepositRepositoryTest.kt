package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal const val DEPOSIT_ID = "00000000-0000-4000-8000-000000000017"
internal const val DEPOSIT_SOURCE = "D37fYaEdaF9BcUJ65gojUC4ChS9r9k9fVRHK2fdxvbk8"
internal const val DEPOSIT_DEST = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
internal const val DEPOSIT_REFERENCE = "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD"
internal val DEPOSIT_SIGNATURE = base58(ByteArray(64) { 17 })

class KeepDepositRepositoryTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val memory = MemoryStore()
        val store = KeepDepositStore(memory, session.wallet, session.origin, "devnet")
        val limits = KeepDepositBounds(BigInteger("1000000000"), 9, 2500, 15000, 1200000)
        val q = KeepDepositQuote(DEPOSIT_ID, session.wallet, session.origin, "devnet", "17", DEPOSIT_SOURCE, DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, DEPOSIT_REFERENCE)
        var now = 0L; var hydrationOffline = false
        var creates = 0; var prepared = 0; var refreshed = 0; var beforePrepare: suspend () -> Unit = {}
        var row = row()
        var configuredMint = ChainAddresses.DEVNET.keepMint
        /** Device wall clock and the cluster's verdict on a recorded signature ([UnpaidAttempt]). */
        /** The last-valid block height of the prepared payment's blockhash; null is a payment prepared without one. */
        var lastValid: Long? = 500L
        var wall = 1_000_000L; var landings = 0; var landing: suspend (String) -> SignatureLanding = { fail("No signature was recorded"); SignatureLanding.PRESENT }
        fun repository() = KeepDepositRepository(session, holder, api, store, SolanaCluster.DEVNET, { configuredMint }, { limits },
            { quote -> assertEquals(q, quote); prepared++; beforePrepare(); PreparedKeepDeposit(byteArrayOf(1,2,3), BigInteger.valueOf(5000), lastValid) }, { refreshed++; if (hydrationOffline) throw IOException("balance refresh offline") }, { now },
            { signature, height -> landings++; assertEquals(DEPOSIT_SIGNATURE, signature); assertEquals("The height saved with THIS payment", store.read()!!.lastValidBlockHeight, height); landing(signature) }, { wall })
        init {
            api.onPost("/deposits") { body -> creates++; assertEquals(jsonBody("kind" to "keep_deposit"), body)
                jsonBody("id" to q.id, "kind" to "keep_deposit", "source" to q.source, "destination" to q.destination, "mint" to q.mint, "decimals" to q.decimals.toString(), "reference" to q.reference) }
            api.onGet("/deposits/$DEPOSIT_ID") { row }
            api.onPost("/deposits/$DEPOSIT_ID/verify") { row }
            api.onPost("/deposits/$DEPOSIT_ID/paid") { assertEquals(DEPOSIT_SIGNATURE, it.string("signature")); json("""{"committed":true}""") }
        }
        suspend fun ready(): KeepDepositRepository = repository().also { it.open(); it.create("17") }
        fun row(status: String = "pending", signature: String? = null, amount: String? = null, createdAt: String = "2026-09-18T00:00:00.000Z") = jsonBody("id" to DEPOSIT_ID, "kind" to "keep_deposit",
            "reference" to DEPOSIT_REFERENCE, "status" to status, "createdAt" to createdAt).let { JsonObject(it + mapOf("txSignature" to (signature?.let(::JsonPrimitive) ?: JsonNull), "paymentSignature" to (signature?.let(::JsonPrimitive) ?: JsonNull), "amount" to (amount?.let(::JsonPrimitive) ?: JsonNull))) }
        fun sender(action: suspend () -> Unit = {}) = KeepDepositSender { _, quote, record ->
            assertEquals(q, quote); assertTrue(store.read()!!.attempted); action(); record(DEPOSIT_SIGNATURE); DEPOSIT_SIGNATURE
        }
    }
    @Test fun `quote amount and all payment accounts persist before either wallet receives a transfer`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        assertEquals(f.q, f.store.read()!!.quote); assertTrue(r.state.value.canPay)
        r.pay(f.sender()); assertTrue(f.store.read()!!.attempted); assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature)
        assertEquals(1, f.creates); assertEquals(1, f.prepared)
        assertEquals(listOf("/deposits", "/deposits/$DEPOSIT_ID/paid", "/deposits/$DEPOSIT_ID/verify"), f.api.posts.map { it.first })
    }
    @Test fun `exact credited reference ID amount and signature retire payment without using balance changes`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(f.sender { f.row = f.row("credited", DEPOSIT_SIGNATURE, f.q.baseUnits.toString()) })
        assertEquals("credited", r.state.value.saved!!.receipt!!.status); assertEquals(1, f.refreshed)
        r.close(); assertNull(f.store.read()); assertTrue(f.api.gets.none { it.first.contains("balances") })
    }
    @Test fun `wallet refusal permits explicit retry of same frozen quote but uncertain replies never resign`() = runBlocking {
        val f = Fixture(); val r = f.ready(); var sends = 0
        r.pay(KeepDepositSender { _, _, _ -> sends++; throw WalletPaymentException("declined", true) })
        assertTrue(r.state.value.canPay); assertFalse(f.store.read()!!.attempted)
        r.pay(KeepDepositSender { _, _, _ -> sends++; throw IOException("lost reply after send") })
        assertTrue(f.store.read()!!.attempted); assertFalse(r.state.value.canPay)
        r.pay(f.sender { sends++ }); r.create("19"); r.close()
        assertEquals(2, sends); assertEquals(1, f.creates); assertEquals(f.q, f.store.read()!!.quote)
    }
    /** 0.5.2 read a ktx-wrapped decline as "uncertain" and stranded the deposit as attempted. */
    @Test fun `a decline in the wallet leaves the deposit payable again and says so with its stage and code`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(KeepDepositSender { _, _, _ -> throw declinedInWallet() })
        assertTrue(r.state.value.canPay); assertFalse(f.store.read()!!.attempted); assertNull(f.store.read()!!.signature)
        assertEquals("Payment was not sent — the request was declined in the wallet. Your reviewed deposit is kept; approve it when ready. [send:-3]", r.state.value.error)
    }
    @Test fun `process death after handoff restores full quote and only verifies original ID`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        try { r.pay(KeepDepositSender { _, _, _ -> throw CancellationException("process lost") }) } catch (_: CancellationException) {}
        assertTrue(f.store.read()!!.attempted)
        val restored = f.repository(); restored.open(); restored.pay(f.sender { fail("Must not re-sign") })
        assertEquals(f.q, restored.state.value.saved!!.quote); assertEquals(1, f.creates); assertEquals(1, f.prepared)
        assertTrue(f.api.posts.any { it.first == "/deposits/$DEPOSIT_ID/verify" })
    }
    @Test fun `saved signature survives lost broadcast and paid acknowledgement for exact receipt recovery`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(KeepDepositSender { _, _, record -> record(DEPOSIT_SIGNATURE); throw IOException("RPC response lost") })
        f.api.onPost("/deposits/$DEPOSIT_ID/paid") { throw IOException("commit RPC unavailable") }
        f.row = f.row("credited", DEPOSIT_SIGNATURE, f.q.baseUnits.toString())
        val restored = f.repository(); restored.open()
        assertEquals("credited", restored.state.value.saved!!.receipt!!.status); assertEquals(1, f.prepared)
    }
    @Test fun `detail never reconstructs missing token quote and malformed journal blocks new money actions`() = runBlocking {
        val f = Fixture(); f.memory.value = """{"id":"$DEPOSIT_ID","attempted":true}"""
        val r = f.repository(); r.open(); r.create("17")
        assertFalse(r.state.value.loaded); assertEquals(0, f.creates); assertNotNull(f.memory.value)
    }
    @Test fun `wrong ID reference kind amount or signature cannot prove the reviewed transfer`() = runBlocking {
        for ((key, wrong) in listOf("id" to BASE_ID, "reference" to DEPOSIT_DEST, "kind" to "entry", "amount" to "18000000000", "txSignature" to base58(ByteArray(64) { 18 }))) {
            val f = Fixture(); val r = f.ready()
            r.pay(f.sender())
            f.row = JsonObject(f.row("credited", DEPOSIT_SIGNATURE, f.q.baseUnits.toString()) + (key to JsonPrimitive(wrong)))
            r.check(); assertNotNull("$key must fail", r.state.value.error); assertNull(f.store.read()!!.receipt)
            assertTrue(f.store.read()!!.attempted); assertEquals(0, f.refreshed)
        }
    }
    @Test fun `paid elsewhere or finalized deposit switches to recovery before requesting a signature`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        f.row = f.row("finalized", DEPOSIT_SIGNATURE, f.q.baseUnits.toString())
        r.pay(f.sender { fail("No second transfer") })
        assertTrue(f.store.read()!!.attempted); assertEquals(0, f.prepared)
    }
    /** Rewritten 2026-09-18 ("4b"): this test pinned "server expired OR failed never erases an attempted payment".
     * What it protected is kept — a 404, a timeout, `failed` (a transfer the server RECEIVED) and Close never erase
     * it. What changed: an attempted `expired` deposit with no signature no longer blocks every later deposit; once
     * the transport margin has passed it retires by itself, because the server's unpaid verdict plus an expired
     * blockhash prove that nothing was sent. */
    @Test fun `404 timeout and server failed never erase an attempted payment, and expired erases it only after the margin`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(KeepDepositSender { _, _, _ -> throw IOException("broadcast unknown") })
        assertEquals(f.wall, f.store.read()!!.attemptedAtMs)
        f.api.onPost("/deposits/$DEPOSIT_ID/verify") { throw ApiException(404, null, "missing") }
        r.check(); r.close(); assertTrue(f.store.read()!!.attempted)
        f.api.onPost("/deposits/$DEPOSIT_ID/verify") { f.row }
        // Still pending however old: a transfer could yet be credited.
        f.wall += 10 * UnpaidAttempt.MARGIN_MS; r.check(); assertNotNull(f.store.read()); f.wall -= 10 * UnpaidAttempt.MARGIN_MS
        for (status in listOf("expired", "failed")) { f.row = f.row(status); r.check(); r.close(); assertNotNull(f.store.read()) }
        f.wall += 10 * UnpaidAttempt.MARGIN_MS; r.check(); r.open()
        assertEquals("Funds received: support, never retired", "failed", f.store.read()!!.receipt!!.status); assertNull(r.state.value.notice)
        assertEquals(1, f.creates); assertEquals(0, f.landings)
    }
    @Test fun `an attempt with no signature retires by itself once the server expired it and the margin passed`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(KeepDepositSender { _, _, _ -> throw IOException("wallet timed out") })
        f.row = f.row("expired"); r.check(); assertEquals("expired", f.store.read()!!.receipt!!.status)
        f.wall += UnpaidAttempt.MARGIN_MS - 1; r.check(); r.open(); assertNotNull("One millisecond before the margin", f.store.read()); assertNull(r.state.value.notice)
        val posts = f.api.posts.size
        f.wall += 1; r.check()
        assertNull(f.store.read()); assertNull(r.state.value.saved); assertEquals(UnpaidAttempt.notice(null, deposit = true), r.state.value.notice)
        assertEquals("An ended deposit is observed by GET only: never /paid or /verify", posts, f.api.posts.size); assertEquals(0, f.landings)
        // The rail accepts a new deposit at once, and the new quote clears the notice.
        f.row = f.row(); r.create("17"); assertEquals(2, f.creates); assertFalse(f.store.read()!!.attempted); assertNull(r.state.value.notice)
    }
    @Test fun `a credited receipt arriving instead of the expiry is adopted normally`() = runBlocking {
        val f = Fixture(); val r = f.ready()
        r.pay(KeepDepositSender { _, _, _ -> throw IOException("wallet timed out") })
        f.wall += 10 * UnpaidAttempt.MARGIN_MS; f.row = f.row("credited", DEPOSIT_SIGNATURE, f.q.baseUnits.toString()); r.check()
        assertEquals("credited", f.store.read()!!.receipt!!.status); assertTrue(r.state.value.hydrated); assertNull(r.state.value.notice)
        r.close(); assertNull(f.store.read())
    }
    /** The sign-only fallback saved a signature and the relay refused it (or timed out): only the cluster can clear it. */
    @Test fun `a recorded signature retires only on the cluster's own proof and fails closed without it`() = runBlocking {
        suspend fun stranded(): Pair<Fixture, KeepDepositRepository> {
            val f = Fixture(); val r = f.ready()
            r.pay(KeepDepositSender { _, _, record -> record(DEPOSIT_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature)
            f.row = f.row("expired"); f.wall += UnpaidAttempt.MARGIN_MS
            return f to r
        }
        stranded().let { (f, r) ->
            f.landing = { SignatureLanding.NOT_FOUND }; r.check()
            assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(SignatureLanding.NOT_FOUND, deposit = true), r.state.value.notice); assertEquals(1, f.landings)
        }
        stranded().let { (f, r) ->
            // It landed and succeeded: KEEP moved, the existing support path keeps it and no second deposit starts.
            f.landing = { SignatureLanding.PRESENT }; r.check()
            assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature); assertTrue(r.state.value.paymentFound); assertNull(r.state.value.notice)
            r.create("17"); assertEquals(1, f.creates)
        }
        stranded().let { (f, r) ->
            // Finalized WITH an error: atomic, no KEEP was transferred, and it can never run again. Only the fee was spent.
            f.landing = { SignatureLanding.FAILED_FINALIZED }; r.check()
            assertNull(f.store.read()); assertTrue(r.state.value.notice!!.contains("NETWORK FEE"))
        }
        stranded().let { (f, r) ->
            f.landing = { throw IOException("relay unavailable") }; r.check()
            assertNotNull("No verdict, no retire", f.store.read()); assertFalse(r.state.value.paymentFound); assertNull(r.state.value.notice)
            f.landing = { SignatureLanding.NOT_FOUND }; r.check()
            assertNull("A later check asks again", f.store.read()); assertEquals(2, f.landings)
        }
    }
    /** The wallet may broadcast — with a fresh blockhash — at any moment until its step ends, and that can be minutes
     * after the attempt began. The margin therefore runs from the END of the wallet step. */
    @Test fun `a wallet step that ended late keeps the deposit until the margin has passed since that end`() = runBlocking {
        val f = Fixture(); val r = f.ready(); val began = f.wall
        r.pay(KeepDepositSender { _, _, _ -> f.wall += 210_000L; throw WalletPaymentException("Wallet did not answer in time.", false) })
        assertEquals(began, f.store.read()!!.attemptedAtMs); assertEquals(began + 210_000L, f.store.read()!!.walletEndedAtMs); assertEquals(500L, f.store.read()!!.lastValidBlockHeight)
        f.row = f.row("expired")
        f.wall = began + UnpaidAttempt.MARGIN_MS; r.check(); assertNotNull("Past the margin from the START only", f.store.read())
        f.wall = began + 210_000L + UnpaidAttempt.MARGIN_MS - 1; r.check(); assertNotNull(f.store.read())
        f.wall += 1; r.check(); assertNull(f.store.read())
        val notice = r.state.value.notice!!; assertEquals(UnpaidAttempt.notice(null, deposit = true), notice)
        assertFalse(notice, notice.contains("NOTHING WAS SENT")); assertTrue(notice, notice.contains("SUPPORT"))
    }
    /** A lagging or pruned RPC node answers null for a transaction that landed: a null that is not proven final never
     * retires, and one saved without the height that could prove it goes to support. */
    @Test fun `a null signature status that is not proven final never retires the deposit`() = runBlocking {
        suspend fun stranded(lastValid: Long?): Pair<Fixture, KeepDepositRepository> {
            val f = Fixture(); f.lastValid = lastValid; val r = f.ready()
            r.pay(KeepDepositSender { _, _, record -> record(DEPOSIT_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            assertEquals(lastValid, f.store.read()!!.lastValidBlockHeight); assertEquals(f.wall, f.store.read()!!.walletEndedAtMs)
            f.row = f.row("expired"); f.wall += UnpaidAttempt.MARGIN_MS
            return f to r
        }
        stranded(500L).let { (f, r) ->
            f.landing = { SignatureLanding.UNPROVEN }; r.check()
            assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature); assertFalse(r.state.value.paymentFound); assertNull(r.state.value.notice)
            f.landing = { SignatureLanding.NOT_FOUND }; r.check(); assertNull("Proven final on a later check", f.store.read())
        }
        for (verdict in listOf(SignatureLanding.UNPROVEN, SignatureLanding.NOT_FOUND)) stranded(null).let { (f, r) ->
            f.landing = { verdict }; r.check()
            assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature); assertTrue(r.state.value.paymentFound); assertNull(r.state.value.notice)
        }
    }
    /** A deposit saved before the attempt time existed. Its quote has no deadline of its own, so its age is bounded
     * only by the server's creation time of this deposit plus the catalogue's payment window — never by "now". */
    @Test fun `a deposit saved before the attempt time existed is old only by the server creation time plus the payment window`() = runBlocking {
        val created = java.time.Instant.parse("2026-09-18T00:00:00.000Z").toEpochMilli()
        val f = Fixture(); val r = f.ready()
        r.pay(KeepDepositSender { _, _, _ -> throw IOException("wallet timed out") })
        f.memory.value = Json.encodeToString(SavedKeepDeposit.serializer(), f.store.read()!!.copy(attemptedAtMs = null, walletEndedAtMs = null, lastValidBlockHeight = null))
        assertFalse("The legacy journal has none of the stamps", listOf("attemptedAtMs", "walletEndedAtMs", "lastValidBlockHeight").any { it in f.memory.value!! })
        f.row = f.row("expired"); f.wall = created + f.limits.quoteWindowMs + UnpaidAttempt.MARGIN_MS; r.check()
        assertNotNull("Exactly the margin after the window is not yet more than the margin", f.store.read())
        // Without the server's creation time the age is unknown and nothing retires, however late the device clock.
        f.row = JsonObject(f.row - "createdAt"); f.wall += 365L * 86_400_000; r.check(); assertNotNull(f.store.read())
        f.row = f.row("expired"); f.wall = created + f.limits.quoteWindowMs + UnpaidAttempt.MARGIN_MS + 1; r.check()
        assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(null, deposit = true), r.state.value.notice)
    }
    @Test fun `identity change during quote request or funding check cannot persist or hand off money`() = runBlocking {
        val f = Fixture(); val r = f.repository(); r.open()
        val original = f.api.postHandlers.getValue("/deposits")
        f.api.onPost("/deposits") { b -> original(b).also { f.holder.replace(null) } }
        try { r.create("17") } catch (_: CancellationException) {}
        assertNull(f.store.read())
        val g = Fixture(); val ready = g.ready(); g.beforePrepare = { g.holder.replace(null) }
        try { ready.pay(g.sender { fail("No old account send") }) } catch (_: CancellationException) {}
        assertFalse(g.store.read()!!.attempted)
    }
    @Test fun `concurrent taps cannot create or sign two transfers`() = runBlocking {
        val f = Fixture(); val r = f.ready(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var sends = 0
        val first = launch { r.pay(f.sender { sends++; started.complete(Unit); release.await() }) }
        started.await(); r.pay(f.sender { sends++ }); r.create("19"); release.complete(Unit); first.join()
        assertEquals(1, sends); assertEquals(1, f.creates)
    }
    @Test fun `lost quote response creates no payment marker and next explicit review never opens wallet automatically`() = runBlocking {
        val f = Fixture(); val r = f.repository(); r.open(); val original = f.api.postHandlers.getValue("/deposits")
        f.api.onPost("/deposits") { b -> original(b); throw IOException("lost quote") }
        r.create("17"); assertNull(f.store.read()); assertEquals(0, f.prepared)
        f.api.onPost("/deposits", original); r.create("17"); assertEquals(2, f.creates); assertFalse(f.store.read()!!.attempted)
    }
    @Test fun `mint decimal or account mismatch refuses quote and amount bounds consume canonical catalogue`() = runBlocking {
        val f = Fixture(); assertEquals("17", f.limits.amount(" 0,017 "))
        for (amount in listOf("0", "-1", "1.5", "1000000001")) assertThrows(IllegalArgumentException::class.java) { f.limits.amount(amount) }
        val r = f.repository(); r.open(); val original = f.api.postHandlers.getValue("/deposits")
        for ((key, wrong) in listOf("mint" to DEPOSIT_DEST, "decimals" to "8", "source" to DEPOSIT_DEST)) {
            f.api.onPost("/deposits") { b -> JsonObject(original(b) + (key to JsonPrimitive(wrong))) }
            r.create("17"); assertNull(f.store.read()); assertNotNull(r.state.value.error)
        }
        assertNull(KeepDepositBounds.from(json("{}")))
    }
    @Test fun `credited proof survives offline hydration restart and unavailable verification until balance refresh succeeds`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.hydrationOffline = true
        r.pay(f.sender { f.row = f.row("credited", DEPOSIT_SIGNATURE, f.q.baseUnits.toString()) })
        assertEquals("credited", f.store.read()!!.receipt!!.status); assertFalse(r.state.value.hydrated); assertTrue(r.state.value.error!!.startsWith("Your deposit is confirmed"))
        r.close(); assertNotNull(f.store.read())
        f.api.onGet("/deposits/$DEPOSIT_ID") { error("Saved immutable credit needs no new GET proof") }
        f.api.onPost("/deposits/$DEPOSIT_ID/verify") { error("Saved immutable credit needs no new verification proof") }
        val restored = f.repository(); restored.open(); restored.close()
        assertNotNull(f.store.read()); assertFalse(restored.state.value.hydrated)
        f.hydrationOffline = false; restored.check(); assertTrue(restored.state.value.hydrated)
        restored.close(); assertNull(f.store.read()); assertEquals(1, f.creates); assertEquals(1, f.prepared)
    }
    @Test fun `elapsed age including device deep sleep cannot renew from pending GET or across process restore`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.now = f.limits.quoteWindowMs
        r.pay(f.sender { fail("Expired quote cannot sign") }); assertFalse(f.store.read()!!.attempted)
        val g = Fixture(); g.ready(); val restored = g.repository(); restored.open()
        assertFalse(restored.state.value.canPay)
        restored.pay(g.sender { fail("Previous process has no trustworthy monotonic quote window") })
        assertFalse(g.store.read()!!.attempted)
        restored.close(); restored.create("17"); assertTrue(restored.state.value.canPay)
    }
    @Test fun `funding check crossing handoff deadline leaves unpaid quote without wallet request`() = runBlocking {
        val f = Fixture(); val r = f.ready(); f.beforePrepare = { f.now = f.limits.quoteWindowMs }
        r.pay(f.sender { fail("Funding lookup used up the quote window") })
        assertFalse(f.store.read()!!.attempted); assertEquals(1, f.prepared)
    }

    @Test fun `shared supply decimals and payment reuse margin control native deposit bounds`() {
        val bounds = KeepDepositBounds.from(json("""{"constants":{"TOKEN":{"totalSupply":500,"decimals":6},"LAND_CHECKOUT_RECOVERY":{"pollMs":3000,"requestTimeoutMs":10000},"ECONOMY":{"depositPendingTtlMin":60,"depositReuseMinRemainingMin":20}}}"""))!!
        assertEquals(BigInteger.valueOf(500), bounds.maximum); assertEquals(6, bounds.decimals)
        assertEquals(2400000L, bounds.quoteWindowMs); assertEquals(3000L, bounds.pollMs)
        assertThrows(IllegalArgumentException::class.java) { bounds.amount("501") }
    }

}
