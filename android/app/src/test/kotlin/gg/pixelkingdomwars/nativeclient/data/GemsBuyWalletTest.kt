package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.GemsBuyIntent
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class GemsBuyWalletTest {
    private class Fixture {
        val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val owner = base58(keys.public.encoded.takeLast(32).toByteArray())
        val holder = testHolder(); val session = signedIn(holder, owner)
        val mint = ChainAddresses.DEVNET.keepMint
        val q = GemsBuyIntent(DEPOSIT_ID, "gems_buy", owner, "gems-wallet-adapter-test", DEPOSIT_REFERENCE,
            runBlocking { KeepDepositPayment.sourceAta(owner, mint) }, DEPOSIT_DEST, mint, 9, 17, 17, "2026-09-21T12:30:00Z")
        var genesis = SolanaCluster.DEVNET.genesisHash; var height = 400L; var sends = 0; var approvals = 0
        var signature: String? = null; var exact: Boolean? = null; var expired = false; var mutate = false; var badSignature = false
        var afterSign: () -> Unit = {}; var recordFails = false; var embedded = true
        val events = mutableListOf<String>()
        val rpc = SolanaRpc { body ->
            when (body.string("method")) {
                "getGenesisHash" -> jsonBody("result" to genesis)
                "getLatestBlockhash" -> json("""{"result":{"value":{"blockhash":"${base58(ByteArray(32) { 9 })}","lastValidBlockHeight":500}}}""")
                "getFeeForMessage" -> json("""{"result":{"value":5000}}""")
                "getBalance" -> json("""{"result":{"value":100000}}""")
                "getTokenAccountBalance" -> json("""{"result":{"value":{"decimals":9,"amount":"17000000000"}}}""")
                "getBlockHeight" -> buildJsonObject { put("result", height) }
                "sendTransaction" -> {
                    events += "relay"; sends++; assertNotNull("signature precedes relay", signature)
                    val wire = Base64.getDecoder().decode(body["params"]!!.jsonArray[0].jsonPrimitive.content)
                    assertEquals(signature, base58(wire.copyOfRange(1, 65))); jsonBody("result" to signature!!)
                }
                else -> error("Unexpected RPC")
            }
        }
        val payments = GemsBuyPayment(rpc, SolanaCluster.DEVNET, mint)
        var signerGuard: () -> Unit = {}
        fun signed(input: ByteArray): ByteArray = input.copyOf().apply {
            if (mutate) this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte()
            val signer = Signature.getInstance("Ed25519"); signer.initSign(keys.private); signer.update(copyOfRange(65, size))
            signer.sign().copyInto(this, 1); if (badSignature) this[1] = (this[1].toInt() xor 1).toByte()
        }
        val signer = object : DurableWalletTransactionSigner {
            override val address = owner
            override suspend fun signMessage(message: ByteArray): ByteArray = error("No message signing")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray = error("Evidence port required")
            override suspend fun signTransactionWithEvidence(serialized: ByteArray, onSigned: (ByteArray) -> Unit): ByteArray {
                approvals++; val wire = signed(serialized); afterSign(); onSigned(wire); signerGuard(); return wire
            }
        }
        val social = object : SocialLogin {
            override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
            override val handOff = MutableStateFlow<SocialProvider?>(null)
            override suspend fun sendEmailCode(email: String): Unit = error("unused")
            override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject = error("unused")
            override suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner {
                assertEquals(owner, wallet); assertSame(this@Fixture.session.token, session); requireCurrentIdentity(); signerGuard = requireCurrentIdentity; return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String): Unit = error("unused")
            override fun cancelMfa() {}
            override suspend fun logout(): Unit = error("unused")
        }
        var payer = GemsBuyPayer { tx, cluster, wallet, _, onSigned, guard ->
            assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(owner, wallet); approvals++
            val wire = signed(tx); afterSign(); onSigned(wire); guard()
            WalletPayment.SignedOnly(wire, wire.copyOfRange(1, 65), TransactionMutation.NONE, null)
        }
        fun wallet() = GemsBuyWallet(session, holder, session.origin, SolanaCluster.DEVNET, payments, { embedded }, { social }, payer,
            { check(!expired) { "Quote expired" } }, {})
        fun record(sig: String, exactBlockhash: Boolean) { events += "record"; if (recordFails) throw IOException("disk unavailable"); signature = sig; exact = exactBlockhash }
        suspend fun pay() { val prepared = payments.prepare(q); wallet().send(prepared.transaction, q, ::record) }
    }
    private suspend fun fails(action: suspend () -> Unit) { try { action(); fail("Expected refusal") } catch (e: AssertionError) { throw e } catch (_: Exception) {} }

    @Test fun `Privy exact signature persists before live checks and one relay`() = runBlocking {
        val f = Fixture(); f.pay(); assertEquals(1, f.sends); assertEquals(true, f.exact); assertEquals(listOf("record", "relay"), f.events)
    }
    @Test fun `valid returned signature survives account change before post-wallet guard without relay`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.afterSign = { f.holder.replace(null) }
            fails { f.pay() }; assertNotNull(f.signature); assertEquals(0, f.sends); assertEquals(true, f.exact)
        }
    }
    @Test fun `changed message or forged signature is never persisted or relayed`() = runBlocking {
        for (bad in listOf(true, false)) {
            val f = Fixture(); f.mutate = bad; f.badSignature = !bad
            fails { f.pay() }; assertNull(f.signature); assertEquals(0, f.sends)
        }
    }
    @Test fun `wrong genesis before preparation never opens wallet`() = runBlocking {
        val f = Fixture(); f.genesis = SolanaCluster.MAINNET.genesisHash
        fails { f.pay() }; assertEquals(0, f.approvals); assertEquals(0, f.sends)
    }
    @Test fun `post-wallet changed genesis expired height and expired quote preserve proof but prevent relay`() = runBlocking {
        for (change in listOf<(Fixture) -> Unit>({ it.genesis = SolanaCluster.MAINNET.genesisHash }, { it.height = 501 }, { it.expired = true })) {
            val f = Fixture(); f.afterSign = { change(f) }
            fails { f.pay() }; assertNotNull(f.signature); assertEquals(0, f.sends)
        }
    }
    @Test fun `signature persistence failure prevents any app relay`() = runBlocking {
        val f = Fixture(); f.recordFails = true; fails { f.pay() }; assertEquals(0, f.sends)
    }
    @Test fun `MWA sent callback after logout is retained without assigning prepared height or rebroadcast`() = runBlocking {
        val f = Fixture(); f.embedded = false
        f.payer = GemsBuyPayer { tx, _, _, onSent, _, guard ->
            val sig = f.signed(tx).copyOfRange(1, 65); f.holder.replace(null); onSent(sig); guard(); WalletPayment.Sent(sig)
        }
        fails { f.pay() }; assertNotNull(f.signature); assertEquals(false, f.exact); assertEquals(0, f.sends)
    }
    @Test fun `external exact sign-only fallback is relayed once and never opens Privy`() = runBlocking {
        val f = Fixture(); f.embedded = false; f.pay(); assertEquals(1, f.approvals); assertEquals(1, f.sends)
    }
    @Test fun `prepared byte mutation and mismatched quote cannot reach wallet`() = runBlocking {
        val f = Fixture(); val prepared = f.payments.prepare(f.q); prepared.transaction[prepared.transaction.lastIndex] = 1
        fails { f.wallet().send(prepared.transaction, f.q, f::record) }; assertEquals(0, f.approvals)
        val restored = f.payments.prepare(f.q)
        fails { f.wallet().send(restored.transaction, f.q.copy(keepIn = 18, gemsOut = 18), f::record) }; assertEquals(0, f.approvals)
    }
}
