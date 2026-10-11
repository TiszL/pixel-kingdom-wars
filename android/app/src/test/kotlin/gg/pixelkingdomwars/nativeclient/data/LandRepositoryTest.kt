package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The land checkout state machine (web `usePayEntry`): the reservation is durable before the POST,
 * the submitted marker is durable before the wallet opens, one signature is posted once, and every
 * uncertain outcome is reconciled by reference on the server's clock rather than by signing again. */
@OptIn(ExperimentalCoroutinesApi::class)
class LandRepositoryTest {
    private val depositId = "0f3a3a4e-2b1f-4a1e-9c3b-4d0d5e6f7a8b"
    private val reference = "5Mx9V8mMkkdVDrMjAZGkYgutxSmxUdTPR846Q1okAgro"
    private val serverNow = "2026-09-11T10:00:00.000Z"
    private fun reservation(status: String? = "pending", tile: Int = 14742, kind: String = "entry", signature: String? = null, amount: String = "200000000"): JsonObject = json("""{
        "id":"$depositId","kind":"$kind",${status?.let { "\"status\":\"$it\"," } ?: ""}"reference":"$reference","baseId":"$BASE_ID","amountLamports":$amount,
        "serverNow":"$serverNow","payableUntil":"2026-09-11T10:25:00.000Z","retryAt":"2026-09-11T10:30:00.000Z",
        "landAddress":{"kind":"fantasy","worldId":"fantasy-v1","tileId":$tile},"fantasyLocation":{"worldId":"fantasy-v1","tileId":$tile,"realmId":"frostveil","allocation":"ordinary","lon":-172.75,"lat":80.25},
        "paymentSignature":${signature?.let { "\"$it\"" } ?: "null"}}""")
    private fun me(entryPaid: Boolean) = json("""{"wallet":"$WALLET","entryPaid":$entryPaid}""")
    private val signatureBytes = ByteArray(64) { (it + 1).toByte() }
    private val signatureText = base58(signatureBytes)

    /** A fixture catalogue carrying `constants.LAND_CHECKOUT_RECOVERY` under the names constants.ts exports; the repository reads nothing else. */
    private val BOUNDS = requireNotNull(LandCheckoutBounds.from(json("""{"constants":{"LAND_CHECKOUT_RECOVERY":{"requestTimeoutMs":15000,"walletResponseGraceMs":30000,"firstEntryRetryMs":60000,"pollMs":2500}}}""")))

    private inner class Fixture(scope: TestScope, saved: String? = null, var bounds: LandCheckoutBounds? = BOUNDS) {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val memory = MemoryStore()
        val intents = PendingIntentStore(memory)
        val observer = ReceiptObserver(intents)
        val purchaseMemory = MemoryStore(saved)
        val purchases = LandPurchaseStore(purchaseMemory)
        val rpcCalls = mutableListOf<String>()
        var balance = "9007199254740993"
        var rpcFailure: Exception? = null
        var afterRpc: suspend (String) -> Unit = {}
        val scheduler = scope.testScheduler
        // Estimates and polling are background jobs. After reserve/open, runCurrent() executes
        // immediate funding work; advanceUntilIdle() deliberately ignores background-only queues.
        val repository = LiveLandRepository(session, holder, scope.backgroundScope, api, intents, observer, purchases, SolanaCluster.DEVNET,
            { SolanaRpc { request -> rpcFailure?.let { throw it }; val response = rpc(request); afterRpc(request["method"]!!.jsonPrimitive.content); response } }, { ChainAddresses.DEVNET }, { bounds },
            { scheduler.currentTime }, newKey = { "land-key-0001" })
        val key = LandPurchaseStore.key(SolanaCluster.DEVNET, WALLET, "entry")
        init { api.onGet("/me") { me(false) } }
        private fun rpc(request: JsonObject): JsonObject {
            val method = request["method"]!!.jsonPrimitive.content; rpcCalls += method
            return buildJsonObject { put("jsonrpc", "2.0"); put("id", request["id"]!!); put("result", when (method) {
                "getLatestBlockhash" -> buildJsonObject { put("value", buildJsonObject { put("blockhash", "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi") }) }
                "getBalance" -> buildJsonObject { put("value", JsonPrimitive(BigInteger(balance))) }
                "getAccountInfo" -> buildJsonObject { put("value", JsonNull) }
                "getMinimumBalanceForRentExemption" -> JsonPrimitive(1246920)
                "getFeeForMessage" -> buildJsonObject { put("value", 5000) }
                else -> error("Unexpected $method")
            }) }
        }
        fun state() = repository.state.value
        fun signer(result: suspend () -> ByteArray) = LandSigner { transaction, cluster, wallet, _ ->
            assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(WALLET, wallet); assertTrue("An unsigned legacy transaction reaches the wallet", transaction.size > 65 && transaction[0] == 1.toByte()); result()
        }
    }

