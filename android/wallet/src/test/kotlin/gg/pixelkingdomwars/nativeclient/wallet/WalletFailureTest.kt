package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.protocol.JsonRpc20Client
import com.solana.mobilewalletadapter.common.ProtocolContract
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import org.junit.Assert.*
import org.junit.Test

/** Incident 2026-09-17 (store build 0.5.0 on a physical Seeker): every SOL payment ended in one generic
 * "Wallet declined before sending" line, so nobody could tell whether the wallet rejected the payload, refused
 * the saved token, answered with another account or the player declined. The classification below is what the
 * notice and the diagnostics channel now carry; it reads only classes and JSON-RPC codes, never wallet text. */
class WalletFailureTest {
    private fun remote(code: Int) = JsonRpc20Client.JsonRpc20RemoteException(code, "PRIVATE wallet text", "PRIVATE data")

    @Test fun `every MWA protocol code names its own kind and always carries its number`() {
        for ((code, kind) in listOf(ProtocolContract.ERROR_AUTHORIZATION_FAILED to WalletFailureKind.AUTHORIZATION_FAILED, ProtocolContract.ERROR_INVALID_PAYLOADS to WalletFailureKind.INVALID_PAYLOADS,
                                    ProtocolContract.ERROR_NOT_SIGNED to WalletFailureKind.NOT_SIGNED, ProtocolContract.ERROR_NOT_SUBMITTED to WalletFailureKind.NOT_SUBMITTED,
                                    ProtocolContract.ERROR_CLUSTER_NOT_SUPPORTED to WalletFailureKind.CLUSTER_NOT_SUPPORTED)) {
            assertEquals(WalletFailureReason(kind, code.toLong()), walletFailureReason(remote(code)))
            // clientlib-ktx 2.0.7 wraps EVERY wallet error in the future's ExecutionException; the reading is the same.
            assertEquals(WalletFailureReason(kind, code.toLong(), WalletPayStage.SEND), walletFailureReason(ExecutionException("PRIVATE", remote(code)), WalletPayStage.SEND))
        }
        // -32601 means "no such method": which method is known only from the stage that asked.
        assertEquals(WalletFailureReason(WalletFailureKind.METHOD_NOT_FOUND_SEND, -32601, WalletPayStage.SEND), walletFailureReason(ExecutionException(remote(-32601)), WalletPayStage.SEND))
        assertEquals(WalletFailureReason(WalletFailureKind.METHOD_NOT_FOUND_SIGN, -32601, WalletPayStage.SIGN), walletFailureReason(ExecutionException(remote(-32601)), WalletPayStage.SIGN))
        val elsewhere = walletFailureReason(remote(-32601))
        assertEquals(WalletFailureKind.REMOTE_ERROR, elsewhere.kind); assertEquals(-32601L, elsewhere.code)
        assertEquals("the wallet returned an error [-32601]", elsewhere.notice)
    }
    @Test fun `app checks, association failures and the relay each map to a fixed kind`() {
        assertEquals(WalletFailureKind.ACCOUNT_MISMATCH, walletFailureReason(WalletRefusedException("Approve with the same wallet")).kind)
        assertEquals(WalletFailureKind.INVALID_RESPONSE, walletFailureReason(WalletRefusedException("no account", WalletFailureKind.INVALID_RESPONSE)).kind)
        assertEquals(WalletFailureKind.TX_BLOCKHASH_CHANGED, walletFailureReason(SignedTransactionRejected(WalletFailureKind.TX_BLOCKHASH_CHANGED, "PRIVATE")).kind)
        assertEquals(WalletFailureKind.TIMEOUT, walletFailureReason(TimeoutException("Timed out while waiting for result")).kind)
        assertEquals(WalletFailureKind.INTERRUPTED, walletFailureReason(java.util.concurrent.CancellationException("Request was cancelled")).kind)
        assertEquals(WalletFailureKind.INTERRUPTED, walletFailureReason(kotlinx.coroutines.CancellationException("declined")).kind)
        assertEquals(WalletFailureKind.INTERRUPTED, walletFailureReason(IOException("socket closed")).kind)
        assertEquals(WalletFailureKind.INVALID_RESPONSE, walletFailureReason(IllegalStateException("The wallet returned an invalid payment response")).kind)
        assertEquals(WalletFailureKind.INVALID_RESPONSE, walletFailureReason(IllegalArgumentException("The wallet changed the reviewed transaction")).kind)
        assertEquals(WalletFailureReason(WalletFailureKind.RPC_REJECTED, -32002, WalletPayStage.RELAY), walletFailureReason(SolanaRpcException("RPC request was rejected", -32002), WalletPayStage.RELAY))
        assertEquals(WalletFailureKind.UNKNOWN, walletFailureReason(null).kind)
        assertEquals(WalletFailureKind.UNKNOWN, walletFailureReason(RuntimeException("PRIVATE")).kind)
        // A rewrapped payment exception keeps the wallet step's classification instead of re-guessing from its class.
        val carried = WalletPaymentException("generic", true, reason = WalletFailureReason(WalletFailureKind.NOT_SIGNED, -3, WalletPayStage.SEND))
        assertEquals(carried.reason, walletFailureReason(carried, WalletPayStage.RELAY))
        assertEquals(WalletFailureKind.UNKNOWN, walletFailureReason(WalletPaymentException("no reason", true)).kind)
    }
    /** Release builds strip device logs and telemetry carries only the kind, so the screen is the evidence: one
     * plain sentence plus a bracket token with the stage and the numeric code. */
    @Test fun `a notice is one plain sentence plus the stage and code token, never the wallet's or a provider's text`() {
        for (cause in listOf<Throwable>(remote(-32000), remote(ProtocolContract.ERROR_NOT_SIGNED), ExecutionException("PRIVATE", remote(-3)), IOException("PRIVATE callback"), IllegalStateException("PRIVATE"))) {
            val reason = walletFailureReason(cause, WalletPayStage.SEND)
            assertFalse(reason.notice.contains("PRIVATE")); assertFalse(reason.kind.diagnostic.contains("PRIVATE"))
            assertTrue(reason.kind.diagnostic.startsWith("NATIVE_WALLET_")); assertTrue(reason.notice.endsWith(reason.token))
        }
        assertEquals(WalletFailureKind.entries.size, WalletFailureKind.entries.map { it.diagnostic }.toSet().size)
        for (kind in WalletFailureKind.entries) assertFalse("the code lives in the token, not the sentence: $kind", kind.notice.contains(Regex("-[0-9]")))
        assertEquals("[send:-3]", WalletFailureReason(WalletFailureKind.NOT_SIGNED, -3, WalletPayStage.SEND).token)
        assertEquals("[authorize:-7]", WalletFailureReason(WalletFailureKind.CLUSTER_NOT_SUPPORTED, -7, WalletPayStage.AUTHORIZE).token)
        assertEquals("[account:ACCOUNT_MISMATCH]", WalletFailureReason(WalletFailureKind.ACCOUNT_MISMATCH, stage = WalletPayStage.ACCOUNT_CHECK).token)
        val chained = WalletFailureReason(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, stage = WalletPayStage.VALIDATE, after = WalletFailureReason(WalletFailureKind.METHOD_NOT_FOUND_SEND, -32601, WalletPayStage.SEND))
        assertEquals("[send:-32601 > validate:TX_INSTRUCTIONS_CHANGED]", chained.token)
        assertEquals(listOf(WalletFailureKind.METHOD_NOT_FOUND_SEND, WalletFailureKind.TX_INSTRUCTIONS_CHANGED), chained.chain.map { it.kind })
        assertEquals("the wallet does not support this network — enable Devnet/Testnet mode in the wallet, then retry [authorize:-7]",
            WalletFailureReason(WalletFailureKind.CLUSTER_NOT_SUPPORTED, -7, WalletPayStage.AUTHORIZE).notice)
        val e = WalletPaymentException("Wallet confirmation was not completed.", true, reason = WalletFailureReason(WalletFailureKind.INVALID_PAYLOADS, -2, WalletPayStage.SIGN))
        assertEquals("the wallet rejected the transaction before signing it [sign:-2]", e.detail)
        assertEquals("Reconnect the existing game wallet.", WalletPaymentException("Reconnect the existing game wallet.", true).detail)
        assertEquals("Payment cancelled — your land is still reserved. Tap pay when ready. (the request was declined in the wallet [send:-3])",
            landPaymentNotice(true, WalletFailureReason(WalletFailureKind.NOT_SIGNED, -3, WalletPayStage.SEND)))
        assertTrue(landPaymentNotice(false, WalletFailureReason(WalletFailureKind.NOT_SUBMITTED, -4, WalletPayStage.SEND)).endsWith("(the wallet signed but reported that it did not send [send:-4])"))
    }
    /** 0.5.2 re-prompted through a SECOND association for -1, -2 and "unsupported". The fallback now lives inside
     * the one association and is allowed only where the wallet provably executed nothing (-32601) or rejected the
     * send payload before signing (-2); a decline, a refused authorization or anything uncertain never re-prompts. */
    @Test fun `only method-not-found or a rejected payload continues to the same-session signature`() {
        assertTrue(permitsSignOnlyFallback(ExecutionException(remote(JSON_RPC_METHOD_NOT_FOUND)))); assertTrue(permitsSignOnlyFallback(ExecutionException(remote(ProtocolContract.ERROR_INVALID_PAYLOADS))))
        assertTrue("an unwrapped remote error reads the same", permitsSignOnlyFallback(remote(JSON_RPC_METHOD_NOT_FOUND)))
        assertFalse("the player declined: never re-prompt", permitsSignOnlyFallback(ExecutionException(remote(ProtocolContract.ERROR_NOT_SIGNED))))
        assertFalse("a refused authorization needs a fresh association, which only the next explicit tap may open", permitsSignOnlyFallback(ExecutionException(remote(ProtocolContract.ERROR_AUTHORIZATION_FAILED))))
        assertFalse("signed, maybe sent", permitsSignOnlyFallback(ExecutionException(remote(ProtocolContract.ERROR_NOT_SUBMITTED))))
        assertFalse(permitsSignOnlyFallback(ExecutionException(remote(-32602)))); assertFalse(permitsSignOnlyFallback(ExecutionException(remote(ProtocolContract.ERROR_CLUSTER_NOT_SUPPORTED))))
        for (cause in listOf<Throwable?>(null, TimeoutException("x"), IOException("x"), IllegalStateException("x"), java.util.concurrent.CancellationException("x")))
            assertFalse(permitsSignOnlyFallback(cause))
    }
    /** Sign-in showed one generic sentence for every wallet answer, so a Phantom or Solflare user refused with -7
     * (Devnet mode off) had nothing to act on. A wallet step now names its reason; this app's own server round
     * trip keeps the generic line. */
    @Test fun `a failed sign-in names the wallet's classified reason and its token`() {
        assertEquals("Wallet sign-in could not complete — the wallet does not support this network — enable Devnet/Testnet mode in the wallet, then retry. Retry when ready. [authorize:-7]",
            sessionFailureNotice("Wallet sign-in", walletFailureReason(ExecutionException("PRIVATE", remote(-7)), WalletPayStage.AUTHORIZE)))
        assertEquals("Wallet confirmation could not complete — the request was declined in the wallet. Retry when ready. [sign:-3]",
            sessionFailureNotice("Wallet confirmation", walletFailureReason(ExecutionException(remote(-3)), WalletPayStage.SIGN)))
        assertEquals("Wallet sign-in was cancelled or could not complete. Retry when ready.", sessionFailureNotice("Wallet sign-in", null))
    }
    @Test fun `forgetting the paired wallet replaces the adapter instance and with it the remembered endpoint`() {
        var created = 0
        val pairing = WalletPairing { created++; Any() }
        val first = pairing.adapter; assertEquals(1, created)
        pairing.forget()
        assertNotSame(first, pairing.adapter); assertEquals(2, created)
        assertSame("reading the pairing does not create adapters", pairing.adapter, pairing.adapter); assertEquals(2, created)
    }

    /** MWA spec: an unimplemented method answers JSON-RPC -32601; the wallet executed nothing, so the other method
     * may be tried without a second signature risk. `sign_transactions` is the optional one, so the payment calls
     * the mandatory `sign_and_send_transactions` first and continues IN THE SAME SESSION on exactly this answer
     * (0.5.2 opened a second association for it, and never got here because the error arrives wrapped). */
    @Test fun `method-not-found is a provable pre-broadcast refusal that permits the same-session signature`() {
        assertTrue(refusedBeforeBroadcast(WalletPayStage.SEND, ExecutionException(remote(JSON_RPC_METHOD_NOT_FOUND))))
        assertTrue(refusedBeforeBroadcast(WalletPayStage.SEND, remote(JSON_RPC_METHOD_NOT_FOUND)))
        assertTrue(permitsSignOnlyFallback(ExecutionException(remote(JSON_RPC_METHOD_NOT_FOUND))))
        assertFalse("another JSON-RPC error is not 'no such method'", permitsSignOnlyFallback(ExecutionException(remote(-32602))))
        assertFalse(refusedBeforeBroadcast(WalletPayStage.SEND, ExecutionException(remote(-32602))))
    }
}
