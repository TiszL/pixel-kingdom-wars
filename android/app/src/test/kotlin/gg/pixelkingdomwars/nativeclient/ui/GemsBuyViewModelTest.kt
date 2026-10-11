package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.economy.GemsBuyViewModel
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GemsBuyViewModelTest {
    private val models = mutableListOf<GemsBuyViewModel>()
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { models.forEach { it.viewModelScope.cancel() }; Dispatchers.resetMain() }

    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val store = GemsBuyStore(MemoryStore(), session.wallet, session.origin, "devnet")
        val key = "native-gems-viewmodel-1"
        val quote = GemsBuyIntent(DEPOSIT_ID, "gems_buy", session.wallet, key, DEPOSIT_REFERENCE, DEPOSIT_SOURCE,
            DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, 17, 17, "2026-09-21T12:30:00Z")
        val limits = KeepDepositBounds(BigInteger("1000000000"), 9, 2500, 15000, 1200000)
        var deposit: GemsBuyDeposit? = null
        var creates = 0; var prepared = 0; var estimated = 0; var prompts = 0; var refreshed = 0
        var fee = BigInteger.valueOf(5000); var now = 0L
        var beforeCreate: suspend () -> Unit = {}; var beforeEstimate: suspend () -> Unit = {}
        private fun payment() = PreparedKeepDeposit(byteArrayOf(1, 2, 3), fee, 500)
        val repository = GemsBuyRepository(session, holder, api, store, SolanaCluster.DEVNET, { quote.mint }, { limits },
            { q -> assertEquals(quote, q); prepared++; payment() }, {}, { now }, { 300_000L }, { 1_000_000L }, { key })
        val model = GemsBuyViewModel(repository,
            { q -> assertEquals(quote, q); estimated++; beforeEstimate(); payment() }, { refreshed++ }).also { models += it }
        init {
            api.onGet("/native/capabilities") {
                json("""{"protocolVersion":1,"simVersion":17,"economy":{"gems":{"enabled":true,"sources":["wallet-keep"],"destinationAta":"$DEPOSIT_DEST","gemsPerKeep":1,"shardsPerGem":3,"minConvertKeep":1,"maxConvertKeepPerTx":1000}}}""")
            }
            api.onGet("/gems/buy/by-key/$key") {
                Json.encodeToJsonElement(GemsBuyRecovery.serializer(), GemsBuyRecovery(1, session.wallet, key, true,
                    "2026-09-21T12:00:00Z", if (deposit == null) "unknown" else "known", deposit, 1)).jsonObject
            }
            api.onPost("/deposits") { body ->
                creates++; assertEquals(key, store.read()!!.draft.idempotencyKey)
                assertEquals(key, body.string("idempotencyKey")); assertEquals("17", body.string("keepIn"))
                beforeCreate()
                deposit = GemsBuyDeposit(quote, "pending", null, null, null, "2026-09-21T12:00:00Z",
                    null, 17, 17, null, null, null, null)
                JsonObject(Json.encodeToJsonElement(GemsBuyIntent.serializer(), quote).jsonObject + mapOf(
                    "status" to JsonPrimitive("pending"), "serverNow" to JsonPrimitive("2026-09-21T12:00:00Z")))
            }
            api.onPost("/deposits/$DEPOSIT_ID/paid") { json("""{"committed":true}""") }
            api.onPost("/deposits/$DEPOSIT_ID/verify") { json("""{"status":"pending"}""") }
        }
        suspend fun reviewed() = model.also { it.foreground(); it.review("17")?.join() }
        fun sender(action: suspend ((String, Boolean) -> Unit) -> Unit = { it(DEPOSIT_SIGNATURE, true) }) =
            GemsBuySender { _, q, record ->
                prompts++; assertEquals(quote, q); assertTrue(store.read()!!.attempted)
                action(record); DEPOSIT_SIGNATURE
            }
    }

    @Test fun `foreground only reads and explicit review freezes consent without opening a wallet`() = runTest {
        val f = Fixture(); f.model.foreground()
        assertTrue(f.api.posts.isEmpty()); assertNull(f.store.read()); assertEquals(1, f.refreshed)
        f.model.review("17")?.join()
        assertEquals(1, f.creates); assertEquals(1, f.estimated); assertEquals(0, f.prepared); assertEquals(0, f.prompts)
        assertEquals(f.quote, f.model.review.value!!.quote); assertEquals("5000", f.model.review.value!!.feeLamports)
        assertTrue(f.model.state.value.canPay); assertFalse(f.store.read()!!.attempted)
    }

    @Test fun `explicit pay opens one wallet and a second tap cannot duplicate the pending approval`() = runTest {
        val f = Fixture(); val model = f.reviewed(); val review = requireNotNull(model.review.value)
        val entered = CompletableDeferred<Unit>(); val returned = CompletableDeferred<Unit>()
        val sender = f.sender { record -> entered.complete(Unit); returned.await(); record(DEPOSIT_SIGNATURE, true) }
        val payment = requireNotNull(model.pay(review, sender))
        entered.await()
        assertTrue(model.paying.value); assertEquals(1, f.prompts)
        assertNull("A second tap must not queue another wallet prompt", model.pay(review, sender))
        returned.complete(Unit); payment.join()
        assertEquals(1, f.prompts); assertEquals(1, f.creates); assertEquals(1, f.prepared)
        assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature)
        assertFalse(model.paying.value); assertNull(model.review.value)
        assertFalse("Wallet success alone is not a proved Gems credit", model.state.value.hydrated)
    }

    @Test fun `external wallet background retains in flight consent and a late signature survives logout`() = runTest {
        val f = Fixture(); val model = f.reviewed(); val review = requireNotNull(model.review.value)
        val entered = CompletableDeferred<Unit>(); val returned = CompletableDeferred<Unit>()
        val payment = requireNotNull(model.pay(review, f.sender { record ->
            entered.complete(Unit); returned.await(); record(DEPOSIT_SIGNATURE, false)
        }))
        entered.await()
        assertTrue(model.paying.value); model.background()
        f.repository.requirePaymentWindow(f.quote)
        assertSame("Opening the external wallet must preserve the approved review", review, model.review.value)
        f.holder.replace(null); returned.complete(Unit); payment.join()
        assertEquals(DEPOSIT_SIGNATURE, f.store.read()!!.signature)
        assertFalse(f.store.read()!!.signatureUsesPreparedHeight)
        assertFalse(model.paying.value)
        assertEquals("Logout suppresses reconciliation, never signature persistence", listOf("/deposits"), f.api.posts.map { it.first })
    }

    @Test fun `uncertain wallet result stays recoverable across lifecycle reads without reposting or signing again`() = runTest {
        val f = Fixture(); val model = f.reviewed(); val review = requireNotNull(model.review.value)
        val sender = f.sender { throw IOException("wallet outcome unknown") }
        model.pay(review, sender)?.join()
        assertTrue(f.store.read()!!.attempted); assertNull(f.store.read()!!.signature)
        val posts = f.api.posts.toList()
        repeat(2) { model.background(); model.foreground() }
        model.pay(review, sender)?.join()
        assertEquals(posts, f.api.posts); assertEquals(1, f.prompts); assertEquals(1, f.creates)
        assertTrue(f.store.read()!!.attempted); assertEquals(f.key, f.store.read()!!.draft.idempotencyKey)
    }

    @Test fun `changed network fee refuses wallet handoff and leaves the original intent available for fresh review`() = runTest {
        val f = Fixture(); val model = f.reviewed(); val review = requireNotNull(model.review.value)
        f.fee = BigInteger.valueOf(6000)
        model.pay(review, f.sender())?.join()
        assertEquals(0, f.prompts); assertFalse(f.store.read()!!.attempted); assertNull(f.store.read()!!.signature)
        assertEquals(f.key, f.store.read()!!.draft.idempotencyKey)
        assertTrue(model.notice.value!!.message.contains("network fee changed"))
        model.reviewSaved()?.join()
        assertEquals(f.quote, model.review.value!!.quote); assertEquals("6000", model.review.value!!.feeLamports)
        assertTrue(model.state.value.canPay); assertEquals(0, f.prompts)
        assertEquals(listOf(f.key, f.key), f.api.posts.filter { it.first == "/deposits" }.map { it.second.string("idempotencyKey") })
    }

    @Test fun `double tap during quote creation admits one intent and one explicit review`() = runTest {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val response = CompletableDeferred<Unit>()
        f.beforeCreate = { entered.complete(Unit); response.await() }
        val first = requireNotNull(f.model.review("17"))
        entered.await()
        assertEquals(1, f.creates)
        assertNull(f.model.review("17"))
        response.complete(Unit); first.join()
        assertEquals(1, f.creates); assertEquals(1, f.estimated); assertEquals(0, f.prompts)
        assertEquals(f.key, f.store.read()!!.draft.idempotencyKey)
    }

    @Test fun `hidden or replaced review cannot authorize a wallet even after returning to the screen`() = runTest {
        val f = Fixture(); val model = f.reviewed(); val oldReview = requireNotNull(model.review.value)
        model.background(); model.pay(oldReview, f.sender())?.join()
        assertNull(model.review.value); assertFalse(model.state.value.canPay)
        model.foreground(); model.pay(oldReview, f.sender())?.join()
        assertEquals(0, f.prompts); assertEquals(1, f.creates)
        model.reviewSaved()?.join(); assertNotSame(oldReview, model.review.value)
        model.pay(oldReview, f.sender())?.join()
        assertEquals(0, f.prompts); assertFalse(f.store.read()!!.attempted)
    }

    @Test fun `estimate finishing after screen background cannot revive a hidden consent`() = runTest {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val estimate = CompletableDeferred<Unit>()
        f.beforeEstimate = { entered.complete(Unit); estimate.await() }
        val reviewing = requireNotNull(f.model.review("17"))
        entered.await()
        assertEquals(1, f.estimated); f.model.background(); estimate.complete(Unit); reviewing.join()
        assertNull(f.model.review.value); assertFalse(f.model.state.value.canPay)
        assertEquals(0, f.prompts); assertFalse(f.store.read()!!.attempted)
        assertEquals(f.key, f.store.read()!!.draft.idempotencyKey)
    }
}
