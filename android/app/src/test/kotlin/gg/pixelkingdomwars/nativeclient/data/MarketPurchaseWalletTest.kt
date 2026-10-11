package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MarketPurchaseWalletTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder); var embedded = true; val events = mutableListOf<String>()
        val q = marketQuote()
        val unsigned = java.util.Base64.getDecoder().decode(marketWire().getValue("unsigned").jsonPrimitive.content)
        var afterSign: suspend () -> Unit = {}; var onSend: () -> Unit = {}; var signature: String? = null
        var expired = false; var changed = false; var reject = false; var gate: CompletableDeferred<Unit>? = null
        var externalFailure: Exception? = null; var noExternal = false; val reported = mutableListOf<WalletFailureKind>()
        /** The wallet app broadcast through its own send; null = it answered method-not-found and signed in the same session. */
        var walletSend: (suspend () -> ByteArray)? = null
        val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
        val signer = object : WalletTransactionSigner {
            override val address = WALLET
            override suspend fun signMessage(message: ByteArray): ByteArray = error("No message signing for a purchase")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray {
                events += "sign"; if (reject) throw IOException("provider rejection with sensitive callback")
                gate?.let { mfa.value = PrivyMfaRequest("user", setOf("totp")); it.await(); mfa.value = null }
                afterSign()
                return serialized.copyOf().apply { (1..64).forEach { this[it] = 21 }; if (changed) this[lastIndex] = 8 }
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
            assertEquals("sendTransaction", body["method"]!!.jsonPrimitive.content); onSend(); buildJsonObject { put("result", MARKET_SIGNATURE) } }
        /** ONE wallet step ([WalletLogin.pay]): it sent, it signed in the same session, or it failed with its verdict. */
        fun wallet() = MarketPurchaseWallet(session, holder, { embedded }, { events += "social"; social }, if (noExternal) null else WalletPayer { tx, cluster, owner, _ ->
            events += "external"; assertArrayEquals(unsigned, tx); assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(WALLET, owner); externalFailure?.let { throw it }
            walletSend?.let { send -> return@WalletPayer WalletPayment.Sent(send()) }
            afterSign(); if (changed) throw tamperedReply(); signedOnly(tx)
        }, rpc, SolanaCluster.DEVNET, { check(!expired) { "Quote expired" } }, report = { reported += it.kind })
        fun record(value: String) { events += "persist"; signature = value }
    }
    @Test fun `Privy signs same account and persists exact signature before the one RPC broadcast`() = runBlocking {
        val f = Fixture(); assertEquals(MARKET_SIGNATURE, f.wallet().send(f.unsigned, f.q, f::record))
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
        assertFalse(e.refusedBeforeBroadcast); assertEquals(MARKET_SIGNATURE, f.signature); assertEquals(1, f.events.count { it == "broadcast" })
    }
    @Test fun `identity change after provider signature prevents persistence and broadcast`() = runBlocking {
        val f = Fixture(); f.afterSign = { f.holder.replace(null) }
        try { f.wallet().send(f.unsigned, f.q, f::record); fail("Expected identity cancellation") } catch (_: CancellationException) {}
        assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
    }
    @Test fun `provider MFA pauses exact purchase and rejects a stale code episode`() = runBlocking {
        val f = Fixture(); f.gate = CompletableDeferred(); val wallet = f.wallet()
        val job = async { wallet.send(f.unsigned, f.q, f::record) }
        val request = wallet.mfa.filterNotNull().first()
        assertFalse(f.events.contains("broadcast")); assertNull(f.signature)
        assertThrows(IllegalStateException::class.java) { runBlocking { wallet.submitMfa(PrivyMfaRequest("user", setOf("totp")), "123456") } }
        wallet.submitMfa(request, "123456"); assertEquals(MARKET_SIGNATURE, job.await()); assertNull(wallet.mfa.value)
    }
    @Test fun `slow approval from either wallet cannot broadcast after quote deadline and signature stays saved`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.afterSign = { f.expired = true }
            assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertEquals(MARKET_SIGNATURE, f.signature); assertFalse(f.events.contains("broadcast"))
        }
    }
    @Test fun `network mismatch refuses either signer before wallet approval`() = runBlocking {
        val f = Fixture()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q.copy(cluster = "mainnet-beta"), f::record) } }
        assertTrue(f.events.isEmpty())
    }

    @Test fun `signature persistence failure prevents broadcast from either provider`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q) { throw IOException("disk unavailable") } } }
            assertFalse(f.events.contains("broadcast")); assertNull(f.signature)
        }
    }
    /** Seeker incident 2026-09-17: the notice said only "Wallet declined before sending", so nobody could tell which MWA
     * branch fired. The wallet step's classified reason now rides the exception into the notice and the
     * diagnostics channel — one sentence plus the stage and code token — while a provider's text still never does. */
    @Test fun `the external wallet's classified refusal reaches the notice and diagnostics without wallet text`() = runBlocking {
        val f = Fixture(); f.embedded = false
        f.externalFailure = declinedInWallet()
        val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
        assertTrue(e.refusedBeforeBroadcast); assertEquals(WalletFailureKind.NOT_SIGNED, e.reason?.kind)
        assertEquals("the request was declined in the wallet [send:-3]", e.detail); assertFalse(e.message!!.contains("PRIVATE"))
        assertEquals(listOf(WalletFailureKind.NOT_SIGNED), f.reported); assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
        // A Privy provider failure is classified by class only; an own precondition keeps its copy and is not a wallet failure.
        val g = Fixture(); g.reject = true
        val p = assertThrows(WalletPaymentException::class.java) { runBlocking { g.wallet().send(g.unsigned, g.q, g::record) } }
        assertEquals(WalletFailureReason(WalletFailureKind.INTERRUPTED, stage = WalletPayStage.SIGN), p.reason); assertFalse(p.detail.contains("sensitive")); assertEquals(listOf(WalletFailureKind.INTERRUPTED), g.reported)
        val h = Fixture(); h.embedded = false; h.noExternal = true
        val own = assertThrows(WalletPaymentException::class.java) { runBlocking { h.wallet().send(h.unsigned, h.q, h::record) } }
        assertEquals("A compatible Solana wallet app is needed.", own.detail); assertNull(own.reason); assertTrue(h.reported.isEmpty()); assertTrue(own.refusedBeforeBroadcast)
        // A relay rejection after the persisted signature is uncertain and names the relay code after the send refusal that led there.
        val r = Fixture(); r.embedded = false; r.onSend = { throw SolanaRpcException("RPC request was rejected", -32002) }
        val u = assertThrows(WalletPaymentException::class.java) { runBlocking { r.wallet().send(r.unsigned, r.q, r::record) } }
        assertFalse(u.refusedBeforeBroadcast); assertEquals(WalletFailureReason(WalletFailureKind.RPC_REJECTED, -32002, WalletPayStage.RELAY, SEND_METHOD_NOT_FOUND), u.reason)
        assertEquals("[send:-32601 > relay:-32002]", u.reason!!.token); assertEquals(MARKET_SIGNATURE, r.signature)
        // The embedded wallet's strict byte check still refuses any change, named at its stage.
        val c = Fixture(); c.changed = true
        val t = assertThrows(WalletPaymentException::class.java) { runBlocking { c.wallet().send(c.unsigned, c.q, c::record) } }
        assertEquals(WalletFailureReason(WalletFailureKind.INVALID_RESPONSE, stage = WalletPayStage.VALIDATE), t.reason); assertTrue(t.refusedBeforeBroadcast)
    }
    /** The quote deadline passing between the signature and this app's relay is this app's own stop. 0.5.x reported it
     * as "the wallet's reply failed this app's checks"; it keeps its own text and is not a wallet failure. */
    @Test fun `a payment window that ends before the relay keeps its own text and is not reported as a wallet failure`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.afterSign = { f.expired = true }
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertEquals("Quote expired", e.message); assertNull(e.reason); assertTrue("this app never relayed", e.refusedBeforeBroadcast)
            assertEquals(if (embedded) emptyList() else listOf(WalletFailureKind.METHOD_NOT_FOUND_SEND), f.reported)
            assertEquals(MARKET_SIGNATURE, f.signature); assertFalse(f.events.contains("broadcast"))
        }
    }
    @Test fun `modified external signed bytes cannot substitute another fee or recipient`() = runBlocking {
        val f = Fixture(); f.embedded = false; f.changed = true
        assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
        assertNull(f.signature); assertFalse(f.events.contains("broadcast"))
    }

    /** Seeker incident 2026-09-18 (store build 0.5.1): the external rail called the deprecated, optional
     * `signTransactions` first, so a wallet without it could never pay. MWA 2.0 makes `signAndSendTransactions`
     * mandatory: it is the first call now, and the wallet's own signature is persisted at once. */
    @Test fun `external wallet pays through its own send first and persists the returned signature`() = runBlocking {
        val f = Fixture(); f.embedded = false
        f.walletSend = { ByteArray(64) { 7 } }
        assertEquals(base58(ByteArray(64) { 7 }), f.wallet().send(f.unsigned, f.q, f::record))
        assertEquals(listOf("external", "persist"), f.events); assertTrue(f.reported.isEmpty()); assertEquals(base58(ByteArray(64) { 7 }), f.signature)
    }
    /** REWRITTEN 2026-09-18: this pinned a SECOND wallet call ("wallet-send" then "external") for the fallback. The
     * second association is deliberately gone — the wallet step signs in the same session — so the rule is now:
     * one wallet step, signature persisted, one relay, and the diagnostics record why and that the fallback worked. */
    @Test fun `a wallet that answers method-not-found or rejects the payload is relayed once after ONE wallet step`() = runBlocking {
        for (refusal in listOf(SEND_METHOD_NOT_FOUND, WalletFailureReason(WalletFailureKind.INVALID_PAYLOADS, -2, WalletPayStage.SEND))) {
            val f = Fixture(); f.embedded = false
            val wallet = MarketPurchaseWallet(f.session, f.holder, { false }, { error("no Privy") }, WalletPayer { tx, _, _, _ -> f.events += "external"; signedOnly(tx, mutation = TransactionMutation.COMPUTE_BUDGET_ADDED, sendRefusal = refusal) },
                f.rpc, SolanaCluster.DEVNET, {}, report = { f.reported += it.kind })
            assertEquals(MARKET_SIGNATURE, wallet.send(f.unsigned, f.q, f::record))
            assertEquals(refusal.token, listOf("external", "persist", "broadcast"), f.events)
            assertEquals(listOf(refusal.kind, WalletFailureKind.FALLBACK_USED_COMPUTE_BUDGET), f.reported)
        }
    }
    @Test fun `a decline, an account mismatch or an uncertain wallet send never re-prompts`() = runBlocking {
        val cases = listOf(
            declinedInWallet() to true,
            WalletPaymentException("other account", true, null, WalletFailureReason(WalletFailureKind.ACCOUNT_MISMATCH, stage = WalletPayStage.ACCOUNT_CHECK)) to true,
            WalletPaymentException("timed out after send", false, null, WalletFailureReason(WalletFailureKind.TIMEOUT, stage = WalletPayStage.SEND)) to false)
        for ((failure, refused) in cases) {
            val f = Fixture(); f.embedded = false; f.externalFailure = failure
            val e = assertThrows(WalletPaymentException::class.java) { runBlocking { f.wallet().send(f.unsigned, f.q, f::record) } }
            assertSame("the wallet step's verdict is never re-guessed", failure, e); assertEquals(failure.reason?.kind.toString(), refused, e.refusedBeforeBroadcast)
            assertEquals(listOf("external"), f.events); assertNull(f.signature); assertEquals(listOf(failure.reason?.kind), f.reported)
        }
    }
}
