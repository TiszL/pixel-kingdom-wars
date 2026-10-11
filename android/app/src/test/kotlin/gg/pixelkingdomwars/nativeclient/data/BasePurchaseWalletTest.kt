package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BasePurchaseWalletTest {
    private class Fixture(kind: String = "builder") {
        val holder = testHolder(); val session = signedIn(holder); var embedded = true
        val events = mutableListOf<String>(); val q = paidQuote(paidOffer(kind).request(PAID_KEY))
        val instruction = BasePurchasePayment.instruction(ChainAddresses.DEVNET, BasePurchaseKind.entries.single { it.wire == kind },
            WALLET, q.reference, q.amountLamports.toBigInteger(), q.rail.destination)
        val unsigned = LegacyTransaction.unsigned(instruction.keys.single { it.signer }.key, ByteArray(32) { 3 }, listOf(instruction))
        var signature: String? = null; var afterSign: suspend () -> Unit = {}; var afterBinding: suspend () -> Unit = {}
        var onSend: () -> Unit = {}; var expired = false; var changed = false; var reject = false
        var missingSocial = false; var signerAddress = WALLET; var gate: CompletableDeferred<Unit>? = null
        val mfa = MutableStateFlow<PrivyMfaRequest?>(null); val reported = mutableListOf<WalletFailureKind>()
        suspend fun sign(tx: ByteArray): ByteArray {
            assertArrayEquals(unsigned, tx)
            if (reject) throw IOException("provider rejected sensitive callback")
            gate?.let { mfa.value = PrivyMfaRequest("user", setOf("totp")); it.await(); mfa.value = null }
            afterSign()
            return tx.copyOf().apply { (1..64).forEach { this[it] = 21 }; if (changed) this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() }
        }
        val signer = object : WalletTransactionSigner {
            override val address get() = signerAddress
            override suspend fun signMessage(message: ByteArray): ByteArray = error("Purchase never signs a login message")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray { events += "sign"; return sign(serialized) }
        }
        val social = object : SocialLogin {
            override val mfa get() = this@Fixture.mfa
            override val handOff = MutableStateFlow<SocialProvider?>(null)
            override suspend fun sendEmailCode(email: String): Unit = error("No new account")
            override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject = error("No replacement login")
            override suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner {
                requireCurrentIdentity(); assertEquals(WALLET, wallet); assertSame(this@Fixture.session.token, session)
                events += "existing"; return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) { assertSame(mfa.value, request); assertEquals("123456", code); requireNotNull(gate).complete(Unit) }
            override fun cancelMfa() { gate?.cancel(); mfa.value = null }
            override suspend fun logout(): Unit = error("Payment never replaces the account")
        }
        val rpc = SolanaRpc { body ->
            events += "broadcast"; assertEquals(PAID_SIGNATURE, signature)
            assertEquals("sendTransaction", body.getValue("method").jsonPrimitive.content)
            val params = body.getValue("params").jsonArray
            val signed = Base64.getDecoder().decode(params[0].jsonPrimitive.content)
            assertEquals(PAID_SIGNATURE, base58(paymentTransactionSignature(unsigned, signed, WALLET)))
            assertEquals(JsonPrimitive(0), params[1].jsonObject["maxRetries"])
            onSend(); buildJsonObject { put("result", PAID_SIGNATURE) }
        }
        fun wallet() = BasePurchaseWallet(session, holder, { afterBinding(); embedded }, { events += "social"; if (missingSocial) null else social },
            // ONE wallet step ([WalletLogin.pay]); here the wallet answered method-not-found to the send and signed in the
            // same session. Its decline and its rejected reply arrive as that step's own classified verdicts.
            WalletPayer { tx, cluster, owner, _ ->
                events += "external"; assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(WALLET, owner)
                if (reject) throw declinedInWallet(); if (changed) throw tamperedReply()
                val signed = sign(tx); WalletPayment.SignedOnly(signed, signed.copyOfRange(1, 65), TransactionMutation.NONE, SEND_METHOD_NOT_FOUND)
            }, rpc, SolanaCluster.DEVNET, { check(!expired) { "Original quote expired" } }, report = { reported += it.kind })
        fun record(value: String) { events += "persist"; signature = value }
    }

    @Test fun `each current payment rail signs existing Privy account and persists exact signature before one broadcast`() = runBlocking {
        for (kind in listOf("builder", "expansion", "mine")) {
            val f = Fixture(kind)
            assertEquals(PAID_SIGNATURE, f.wallet().send(f.unsigned, f.q, f::record))
            assertEquals(listOf("social", "existing", "sign", "persist", "broadcast"), f.events)
        }
    }

    @Test fun `external sign-only path preserves reviewed bytes and never initializes another provider`() = runBlocking {
        val f = Fixture(); f.embedded = false; f.wallet().send(f.unsigned, f.q, f::record)
        assertEquals(listOf("external", "persist", "broadcast"), f.events)
    }

    @Test fun `unsigned provider refusal and modified signed payload never persist proof or broadcast`() = runBlocking {
        for (embedded in listOf(true, false)) for (changed in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.changed = changed; f.reject = !changed
            val error = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertTrue(error.refusedBeforeBroadcast); assertFalse(requireNotNull(error.message).contains("sensitive"))
            assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
        }
    }

    @Test fun `signature persistence failure stops either provider before any RPC broadcast`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q) { throw IOException("journal storage failed") } } }
            assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
        }
    }

    @Test fun `lost RPC response preserves signature and is never classified safe for another signature`() = runBlocking {
        val f = Fixture(); f.onSend = { throw IOException("broadcast reply lost") }
        val error = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
        assertFalse(error.refusedBeforeBroadcast); assertEquals(PAID_SIGNATURE, f.signature)
        assertEquals(1, f.events.count { it == "broadcast" })
    }

    @Test fun `identity changes during binding or after signature stop old account persistence and broadcast`() = runBlocking {
        for (duringBinding in listOf(true, false)) {
            val f = Fixture()
            if (duringBinding) f.afterBinding = { f.holder.replace(null) } else f.afterSign = { f.holder.replace(null) }
            try { f.wallet().send(f.unsigned, f.q, f::record); fail("Expected superseded account cancellation") } catch (_: CancellationException) {}
            assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
        }
    }

    @Test fun `missing embedded provider and mismatched signer never fall back to external account`() = runBlocking {
        for (missing in listOf(true, false)) {
            val f = Fixture(); f.missingSocial = missing; if (!missing) f.signerAddress = PAID_REFERENCE
            assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertFalse(f.events.contains("external")); assertFalse(f.events.contains("sign")); assertFalse(f.events.contains("broadcast"))
        }
    }

    @Test fun `slow wallet approval cannot broadcast after original quote expires and keeps signature for recovery`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.afterSign = { f.expired = true }
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertEquals(PAID_SIGNATURE, f.signature); assertFalse(f.events.contains("broadcast"))
            // The expired window is this app's own stop: its own text, never "the wallet's reply failed this app's checks".
            assertEquals("Original quote expired", e.message); assertNull(e.reason); assertFalse(f.reported.contains(WalletFailureKind.INVALID_RESPONSE))
        }
    }

    @Test fun `wallet and network mismatch refuse before either provider receives transaction`() = runBlocking {
        for (network in listOf(true, false)) {
            val f = Fixture()
            val wrong = if (network) f.q.copy(rail = f.q.rail.copy(cluster = "mainnet-beta")) else f.q.copy(wallet = PAID_REFERENCE)
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.wallet().send(f.unsigned, wrong, f::record) } }
            assertTrue(f.events.isEmpty())
        }
    }

    @Test fun `provider MFA stays bound to exact existing payment and refuses stale challenge episode`() = runBlocking {
        val f = Fixture(); f.gate = CompletableDeferred(); val wallet = f.wallet()
        val job = async { wallet.send(f.unsigned, f.q, f::record) }
        val request = wallet.mfa.filterNotNull().first()
        assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
        assertThrows(IllegalStateException::class.java) { runBlocking { wallet.submitMfa(PrivyMfaRequest("user", setOf("totp")), "123456") } }
        wallet.submitMfa(request, "123456"); assertEquals(PAID_SIGNATURE, job.await()); assertNull(wallet.mfa.value)
    }
}
