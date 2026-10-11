package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.economy.KeepDepositViewModel
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

/** Owner 2026-09-18: "SOL spending flow is frustrating… flow should be simple, as in most games, but secure."
 * DEPOSIT N KEEP is one gold tap (web DepositScreen). These tests pin what the simplification must not loosen: one tap
 * is one quote and at most one wallet prompt; an uncertain reply is only ever checked, never re-approved; only an
 * ATTEMPTED deposit is polled; and a finished or provably unpaid deposit never blocks the next one. */
@OptIn(ExperimentalCoroutinesApi::class)
class KeepDepositViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val store = KeepDepositStore(MemoryStore(), session.wallet, session.origin, "devnet")
        val limits = KeepDepositBounds(BigInteger("1000000000"), 9, 2500, 15000, 1200000)
        val q = KeepDepositQuote(DEPOSIT_ID, session.wallet, session.origin, "devnet", "17", DEPOSIT_SOURCE, DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, DEPOSIT_REFERENCE)
        var now = 0L; var creates = 0; var prepared = 0; var prompts = 0; var refreshed = 0; var wall = 1_000_000L
        var row = row()
        fun repository() = KeepDepositRepository(session, holder, api, store, SolanaCluster.DEVNET, { ChainAddresses.DEVNET.keepMint }, { limits },
            { prepared++; PreparedKeepDeposit(byteArrayOf(1, 2, 3), BigInteger.valueOf(5000)) }, { refreshed++ }, { now }, wallClockMs = { wall })
        init {
            api.onPost("/deposits") { creates++
                jsonBody("id" to q.id, "kind" to "keep_deposit", "source" to q.source, "destination" to q.destination, "mint" to q.mint, "decimals" to q.decimals.toString(), "reference" to q.reference) }
            api.onGet("/deposits/$DEPOSIT_ID") { row }
            api.onPost("/deposits/$DEPOSIT_ID/verify") { row }
            api.onPost("/deposits/$DEPOSIT_ID/paid") { json("""{"committed":true}""") }
        }
        fun row(status: String = "pending", signature: String? = null, amount: String? = null) = jsonBody("id" to DEPOSIT_ID, "kind" to "keep_deposit",
            "reference" to DEPOSIT_REFERENCE, "status" to status).let { JsonObject(it + mapOf("txSignature" to (signature?.let(::JsonPrimitive) ?: JsonNull), "paymentSignature" to (signature?.let(::JsonPrimitive) ?: JsonNull), "amount" to (amount?.let(::JsonPrimitive) ?: JsonNull))) }
        fun credited() = row("credited", DEPOSIT_SIGNATURE, q.baseUnits.toString())
        fun approve(action: () -> Unit = {}) = KeepDepositSender { _, _, record -> prompts++; assertTrue(store.read()!!.attempted); action(); record(DEPOSIT_SIGNATURE); DEPOSIT_SIGNATURE }
        fun confirms() = api.posts.count { it.first.endsWith("/verify") || it.first.endsWith("/paid") }
    }
    private suspend fun TestScope.opened(f: Fixture): KeepDepositViewModel = KeepDepositViewModel(f.repository()).also { model ->
        val job = launch { model.foreground(null) }; runCurrent(); job.cancelAndJoin()
    }

    @Test fun `one gold tap quotes then opens the wallet exactly once, and a credited deposit closes itself`() = runTest {
        val f = Fixture(); val model = opened(f)
        model.deposit("17", f.approve { f.row = f.credited() })?.join()
        assertEquals(1, f.creates); assertEquals(1, f.prepared); assertEquals(1, f.prompts)
        assertNull("Credited and refreshed: retired through the store's own guard", f.store.read()); assertEquals(1, f.refreshed)
        assertTrue(Toasts.queue.items.value.any { it.message == "DEPOSITED 17 KEEP" }); assertFalse(model.paying.value)
    }

    @Test fun `a wallet decline returns to a re-payable plate, RETRY reuses the same quote, and CANCEL frees the slot`() = runTest {
        val f = Fixture(); val model = opened(f)
        model.deposit("17", KeepDepositSender { _, _, _ -> f.prompts++; throw WalletPaymentException("declined", true) })?.join()
        val declined = f.store.read()!!
        assertFalse(declined.attempted); assertNull(declined.signature); assertTrue(model.state.value.canPay); assertNotNull(model.state.value.error)
        assertEquals("Declining never retries by itself", 1, f.prompts)
        model.retryPay(f.approve { f.row = f.credited() })?.join()
        assertEquals("RETRY never asks for a second quote", 1, f.creates); assertEquals(2, f.prompts); assertNull(f.store.read())
    }

    @Test fun `an uncertain wallet reply enters auto-checking, never re-prompts, and resumes after leaving and reopening`() = runTest {
        val f = Fixture(); val model = opened(f)
        val uncertain = KeepDepositSender { _, _, _ -> f.prompts++; throw IOException("wallet connection lost") }
        model.deposit("17", uncertain)?.join()
        assertTrue(f.store.read()!!.attempted); assertNotNull(model.state.value.error)
        val sentence = requireNotNull(model.payFailure.value); assertTrue(sentence.contains("uncertain"))
        model.retryPay(uncertain)?.join(); model.deposit("17", uncertain)?.join()
        assertEquals("No second wallet approval or quote for an attempted deposit", 1, f.prompts); assertEquals(1, f.creates)
        val idle = f.confirms()
        var screen = launch { model.foreground(f.limits) }; runCurrent(); val opened = f.confirms()
        advanceTimeBy(f.limits.pollMs); runCurrent(); assertTrue("It checks by itself", f.confirms() > opened)
        // Review 2026-09-18: the poll clears state.error; the DEPOSIT tap's sentence must outlive it until the deposit moves on.
        assertNull(model.state.value.error); assertEquals("One poll later the player can still read why", sentence, model.payFailure.value)
        val left = f.confirms(); screen.cancelAndJoin(); advanceTimeBy(f.limits.pollMs * 4); runCurrent(); assertEquals("Leaving stops the poll", left, f.confirms())
        val reopened = KeepDepositViewModel(f.repository()); f.row = f.credited()
        screen = launch { reopened.foreground(f.limits) }; runCurrent()
        assertNull("Reopening finishes it without a tap", f.store.read()); assertEquals(1, f.prompts); assertTrue(idle <= left); screen.cancelAndJoin()
    }

    /** "4b" (2026-09-18): the player left the wallet sheet open too long. The deposit stayed `attempted` with no
     * signature, the server expired it, and the saved deposit blocked every later deposit with "contact support".
     * It now clears itself within the visit and the next deposit goes straight through. */
    @Test fun `an attempted deposit the server expired unpaid clears itself in the visit and the next deposit is not blocked`() = runTest {
        val f = Fixture(); val model = opened(f)
        model.deposit("17", KeepDepositSender { _, _, _ -> f.prompts++; throw IOException("wallet timed out") })?.join()
        assertTrue(f.store.read()!!.attempted); assertNull(f.store.read()!!.signature)
        val screen = launch { model.foreground(f.limits) }; runCurrent()
        f.row = f.row("expired"); advanceTimeBy(f.limits.pollMs + 1); runCurrent()
        assertEquals("expired", f.store.read()!!.receipt!!.status); val confirms = f.confirms()
        model.deposit("17", KeepDepositSender { _, _, _ -> f.prompts++; error("Still inside the transport margin: no second wallet") })?.join()
        assertEquals(1, f.prompts); assertEquals(1, f.creates)
        f.wall += UnpaidAttempt.MARGIN_MS
        advanceTimeBy(f.limits.pollMs * 12); runCurrent()
        assertNull(f.store.read()); assertEquals(UnpaidAttempt.notice(null, deposit = true), model.state.value.notice)
        assertEquals("An ended deposit is never /paid or /verified again", confirms, f.confirms())
        f.row = f.row(); model.deposit("17", f.approve { f.row = f.credited() })?.join()
        assertEquals("The rail is open again", 2, f.prompts); assertEquals(2, f.creates); assertNull(f.store.read()); screen.cancelAndJoin()
    }

    @Test fun `a never-attempted quote is never polled, and one that can no longer be paid closes itself`() = runTest {
        val f = Fixture(); val model = opened(f)
        model.deposit("17", KeepDepositSender { _, _, _ -> throw WalletPaymentException("declined", true) })?.join()
        val before = f.confirms()
        var screen = launch { model.foreground(f.limits) }; runCurrent(); advanceTimeBy(f.limits.pollMs * 4); runCurrent()
        assertEquals("GET-only while unpaid", before, f.confirms()); assertNotNull("Still payable: RETRY stays", f.store.read()); screen.cancelAndJoin()
        // A new process cannot prove the quote is still payable; it was never attempted, so it is provably unpaid.
        val reopened = KeepDepositViewModel(f.repository())
        screen = launch { reopened.foreground(f.limits) }; runCurrent()
        assertNull(f.store.read()); assertEquals(before, f.confirms()); screen.cancelAndJoin()
        reopened.deposit("17", f.approve { f.row = f.credited() })?.join()
        assertEquals("The next deposit is not blocked", 2, f.creates); assertNull(f.store.read())
    }
}
