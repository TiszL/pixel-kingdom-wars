package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Seeker incidents 2026-09-17/18: the land rail depended on the wallet's own `signAndSendTransactions`, then
 * (0.5.1/0.5.2) retried a refused send through a SECOND wallet association. The payment is now ONE association
 * ([WalletLogin.pay]): the wallet either sent, or — after answering -32601 / -2 to the send — signed in the same
 * session and hands back checked bytes that this app broadcasts once through the session relay, signature
 * persisted first. The rail never opens the wallet a second time.
 *
 * REWRITTEN 2026-09-18: these tests pinned the two-call order (`send`, then a separate `sign` prompt). That order
 * is what made the fallback a second authorization and is deliberately gone; each test now encodes the same
 * money rule over the single wallet step. */
class LandPaymentWalletTest {
    private class Fixture {
        val unsigned: ByteArray = java.util.Base64.getDecoder().decode(marketWire().getValue("unsigned").jsonPrimitive.content)
        val events = mutableListOf<String>(); val reported = mutableListOf<WalletFailureKind>()
        /** The wallet step; its argument is the rail's `onSent`, which [WalletLogin.pay] calls inside the association. */
        var outcome: ((ByteArray) -> Unit) -> WalletPayment = { WalletPayment.Sent(ByteArray(64) { 7 }) }; var rpcFailure: Exception? = null
        var recorded: ByteArray? = null
        val wallet = LandPaymentWallet(
            WalletPayer { tx, cluster, owner, onSent ->
                events += "wallet"; assertArrayEquals(unsigned, tx); assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(WALLET, owner); outcome(onSent)
            },
            SolanaRpc { body ->
                events += "broadcast"; assertNotNull("persist before the single RPC send", recorded)
                assertEquals("sendTransaction", body["method"]!!.jsonPrimitive.content)
                val relayed = java.util.Base64.getDecoder().decode(body["params"]!!.jsonArray[0].jsonPrimitive.content)
                assertArrayEquals("the wallet's RETURNED bytes are relayed", signedOnly(unsigned).signedTransaction, relayed)
                rpcFailure?.let { throw it }; buildJsonObject { put("result", MARKET_SIGNATURE) }
            },
            report = { reported += it.kind })
        suspend fun pay() = wallet.signAndSend(unsigned, SolanaCluster.DEVNET, WALLET) { events += "persist"; recorded = it }
        fun refused(kind: WalletFailureKind, code: Long? = null, stage: WalletPayStage = WalletPayStage.SEND, refusedBeforeBroadcast: Boolean = true) =
            WalletPaymentException("wallet said so", refusedBeforeBroadcast, IllegalStateException("PRIVATE wallet text"), WalletFailureReason(kind, code, stage))
    }

