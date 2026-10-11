package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.JsonRpc20Client
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Seeker incidents 2026-09-17/18 (store builds 0.5.0–0.5.2): no SOL payment could complete, and three defects
 * hid behind one generic notice.
 *  1. A `get_capabilities` gate read a clientlib flag that is false for every spec-conformant MWA 2.0 wallet, so
 *     the wallet's own send — the only path ever seen to land for the owner's wallet — was never called.
 *  2. clientlib-ktx 2.0.7 delivers every wallet JSON-RPC error wrapped in an ExecutionException; the verdict was
 *     read from the wrapper, so a plain decline became "uncertain" and stranded the purchase as attempted.
 *  3. The fallback opened a second association and demanded byte-identical signed bytes.
 * These tests drive the real in-session payment code with a fake wallet that fails exactly as ktx does. */
class WalletPayTest {
    private val fixture = SignedFixture()
    private fun remote(code: Int) = JsonRpc20Client.JsonRpc20RemoteException(code, "PRIVATE wallet text", "PRIVATE data")
    /** What ktx's future.get() throws for a wallet error. */
    private fun wrapped(code: Int) = ExecutionException("PRIVATE wrapper text", remote(code))

    private class FakeWallet(val onSend: () -> ByteArray, val onSign: (ByteArray) -> ByteArray = { error("sign_transactions must not be called") }) : AdapterOperations {
        val calls = mutableListOf<String>()
        override suspend fun signAndSendTransactions(transactions: Array<ByteArray>, params: TransactionParams): MobileWalletAdapterClient.SignAndSendTransactionsResult {
            calls += "sign_and_send"; return MobileWalletAdapterClient.SignAndSendTransactionsResult(arrayOf(onSend()))
        }
        override suspend fun signTransactions(transactions: Array<ByteArray>): MobileWalletAdapterClient.SignPayloadsResult {
            calls += "sign"; return MobileWalletAdapterClient.SignPayloadsResult(arrayOf(onSign(transactions.single())))
        }
        /** The 0.5.1 gate. A spec-conformant wallet answers `features: []` here, which clientlib reads as "cannot send". */
        override suspend fun getCapabilities(): MobileWalletAdapterClient.GetCapabilitiesResult { calls += "get_capabilities"; throw AssertionError("get_capabilities must never gate a payment") }
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, rpcCluster: RpcCluster) = error("unused")
        override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, chain: String, authToken: String?, features: Array<String>?,
                                       addresses: Array<ByteArray>?, signInPayload: SignInWithSolana.Payload?) = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri: Uri, iconUri: Uri, identityName: String, authToken: String) = error("unused")
        override suspend fun deauthorize(authToken: String) = error("unused")
        override suspend fun signMessages(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
        override suspend fun signMessagesDetached(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
    }

    /** One association as [WalletLogin.pay] runs it: the block inside, then the PRODUCTION mapping of how the
     * association ended ([walletPaymentOutcome]) — a test-local copy of that mapping is what a reviewer flagged.
     * Only ktx is imitated: 2.0.7 converts a runtime, execution, cancellation or interruption failure of the block
     * into a Failure result and lets checked exceptions escape `transact`. */
    private fun pay(wallet: FakeWallet, account: ByteArray? = fixture.publicKey, flight: WalletPayFlight = WalletPayFlight(), guard: () -> Unit = {},
                    onSent: (ByteArray) -> Unit = {}, onSigned: ((ByteArray) -> Unit)? = null): WalletPayment {
        var escaped: Exception? = null
        val result: TransactionResult<WalletPayment>? = try { TransactionResult.Success(runBlocking { wallet.payInSession(flight, account, fixture.unsigned, fixture.wallet, guard, onSent, onSigned) }) }
            catch (e: Exception) { if (e is RuntimeException || e is ExecutionException || e is InterruptedException) TransactionResult.Failure("PRIVATE ktx text", e) else { escaped = e; null } }
        return walletPaymentOutcome(flight, result, escaped)
    }
    private fun failure(wallet: FakeWallet, account: ByteArray? = fixture.publicKey) = assertThrows(WalletPaymentException::class.java) { pay(wallet, account) }

    @Test fun `opt-in returned signature is persisted before post-wallet session guard`() {
        var changed = false; var recorded: ByteArray? = null
        val wallet = FakeWallet(onSend = { throw wrapped(-32601) }, onSign = { changed = true; fixture.signedUnchanged })
        assertThrows(WalletPaymentException::class.java) { pay(wallet, guard = { if (changed) throw CancellationException("changed") },
            onSigned = { bytes ->
                recorded = paymentTransactionSignature(fixture.unsigned, bytes, fixture.wallet)
                semanticPaymentSignature(fixture.unsigned, bytes, fixture.wallet)
            }) }
        assertArrayEquals(fixture.signedUnchanged.copyOfRange(1, 65), recorded)
    }
    @Test fun `opt-in persistence failure prevents signed-only result returning for relay`() {
        val wallet = FakeWallet(onSend = { throw wrapped(-32601) }, onSign = { fixture.signedUnchanged })
        assertThrows(WalletPaymentException::class.java) { pay(wallet, onSigned = { throw IOException("journal unavailable") }) }
        assertEquals(listOf("sign_and_send", "sign"), wallet.calls)
    }

    @Test fun `the wallet's own send is called first and unconditionally, never behind get_capabilities`() {
        val wallet = FakeWallet(onSend = { ByteArray(64) { 7 } })
        val paid = pay(wallet)
        assertTrue(paid is WalletPayment.Sent); assertArrayEquals(ByteArray(64) { 7 }, paid.signature)
        assertEquals("a wallet whose capabilities reply lists no features must still be asked to send", listOf("sign_and_send"), wallet.calls)
    }

    @Test fun `a wrapped decline is a refusal before broadcast, so the purchase stays payable`() {
        val wallet = FakeWallet(onSend = { throw wrapped(-3) })
        val e = failure(wallet)
        assertTrue("0.5.2 read the ExecutionException wrapper and called this uncertain", e.refusedBeforeBroadcast)
        assertEquals(WalletFailureReason(WalletFailureKind.NOT_SIGNED, -3, WalletPayStage.SEND), e.reason)
        assertEquals("[send:-3]", e.reason!!.token); assertEquals(listOf("sign_and_send"), wallet.calls)
        assertFalse(e.detail.contains("PRIVATE")); assertFalse(e.message!!.contains("PRIVATE"))
    }

    @Test fun `every wrapped MWA code at the send stage gets its exact verdict`() {
        // Refused by an explicit wallet answer that precedes any signature; -2 and -32601 continue in the same session instead.
        for ((code, kind) in listOf(-1 to WalletFailureKind.AUTHORIZATION_FAILED, -3 to WalletFailureKind.NOT_SIGNED)) {
            val e = failure(FakeWallet(onSend = { throw wrapped(code) }))
            assertTrue("code $code", e.refusedBeforeBroadcast); assertEquals(WalletFailureReason(kind, code.toLong(), WalletPayStage.SEND), e.reason)
        }
        // -4: the wallet signed, and its send may have propagated. -7 and unknown codes are no explicit pre-signature refusal.
        for ((code, kind) in listOf(-4 to WalletFailureKind.NOT_SUBMITTED, -7 to WalletFailureKind.CLUSTER_NOT_SUPPORTED, -32000 to WalletFailureKind.REMOTE_ERROR)) {
            val wallet = FakeWallet(onSend = { throw wrapped(code) }); val e = failure(wallet)
            assertFalse("code $code must never invite a second payment", e.refusedBeforeBroadcast)
            assertEquals(WalletFailureReason(kind, code.toLong(), WalletPayStage.SEND), e.reason); assertEquals("[send:$code]", e.reason!!.token)
            assertEquals("an uncertain outcome never re-prompts", listOf("sign_and_send"), wallet.calls)
        }
        // Transport endings after the send call started prove nothing either way.
        for (cause in listOf<Exception>(TimeoutException("PRIVATE"), IOException("PRIVATE"), CancellationException("Request was cancelled"), ExecutionException(IOException("PRIVATE")))) {
            val wallet = FakeWallet(onSend = { throw cause }); val e = failure(wallet)
            assertFalse(cause.javaClass.simpleName, e.refusedBeforeBroadcast); assertEquals(WalletPayStage.SEND, e.reason?.stage); assertEquals(listOf("sign_and_send"), wallet.calls)
        }
        // A malformed reply AFTER the wallet answered the send is uncertain: it may already be on the network.
        val malformed = assertThrows(WalletPaymentException::class.java) { pay(FakeWallet(onSend = { ByteArray(12) }), onSent = { fail("a malformed reply is no payment identity") }) }
        assertFalse(malformed.refusedBeforeBroadcast); assertEquals(WalletFailureReason(WalletFailureKind.INVALID_RESPONSE, stage = WalletPayStage.SEND), malformed.reason)
    }

    @Test fun `any failure before the send call is a refusal, whatever the code`() {
        // Association and authorize: the payment block never ran, so the flight is still at AUTHORIZE.
        for (code in listOf(-1, -2, -3, -4, -7, -32601)) {
            val e = walletPaymentFailure(WalletPayFlight(), wrapped(code))
            assertTrue("authorize $code", e.refusedBeforeBroadcast); assertEquals(WalletPayStage.AUTHORIZE, e.reason?.stage); assertEquals("[authorize:$code]", e.reason!!.token)
        }
        assertEquals("-32601 outside the two signing calls is not given a signing meaning", WalletFailureKind.REMOTE_ERROR, walletPaymentFailure(WalletPayFlight(), wrapped(-32601)).reason?.kind)
        val network = walletPaymentFailure(WalletPayFlight(), wrapped(-7))
        assertEquals(WalletFailureKind.CLUSTER_NOT_SUPPORTED, network.reason?.kind)
        assertTrue("the player is told how to fix a devnet refusal", network.detail.contains("enable Devnet/Testnet mode in the wallet"))
        for (cause in listOf<Exception>(TimeoutException("Timed out waiting to send association intent"), IOException("IO error while sending operation"), CancellationException("Request was cancelled")))
            assertTrue("0.5.2 stranded the purchase on ${cause.javaClass.simpleName} during authorize", walletPaymentFailure(WalletPayFlight(), cause).refusedBeforeBroadcast)
        val none = walletPaymentFailure(WalletPayFlight(), null, noWalletFound = true)
        assertTrue(none.refusedBeforeBroadcast); assertEquals("[authorize:NOT_FOUND]", none.reason!!.token)
        // The account check runs inside the block, strictly before the send.
        val other = FakeWallet(onSend = { error("must not send to another account") })
        val mismatch = failure(other, account = ByteArray(32) { 9 })
        assertTrue(mismatch.refusedBeforeBroadcast); assertEquals(WalletFailureReason(WalletFailureKind.ACCOUNT_MISMATCH, stage = WalletPayStage.ACCOUNT_CHECK), mismatch.reason)
        assertEquals("[account:ACCOUNT_MISMATCH]", mismatch.reason!!.token); assertTrue(other.calls.isEmpty())
        val missing = failure(FakeWallet(onSend = { error("no account") }), account = null)
        assertTrue(missing.refusedBeforeBroadcast); assertEquals(WalletFailureKind.INVALID_RESPONSE, missing.reason?.kind)
    }

    @Test fun `method-not-found or a rejected payload continues by signing in the same session`() {
        for ((code, kind) in listOf(-32601 to WalletFailureKind.METHOD_NOT_FOUND_SEND, -2 to WalletFailureKind.INVALID_PAYLOADS)) {
            val wallet = FakeWallet(onSend = { throw wrapped(code) }, onSign = { assertArrayEquals(fixture.unsigned, it); fixture.signedWithComputeBudget })
            val paid = pay(wallet, onSent = { fail("the wallet sent nothing") }) as WalletPayment.SignedOnly
            assertEquals("one association: the send, then the signature", listOf("sign_and_send", "sign"), wallet.calls)
            assertEquals(WalletFailureReason(kind, code.toLong(), WalletPayStage.SEND), paid.sendRefusal)
            assertEquals(TransactionMutation.COMPUTE_BUDGET_ADDED, paid.mutation)
            assertArrayEquals("the RETURNED bytes are what gets relayed", fixture.signedWithComputeBudget, paid.signedTransaction)
            assertArrayEquals(fixture.signedWithComputeBudget.copyOfRange(1, 65), paid.signature)
        }
        // An unwrapped remote exception (should ktx ever stop wrapping) is read the same way.
        val bare = FakeWallet(onSend = { throw remote(-32601) }, onSign = { fixture.signedUnchanged })
        assertEquals(TransactionMutation.NONE, (pay(bare) as WalletPayment.SignedOnly).mutation)
    }

    @Test fun `every failure of the same-session signature is a refusal that names both steps`() {
        for ((code, kind) in listOf(-1 to WalletFailureKind.AUTHORIZATION_FAILED, -2 to WalletFailureKind.INVALID_PAYLOADS, -3 to WalletFailureKind.NOT_SIGNED,
                                    -4 to WalletFailureKind.NOT_SUBMITTED, -7 to WalletFailureKind.CLUSTER_NOT_SUPPORTED, -32601 to WalletFailureKind.METHOD_NOT_FOUND_SIGN)) {
            val wallet = FakeWallet(onSend = { throw wrapped(-32601) }, onSign = { throw wrapped(code) }); val e = failure(wallet)
            assertTrue("sign_transactions never broadcasts and nothing was relayed ($code)", e.refusedBeforeBroadcast)
            assertEquals(kind, e.reason?.kind); assertEquals(WalletPayStage.SIGN, e.reason?.stage)
            assertEquals("[send:-32601 > sign:$code]", e.reason!!.token)
            assertEquals(listOf(WalletFailureKind.METHOD_NOT_FOUND_SEND, kind), e.reason!!.chain.map { it.kind })
        }
        for (cause in listOf<Exception>(TimeoutException("PRIVATE"), IOException("PRIVATE")))
            assertTrue(failure(FakeWallet(onSend = { throw wrapped(-2) }, onSign = { throw cause })).refusedBeforeBroadcast)
        // A signed reply that fails the semantic check was never relayed.
        val tampered = failure(FakeWallet(onSend = { throw wrapped(-32601) }, onSign = { fixture.signed(fixture.transfers(sellerLamports = 190001)) }))
        assertTrue(tampered.refusedBeforeBroadcast); assertEquals("[send:-32601 > validate:TX_INSTRUCTIONS_CHANGED]", tampered.reason!!.token)
        assertEquals("the wallet changed the reviewed payment instructions [send:-32601 > validate:TX_INSTRUCTIONS_CHANGED]", tampered.detail)
        // A validly signed reply whose added priority fee could drain the fee payer is refused the same way.
        val greedy = failure(FakeWallet(onSend = { throw wrapped(-32601) }, onSign = { fixture.signed(listOf(fixture.unitPrice(50_000_000_000), fixture.unitLimit(1_400_000)) + fixture.transfers()) }))
        assertTrue(greedy.refusedBeforeBroadcast); assertEquals("[send:-32601 > validate:TX_PRIORITY_FEE_TOO_HIGH]", greedy.reason!!.token)
    }

    /** Reviewer note 2026-09-18, confirmed with javap on clientlib-ktx 2.0.7 (`MobileWalletAdapter$associate$2$2`):
     * after the block returns, `scenario.close().get(10000 ms)` runs outside the exception table and the outer
     * `associate` does not catch TimeoutException, so a wallet slow to disconnect threw out of `transact`. The
     * signature travelled only in the block's return value, so a KNOWN broadcast became "uncertain". */
    @Test fun `a session that ends badly after the send answered keeps the known signature and has already journalled it`() {
        val signature = ByteArray(64) { 7 }
        for (ending in listOf<Exception>(TimeoutException("PRIVATE close timed out"), ExecutionException(IOException("PRIVATE")), CancellationException("Request was cancelled"))) {
            val flight = WalletPayFlight(); val journal = mutableListOf<ByteArray>()
            runBlocking { FakeWallet(onSend = { signature }).payInSession(flight, fixture.publicKey, fixture.unsigned, fixture.wallet, {}, { journal += it }) }
            assertEquals("handed over inside the association, exactly once", 1, journal.size); assertArrayEquals(signature, journal.single())
            // `transact` then threw (its close timeout is checked, so it escapes) or answered a Failure (what ktx converts).
            for (paid in listOf(walletPaymentOutcome(flight, null, ending), walletPaymentOutcome(flight, TransactionResult.Failure("PRIVATE", ending), null))) {
                assertTrue("${ending.javaClass.simpleName}: the broadcast is known, so this is no uncertain failure", paid is WalletPayment.Sent); assertArrayEquals(signature, paid.signature)
            }
        }
        // Without a signature the same endings keep their stage's verdict.
        val sending = WalletPayFlight().also { it.stage = WalletPayStage.SEND }
        val lost = assertThrows(WalletPaymentException::class.java) { walletPaymentOutcome(sending, null, TimeoutException("PRIVATE")) }
        assertFalse(lost.refusedBeforeBroadcast); assertEquals(WalletFailureReason(WalletFailureKind.TIMEOUT, stage = WalletPayStage.SEND), lost.reason)
        assertTrue(assertThrows(WalletPaymentException::class.java) { walletPaymentOutcome(WalletPayFlight(), null, TimeoutException("PRIVATE")) }.refusedBeforeBroadcast)
        val none = assertThrows(WalletPaymentException::class.java) { walletPaymentOutcome(WalletPayFlight(), TransactionResult.NoWalletFound("PRIVATE"), null) }
        assertTrue(none.refusedBeforeBroadcast); assertEquals("[authorize:NOT_FOUND]", none.reason!!.token)
        val declined = assertThrows(WalletPaymentException::class.java) { walletPaymentOutcome(sending, TransactionResult.Failure("PRIVATE", wrapped(-3)), null) }
        assertTrue(declined.refusedBeforeBroadcast); assertEquals("[send:-3]", declined.reason!!.token); assertFalse(declined.message!!.contains("PRIVATE"))
    }

    /** In [WalletLogin.pay] a real identity or session change is rethrown as cancellation by the guard that follows
     * the association. A cancellation that is only the wallet session ending is judged like any other ending.
     *
     * REWRITTEN 2026-09-18: this pinned "the guard fails after the send returned, so the payment is an uncertain
     * failure". The send's signature is now handed to the journal BEFORE that guard (the rail's own order: persist,
     * then guard), so the broadcast is known and the step's result is Sent. Uncertain is kept for a reply that
     * carried no usable signature. */
    @Test fun `a cancelled wallet session is judged by the stage it interrupted`() {
        var calls = 0; val journal = mutableListOf<ByteArray>()
        val wallet = FakeWallet(onSend = { ByteArray(64) { 7 } })
        // The guard runs on entry and again after the wallet answered; the second one throws here.
        val paid = pay(wallet, guard = { if (++calls == 2) { assertEquals("journalled before the guard can interrupt", 1, journal.size); throw CancellationException("identity changed") } }, onSent = { journal += it })
        assertTrue("after the send returned nothing may be called a refusal, and a known signature is not a failure", paid is WalletPayment.Sent)
        assertArrayEquals(ByteArray(64) { 7 }, paid.signature); assertEquals(2, calls)
        calls = 0
        val e = assertThrows(WalletPaymentException::class.java) { pay(FakeWallet(onSend = { ByteArray(12) }), guard = { if (++calls == 2) throw CancellationException("identity changed") }) }
        assertFalse("no usable signature: still uncertain, never a refusal", e.refusedBeforeBroadcast); assertEquals(WalletPayStage.SEND, e.reason?.stage)
        val before = assertThrows(WalletPaymentException::class.java) { pay(FakeWallet(onSend = { error("no send") }), guard = { throw CancellationException("identity changed") }) }
        assertTrue(before.refusedBeforeBroadcast); assertEquals(WalletPayStage.ACCOUNT_CHECK, before.reason?.stage)
    }
}