    @Test fun `resuming an unfunded checkout refreshes funding without another reservation or payment`() = runTest {
        val f = Fixture(this); f.balance = "0"; f.api.onPost("/deposits") { reservation() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        assertFalse(f.state().estimate!!.funded)
        val saved = f.purchaseMemory.value; val frozen = f.state().reservation
        f.balance = "9007199254740993"
        f.repository.open("entry"); runCurrent()
        assertTrue(f.state().estimate!!.funded); assertFalse(f.state().estimateLoading)
        assertEquals(frozen, f.state().reservation); assertEquals(saved, f.purchaseMemory.value)
        assertEquals(listOf("/deposits"), f.api.posts.map { it.first })
        assertFalse(f.purchases.read(f.key)!!.submitted)
    }

    @Test fun `explicit funding check recovers an unavailable estimate and keeps the saved parcel`() = runTest {
        val f = Fixture(this); f.rpcFailure = IOException("offline"); f.api.onPost("/deposits") { reservation() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        assertTrue(f.state().estimateUnavailable)
        f.rpcFailure = null; f.repository.refreshEstimate(); runCurrent()
        assertTrue(f.state().estimate!!.funded); assertFalse(f.state().estimateUnavailable)
        assertEquals(depositId, f.state().reservation!!.id); assertEquals(1, f.api.posts.size)
    }

    @Test fun `an older delayed funding read cannot erase the newest successful check`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }; f.balance = "0"
        val old = CompletableDeferred<Unit>(); var delayed = false
        f.afterRpc = { if (it == "getFeeForMessage" && !delayed) { delayed = true; withContext(NonCancellable) { old.await() } } }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.balance = "9007199254740993"; f.repository.refreshEstimate(); runCurrent()
        val fresh = f.state().estimate; assertTrue(fresh!!.funded)
        old.complete(Unit); runCurrent()
        assertEquals(fresh, f.state().estimate); assertFalse(f.state().estimateUnavailable); assertFalse(f.state().estimateLoading)
        assertEquals(1, f.api.posts.size)
    }

