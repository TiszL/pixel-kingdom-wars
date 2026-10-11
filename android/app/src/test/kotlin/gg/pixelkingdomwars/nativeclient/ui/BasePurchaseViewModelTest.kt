package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseViewModel
import gg.pixelkingdomwars.nativeclient.wallet.WalletFailureKind
import gg.pixelkingdomwars.nativeclient.wallet.WalletFailureReason
import gg.pixelkingdomwars.nativeclient.wallet.WalletPaymentException
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BasePurchaseViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val store = BasePurchaseStore(MemoryStore(), WALLET, session.origin, "devnet")
        var selected: String? = BASE_ID
        var directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1)))
        val catalogue = json("""{"constants":{"LAND_CHECKOUT_RECOVERY":{"requestTimeoutMs":15000},"CAPS":{"buildersMax":2,"builderPricesSol":[0.000000071]}}}""")
        val gets = mutableListOf<String>(); val posts = mutableListOf<Pair<String, JsonObject>>()
        val api = object : ApiClient {
            override suspend fun get(path: String, query: Map<String, String>): JsonObject {
                gets += path
                return when {
                    path.startsWith("${BasePurchaseRepository.PATH}/") -> buildJsonObject {
                        put("version", 1); put("wallet", WALLET); put("idempotencyKey", path.substringAfterLast('/'))
                        put("enabled", true); put("serverNow", "2026-09-13T00:00:00.000Z"); put("purchase", JsonNull)
                    }
                    path == "/base" -> baseJson(requireNotNull(query["baseId"]))
                    path == "/balances" -> balancesJson()
                    path == "/tutorial" -> tutorialJson()
                    else -> error("Unexpected GET $path")
                }
            }
            override suspend fun post(path: String, body: JsonObject): JsonObject {
                posts += path to body
                assertEquals(store.read()?.request?.raw, body)
                throw IOException("Quote response lost")
            }
            override suspend fun put(path: String, body: JsonObject): JsonObject = error("Unexpected PUT")
            override suspend fun delete(path: String): JsonObject = error("Unexpected DELETE")
        }
        fun model() = BasePurchaseViewModel(BasePurchaseRepository(session, holder, api, store, SolanaCluster.DEVNET,
            { selected }, { directory }, { catalogue }, { true }, {}, {},
            { error("Lifecycle or review must never prepare wallet payment") }, { 0L }))
    }

    /** Mount = the screen's RESUMED block: it runs until the screen leaves, so a test mounts, lets it settle, and leaves. */
    private suspend fun TestScope.mount(model: BasePurchaseViewModel, kind: String = "", baseId: String = "", buildingId: String? = null) {
        val job = launch { model.foreground(kind, baseId, buildingId) }; runCurrent(); job.cancelAndJoin()
    }
    private fun neverPays() = BasePurchaseSender { _, _, _ -> error("No wallet may open here") }

    /** Rewritten 2026-09-18: mount now reviews the requested offer by itself (the REVIEW PURCHASE tap is gone). The rule
     * it protects is unchanged: reviewing is GET-only, and mount, review and Back never persist or POST anything. */
    @Test fun `mount auto-review and Back before paying never persist or submit a purchase`() = runTest {
        val f = Fixture(); val model = f.model()
        mount(model, "builder", BASE_ID)
        assertTrue(model.state.value.loaded)
        assertEquals("The confirm plate shows the catalogue price without a tap", "71", model.state.value.review?.amountLamports)
        model.dismiss()
        mount(model)
        assertNull(model.state.value.review)
        assertNull(f.store.read())
        assertTrue(f.posts.isEmpty())
    }

    /** Rewritten 2026-09-18: PAY is now the single tap that requests the quote (`buy`), where REQUEST PURCHASE QUOTE used
     * to be its own step. Unchanged rule: a lost quote reply is never followed by a wallet prompt or a second POST. */
    @Test fun `lost quote survives Back resume and explicit GET check without a second mutation or a wallet prompt`() = runTest {
        val f = Fixture(); val model = f.model()
        model.review("builder", BASE_ID, null)?.join()
        model.buy(requireNotNull(model.state.value.review), neverPays())?.join()
        val original = requireNotNull(f.store.read())
        assertNull(original.purchase)
        assertEquals(1, f.posts.size)
        model.dismiss(); mount(model, "builder", BASE_ID); model.check()?.join()
        assertEquals(original, f.store.read())
        assertEquals(original, model.state.value.saved)
        assertEquals(1, f.posts.size)
        assertEquals("${BasePurchaseRepository.PATH}/quote", f.posts.single().first)
        assertEquals(original.request.raw, f.posts.single().second)
    }

    @Test fun `cold recovery after losing original deed observes its original key without requiring a new destination`() = runTest {
        val f = Fixture(); val model = f.model()
        model.review("builder", BASE_ID, null)?.join()
        model.buy(requireNotNull(model.state.value.review), neverPays())?.join()
        val original = requireNotNull(f.store.read())
        f.selected = null; f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = emptyList())
        f.gets.clear()
        val restored = f.model(); mount(restored); restored.check()?.join(); restored.dismiss()
        assertEquals(original, restored.state.value.saved)
        assertTrue(f.gets.isNotEmpty())
        assertTrue(f.gets.all { it == "${BasePurchaseRepository.PATH}/${original.request.key}" })
        assertEquals(1, f.posts.size)
        assertEquals(original, f.store.read())
    }

    // ---- the one-tap flow (owner 2026-09-18), against the full paid fixture ----

    private val pollMs = 2_500L
    private fun paid() = PaidFixture().also { f ->
        val constants = f.catalogue.getValue("constants").jsonObject
        f.catalogue = JsonObject(f.catalogue + ("constants" to JsonObject(constants + ("LAND_CHECKOUT_RECOVERY" to json("""{"requestTimeoutMs":15000,"pollMs":$pollMs}""")))))
    }
    private fun PaidFixture.confirms() = posts.count { it.first.endsWith("/verify") || it.first.endsWith("/paid") }
    private fun PaidFixture.quotes() = posts.count { it.first.endsWith("/quote") }

    @Test fun `one gold tap quotes then opens the wallet exactly once, and a credited purchase finishes itself and leaves`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        val screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        val offer = requireNotNull(model.state.value.review); assertTrue(f.posts.isEmpty())
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
        var prompts = 0
        model.buy(offer, f.sender { prompts++ })?.join()
        assertEquals(1, f.quotes()); assertEquals(1, f.prepared); assertEquals(1, prompts)
        assertNull("Credited and hydrated: retired through the store's own guard", f.store.read())
        assertEquals("The screen leaves once", "builder", model.finished.value); assertTrue(f.hydrated > 0)
        assertTrue(Toasts.queue.items.value.any { it.message == "BUILDER HIRED" }); screen.cancelAndJoin()
    }

    @Test fun `a wallet decline returns to a re-payable plate without a stranded purchase, and RETRY reuses the same quote`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        val screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        model.buy(requireNotNull(model.state.value.review), BasePurchaseSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        val declined = requireNotNull(f.store.read())
        assertFalse(declined.attempted); assertNull(declined.signature); assertTrue(model.state.value.canPay); assertNotNull(model.state.value.error)
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
        model.retryPay(f.sender())?.join()
        assertEquals("RETRY never asks for a second quote", 1, f.quotes()); assertNull(f.store.read()); assertEquals("builder", model.finished.value)
        screen.cancelAndJoin()
    }

    @Test fun `a purchase that finishes after the player left the screen never closes the next visit`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        var screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        val offer = requireNotNull(model.state.value.review)
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
        // The wallet sheet only pauses the screen (the RESUMED block is cancelled); it is still mounted, so it leaves once.
        screen.cancelAndJoin(); model.buy(offer, f.sender())?.join()
        assertEquals("builder", model.finished.value); model.consumeFinished()
        // Back / dispose unmounts: nothing may be left over for the next visit of this session-scoped model.
        model.dismiss(); assertNull(model.finished.value)
        screen = launch { model.foreground("shield", BASE_ID, null) }; runCurrent()
        assertNull(model.finished.value); assertNotNull("The next purchase opens on its own confirm plate", model.state.value.review); screen.cancelAndJoin()
    }

    @Test fun `an uncertain wallet reply enters auto-checking, never re-prompts, and resumes after leaving and reopening`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository()); var prompts = 0
        val uncertain = BasePurchaseSender { _, _, _ -> prompts++; throw IOException("wallet connection lost") }
        model.review("builder", BASE_ID, null)?.join(); model.buy(requireNotNull(model.state.value.review), uncertain)?.join()
        assertTrue(requireNotNull(f.store.read()).attempted); assertNotNull(model.state.value.error)
        model.retryPay(uncertain)?.join(); assertEquals("No second wallet approval for an attempted payment", 1, prompts)
        assertEquals("Nothing polls while the screen is not resumed", 0, f.confirms())
        var screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent(); assertEquals(0, f.confirms())
        advanceTimeBy(pollMs); runCurrent(); val first = f.confirms(); assertTrue("It checks by itself", first > 0)
        screen.cancelAndJoin(); advanceTimeBy(pollMs * 4); runCurrent(); assertEquals("Leaving stops the poll", first, f.confirms())
        // Reopen in a new process: the saved attempted payment is all it needs.
        val reopened = BasePurchaseViewModel(f.repository())
        screen = launch { reopened.foreground("builder", BASE_ID, null) }; runCurrent()
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
        advanceTimeBy(pollMs); runCurrent()
        assertTrue(f.confirms() > first); assertNull(f.store.read()); assertEquals("builder", reopened.finished.value)
        assertEquals(1, prompts); assertEquals(1, f.prepared); assertEquals(1, f.quotes()); screen.cancelAndJoin()
    }

    /** Review 2026-09-18 (major): every repository action clears `state.error`, and the new confirm loop acts within
     * one poll, so the uncertain sentence — the only place the wallet's reason is shown, and today's Seeker failure
     * lands exactly here — vanished after 2.5 s behind a positive "CONFIRMING… WE FINISH IT". The PAY tap's sentence now
     * lives in the ViewModel until that purchase changes status. */
    @Test fun `the wallet's failure sentence outlives the confirm polls and leaves only when the purchase changes status`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        val screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        val timeout = WalletPaymentException("no reply", false, reason = WalletFailureReason(WalletFailureKind.TIMEOUT))
        model.buy(requireNotNull(model.state.value.review), BasePurchaseSender { _, _, _ -> throw timeout })?.join()
        val saved = requireNotNull(f.store.read()); assertTrue(saved.attempted); assertNull("Nothing proves a transfer was signed", saved.signature)
        val sentence = requireNotNull(model.payFailure.value)
        assertTrue(sentence.contains("uncertain")); assertTrue("The wallet's own reason stays readable", sentence.contains(WalletFailureKind.TIMEOUT.notice))
        advanceTimeBy(pollMs); runCurrent()
        assertTrue("The confirm loop ran", f.confirms() > 0); assertNull("…and cleared the repository's copy", model.state.value.error)
        assertEquals("One poll tick later the player can still read why", sentence, model.payFailure.value)
        advanceTimeBy(pollMs * 3); runCurrent(); assertEquals(sentence, model.payFailure.value)
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
        advanceTimeBy(pollMs); runCurrent()
        assertNull("The purchase moved on, so its failure sentence goes with it", model.payFailure.value); assertNull(f.store.read()); screen.cancelAndJoin()
    }

    @Test fun `a decline sentence survives the unpaid-quote observation, and RETRY replaces it`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        val screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        model.buy(requireNotNull(model.state.value.review), BasePurchaseSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        val sentence = requireNotNull(model.payFailure.value); assertTrue(sentence.contains("declined"))
        advanceTimeBy(pollMs * 12); runCurrent()
        assertNull(model.state.value.error); assertEquals(sentence, model.payFailure.value)
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE) }
        model.retryPay(f.sender())?.join(); assertNull(model.payFailure.value); screen.cancelAndJoin()
    }

    /** Review 2026-09-18 (major): a declined quote cannot be closed locally (the store refuses a pending quote) and it
     * blocks every base purchase, including an out-of-energy refill. Nothing re-observed it within the visit, so after
     * the 20-minute price window the player sat on a dead RETRY plate that promised to clear by itself. The loop now
     * observes it with the GET that never verifies or expires anything, so this visit sees the window close and the
     * server end the quote, and the store's own guard retires it. */
    @Test fun `an unpaid quote is observed GET-only within the visit, so its closed window and the server's expiry are seen without leaving`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        val screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        model.buy(requireNotNull(model.state.value.review), BasePurchaseSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        assertTrue(model.state.value.canPay); val observed = f.gets.size
        // The 10-minute fixture window closes while the player is still on the plate.
        f.now = 600_001; f.serverNow = "2026-09-13T00:10:01.000Z"
        advanceTimeBy(pollMs * 12); runCurrent()
        assertTrue("It looked again by itself", f.gets.size > observed)
        assertFalse("The plate knows the price can no longer be paid", model.state.value.quoteFresh); assertFalse(model.state.value.canPay)
        assertNotNull("Still pending on the server: nothing local may close it", f.store.read())
        f.row = paidState(f.row!!.quote, "expired")
        advanceTimeBy(pollMs * 12); runCurrent()
        assertNull("Server-proven unpaid and ended: retired in this visit", f.store.read()); assertNull(model.finished.value)
        assertEquals("Verification could expire an unpaid quote: never from a lifecycle", 0, f.confirms()); assertEquals(1, f.quotes())
        screen.cancelAndJoin()
    }

    /** Rewritten 2026-09-18 (review): "never polled" became "never VERIFIED". The rule it protects is unchanged — a
     * lifecycle never POSTs /paid or /verify for a quote whose payment was never attempted — but the quote is now
     * observed GET-only (previous test), because nothing else could end it within a visit. */
    @Test fun `a never-attempted quote is never verified by a lifecycle, and once the server ends it the next purchase is not blocked`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        model.review("builder", BASE_ID, null)?.join()
        model.buy(requireNotNull(model.state.value.review), BasePurchaseSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        var screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent(); advanceTimeBy(pollMs * 30); runCurrent()
        assertEquals("Verification could expire an unpaid quote: never from a lifecycle", 0, f.confirms()); assertNotNull(f.store.read())
        assertTrue("Observed or not, a payable quote stays payable", model.state.value.canPay)
        screen.cancelAndJoin()
        f.row = paidState(f.row!!.quote, "expired")
        screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        assertNull("Server-proven unpaid and ended: retired through the store's own guard", f.store.read())
        assertNotNull("The fresh confirm plate is already up", model.state.value.review); assertNull(model.finished.value)
        assertEquals(0, f.confirms()); assertEquals(1, f.quotes()); screen.cancelAndJoin()
    }

    /** "4b" (2026-09-18): the player left the wallet sheet open too long. The payment stayed `attempted` with no
     * signature, the server expired the quote, and the saved purchase blocked every base purchase with "contact
     * support". It now clears itself within the visit and the next price is already on the plate. */
    @Test fun `an attempted payment the server expired unpaid clears itself in the visit and the next price is shown`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        model.review("builder", BASE_ID, null)?.join()
        model.buy(requireNotNull(model.state.value.review), BasePurchaseSender { _, _, _ -> throw IOException("wallet timed out") })?.join()
        assertTrue(requireNotNull(f.store.read()).attempted); assertNull(f.store.read()?.signature)
        val screen = launch { model.foreground("builder", BASE_ID, null) }; runCurrent()
        // The auto-confirm poll verifies the attempted payment; after its TTL the server answers "expired".
        f.onVerify = { f.row = paidState(f.row!!.quote, "expired") }
        advanceTimeBy(pollMs + 1); runCurrent()
        assertEquals("expired", f.store.read()?.purchase?.status); assertNotNull("The attempt is still inside the transport margin", f.store.read())
        val confirms = f.confirms()
        f.wall += UnpaidAttempt.MARGIN_MS
        advanceTimeBy(pollMs * 12); runCurrent()
        assertNull("Retired by the slow GET-only check", f.store.read()); assertEquals(UnpaidAttempt.notice(null), model.state.value.notice)
        assertEquals("An ended quote is never /paid or /verified again", confirms, f.confirms())
        assertNotNull("The rail is open again: the fresh confirm plate is already up", model.state.value.review); assertNull(model.finished.value)
        assertEquals(1, f.quotes()); assertEquals(1, f.prepared); screen.cancelAndJoin()
    }

    @Test fun `a paid shield the server could not grant is never toasted away, it waits for one OK`() = runTest {
        val f = paid(); val model = BasePurchaseViewModel(f.repository())
        model.review("shield", BASE_ID, null)?.join()
        f.onVerify = { f.row = paidState(f.row!!.quote, "credited", PAID_SIGNATURE, shieldGranted = false) }
        model.buy(requireNotNull(model.state.value.review), f.sender())?.join()
        assertNotNull("The honest sentence stays on the plate", f.store.read()); assertNull(model.finished.value)
        val routes = mutableListOf<String>(); model.finish { routes += it }?.join()
        assertEquals(listOf("shield"), routes); assertNull(f.store.read())
    }
}