    @Test fun `the wallet's own send is the first and only path when it succeeds, and its signature is persisted at once`() = runBlocking {
        val f = Fixture(); assertArrayEquals(ByteArray(64) { 7 }, f.pay())
        assertEquals(listOf("wallet", "persist"), f.events); assertTrue(f.reported.isEmpty()); assertArrayEquals(ByteArray(64) { 7 }, f.recorded)
    }
    /** Reviewer note 2026-09-18: the send's signature reached the journal only through the wallet step's RETURN
     * value, and clientlib-ktx 2.0.7 can throw out of `transact` after the wallet answered (its session close
     * timeout), so a KNOWN broadcast was dropped. The step now hands the signature over the moment the wallet
     * answers; whatever happens to the step afterwards, the journal already has it — once. */
    @Test fun `a signature handed over inside the wallet step is persisted at once, exactly once, whatever ends the step`() = runBlocking {
        val sent = ByteArray(64) { 7 }
        val f = Fixture(); f.outcome = { onSent -> onSent(sent); f.events += "session closed"; WalletPayment.Sent(sent) }
        assertArrayEquals(sent, f.pay())
        assertEquals("persisted before the association ended, and not a second time on return", listOf("wallet", "persist", "session closed"), f.events)
        val cancelled = Fixture(); cancelled.outcome = { onSent -> onSent(sent); throw CancellationException("identity changed while the wallet disconnected") }
        assertThrows(CancellationException::class.java) { runBlocking { cancelled.pay() } }
        assertArrayEquals("the known broadcast is in the journal although the step never returned", sent, cancelled.recorded)
        assertEquals(listOf("wallet", "persist"), cancelled.events)
        // A journal that failed inside the step is asked once more on return; its failure is this app's own and travels as it is.
        var attempts = 0
        val broken = Fixture(); broken.outcome = { onSent -> runCatching { onSent(sent) }; WalletPayment.Sent(sent) }
        val e = assertThrows(IOException::class.java) { runBlocking { broken.wallet.signAndSend(broken.unsigned, SolanaCluster.DEVNET, WALLET) { attempts++; throw IOException("journal storage failed") } } }
        assertEquals("journal storage failed", e.message); assertEquals(2, attempts); assertTrue(broken.reported.isEmpty())
    }
    @Test fun `a same-session signature is persisted before the one relay send, and the path that worked is recorded`() = runBlocking {
        for ((mutation, marker) in listOf(TransactionMutation.NONE to WalletFailureKind.FALLBACK_USED, TransactionMutation.COMPUTE_BUDGET_ADDED to WalletFailureKind.FALLBACK_USED_COMPUTE_BUDGET)) {
            val f = Fixture(); f.outcome = { signedOnly(f.unsigned, mutation = mutation) }
            assertEquals(MARKET_SIGNATURE, base58(f.pay()))
            assertEquals("ONE wallet step, never a second prompt", listOf("wallet", "persist", "broadcast"), f.events)
            assertEquals(MARKET_SIGNATURE, base58(requireNotNull(f.recorded)))
            assertEquals("diagnostics show why the fallback ran and that it succeeded", listOf(WalletFailureKind.METHOD_NOT_FOUND_SEND, marker), f.reported)
        }
    }
    @Test fun `the player's decline, an account mismatch, a missing wallet and a refused network never re-prompt and stay payable`() = runBlocking {
        for ((kind, stage) in listOf(WalletFailureKind.NOT_SIGNED to WalletPayStage.SEND, WalletFailureKind.ACCOUNT_MISMATCH to WalletPayStage.ACCOUNT_CHECK,
                                     WalletFailureKind.NOT_FOUND to WalletPayStage.AUTHORIZE, WalletFailureKind.CLUSTER_NOT_SUPPORTED to WalletPayStage.AUTHORIZE)) {
            val f = Fixture(); f.outcome = { throw f.refused(kind, stage = stage) }
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.pay() } }
            assertTrue("the wallet step's own verdict reaches the checkout unchanged", e.refusedBeforeBroadcast); assertEquals(WalletFailureReason(kind, stage = stage), e.reason)
            assertTrue(e.message!!.startsWith("Payment cancelled — your land is still reserved.")); assertFalse(e.message!!.contains("PRIVATE"))
            assertEquals(listOf("wallet"), f.events); assertEquals(listOf(kind), f.reported); assertNull(f.recorded)
        }
    }
    @Test fun `an uncertain wallet outcome is never retried and never called a refusal`() = runBlocking {
        for (kind in listOf(WalletFailureKind.NOT_SUBMITTED, WalletFailureKind.INTERRUPTED, WalletFailureKind.TIMEOUT)) {
            val f = Fixture(); f.outcome = { throw f.refused(kind, refusedBeforeBroadcast = false) }
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.pay() } }
            assertFalse(e.refusedBeforeBroadcast); assertTrue(e.message!!.startsWith("Wallet response was interrupted"))
            assertEquals(listOf("wallet"), f.events); assertNull(f.recorded)
        }
    }
    @Test fun `a refusal of the same-session signature stays a safe refusal naming both steps, and nothing was persisted or sent`() = runBlocking {
        val f = Fixture()
        f.outcome = { throw WalletPaymentException("x", true, reason = WalletFailureReason(WalletFailureKind.NOT_SIGNED, -3, WalletPayStage.SIGN, after = SEND_METHOD_NOT_FOUND)) }
        val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.pay() } }
        assertTrue(e.refusedBeforeBroadcast); assertEquals(WalletFailureKind.NOT_SIGNED, e.reason?.kind)
        assertEquals("Payment cancelled — your land is still reserved. Tap pay when ready. (the request was declined in the wallet [send:-32601 > sign:-3])", e.message)
        assertEquals(listOf("wallet"), f.events); assertNull(f.recorded)
        assertEquals("one diagnostics record per step", listOf(WalletFailureKind.METHOD_NOT_FOUND_SEND, WalletFailureKind.NOT_SIGNED), f.reported)
    }
    @Test fun `a lost relay reply after the persisted signature is uncertain and names the relay rejection`() = runBlocking {
        val f = Fixture(); f.outcome = { signedOnly(f.unsigned) }
        f.rpcFailure = SolanaRpcException("RPC request was rejected", -32002)
        val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.pay() } }
        assertFalse(e.refusedBeforeBroadcast); assertEquals(WalletFailureKind.RPC_REJECTED, e.reason?.kind)
        assertTrue(e.message!!.startsWith("Wallet response was interrupted")); assertTrue(e.message!!.endsWith("(the network relay rejected the signed transaction [send:-32601 > relay:-32002])"))
        assertEquals(MARKET_SIGNATURE, base58(requireNotNull(f.recorded))); assertEquals(listOf("wallet", "persist", "broadcast"), f.events)
        // A generic transport loss stays uncertain as well; the wallet is never opened again.
        val g = Fixture(); g.outcome = { signedOnly(g.unsigned) }; g.rpcFailure = IOException("lost response")
        assertFalse(assertThrows(WalletPaymentException::class.java) { runBlocking { g.pay() } }.refusedBeforeBroadcast)
        assertEquals(1, g.events.count { it == "wallet" }); assertFalse(g.reported.contains(WalletFailureKind.FALLBACK_USED))
    }
    @Test fun `a signed reply that changed the payment cannot be broadcast or persisted`() = runBlocking {
        val f = Fixture(); f.outcome = { throw tamperedReply() }
        val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet.signAndSend(f.unsigned, SolanaCluster.DEVNET, WALLET) { fail("nothing to persist") } } }
        assertTrue(e.refusedBeforeBroadcast); assertEquals(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, e.reason?.kind)
        assertTrue(e.message!!.endsWith("[send:-32601 > validate:TX_INSTRUCTIONS_CHANGED])")); assertFalse(f.events.contains("broadcast"))
    }
    /** A journal that cannot save the signature stops this app's relay. That is this app's failure: it keeps its
     * own message and is not reported as the wallet's. */
    @Test fun `a journal failure before the relay keeps its own message and is not a wallet failure`() = runBlocking {
        val f = Fixture(); f.outcome = { signedOnly(f.unsigned) }
        val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet.signAndSend(f.unsigned, SolanaCluster.DEVNET, WALLET) { throw IOException("journal storage failed") } } }
        assertTrue(e.refusedBeforeBroadcast); assertNull(e.reason); assertEquals("journal storage failed", e.message)
        assertFalse(f.events.contains("broadcast")); assertEquals("only the send refusal that led here was reported", listOf(WalletFailureKind.METHOD_NOT_FOUND_SEND), f.reported)
    }
    @Test fun `identity cancellation during the wallet step propagates as cancellation, not as a payment verdict`() = runBlocking {
        val f = Fixture(); f.outcome = { throw CancellationException("identity changed") }
        assertThrows(CancellationException::class.java) { runBlocking { f.pay() } }; assertNull(f.recorded); assertTrue(f.reported.isEmpty())
    }
}
