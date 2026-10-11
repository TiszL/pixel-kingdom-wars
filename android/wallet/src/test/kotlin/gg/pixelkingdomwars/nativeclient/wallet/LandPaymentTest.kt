package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.protocol.JsonRpc20Client
import com.solana.mobilewalletadapter.common.ProtocolContract
import java.math.BigInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The land payment is priced with exact lamports (payment + fee + Player PDA rent) from RPC reads
 * before any wallet prompt, and the RPC layer never turns an error or a float into a balance. */
class LandPaymentTest {
    private val wallet = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val reference = "5Mx9V8mMkkdVDrMjAZGkYgutxSmxUdTPR846Q1okAgro"
    private val blockhash = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"
    private fun rpc(calls: MutableList<String>, accountExists: Boolean = false, balance: String = "9007199254740993") = SolanaRpc { request ->
        val method = request["method"]!!.jsonPrimitive.content; calls += method
        val params = request["params"]!!.jsonArray
        buildJsonObject { put("jsonrpc", "2.0"); put("id", request["id"]!!); put("result", when (method) {
            "getLatestBlockhash" -> buildJsonObject { put("context", buildJsonObject { put("slot", 1) }); put("value", buildJsonObject { put("blockhash", blockhash); put("lastValidBlockHeight", 10) }) }
            "getBalance" -> { assertEquals(wallet, params[0].jsonPrimitive.content); buildJsonObject { put("value", JsonPrimitive(BigInteger(balance))) } }
            "getAccountInfo" -> { assertEquals("4fNQ1oioZwdDuDe61ovHksuzQrtFccUZjmXRw7YG3JcM", params[0].jsonPrimitive.content); buildJsonObject { put("value", if (accountExists) buildJsonObject { put("lamports", 1) } else JsonNull) } }
            "getMinimumBalanceForRentExemption" -> { assertEquals(51, params[0].jsonPrimitive.int); JsonPrimitive(1246920) }
            "getFeeForMessage" -> { assertTrue(params[0].jsonPrimitive.content.isNotEmpty()); buildJsonObject { put("value", 5000) } }
            else -> error("Unexpected $method")
        }) }
    }