    @Test fun `a read from a superseded wallet cannot publish or start another funding check`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }
        val delayed = CompletableDeferred<Unit>()
        f.afterRpc = { if (it == "getFeeForMessage") delayed.await() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.holder.replace(null); val before = f.state()
        delayed.complete(Unit); runCurrent()
        assertEquals(before, f.state()); assertEquals(1, f.api.posts.size)
        assertThrows(gg.pixelkingdomwars.nativeclient.network.SessionSupersededException::class.java) {
            kotlinx.coroutines.runBlocking { f.repository.refreshEstimate() }
        }
    }

    @Test fun `a delayed first-land estimate cannot publish into a different deed reservation`() = runTest {
        val f = Fixture(this); f.balance = "0"; f.api.onPost("/deposits") { reservation() }
        val old = CompletableDeferred<Unit>(); var delayed = false
        f.afterRpc = { if (it == "getFeeForMessage" && !delayed) { delayed = true; withContext(NonCancellable) { old.await() } } }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.api.onPost("/deposits") { JsonObject(reservation(kind = "deed") + ("id" to JsonPrimitive("1f3a3a4e-2b1f-4a1e-9c3b-4d0d5e6f7a8b"))) }
        f.balance = "9007199254740993"; f.repository.open("deed"); f.repository.reserve(null); runCurrent()
        val fresh = f.state(); assertEquals("deed", fresh.purchaseKind); assertTrue(fresh.estimate!!.funded)
        old.complete(Unit); runCurrent()
        assertEquals(fresh, f.state()); assertEquals(2, f.api.posts.size)
        assertFalse(f.purchases.read(f.key)!!.submitted)
    }

    @Test fun `opening checkout from the world retains its explicitly selected parcel`() = runTest {
        val f=Fixture(this)
        f.repository.open("entry");f.repository.draft(14742);f.repository.open("entry")
        assertEquals(14742,f.state().draftedTile)
        assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `reserve persists the exact fantasy intent before the POST, adopts the frozen reservation and prices it`() = runTest {
        val f = Fixture(this)
        f.api.onPost("/deposits") { body ->
            val saved = requireNotNull(PendingIntentStore(MemoryStore(f.memory.value)).get(IntentKind.LAND_RESERVATION, WALLET)); assertTrue(saved.attempted); assertEquals(body, saved.body)
            assertEquals(json("""{"kind":"entry","idempotencyKey":"land-key-0001","landAddress":{"kind":"fantasy","worldId":"fantasy-v1","tileId":14742}}"""), body)
            reservation()
        }
        f.repository.open("entry"); f.repository.draft(14742); f.repository.reserve(14742)
        assertEquals(LandPhase.READY, f.state().phase); assertEquals("fantasy-v1:14742", f.state().reservation!!.reservationIdentity); assertNull(f.state().draftedTile)
        assertEquals(SavedLandPurchase(depositId), f.purchases.read(f.key)); assertNull("Hydrated reservation retires the intent", f.intents.get(IntentKind.LAND_RESERVATION, WALLET))
        runCurrent()
        val estimate = requireNotNull(f.state().estimate)
        assertEquals(BigInteger.valueOf(200_000_000 + 5000 + 1246920), estimate.requiredLamports); assertTrue(estimate.funded)
        assertEquals(listOf("getLatestBlockhash", "getBalance", "getAccountInfo", "getMinimumBalanceForRentExemption", "getFeeForMessage"), f.rpcCalls)
        assertEquals(1500L, f.state().payableRemainingSec(f.scheduler.currentTime))
    }
    @Test fun `already paid is credited and a resolving 409 resumes the wallet's reservation without a second POST`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { json("""{"alreadyPaid":true,"kind":"entry"}""") }
        f.repository.open("entry"); f.repository.reserve(null)
        assertEquals(LandPhase.CREDITED, f.state().phase)
        val g = Fixture(this)
        g.api.onPost("/deposits") { throw ApiException(409, "RESERVATION_MISMATCH", "already reserves", json("""{"depositId":"$depositId","serverNow":"$serverNow","payableUntil":"2026-09-11T10:25:00.000Z","retryAt":"2026-09-11T10:30:00.000Z","landAddress":{"kind":"fantasy","worldId":"fantasy-v1","tileId":777}}""")) }
        g.api.onGet("/deposits/$depositId") { reservation(tile = 777) }
        g.repository.open("entry"); g.repository.reserve(14742)
        assertEquals(LandPhase.READY, g.state().phase); assertEquals(777, g.state().reservation!!.landAddress!!.tileId)
        assertEquals("RESUMED YOUR RESERVED LAND fantasy-v1:777.", g.state().notice); assertEquals(1, g.api.posts.size)
        assertNull(g.intents.get(IntentKind.LAND_RESERVATION, WALLET)); assertEquals(depositId, g.purchases.read(g.key)!!.id)
        // Web useEntry.ts:339-341 selects the copy by the 409 code; the server sends retryAt and the identity for BOTH codes,
        // so a closing window must not be announced as a resumed reservation.
        val h = Fixture(this)
        h.api.onPost("/deposits") { throw ApiException(409, "PAYMENT_WINDOW_CLOSING", "closing", json("""{"depositId":"$depositId","serverNow":"$serverNow","payableUntil":"2026-09-11T10:25:00.000Z","retryAt":"2026-09-11T10:30:00.000Z","landAddress":{"kind":"fantasy","worldId":"fantasy-v1","tileId":777}}""")) }
        h.api.onGet("/deposits/$depositId") { reservation(tile = 777) }
        h.repository.open("entry"); h.repository.reserve(14742)
        assertEquals(LiveLandRepository.PAYMENT_WINDOW_CLOSED, h.state().notice); assertEquals("PAYMENT WINDOW CLOSED — CHECKING BEFORE RELEASING YOUR RESERVATION.", h.state().notice)
        assertEquals(777, h.state().reservation!!.landAddress!!.tileId); assertEquals(1, h.api.posts.size)
    }
    @Test fun `ENTRY_REQUIRED switches a deed purchase to the first land and a lost reply stays retryable`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { throw ApiException(409, "ENTRY_REQUIRED", "buy the first entry deed") }
        f.repository.open("deed")
        assertThrows(ApiException::class.java) { kotlinx.coroutines.runBlocking { f.repository.reserve(null) } }
        assertEquals("entry", f.state().purchaseKind); assertEquals(LandPhase.IDLE, f.state().phase); assertTrue(f.state().error!!.contains("FIRST land"))
        f.api.onPost("/deposits") { throw IOException("lost") }
        assertThrows(IOException::class.java) { kotlinx.coroutines.runBlocking { f.repository.reserve(null) } }
        assertEquals(LandPhase.IDLE, f.state().phase); assertTrue(f.observer.blocks(IntentKind.LAND_RESERVATION)); assertTrue(f.observer.interrupted.value.single().retryable)
        assertThrows("A saved reservation blocks a new one until recovered", IllegalStateException::class.java) { kotlinx.coroutines.runBlocking { f.repository.reserve(null) } }
    }
    @Test fun `pay re-reads authority, persists the submitted marker before the wallet, posts the signature once and verifies until credited`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.api.onGet("/deposits/$depositId") { reservation() }
        var verifies = 0; var paid = 0
        f.api.onPost("/deposits/$depositId/paid") { body -> paid++; assertEquals(signatureText, body.string("signature")); reservation(signature = signatureText) }
        f.api.onPost("/deposits/$depositId/verify") { if (++verifies < 3) reservation(signature = signatureText) else reservation(status = "credited", signature = signatureText) }
        val signer = f.signer {
            val saved = requireNotNull(LandPurchaseStore(MemoryStore(f.purchaseMemory.value)).read(f.key))
            assertTrue("The submitted marker is durable before the wallet opens", saved.submitted); assertEquals(1789120800000L, saved.attemptStartedAt); assertNull(saved.signature)
            assertEquals(LandPhase.PAYING, f.state().phase)
            signatureBytes
        }
        f.repository.pay(signer)
        assertEquals(listOf("/me", "/deposits/$depositId"), f.api.gets.takeLast(2).map { it.first })
        assertEquals(LandPhase.CONFIRMING, f.state().phase); assertEquals(signatureText, f.state().paymentSignature)
        advanceTimeBy(BOUNDS.pollMs * 4)
        assertEquals(LandPhase.CREDITED, f.state().phase); assertEquals(1, paid); assertEquals(3, verifies)
        assertEquals("Entry recovery stays until the next visit finds /me.entryPaid", SavedLandPurchase(depositId, signatureText, true, 1789120800000L), f.purchases.read(f.key))
    }
    @Test fun `a wallet refusal before broadcast keeps the tile payable and clears the submitted marker`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }; f.api.onGet("/deposits/$depositId") { reservation() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.repository.pay(f.signer { throw WalletPaymentException("Payment cancelled — your land is still reserved. Tap pay when ready.", refusedBeforeBroadcast = true) })
        assertEquals(LandPhase.READY, f.state().phase); assertEquals("Payment cancelled — your land is still reserved. Tap pay when ready.", f.state().error)
        assertEquals(SavedLandPurchase(depositId), f.purchases.read(f.key)); assertTrue(f.api.posts.none { it.first.endsWith("/verify") })
    }
    /** Web `useEntry.ts submit` catch: only `paymentRefusedBeforeBroadcast` reopens PAY. A failure raised after
     * `signAndSendTransactions` returned (a malformed signatures payload, a guard cancellation, ERROR_NOT_SUBMITTED)
     * can follow a broadcast; buy_sink is repeatable, so a reopened PAY would sign a second transaction with a new
     * blockhash and charge the same reservation twice. The durable submitted marker must outlive that failure. */
    @Test fun `a failure after the send call keeps the deed's submitted marker, never reopens PAY and resumes verification on restart`() = runTest {
        val deedKey = LandPurchaseStore.key(SolanaCluster.DEVNET, WALLET, "deed")
        val f = Fixture(this); f.api.onPost("/deposits") { reservation(kind = "deed") }; f.api.onGet("/deposits/$depositId") { reservation(kind = "deed") }
        f.api.onPost("/deposits/$depositId/verify") { reservation(kind = "deed") }
        f.repository.open("deed"); f.repository.reserve(null); runCurrent()
        var signed = 0
        f.repository.pay(f.signer { signed++; throw WalletPaymentException("Wallet response was interrupted — checking your payment before another attempt.", refusedBeforeBroadcast = false, IllegalStateException("The wallet returned an invalid payment response")) })
        assertEquals(1, signed); assertEquals(LandPhase.CONFIRMING, f.state().phase); assertTrue(f.state().error!!.startsWith("WALLET RESPONSE WAS INTERRUPTED"))
        val kept = requireNotNull(f.purchases.read(deedKey))
        assertTrue("The submitted marker survives an uncertain outcome", kept.submitted); assertEquals(depositId, kept.id); assertNotNull(kept.attemptStartedAt)
        f.repository.pay(f.signer { signed++; signatureBytes })
        assertEquals("PAY is closed while the reference check runs", 1, signed); assertEquals(LandPhase.CONFIRMING, f.state().phase)
        advanceTimeBy(BOUNDS.pollMs * 2 + 1)
        assertEquals(LandPhase.CONFIRMING, f.state().phase); assertTrue(f.api.posts.count { it.first.endsWith("/verify") } >= 2); assertTrue(f.purchases.read(deedKey)!!.submitted)
        // Restart with the same store: the marker resumes verification, it does not offer PAY with a new blockhash.
        val g = Fixture(this, saved = f.purchaseMemory.value); g.api.onGet("/deposits/$depositId") { reservation(kind = "deed") }; g.api.onPost("/deposits/$depositId/verify") { reservation(kind = "deed") }
        g.repository.open("deed")
        assertEquals(LandPhase.CONFIRMING, g.state().phase); assertTrue(g.purchases.read(deedKey)!!.submitted); assertNull(g.state().paymentSignature)
        g.repository.pay(g.signer { signed++; signatureBytes }); assertEquals(1, signed)
    }
    @Test fun `an uncertain wallet failure and a delayed response verify by reference instead of signing again`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }; f.api.onGet("/deposits/$depositId") { reservation() }
        var verifies = 0
        f.api.onPost("/deposits/$depositId/verify") { if (++verifies < 2) reservation() else reservation(status = "credited", signature = signatureText) }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.repository.pay(f.signer { throw IOException("association dropped") })
        assertEquals(LandPhase.CONFIRMING, f.state().phase); assertTrue(f.state().error!!.startsWith("WALLET RESPONSE WAS INTERRUPTED"))
        advanceTimeBy(BOUNDS.pollMs * 3); assertEquals(LandPhase.CREDITED, f.state().phase)

        val g = Fixture(this); g.api.onPost("/deposits") { reservation() }; g.api.onGet("/deposits/$depositId") { reservation() }
        g.api.onPost("/deposits/$depositId/verify") { reservation() }
        g.api.onPost("/deposits/$depositId/paid") { reservation(signature = signatureText) }
        g.repository.open("entry"); g.repository.reserve(null); runCurrent()
        val reply = CompletableDeferred<ByteArray>()
        val paying = launch { g.repository.pay(g.signer { reply.await() }) }
        advanceTimeBy(BOUNDS.walletResponseGraceMs + 1)
        assertEquals("The grace window starts reference checking while the wallet is still open", LandPhase.CONFIRMING, g.state().phase)
        assertTrue(g.state().error!!.startsWith("WALLET RESPONSE IS DELAYED"))
        reply.complete(signatureBytes); paying.join()
        assertEquals("A late signature is kept for recovery", signatureText, g.purchases.read(g.key)!!.signature)
        assertTrue(g.api.posts.any { it.first.endsWith("/paid") }); assertEquals(LandPhase.CONFIRMING, g.state().phase)
    }
    @Test fun `restore resumes a saved reservation, a saved signature resumes verification and a missing row is forgotten`() = runTest {
        val saved = """{"${LandPurchaseStore.key(SolanaCluster.DEVNET, WALLET, "entry")}":{"id":"$depositId","signature":"$signatureText","submitted":true,"attemptStartedAt":1789120790000}}"""
        val f = Fixture(this, saved); f.api.onGet("/deposits/$depositId") { reservation() }; f.api.onPost("/deposits/$depositId/verify") { reservation() }
        f.repository.open("entry")
        assertEquals(LandPhase.CONFIRMING, f.state().phase); assertEquals(signatureText, f.state().paymentSignature); assertEquals(listOf("/me", "/deposits/$depositId"), f.api.gets.map { it.first })
        assertEquals("The attempt clock survives on the server clock", 1789120790000L, f.state().attemptStartedAtMs)
        assertEquals(50L, f.state().retryEntryInSec(f.scheduler.currentTime, BOUNDS))
        val g = Fixture(this, saved); g.api.onGet("/deposits/$depositId") { throw ApiException(404, null, "not found") }
        g.repository.open("entry")
        assertEquals(LandPhase.IDLE, g.state().phase); assertEquals("RESERVATION NOT FOUND — CHOOSE YOUR LAND AGAIN.", g.state().error); assertNull(g.purchases.read(g.key))
        val h = Fixture(this, saved); h.api.onGet("/me") { me(true) }
        h.repository.open("entry"); assertEquals(LandPhase.CREDITED, h.state().phase); assertTrue(h.api.gets.none { it.first.startsWith("/deposits") })
        val i = Fixture(this, saved); i.api.onGet("/deposits/$depositId") { throw IOException("offline") }
        i.repository.open("entry"); assertEquals(LandPhase.RESTORING, i.state().phase); assertEquals("RECONNECTING TO YOUR RESERVED LAND…", i.state().error)
        i.api.onGet("/deposits/$depositId") { reservation() }; i.api.onPost("/deposits/$depositId/verify") { reservation() }
        advanceTimeBy(BOUNDS.pollMs + 1); assertEquals(LandPhase.CONFIRMING, i.state().phase)
    }
    @Test fun `expired and failed outcomes end the checkout with the web's copy`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }; f.api.onGet("/deposits/$depositId") { reservation() }
        f.api.onPost("/deposits/$depositId/verify") { reservation(status = "expired") }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.repository.pay(f.signer { throw IOException("dropped") }); advanceTimeBy(1)
        assertEquals(LandPhase.IDLE, f.state().phase); assertNull(f.state().reservation); assertNull(f.purchases.read(f.key))
        assertTrue(f.state().error!!.startsWith("NO PAYMENT WAS CONFIRMED FOR THIS RESERVATION"))
        val g = Fixture(this); g.api.onPost("/deposits") { reservation() }; g.api.onGet("/deposits/$depositId") { reservation() }
        g.api.onPost("/deposits/$depositId/verify") { reservation(status = "failed") }
        g.repository.open("entry"); g.repository.reserve(null); runCurrent()
        g.repository.pay(g.signer { throw IOException("dropped") }); advanceTimeBy(1)
        assertEquals(LandPhase.FAILED, g.state().phase); assertTrue(g.state().error!!.contains(LiveLandRepository.SUPPORT_EMAIL))
    }
    @Test fun `the first-land retry opens after the retry window on the server clock and re-reads before signing again`() = runTest {
        val f = Fixture(this); f.api.onPost("/deposits") { reservation() }; f.api.onGet("/deposits/$depositId") { reservation() }
        f.api.onPost("/deposits/$depositId/verify") { reservation() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        f.repository.pay(f.signer { throw IOException("dropped") })
        assertEquals(LandPhase.CONFIRMING, f.state().phase)
        val bounds = BOUNDS
        advanceTimeBy(bounds.firstEntryRetryMs - 1000)
        assertFalse(f.state().canRetryEntry(f.scheduler.currentTime, bounds)); assertEquals(1L, f.state().retryEntryInSec(f.scheduler.currentTime, bounds))
        advanceTimeBy(1000)
        assertTrue(f.state().canRetryEntry(f.scheduler.currentTime, bounds))
        var signed = 0
        f.repository.retryPayment(f.signer { signed++; signatureBytes })
        assertEquals(1, signed); assertEquals(LandPhase.CONFIRMING, f.state().phase); assertEquals(signatureText, f.state().paymentSignature)
        assertTrue("A retry never starts before the server row is re-verified", f.api.posts.count { it.first.endsWith("/verify") } >= 1)
        assertFalse("The retry window restarts with the new attempt", f.state().canRetryEntry(f.scheduler.currentTime, bounds))
    }
    @Test fun `insufficient SOL and an unavailable RPC never open the wallet and keep the tile reserved`() = runTest {
        val f = Fixture(this); f.balance = "200004999"; f.api.onPost("/deposits") { reservation() }; f.api.onGet("/deposits/$depositId") { reservation() }
        f.repository.open("entry"); f.repository.reserve(null); runCurrent()
        assertFalse(f.state().estimate!!.funded)
        var signed = 0
        f.repository.pay(f.signer { signed++; signatureBytes })
        assertEquals(0, signed); assertEquals(LandPhase.READY, f.state().phase); assertTrue(f.state().error!!.startsWith("NOT ENOUGH SOL"))
        f.rpcFailure = ApiException(404, null, "Route POST:/rpc/solana/devnet not found")
        f.repository.pay(f.signer { signed++; signatureBytes })
        assertEquals(0, signed); assertEquals(LandPhase.READY, f.state().phase); assertTrue(f.state().error!!.startsWith("COULD NOT CHECK SOL AND FEES"))
        assertEquals(depositId, f.state().reservation!!.id)
    }
    /** Hard rule: never a Kotlin copy of a timer. `LAND_CHECKOUT_RECOVERY` is read by its constants.ts names and a
     * pack that lacks any of the four timers cannot time a request, a poll or the wallet grace window, so the
     * checkout refuses to restore, reserve or pay — and leaves the durable purchase marker for the next open. */
    @Test fun `a pack without LAND_CHECKOUT_RECOVERY disables the checkout and leaves the saved purchase untouched`() = runTest {
        assertNull(LandCheckoutBounds.from(null)); assertNull(LandCheckoutBounds.from(json("""{"constants":{}}""")))
        assertNull("Every timer is required", LandCheckoutBounds.from(json("""{"constants":{"LAND_CHECKOUT_RECOVERY":{"pollMs":400}}}""")))
        assertNull("A non-positive timer is refused", LandCheckoutBounds.from(json("""{"constants":{"LAND_CHECKOUT_RECOVERY":{"requestTimeoutMs":0,"walletResponseGraceMs":2000,"firstEntryRetryMs":3000,"pollMs":400}}}""")))
        assertEquals(LandCheckoutBounds(1000, 2000, 3000, 400), LandCheckoutBounds.from(json("""{"constants":{"LAND_CHECKOUT_RECOVERY":{"requestTimeoutMs":1000,"walletResponseGraceMs":2000,"firstEntryRetryMs":3000,"pollMs":400}}}""")))
        val entryKey = LandPurchaseStore.key(SolanaCluster.DEVNET, WALLET, "entry")
        val saved = """{"$entryKey":{"id":"$depositId","signature":"$signatureText","submitted":true,"attemptStartedAt":1789120790000}}"""
        val f = Fixture(this, saved, bounds = null)
        f.repository.open("entry")
        assertEquals(LandPhase.IDLE, f.state().phase); assertEquals(LiveLandRepository.LAND_CHECKOUT_UNAVAILABLE, f.state().unavailable)
        assertTrue("No request runs without bounds", f.api.gets.isEmpty() && f.api.posts.isEmpty())
        assertEquals("The durable marker is kept for the next open", saved, f.purchaseMemory.value)
        val refused = assertThrows(IllegalStateException::class.java) { kotlinx.coroutines.runBlocking { f.repository.reserve(14742) } }
        assertEquals(LiveLandRepository.LAND_CHECKOUT_UNAVAILABLE, refused.message); assertTrue(f.api.posts.isEmpty()); assertNull(f.intents.get(IntentKind.LAND_RESERVATION, WALLET))
        var signed = 0
        f.repository.pay(f.signer { signed++; signatureBytes }); f.repository.retryPayment(f.signer { signed++; signatureBytes }); assertEquals(0, signed)
        // The catalogue arrives (content update applied): reopening restores the saved payment check.
        f.bounds = BOUNDS; f.api.onGet("/deposits/$depositId") { reservation() }; f.api.onPost("/deposits/$depositId/verify") { reservation() }
        f.repository.open("entry")
        assertEquals(LandPhase.CONFIRMING, f.state().phase); assertNull(f.state().unavailable); assertEquals(signatureText, f.state().paymentSignature)
    }
}
