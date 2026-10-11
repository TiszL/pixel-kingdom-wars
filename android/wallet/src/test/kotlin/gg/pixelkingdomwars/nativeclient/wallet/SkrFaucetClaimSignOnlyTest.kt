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
import java.util.Base64

/**
 * WHY: the devnet test SKR claim is co-signed and sent by the faucet server, so the phone's whole part is the player's
 * signature, given in the wallet app. The wallet must be asked once to SIGN exactly the server-prepared bytes the app
 * reviewed (never to send them: the faucet's signature is still missing), with the account the claim is for, and the
 * verified signed bytes must be saved before any later guard can throw them away (they are the only proof of what the
 * player approved). Bytes: the server fixture's prepare and its test player's signature (skr-faucet-*-vector(s).json,
 * fixture-derived, see their _provenance), driven through the exact helper WalletLogin's association runs.
 */
class SkrFaucetClaimSignOnlyTest {
    private fun vector(name: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/$name")).readText()).jsonObject
    private val api = vector("skr-faucet-api-vectors.json")
    private val signedVector = vector("skr-faucet-signed-vector.json")
    private val player = signedVector.getValue("wallet").jsonPrimitive.content
    private val wire = Base64.getDecoder().decode(signedVector.getValue("signedTransaction").jsonPrimitive.content)
    private val prepare = api.getValue("prepare").jsonObject
    private val grant = prepare.getValue("grant").jsonObject
    private val mint = grant.getValue("mint").jsonPrimitive.content
    private val grantSkr = api.getValue("status").jsonObject.getValue("grantSkr").jsonPrimitive.content
    private suspend fun prepared(skr: String = grantSkr, tokenMint: String = mint) = SkrFaucetClaimTransaction.prepare(player, tokenMint,
        grant.getValue("decimals").jsonPrimitive.int, grant.getValue("amountRaw").jsonPrimitive.content, skr,
        prepare.getValue("unsignedTransaction").jsonPrimitive.content)
    private class Wallet(private val sign: (ByteArray) -> Array<ByteArray>) : AdapterOperations {
        val calls = mutableListOf<String>()
        override suspend fun signTransactions(transactions: Array<ByteArray>): MobileWalletAdapterClient.SignPayloadsResult {
            calls += "sign"; return MobileWalletAdapterClient.SignPayloadsResult(sign(transactions.single()))
        }
        override suspend fun signAndSendTransactions(transactions: Array<ByteArray>, params: TransactionParams): MobileWalletAdapterClient.SignAndSendTransactionsResult = error("The faucet claim must never ask the wallet to send")
        override suspend fun getCapabilities(): MobileWalletAdapterClient.GetCapabilitiesResult = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, rpcCluster: RpcCluster) = error("unused")
        override suspend fun authorize(identityUri: Uri, iconUri: Uri, identityName: String, chain: String, authToken: String?, features: Array<String>?, addresses: Array<ByteArray>?, signInPayload: SignInWithSolana.Payload?) = error("unused")
        @Suppress("OVERRIDE_DEPRECATION") override suspend fun reauthorize(identityUri: Uri, iconUri: Uri, identityName: String, authToken: String) = error("unused")
        override suspend fun deauthorize(authToken: String) = error("unused")
        override suspend fun signMessages(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
        override suspend fun signMessagesDetached(messages: Array<ByteArray>, addresses: Array<ByteArray>) = error("unused")
    }

    @Test fun `one exact sign-only call retains the verified claim before any post-wallet guard`() = runBlocking {
        val order = mutableListOf<String>(); val prepared = prepared()
        val wallet = Wallet { bytes -> assertArrayEquals(prepared.unsignedTransaction(), bytes); order += "wallet"; arrayOf(wire) }
        var retained: SignedSkrFaucetClaim? = null
        val result = wallet.signSkrFaucetClaimInSession(prepared, publicKeyBytes(player), { order += "guard" }, { order += "retained"; retained = it })
        assertEquals(Base64.getEncoder().encodeToString(wire), result.wire); assertEquals(result, retained)
        assertEquals(listOf("sign"), wallet.calls)
        assertEquals(listOf("guard", "wallet", "retained", "guard"), order)
    }

    @Test fun `a sheet closed after approval cannot discard the signed claim`() {
        var approved = false; var retained: SignedSkrFaucetClaim? = null
        val wallet = Wallet { approved = true; arrayOf(wire) }
        assertThrows(CancellationException::class.java) { runBlocking {
            wallet.signSkrFaucetClaimInSession(prepared(), publicKeyBytes(player), { if (approved) throw CancellationException("closed") }, { retained = it })
        } }
        assertNotNull(retained); assertEquals(listOf("sign"), wallet.calls)
    }

    @Test fun `another wallet account or a closed sheet never prompts the wallet`() {
        val wallet = Wallet { error("must not sign") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking {
            wallet.signSkrFaucetClaimInSession(prepared(), publicKeyBytes(mint), {}, {})
        } }
        assertThrows(CancellationException::class.java) { runBlocking {
            wallet.signSkrFaucetClaimInSession(prepared(), publicKeyBytes(player), { throw CancellationException("closed") }, {})
        } }
        assertTrue(wallet.calls.isEmpty())
    }

    @Test fun `a changed, duplicate or empty wallet reply never reaches the journal`() {
        listOf(arrayOf(wire.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }), arrayOf(wire, wire), emptyArray()).forEach { reply ->
            val wallet = Wallet { reply }
            assertThrows(Exception::class.java) { runBlocking {
                wallet.signSkrFaucetClaimInSession(prepared(), publicKeyBytes(player), {}, { fail("No unverified evidence is saved") })
            } }
            assertEquals(listOf("sign"), wallet.calls)
        }
    }

    @Test fun `a storage failure stops the claim without another signature or any send`() {
        val wallet = Wallet { arrayOf(wire) }
        assertThrows(IOException::class.java) { runBlocking {
            wallet.signSkrFaucetClaimInSession(prepared(), publicKeyBytes(player), {}, { throw IOException("locked storage") })
        } }
        assertEquals(listOf("sign"), wallet.calls)
    }

    // The amount and token are checked against the build's pin and the constants pack before the wallet ever opens.
    @Test fun `a prepared claim for another amount or another token is refused before the wallet opens`() {
        assertThrows(IllegalArgumentException::class.java) { runBlocking { prepared(skr = "2000") } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { prepared(tokenMint = player) } }
    }
}
