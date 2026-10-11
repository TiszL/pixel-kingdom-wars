package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import gg.pixelkingdomwars.nativeclient.wallet.WalletPaymentException
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BasePurchaseRepositoryTest {
    @Test fun `canonical builder expansion and Mine consent persist before quote then attempt before wallet`() = runBlocking {
        for (kind in listOf("builder", "expansion", "mine")) {
            val f = PaidFixture(); val r = f.ready(kind); val saved = requireNotNull(f.store.read())
            assertEquals(paidOffer(kind), saved.offer)
            assertEquals(saved.request.raw, f.posts.single().second)
            assertEquals(saved.request, saved.purchase?.quote?.request)
            r.pay(f.sender())
            assertTrue(requireNotNull(f.store.read()).attempted)
            assertEquals(PAID_SIGNATURE, f.store.read()?.signature)
            assertEquals(listOf("${BasePurchaseRepository.PATH}/quote", "/deposits/$PAID_DEPOSIT/paid", "/deposits/$PAID_DEPOSIT/verify"), f.posts.map { it.first })
            assertEquals(1, f.prepared)
        }
    }

    @Test fun `lost quote reply restores exact key using GET only even after all original land is lost`() = runBlocking {
        val f = PaidFixture(); f.quoteReplyLost = true; f.ready()
        val draft = requireNotNull(f.store.read()); assertNull(draft.purchase)
        f.base = null; f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = emptyList())
        f.gets.clear(); val restored = f.repository(); restored.open(); restored.check(); restored.dismiss()
        assertEquals(draft.request, f.store.read()?.request)
        assertEquals(draft.offer, f.store.read()?.offer)
        assertNotNull(f.store.read()?.purchase)
        assertEquals(1, f.posts.size); assertEquals(0, f.prepared)
        assertTrue(f.gets.all { it.first == "${BasePurchaseRepository.PATH}/${draft.request.key}" && it.second.isEmpty() })
    }

    @Test fun `explicit quote retry preserves request body while null unsupported and malformed reads cannot replace it`() = runBlocking {
        val f = PaidFixture(); f.quoteReplyLost = true; f.quoteNotAccepted = true; val r = f.ready()
        val draft = requireNotNull(f.store.read())
        r.check(); r.finish(); assertEquals(draft, f.store.read())
        f.supported = false; r.check(); r.retryQuote(); assertEquals(1, f.posts.size)
        f.supported = true; f.getChange = { JsonObject(it + ("version" to JsonPrimitive(2))) }
        r.check(); r.retryQuote(); assertEquals(draft, f.store.read()); assertEquals(1, f.posts.size)
        f.getChange = { it }; f.quoteReplyLost = false; f.quoteNotAccepted = false
        r.retryQuote()
        assertEquals(2, f.posts.size); assertEquals(f.posts.first().second, f.posts.last().second)
        assertEquals(draft.request, f.store.read()?.purchase?.quote?.request)
    }

    @Test fun `quote request timeout preserves durable consent for GET recovery without automatic retry`() = runBlocking {
        val f = PaidFixture(); f.afterQuote = { throw java.net.SocketTimeoutException("transport request timed out") }
        // Transport timeouts are ordinary I/O failures; they do not prove the server refused the quote.
        val r = f.ready(); val original = requireNotNull(f.store.read())
        assertNull(original.purchase); assertEquals(1, f.posts.size)
        r.open(); r.check(); assertEquals(original.request, f.store.read()?.request); assertEquals(1, f.posts.size)
    }

    @Test fun `corrupt storage blocks review quote preparation and wallet approval without erasing evidence`() = runBlocking {
        val f = PaidFixture(); f.disk.value = "not encrypted purchase JSON"; val r = f.repository()
        r.open(); r.review("builder", BASE_ID); r.retryQuote(); r.pay(f.sender { fail("Corrupt journal must not send") })
        assertEquals("not encrypted purchase JSON", f.disk.value); assertFalse(r.state.value.loaded)
        assertTrue(f.posts.isEmpty()); assertEquals(0, f.prepared)
    }

    @Test fun `changed server amount or reviewed rail leaves original draft with no wallet handoff`() = runBlocking {
        for (change in listOf<(BasePurchaseQuote) -> BasePurchaseQuote>(
            { q -> BasePurchaseQuote.from(JsonObject(q.raw + ("amountLamports" to JsonPrimitive("1")))) },
            { q -> BasePurchaseQuote.from(JsonObject(q.raw + ("rail" to JsonObject(q.rail.raw + ("treasuryDev" to JsonPrimitive(PAID_REFERENCE)))))) }
        )) {
            val f = PaidFixture(); f.quoteChange = change; val r = f.ready()
            assertNull(f.store.read()?.purchase); assertNotNull(r.state.value.error)
            r.pay(f.sender { fail("Changed consent cannot sign") }); assertEquals(0, f.prepared)
        }
    }

    @Test fun `prebroadcast wallet refusal permits only explicit same quote retry while uncertain outcome never resigns`() = runBlocking {
        val f = PaidFixture(); val r = f.ready(); var sends = 0
        r.pay(BasePurchaseSender { _, _, _ -> sends++; throw WalletPaymentException("unsigned refusal", true) })
        assertFalse(requireNotNull(f.store.read()).attempted)
        r.pay(BasePurchaseSender { _, _, _ -> sends++; throw IOException("wallet outcome unknown") })
        val uncertain = requireNotNull(f.store.read()); assertTrue(uncertain.attempted)
        r.pay(f.sender { sends++ }); r.review("builder", BASE_ID); r.finish()
        assertEquals(2, sends); assertEquals(uncertain.request, f.store.read()?.request); assertEquals(1, f.posts.size)
    }

    /** 0.5.2 read a ktx-wrapped decline as "uncertain" and stranded the purchase as attempted. */
    @Test fun `a decline in the wallet leaves the purchase payable again and says so with its stage and code`() = runBlocking {
        val f = PaidFixture(); val r = f.ready()
        r.pay(BasePurchaseSender { _, _, _ -> throw declinedInWallet() })
        assertFalse(requireNotNull(f.store.read()).attempted); assertNull(f.store.read()!!.signature)
        assertEquals("Payment was not sent — the request was declined in the wallet. The original quote is kept for explicit approval within its payment window. [send:-3]", r.state.value.error)
    }

    @Test fun `known signature after lost broadcast survives restart and explicit verification never opens a second wallet`() = runBlocking {
        val f = PaidFixture(); val r = f.ready()
        r.pay(BasePurchaseSender { _, _, record -> record(PAID_SIGNATURE); throw IOException("RPC reply lost") })
        val original = requireNotNull(f.store.read()); val count = f.posts.size
        val restored = f.repository(); restored.open(); restored.check()
        assertEquals(count, f.posts.size); assertEquals(original, f.store.read())
        restored.pay(f.sender { fail("Known signature cannot be signed again") }); restored.reconcile()
        assertEquals(listOf("/deposits/$PAID_DEPOSIT/paid", "/deposits/$PAID_DEPOSIT/verify"), f.posts.drop(count).map { it.first })
        assertEquals(PAID_SIGNATURE, f.posts[count].second.string("signature")); assertEquals(1, f.prepared)
    }

    @Test fun `process death after attempted handoff preserves uncertainty and restart performs GET only`() = runBlocking {
        val f = PaidFixture(); val r = f.ready()
        try { r.pay(BasePurchaseSender { _, _, _ -> throw CancellationException("process died") }) } catch (_: CancellationException) {}
        val original = requireNotNull(f.store.read()); assertTrue(original.attempted); assertNull(original.signature)
        val restored = f.repository(); restored.open(); restored.pay(f.sender { fail("Never re-sign interrupted handoff") })
        assertEquals(original, f.store.read()); assertEquals(1, f.posts.size); assertEquals(1, f.prepared)
    }

    @Test fun `unpaid pending cannot Finish and explicit original expiration verification is distinct from GET observation`() = runBlocking {
        val f = PaidFixture(); val r = f.ready(); val q = requireNotNull(f.store.read()?.purchase).quote
        r.finish(); assertEquals(q, f.store.read()?.purchase?.quote)
        f.now = 660_000L; f.serverNow = q.retryAt
        r.check(); r.finish(); assertEquals("pending", f.store.read()?.purchase?.status); assertEquals(1, f.posts.size)
        f.onVerify = { f.row = paidState(q, "expired") }
        r.reconcile()
        assertEquals(listOf("${BasePurchaseRepository.PATH}/quote", "/deposits/$PAID_DEPOSIT/verify"), f.posts.map { it.first })
        assertEquals("expired", f.store.read()?.purchase?.status); assertFalse(requireNotNull(f.store.read()).attempted)
        r.finish(); assertNull(f.store.read()); assertEquals(0, f.prepared)
    }

    /** Rewritten 2026-09-18 ("4b"): this test pinned "server expiry OR failure never clears an attempted payment".
     * What it protected is kept — a terminal status is not a refund, Finish never closes it, no second wallet opens,
     * and `failed` (funds the server RECEIVED) stays for support for ever. What changed: an attempted `expired`
     * purchase with no signature no longer blocks every base purchase; once the transport margin has passed it
     * retires by itself, because the server's unpaid verdict plus an expired blockhash prove nothing was charged. */
    @Test fun `server failure never clears an attempted payment, and expiry clears it only after the margin`() = runBlocking {
        for (status in listOf("expired", "failed")) {
            val f = PaidFixture(); val r = f.ready()
            r.pay(BasePurchaseSender { _, _, _ -> throw IOException("unknown send") })
            assertEquals(f.wall, f.store.read()?.attemptedAtMs)
            f.row = paidState(requireNotNull(f.row).quote, status)
            r.check(); r.finish(); r.pay(f.sender { fail("Terminal status is not a refund") })
            assertEquals(status, f.store.read()?.purchase?.status); assertTrue(requireNotNull(f.store.read()).attempted)
            assertEquals(1, f.prepared); assertEquals(1, f.posts.size); assertNull(r.state.value.notice)
            f.wall += UnpaidAttempt.MARGIN_MS - 1; r.check(); assertNotNull("One millisecond before the margin", f.store.read())
            f.wall += 1; r.check()
            if (status == "failed") {
                assertEquals("Funds received: support, never retired", "failed", f.store.read()?.purchase?.status); assertNull(r.state.value.notice)
                assertEquals("Not an unpaid end at all: the cluster is never even asked", 0, f.landings)
            } else {
                assertNull(f.store.read()); assertNull(r.state.value.saved); assertEquals(UnpaidAttempt.notice(null), r.state.value.notice)
                assertEquals("Observation only: never /paid or /verify", 1, f.posts.size); assertEquals(0, f.landings)
                // The rail accepts a new purchase at once, and the new quote clears the notice.
                r.review("builder", BASE_ID); r.create(requireNotNull(r.state.value.review))
                assertEquals("pending", f.store.read()?.purchase?.status); assertFalse(requireNotNull(f.store.read()).attempted); assertNull(r.state.value.notice)
            }
        }
    }

    @Test fun `a pending quote never retires however old, and a credited receipt arriving instead is adopted normally`() = runBlocking {
        val f = PaidFixture(); val r = f.ready()
        r.pay(BasePurchaseSender { _, _, _ -> throw IOException("wallet timed out") })
        f.wall += 10 * UnpaidAttempt.MARGIN_MS; r.check(); r.reconcile()
        assertEquals("pending", f.store.read()?.purchase?.status); assertTrue(requireNotNull(f.store.read()).attempted); assertNull(r.state.value.notice)
        // The wallet DID send although this app never heard back: the server credits by reference, and that wins.
        f.row = paidState(requireNotNull(f.row).quote, "credited", PAID_SIGNATURE); r.check()
        assertEquals("credited", f.store.read()?.purchase?.status); assertTrue(r.state.value.hydrated); assertNull(r.state.value.notice)
        r.finish(); assertNull(f.store.read())
    }

    /** The sign-only fallback saved a signature and the relay refused it (or timed out): only the cluster can clear it. */
    @Test fun `a recorded signature retires only on the cluster's own proof and fails closed without it`() = runBlocking {
        suspend fun stranded(): Pair<PaidFixture, BasePurchaseRepository> {
            val f = PaidFixture(); val r = f.ready()
            r.pay(BasePurchaseSender { _, _, record -> record(PAID_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            assertEquals(PAID_SIGNATURE, f.store.read()?.signature)
            f.row = paidState(requireNotNull(f.row).quote, "expired"); f.wall += UnpaidAttempt.MARGIN_MS
            return f to r
        }
        stranded().let { (f, r) ->
            f.landing = { SignatureLanding.NOT_FOUND }; val posts = f.posts.size; r.reconcile()
            assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(SignatureLanding.NOT_FOUND), r.state.value.notice); assertEquals(1, f.landings)
            assertEquals("The first reconcile learns the expiry through the existing /paid + /verify", posts + 2, f.posts.size)
        }
        stranded().let { (f, r) ->
            // It landed and succeeded: money moved, the existing support path keeps it and no second purchase starts.
            f.landing = { SignatureLanding.PRESENT }; r.check()
            assertEquals(PAID_SIGNATURE, f.store.read()?.signature); assertTrue(r.state.value.paymentFound); assertNull(r.state.value.notice)
            val posts = f.posts.size; r.reconcile(); assertEquals("An ended quote is never /paid or /verified again", posts, f.posts.size)
            r.review("builder", BASE_ID); assertNull(r.state.value.review)
        }
        stranded().let { (f, r) ->
            // Finalized WITH an error: atomic, nothing was transferred, and it can never run again. Only the fee was spent.
            f.landing = { SignatureLanding.FAILED_FINALIZED }; r.check()
            assertNull(f.store.read()); assertTrue(requireNotNull(r.state.value.notice).contains("NETWORK FEE"))
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
    @Test fun `a wallet step that ended late keeps the purchase until the margin has passed since that end`() = runBlocking {
        val f = PaidFixture(); val r = f.ready(); val began = f.wall
        r.pay(BasePurchaseSender { _, _, _ -> f.wall += 210_000L; throw WalletPaymentException("Wallet did not answer in time.", false) })
        assertEquals(began, f.store.read()?.attemptedAtMs); assertEquals(began + 210_000L, f.store.read()?.walletEndedAtMs); assertEquals(500L, f.store.read()?.lastValidBlockHeight)
        f.row = paidState(requireNotNull(f.row).quote, "expired")
        f.wall = began + UnpaidAttempt.MARGIN_MS; r.check(); assertNotNull("Past the margin from the START only", f.store.read())
        f.wall = began + 210_000L + UnpaidAttempt.MARGIN_MS - 1; r.check(); assertNotNull(f.store.read())
        f.wall += 1; r.check(); assertNull(f.store.read())
        val notice = requireNotNull(r.state.value.notice); assertFalse(notice, notice.contains("NOTHING WAS CHARGED")); assertTrue(notice, notice.contains("SUPPORT"))
    }

    /** A lagging or pruned RPC node answers null for a transaction that landed: a null that is not proven final never
     * retires, and one saved without the height that could prove it goes to support. */
    @Test fun `a null signature status that is not proven final never retires the purchase`() = runBlocking {
        suspend fun stranded(lastValid: Long?): Pair<PaidFixture, BasePurchaseRepository> {
            val f = PaidFixture(); f.lastValid = lastValid; val r = f.ready()
            r.pay(BasePurchaseSender { _, _, record -> record(PAID_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            assertEquals(lastValid, f.store.read()?.lastValidBlockHeight)
            f.row = paidState(requireNotNull(f.row).quote, "expired"); f.wall += UnpaidAttempt.MARGIN_MS
            return f to r
        }
        stranded(500L).let { (f, r) ->
            f.landing = { SignatureLanding.UNPROVEN }; r.check()
            assertEquals(PAID_SIGNATURE, f.store.read()?.signature); assertFalse(r.state.value.paymentFound); assertNull(r.state.value.notice)
            f.landing = { SignatureLanding.NOT_FOUND }; r.check(); assertNull("Proven final on a later check", f.store.read())
        }
        for (verdict in listOf(SignatureLanding.UNPROVEN, SignatureLanding.NOT_FOUND)) stranded(null).let { (f, r) ->
            f.landing = { verdict }; r.check()
            assertEquals(PAID_SIGNATURE, f.store.read()?.signature); assertTrue(r.state.value.paymentFound); assertNull(r.state.value.notice)
        }
    }

    /** The verdict is awaited over the network. A session replaced meanwhile must find its saved purchase untouched:
     * the session is checked after the verdict returns and before the store is cleared. */
    @Test fun `a session replaced while the cluster verdict is in flight never clears the saved purchase`() = runBlocking {
        for (fails in listOf(false, true)) {
            val f = PaidFixture(); val r = f.ready()
            r.pay(BasePurchaseSender { _, _, record -> record(PAID_SIGNATURE); throw WalletPaymentException("Payment broadcast outcome is uncertain.", false) })
            f.row = paidState(requireNotNull(f.row).quote, "expired"); f.wall += UnpaidAttempt.MARGIN_MS
            f.landing = { f.holder.replace(null); if (fails) throw IOException("relay unavailable"); SignatureLanding.NOT_FOUND }
            try { r.check() } catch (_: CancellationException) {} catch (_: IllegalStateException) {}
            assertEquals(1, f.landings); assertEquals("The purchase of the replaced session stays saved", PAID_SIGNATURE, f.store.read()?.signature)
        }
    }

    @Test fun `base content or Back changing during funding check prevents handoff and retains original quote`() = runBlocking {
        for (change in listOf<(PaidFixture, BasePurchaseRepository) -> Unit>(
            { f, _ -> f.base = PAID_OTHER }, { f, _ -> f.catalogue = json("{}") }, { _, r -> r.dismiss() }, { f, _ -> f.allowed = false }
        )) {
            val f = PaidFixture(); val r = f.ready(); val original = requireNotNull(f.store.read())
            f.beforePrepare = { change(f, r) }
            r.pay(f.sender { fail("Changed review cannot hand off") })
            assertEquals(original, f.store.read()); assertEquals(1, f.posts.size)
        }
    }

    @Test fun `identity supersession after quote acceptance retains draft and during preparation never reaches wallet`() = runBlocking {
        val f = PaidFixture(); f.afterQuote = { f.holder.replace(null) }; val r = f.repository()
        r.review("builder", BASE_ID)
        try { r.create(requireNotNull(r.state.value.review)) } catch (_: CancellationException) {}
        assertNotNull(f.store.read()); assertNull(f.store.read()?.purchase); assertEquals(1, f.posts.size)
        val g = PaidFixture(); val ready = g.ready(); g.beforePrepare = { g.holder.replace(null) }
        try { ready.pay(g.sender { fail("Old account cannot pay") }) } catch (_: CancellationException) {}
        assertFalse(requireNotNull(g.store.read()).attempted)
    }

    @Test fun `elapsed quote deadline cannot renew from stale server time or slow preparation`() = runBlocking {
        val f = PaidFixture(); val r = f.ready(); f.now = 600_000
        r.check(); r.pay(f.sender { fail("Old server timestamp cannot renew old quote") })
        assertFalse(requireNotNull(f.store.read()).attempted); assertEquals(0, f.prepared)
        val g = PaidFixture(); val ready = g.ready(); g.beforePrepare = { g.now = 600_000 }
        ready.pay(g.sender { fail("Preparation crossed the deadline") }); assertFalse(requireNotNull(g.store.read()).attempted)
    }

    @Test fun `accepted immutable receipt survives failed original hydration and refresh never substitutes selected other deed`() = runBlocking {
        val f = PaidFixture(); val r = f.ready("mine"); f.onHydrate = { throw IOException("original Home unavailable") }
        r.pay(f.sender { f.row = paidState(requireNotNull(f.row).quote, "credited", PAID_SIGNATURE) })
        assertEquals("credited", f.store.read()?.purchase?.status); assertFalse(r.state.value.hydrated)
        r.finish(); assertNotNull(f.store.read())
        f.base = PAID_OTHER; f.gets.clear(); f.onHydrate = {}; val restored = f.repository(); restored.open()
        assertTrue(restored.state.value.hydrated)
        assertTrue(f.gets.filter { it.first in setOf("/base", "/balances", "/tutorial") }.all { it.second["baseId"] == BASE_ID })
        assertEquals(1, f.hydrated); restored.finish(); assertNull(f.store.read())
    }

    @Test fun `accepted improvement after original deed loss finishes only after refreshed directory establishes unavailability`() = runBlocking {
        val f = PaidFixture(); val r = f.ready(); val q = requireNotNull(f.row).quote
        f.row = paidState(q, "credited", PAID_SIGNATURE); f.base = PAID_OTHER
        f.directory = requireNotNull(f.directory).copy(bases = requireNotNull(f.directory).bases.filter { it.id != BASE_ID })
        f.gets.clear(); r.check()
        assertTrue(r.state.value.hydrated); assertNotNull(r.state.value.unavailable)
        assertTrue(f.gets.none { it.first in setOf("/base", "/balances") }); assertEquals(0, f.hydrated)
        r.finish(); assertNull(f.store.read())
    }

    @Test fun `concurrent pay taps cannot prepare sign or broadcast two transfers`() = runBlocking {
        val f = PaidFixture(); val r = f.ready(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var sends = 0
        val first = launch { r.pay(f.sender { sends++; started.complete(Unit); release.await() }) }
        started.await(); r.pay(f.sender { sends++ }); release.complete(Unit); first.join()
        assertEquals(1, sends); assertEquals(1, f.prepared)
        assertEquals(1, f.posts.count { it.first == "/deposits/$PAID_DEPOSIT/paid" })
    }

}
