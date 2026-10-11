package gg.pixelkingdomwars.nativeclient.wallet

import android.net.Uri
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.RpcCluster
import com.solana.mobilewalletadapter.clientlib.TransactionParams
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Drives the exact helper used by WalletLogin's new association, with no Android or wallet process. */
class RealmSaleSignOnlyTest {
    private val raw = kotlinx.serialization.json.Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-crypto-fixtures.json")).readText()).jsonObject
    private val policy = raw.getValue("policy").jsonObject.let { p -> RealmSaleSigningPolicy(
        gg.pixelkingdomwars.nativeclient.realmsales.RealmSalesProtocolPolicy.from(kotlinx.serialization.json.JsonObject(p - "kingSpots" - "regularRealmCount")),
        p.getValue("kingSpots").jsonPrimitive.int, p.getValue("regularRealmCount").jsonPrimitive.int) }
    private val value = raw.getValue("fixtures").jsonArray.first().jsonObject
    private val p = gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePreparation.from(value.getValue("preparation").jsonObject, policy.protocol)
    private val wire = value.getValue("wire").jsonObject.getValue("signedTransactionHex").jsonPrimitive.content.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private val signed = SignedRealmSale(java.util.Base64.getEncoder().encodeToString(wire), value.getValue("wire").jsonObject.getValue("signature").jsonPrimitive.content)
    private suspend fun prepared() = RealmSaleTransaction.prepare(p, policy, RealmSaleSigningTrust(p.source.genesisHash,p.source.programId,p.terms.developer,p.source.programDataSha256,p.source.reviewedDeploymentSlot,p.source.revision))
    private class Wallet(private val sign: (ByteArray) -> Array<ByteArray>) : AdapterOperations {
        val calls = mutableListOf<String>()
        override suspend fun signTransactions(transactions: Array<ByteArray>): MobileWalletAdapterClient.SignPayloadsResult {
            calls += "sign"; return MobileWalletAdapterClient.SignPayloadsResult(sign(transactions.single()))
        }
        override suspend fun signAndSendTransactions(transactions: Array<ByteArray>, params: TransactionParams): MobileWalletAdapterClient.SignAndSendTransactionsResult = error("Realm sales must never ask the wallet to send")
        override suspend fun getCapabilities(): MobileWalletAdapterClient.GetCapabilitiesResult = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, rpcCluster: RpcCluster) = error("unused")
        override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, chain: String, authToken: String?, features: Array<String>?, addresses: Array<ByteArray>?, signInPayload: SignInWithSolana.Payload?) = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri: Uri, iconUri: Uri, identityName: String, authToken: String) = error("unused")
        override suspend fun deauthorize(authToken: String) = error("unused")
        override suspend fun signMessages(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
        override suspend fun signMessagesDetached(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
    }
    @Test fun `one exact sign-only call retains full verified wire before any post-wallet guard`() = runBlocking {
        val order = mutableListOf<String>(); val prepared = prepared()
        val wallet = Wallet { bytes -> assertArrayEquals(prepared.unsignedTransaction(), bytes); order += "wallet"; arrayOf(wire) }
        val result = wallet.signRealmSaleInSession(prepared, publicKeyBytes(p.wallet), { order += "guard" }, { order += "retained"; assertEquals(signed, it) })
        assertEquals(signed, result); assertEquals(listOf("sign"), wallet.calls)
        assertEquals(listOf("guard", "wallet", "retained", "guard"), order)
    }
    @Test fun `session change after approval cannot discard the original signed wire`() {
        var changed = false; var retained: SignedRealmSale? = null
        val wallet = Wallet { changed = true; arrayOf(wire) }
        assertThrows(CancellationException::class.java) { runBlocking {
            wallet.signRealmSaleInSession(prepared(), publicKeyBytes(p.wallet), { if (changed) throw CancellationException("changed") }, { retained = it })
        } }
        assertEquals(signed, retained); assertEquals(listOf("sign"), wallet.calls)
    }
    @Test fun `wrong authorized wallet and failed pre-sign admission cannot prompt the wallet`() {
        val wallet = Wallet { error("must not sign") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking {
            wallet.signRealmSaleInSession(prepared(), publicKeyBytes(p.terms.developer), {}, {})
        } }
        assertThrows(CancellationException::class.java) { runBlocking {
            wallet.signRealmSaleInSession(prepared(), publicKeyBytes(p.wallet), { throw CancellationException("paused") }, {})
        } }
        assertTrue(wallet.calls.isEmpty())
    }
    @Test fun `persistence failure prevents successful return without another signature or send`() {
        val wallet = Wallet { arrayOf(wire) }
        assertThrows(IOException::class.java) { runBlocking {
            wallet.signRealmSaleInSession(prepared(), publicKeyBytes(p.wallet), {}, { throw IOException("locked storage") })
        } }
        assertEquals(listOf("sign"), wallet.calls)
    }
    @Test fun `malformed oversized mutated and duplicate replies never reach the journal`() {
        listOf(arrayOf(ByteArray(1233)), arrayOf(wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }),
            arrayOf(wire, wire), emptyArray()).forEach { reply ->
            val wallet = Wallet { reply }
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                wallet.signRealmSaleInSession(prepared(), publicKeyBytes(p.wallet), {}, { fail("No valid original evidence") })
            } }
            assertEquals(listOf("sign"), wallet.calls)
        }
    }
}