    @Test fun `entry adds the Player PDA rent only when the account does not exist yet`() = runBlocking {
        val calls = mutableListOf<String>()
        val prepared = LandPayment.prepare(rpc(calls), ChainAddresses.DEVNET, wallet, reference, "entry", BigInteger.valueOf(200_000_000))
        assertEquals(listOf("getLatestBlockhash", "getBalance", "getAccountInfo", "getMinimumBalanceForRentExemption", "getFeeForMessage"), calls)
        assertEquals(BigInteger.valueOf(200_000_000 + 5000 + 1246920), prepared.estimate.requiredLamports); assertTrue(prepared.estimate.funded)
        validateTransactionSigner(prepared.transaction, wallet)
        assertArrayEquals(prepared.message, prepared.transaction.copyOfRange(65, prepared.transaction.size))
        val existing = mutableListOf<String>()
        val again = LandPayment.prepare(rpc(existing, accountExists = true, balance = "200004999"), ChainAddresses.DEVNET, wallet, reference, "entry", BigInteger.valueOf(200_000_000))
        assertEquals(BigInteger.ZERO, again.estimate.accountRentLamports); assertFalse("One lamport short is not funded", again.estimate.funded)
        assertFalse(existing.contains("getMinimumBalanceForRentExemption"))
    }
    @Test fun `a deed pays no rent and refuses a missing price or unknown kind`() = runBlocking {
        val calls = mutableListOf<String>()
        val prepared = LandPayment.prepare(rpc(calls), ChainAddresses.DEVNET, wallet, reference, "deed", BigInteger.valueOf(200_000_000))
        assertEquals(listOf("getLatestBlockhash", "getBalance", "getFeeForMessage"), calls)
        assertEquals(BigInteger.valueOf(200_005_000), prepared.estimate.requiredLamports)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { LandPayment.prepare(rpc(mutableListOf()), ChainAddresses.DEVNET, wallet, reference, "deed", BigInteger.ZERO) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { LandPayment.prepare(rpc(mutableListOf()), ChainAddresses.DEVNET, wallet, reference, "energy", BigInteger.TEN) } }
        Unit
    }
    @Test fun `rpc errors, missing results and non integer values never become a funding estimate`() = runBlocking {
        val failing = SolanaRpc { buildJsonObject { put("jsonrpc", "2.0"); put("error", buildJsonObject { put("code", -32005); put("message", "Node is behind") }) } }
        val error = assertThrows(SolanaRpcException::class.java) { runBlocking { failing.latestBlockhash() } }
        assertEquals(-32005L, error.code); assertEquals("Node is behind", error.message)
        val empty = SolanaRpc { buildJsonObject { put("jsonrpc", "2.0") } }
        assertThrows(SolanaRpcException::class.java) { runBlocking { empty.balanceLamports(wallet) } }
        val fractional = SolanaRpc { buildJsonObject { put("result", buildJsonObject { put("value", 1.5) }) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { fractional.balanceLamports(wallet) } }
        val nullFee = SolanaRpc { buildJsonObject { put("result", buildJsonObject { put("value", JsonNull) }) } }
        assertThrows(SolanaRpcException::class.java) { runBlocking { nullFee.feeForMessage(ByteArray(3)) } }
        val exact = SolanaRpc { buildJsonObject { put("result", buildJsonObject { put("value", JsonPrimitive(BigInteger("18446744073709551615"))) }) } }
        assertEquals(BigInteger("18446744073709551615"), exact.balanceLamports(wallet))
    }
    /** Web `paymentRefusedBeforeBroadcast`: a refusal reopens PAY and clears the durable submitted marker,
     * so misclassifying a post-broadcast failure as a refusal lets a repeatable buy_sink be signed twice
     * (double SOL charge), while misclassifying a decline as uncertain strands the purchase. The verdict is read
     * from the STAGE the payment reached and the UNWRAPPED wallet code: before 2026-09-18 it was read from the
     * exception class alone, and clientlib-ktx 2.0.7 wraps every wallet error in an ExecutionException, so every
     * wallet answer — even a plain decline — read as uncertain. */
    @Test fun `only an explicit pre broadcast decline permits a new signature, every post send failure stays uncertain`() {
        fun remote(code: Int) = java.util.concurrent.ExecutionException("wrapper", JsonRpc20Client.JsonRpc20RemoteException(code, "wallet says no", null))
        val send = WalletPayStage.SEND
        // The wallet's own pre-signing refusals of the send call.
        assertTrue("ERROR_NOT_SIGNED: the player declined in the wallet", refusedBeforeBroadcast(send, remote(ProtocolContract.ERROR_NOT_SIGNED)))
        assertTrue("ERROR_AUTHORIZATION_FAILED: the wallet refused to act on this token", refusedBeforeBroadcast(send, remote(ProtocolContract.ERROR_AUTHORIZATION_FAILED)))
        assertTrue("ERROR_INVALID_PAYLOADS: the wallet rejected the transaction before signing", refusedBeforeBroadcast(send, remote(ProtocolContract.ERROR_INVALID_PAYLOADS)))
        assertTrue("method not found: the wallet executed nothing", refusedBeforeBroadcast(send, remote(JSON_RPC_METHOD_NOT_FOUND)))
        // Everything that can follow a broadcast: the wallet signed but reports the send as not submitted,
        // a malformed signatures payload failing our shape checks after the send returned, a guard()
        // cancellation after the send returned, I/O, timeouts and unknown remote codes.
        assertFalse("ERROR_NOT_SUBMITTED means the wallet signed; its send may have propagated", refusedBeforeBroadcast(send, remote(ProtocolContract.ERROR_NOT_SUBMITTED)))
        assertFalse("A post-send shape check is not a wallet decline", refusedBeforeBroadcast(send, IllegalStateException("The wallet returned an invalid payment response")))
        assertFalse(refusedBeforeBroadcast(send, IllegalArgumentException("The wallet returned an invalid payment signature")))
        assertFalse("A cancelled association after the send call proves nothing", refusedBeforeBroadcast(send, kotlinx.coroutines.CancellationException("declined")))
        assertFalse(refusedBeforeBroadcast(send, java.util.concurrent.CancellationException("Request was cancelled")))
        assertFalse(refusedBeforeBroadcast(send, null)); assertFalse(refusedBeforeBroadcast(send, java.io.IOException("socket closed")))
        assertFalse(refusedBeforeBroadcast(send, java.util.concurrent.TimeoutException("Timed out while waiting for result")))
        assertFalse(refusedBeforeBroadcast(send, remote(ProtocolContract.ERROR_CLUSTER_NOT_SUPPORTED))); assertFalse(refusedBeforeBroadcast(send, remote(-32000)))
        assertFalse("this app's relay may have reached the network", refusedBeforeBroadcast(WalletPayStage.RELAY, java.io.IOException("lost")))
        // Before the send call, and on the sign-only path before this app relays, nothing can have been broadcast.
        for (stage in listOf(WalletPayStage.AUTHORIZE, WalletPayStage.ACCOUNT_CHECK, WalletPayStage.SIGN, WalletPayStage.VALIDATE)) {
            assertTrue(stage.name, refusedBeforeBroadcast(stage, java.util.concurrent.TimeoutException("Timed out waiting to send association intent")))
            assertTrue(stage.name, refusedBeforeBroadcast(stage, remote(ProtocolContract.ERROR_NOT_SUBMITTED))); assertTrue(stage.name, refusedBeforeBroadcast(stage, null))
        }
        // Copy follows the classification: refusals invite another tap, everything else announces the reference check.
        fun notice(stage: WalletPayStage, cause: Throwable) = walletPaymentFailure(WalletPayFlight().also { it.stage = stage }, cause).message!!
        assertTrue(notice(send, remote(ProtocolContract.ERROR_NOT_SIGNED)).startsWith("Payment cancelled"))
        assertTrue(notice(WalletPayStage.ACCOUNT_CHECK, WalletRefusedException("Approve with the same wallet")).startsWith("Payment cancelled"))
        assertTrue(notice(send, IllegalStateException("The wallet returned an invalid payment response")).contains("checking your payment"))
        assertTrue(notice(send, remote(ProtocolContract.ERROR_NOT_SUBMITTED)).contains("checking your payment"))
        assertTrue(notice(send, java.io.IOException("lost")).contains("checking your payment"))
        assertTrue(WalletPaymentException("Payment cancelled", refusedBeforeBroadcast = true).refusedBeforeBroadcast)
    }
}
