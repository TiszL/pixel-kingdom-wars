package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Drives the exact helper used by WalletLogin's new association, with no Android or wallet process. */
class MiningClaimSignOnlyTest {
    private val f = MiningClaimFixture()
    private class Wallet(private val sign: (ByteArray) -> Array<ByteArray>) : AdapterOperations {
        val calls = mutableListOf<String>()
        override suspend fun signTransactions(transactions: Array<ByteArray>): MobileWalletAdapterClient.SignPayloadsResult {
            calls += "sign"; return MobileWalletAdapterClient.SignPayloadsResult(sign(transactions.single()))
        }
        override suspend fun signAndSendTransactions(transactions: Array<ByteArray>, params: TransactionParams): MobileWalletAdapterClient.SignAndSendTransactionsResult = error("Mining must never ask the wallet to send")
        override suspend fun getCapabilities(): MobileWalletAdapterClient.GetCapabilitiesResult = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, rpcCluster: RpcCluster) = error("unused")
        override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, chain: String, authToken: String?, features: Array<String>?, addresses: Array<ByteArray>?, signInPayload: SignInWithSolana.Payload?) = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri: Uri, iconUri: Uri, identityName: String, authToken: String) = error("unused")
        override suspend fun deauthorize(authToken: String) = error("unused")
        override suspend fun signMessages(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
        override suspend fun signMessagesDetached(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
    }
    @Test fun `one exact sign-only call retains full verified wire before any post-wallet guard`() = runBlocking {
        val order = mutableListOf<String>(); val prepared = f.prepared()
        val wallet = Wallet { bytes -> assertArrayEquals(prepared.unsignedTransaction(), bytes); order += "wallet"; arrayOf(f.wire) }
        val result = wallet.signMiningClaimInSession(prepared, publicKeyBytes(f.input.wallet), { order += "guard" }, { order += "retained"; assertEquals(f.signed, it) })
        assertEquals(f.signed, result); assertEquals(listOf("sign"), wallet.calls)
        assertEquals(listOf("guard", "wallet", "retained", "guard"), order)
    }
    @Test fun `session change after approval cannot discard the original signed wire`() {
        var changed = false; var retained: SignedMiningClaim? = null
        val wallet = Wallet { changed = true; arrayOf(f.wire) }
        assertThrows(CancellationException::class.java) { runBlocking {
            wallet.signMiningClaimInSession(f.prepared(), publicKeyBytes(f.input.wallet), { if (changed) throw CancellationException("changed") }, { retained = it })
        } }
        assertEquals(f.signed, retained); assertEquals(listOf("sign"), wallet.calls)
    }
    @Test fun `wrong authorized wallet and failed pre-sign admission cannot prompt the wallet`() {
        val wallet = Wallet { error("must not sign") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking {
            wallet.signMiningClaimInSession(f.prepared(), publicKeyBytes(f.trust.reserveOwner), {}, {})
        } }
        assertThrows(CancellationException::class.java) { runBlocking {
            wallet.signMiningClaimInSession(f.prepared(), publicKeyBytes(f.input.wallet), { throw CancellationException("paused") }, {})
        } }
        assertTrue(wallet.calls.isEmpty())
    }
    @Test fun `persistence failure prevents successful return without another signature or send`() {
        val wallet = Wallet { arrayOf(f.wire) }
        assertThrows(IOException::class.java) { runBlocking {
            wallet.signMiningClaimInSession(f.prepared(), publicKeyBytes(f.input.wallet), {}, { throw IOException("locked storage") })
        } }
        assertEquals(listOf("sign"), wallet.calls)
    }
    @Test fun `malformed oversized mutated and duplicate replies never reach the journal`() {
        listOf(arrayOf(ByteArray(1233)), arrayOf(f.wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }),
            arrayOf(f.wire, f.wire), emptyArray()).forEach { reply ->
            val wallet = Wallet { reply }
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                wallet.signMiningClaimInSession(f.prepared(), publicKeyBytes(f.input.wallet), {}, { fail("No valid original evidence") })
            } }
            assertEquals(listOf("sign"), wallet.calls)
        }
    }
}
