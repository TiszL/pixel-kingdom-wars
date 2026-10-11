package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepDepositWalletTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); var embedded = true; val events = mutableListOf<String>()
        val q = KeepDepositQuote(DEPOSIT_ID, session.wallet, session.origin, "devnet", "17", DEPOSIT_SOURCE, DEPOSIT_DEST, ChainAddresses.DEVNET.keepMint, 9, DEPOSIT_REFERENCE)
        val unsigned = LegacyTransaction.unsigned(decodeWallet(), ByteArray(32) { 99 }, listOf(KeepDepositPayment.instruction(
            WALLET, DEPOSIT_SOURCE, DEPOSIT_DEST, q.mint, DEPOSIT_REFERENCE, BigInteger("17000000000"), 9)))
        private fun decodeWallet() = java.math.BigInteger(WALLET.fold(BigInteger.ZERO) { n, c -> n * BigInteger.valueOf(58) + BigInteger.valueOf("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(c).toLong()) }.toString()).toByteArray().takeLast(32).toByteArray()
        var afterSign: suspend () -> Unit = {}; var onSend: () -> Unit = {}; var signature: String? = null
        var expired = false; var changed = false; var reject = false; var gate: CompletableDeferred<Unit>? = null
        val mfa = MutableStateFlow<PrivyMfaRequest?>(null); val reported = mutableListOf<WalletFailureKind>()
        val signer = object : WalletTransactionSigner {
            override val address = WALLET
            override suspend fun signMessage(message: ByteArray): ByteArray = error("No message signing for a deposit")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray {
                events += "sign"; if (reject) throw IOException("provider rejection with sensitive callback")
                gate?.let { mfa.value = PrivyMfaRequest("user", setOf("totp")); it.await(); mfa.value = null }
                afterSign()
                return serialized.copyOf().apply { (1..64).forEach { this[it] = 17 }; if (changed) this[lastIndex] = 8 }
            }
        }
        val social = object : SocialLogin {
            override val mfa get() = this@Fixture.mfa
            override val handOff = MutableStateFlow<SocialProvider?>(null)
            override suspend fun sendEmailCode(email: String): Unit = error("No login")
            override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject = error("No replacement login")
            override suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner {
                requireCurrentIdentity(); assertEquals(WALLET, wallet); assertSame(this@Fixture.session.token, session); events += "existing"; return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) { assertSame(mfa.value, request); assertEquals("123456", code); gate!!.complete(Unit) }
            override fun cancelMfa() { gate?.cancel(); mfa.value = null }
            override suspend fun logout(): Unit = error("No logout")
        }
        val rpc = SolanaRpc { body -> events += "broadcast"; assertNotNull("persist before RPC", signature)
            assertEquals("sendTransaction", body["method"]!!.jsonPrimitive.content); onSend(); buildJsonObject { put("result", DEPOSIT_SIGNATURE) } }
        /** ONE wallet step ([WalletLogin.pay]); here the wallet answered method-not-found to the send and signed in the same session. */
        fun wallet() = KeepDepositWallet(session, holder, { embedded }, { events += "social"; social }, WalletPayer { tx, cluster, owner, _ ->
            events += "external"; assertArrayEquals(unsigned, tx); assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(WALLET, owner); afterSign()
            if (changed) throw tamperedReply(); signedOnly(tx, fill = 17)
        }, rpc, SolanaCluster.DEVNET, { check(!expired) { "Quote expired" } }, report = { reported += it.kind })
        fun record(value: String) { events += "persist"; signature = value }
    }
    @Test fun `Privy signs same account and persists exact signature before the one RPC broadcast`() = runBlocking {
        val f = Fixture(); assertEquals(DEPOSIT_SIGNATURE, f.wallet().send(f.unsigned, f.q, f::record))
        assertEquals(listOf("social", "existing", "sign", "persist", "broadcast"), f.events)
    }
    @Test fun `external wallet signs reviewed bytes with explicit cluster and common broadcast without initializing Privy`() = runBlocking {
        val f = Fixture(); f.embedded = false; f.wallet().send(f.unsigned, f.q, f::record)
        assertEquals(listOf("external", "persist", "broadcast"), f.events)
    }
    @Test fun `sign-only rejection or modified transaction proves no RPC broadcast and never persists a signature`() = runBlocking {
        for (changed in listOf(false, true)) {
            val f = Fixture(); f.reject = !changed; f.changed = changed
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertTrue(e.refusedBeforeBroadcast); assertFalse(e.message!!.contains("sensitive")); assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
        }
    }
    @Test fun `lost RPC reply leaves known signature and is never a safe repeat-sign refusal`() = runBlocking {
        val f = Fixture(); f.onSend = { throw IOException("lost response") }
        val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
        assertFalse(e.refusedBeforeBroadcast); assertEquals(DEPOSIT_SIGNATURE, f.signature); assertEquals(1, f.events.count { it == "broadcast" })
    }
    @Test fun `identity change after provider signature prevents persistence and broadcast`() = runBlocking {
        val f = Fixture(); f.afterSign = { f.holder.replace(null) }
        try { f.wallet().send(f.unsigned, f.q, f::record); fail("Expected identity cancellation") } catch (_: CancellationException) {}
        assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
    }
    @Test fun `provider MFA pauses exact deposit and rejects a stale code episode`() = runBlocking {
        val f = Fixture(); f.gate = CompletableDeferred(); val wallet = f.wallet()
        val job = async { wallet.send(f.unsigned, f.q, f::record) }
        val request = wallet.mfa.filterNotNull().first()
        assertFalse(f.events.contains("broadcast")); assertNull(f.signature)
        assertThrows(IllegalStateException::class.java) { runBlocking { wallet.submitMfa(PrivyMfaRequest("user", setOf("totp")), "123456") } }
        wallet.submitMfa(request, "123456"); assertEquals(DEPOSIT_SIGNATURE, job.await()); assertNull(wallet.mfa.value)
    }
    @Test fun `slow approval from either wallet cannot broadcast after quote deadline and signature stays saved`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.afterSign = { f.expired = true }
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertEquals(DEPOSIT_SIGNATURE, f.signature); assertFalse(f.events.contains("broadcast"))
            // The expired window is this app's own stop: its own text, never "the wallet's reply failed this app's checks".
            assertEquals("Quote expired", e.message); assertNull(e.reason); assertFalse(f.reported.contains(WalletFailureKind.INVALID_RESPONSE))
        }
    }
    /** The wallet's own send is the first path for a deposit too; its signature is persisted at once and nothing is relayed. */
    @Test fun `a deposit the wallet sent itself persists the returned signature and never relays`() = runBlocking {
        val f = Fixture(); f.embedded = false
        val wallet = KeepDepositWallet(f.session, f.holder, { false }, { error("no Privy") }, WalletPayer { _, _, _, _ -> f.events += "external"; WalletPayment.Sent(ByteArray(64) { 17 }) },
            f.rpc, SolanaCluster.DEVNET, {}, report = { f.reported += it.kind })
        assertEquals(DEPOSIT_SIGNATURE, wallet.send(f.unsigned, f.q, f::record))
        assertEquals(listOf("external", "persist"), f.events); assertTrue(f.reported.isEmpty())
    }
    @Test fun `network mismatch refuses either signer before wallet approval`() = runBlocking {
        val f = Fixture()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q.copy(cluster = "mainnet-beta"), f::record) } }
        assertTrue(f.events.isEmpty())
    }

}
