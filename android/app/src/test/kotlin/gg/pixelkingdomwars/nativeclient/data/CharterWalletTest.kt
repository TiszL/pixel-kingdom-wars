package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.Base64

/** Shared public canonical Charter fixture, with no persisted private key. */
internal class CharterWalletFixture {
    val envelope=CharterFixtures.envelope()
    private val raw=CharterFixtures.row.charterObject("creationWire")
    val wire:ByteArray get()=Base64.getDecoder().decode(raw.charterText("signedTransaction"))
    suspend fun prepared()=CharterTransaction.prepare(envelope.signing!!,CharterFixtures.pins,envelope.actor,CharterFixtures.crypto)
    val signed:SignedCharter get()=runBlocking{prepared().verifySigned(wire)}
    val saved get()=signed
}

class CharterWalletTest {
    private class Fixture {
        val f = CharterWalletFixture()
        val holder = testHolder(); val session = signedIn(holder, f.envelope.actor)
        var embedded = true; var approvals = 0; var allowed = true; var socialCalls = 0
        var afterSign: () -> Unit = {}; var recordFails = false; var changedWire = false; var afterEvidenceFails = false
        var signerGuard: () -> Unit = {}
        var pauseForMfa = false; var mfaResumed = false
        val mfaRequest = PrivyMfaRequest("fixture-user", setOf("totp"))
        val mfaReady = CompletableDeferred<Unit>(); val continueMfa = CompletableDeferred<Unit>()
        val verificationEntered = CompletableDeferred<Unit>(); val verificationRelease = CompletableDeferred<Unit>()
        suspend fun verifyMfa(guard: () -> Unit) { guard(); verificationEntered.complete(Unit); verificationRelease.await(); guard(); mfaResumed = true; continueMfa.complete(Unit) }
        var saved: SignedCharter? = null
        val events = mutableListOf<String>()
        fun bytes() = f.wire.also { if (changedWire) it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        val signer = object : DurableWalletTransactionSigner {
            override val address = f.envelope.actor
            override suspend fun signMessage(message: ByteArray): ByteArray = error("No detached signing")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray = error("Durable signing required")
            override suspend fun signTransactionWithEvidence(serialized: ByteArray, onSigned: (ByteArray) -> Unit): ByteArray {
                assertArrayEquals(f.prepared().unsignedTransaction(), serialized)
                approvals++; events += "sign"; val wire = bytes(); afterSign(); onSigned(wire)
                if (afterEvidenceFails) throw IOException("association ended")
                signerGuard(); return wire
            }
        }
        val social = object : SocialLogin {
            override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
            override val handOff = MutableStateFlow<SocialProvider?>(null)
            override suspend fun sendEmailCode(email: String): Unit = error("unused")
            override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject = error("unused")
            override suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner {
                assertEquals(f.envelope.actor, wallet); assertSame(this@Fixture.session.token, session)
                requireCurrentIdentity(); signerGuard = requireCurrentIdentity
                if (pauseForMfa) { mfa.value = mfaRequest; mfaReady.complete(Unit); continueMfa.await(); requireCurrentIdentity() }
                return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) = verifyMfa {}
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) = verifyMfa(requireCurrentIdentity)
            override fun cancelMfa() {}
            override suspend fun logout(): Unit = error("unused")
        }
        var external = CharterExternalSigner { prepared, cluster, onSigned, guard ->
            assertEquals(SolanaCluster.DEVNET, cluster); approvals++; events += "sign"
            val result = if (changedWire) f.signed.copy(wire = Base64.getEncoder().encodeToString(bytes())) else f.signed
            afterSign(); onSigned(result)
            if (afterEvidenceFails) throw IOException("association ended")
            guard(); result
        }
        fun wallet() = CharterWallet(session, holder, session.origin, SolanaCluster.DEVNET, { embedded },
            { socialCalls++; social }, external)
        suspend fun record(value: SignedCharter) { events += "record"; if (recordFails) throw IOException("storage unavailable"); saved = value }
        suspend fun sign(wallet: CharterWallet = wallet()): SignedCharter = wallet.sign(f.prepared(), ::record) { check(allowed) { "admission changed" } }
    }
    private suspend fun refuses(block: suspend () -> Unit) {
        try { block(); fail("Expected refusal") } catch (error: AssertionError) { throw error } catch (_: Exception) {}
    }

    @Test fun `availability preflight never prompts and missing tracks refuse before an approval`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            f.wallet().requireAvailable { check(f.allowed) }; assertEquals(0, f.approvals)
            val missing = CharterWallet(f.session, f.holder, f.session.origin, SolanaCluster.DEVNET, { embedded }, { null }, null)
            refuses { missing.requireAvailable {} }; assertEquals(0, f.approvals)
        }
    }
    @Test fun `both wallet tracks retain exact full wire once without a broadcast interface`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            assertEquals(f.f.saved, f.sign()); assertEquals(f.f.saved, f.saved)
            assertEquals(1, f.approvals); assertEquals(listOf("sign", "record"), f.events)
            assertEquals(if (embedded) 1 else 0, f.socialCalls)
        }
    }
    @Test fun `returned evidence survives account or admission change during either wallet approval`() = runBlocking {
        for (embedded in listOf(true, false)) for (logout in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            f.afterSign = { if (logout) f.holder.replace(null) else f.allowed = false }
            refuses { f.sign() }; assertEquals(f.f.saved, f.saved); assertEquals(1, f.approvals)
        }
    }
    @Test fun `association failure after evidence retains the same original wire on both wallet tracks`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.afterEvidenceFails = true
            refuses { f.sign() }; assertEquals(f.f.saved, f.saved); assertEquals(1, f.approvals)
        }
    }
    @Test fun `changed wallet message and persistence failure cannot report a signed success`() = runBlocking {
        for (embedded in listOf(true, false)) for (badWire in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.changedWire = badWire; f.recordFails = !badWire
            refuses { f.sign() }; assertNull(f.saved); assertEquals(1, f.approvals)
        }
    }
    @Test fun `refused admission never prompts either wallet track`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.allowed = false
            refuses { f.sign() }; assertNull(f.saved); assertEquals(0, f.approvals)
        }
    }
    @Test fun `a concurrent second approval cannot replace the active original journal callback`() = runBlocking {
        val f = Fixture(); f.embedded = false
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.external = CharterExternalSigner { _, _, retain, guard -> entered.complete(Unit); release.await(); retain(f.f.signed); guard(); f.f.signed }
        val wallet = f.wallet()
        val first = async { f.sign(wallet) }; entered.await()
        refuses { f.sign(wallet) }
        release.complete(Unit); assertEquals(f.f.saved, first.await()); assertEquals(f.f.saved, f.saved)
    }
    @Test fun `cancellation waits for the owned suspended journal write on both wallet tracks`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            val job = launch {
                f.wallet().sign(f.f.prepared(), { value -> entered.complete(Unit); release.await(); f.record(value) }) { check(f.allowed) }
            }
            entered.await(); job.cancel(); yield()
            assertFalse(job.isCompleted); assertNull(f.saved)
            release.complete(Unit); job.join()
            assertEquals(f.f.saved, f.saved); assertEquals(1, f.approvals)
        }
    }
    @Test fun `suspended retention failure cannot report a successful approval`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            val result = async {
                runCatching { f.wallet().sign(f.f.prepared(), { entered.complete(Unit); release.await(); throw IOException("journal write failed") }) { check(f.allowed) } }
            }
            entered.await(); assertFalse(result.isCompleted); release.complete(Unit)
            assertTrue(result.await().isFailure); assertNull(f.saved); assertEquals(1, f.approvals)
        }
    }

    @Test fun `MFA verification cannot resume approval after admission or session changes during the provider await`() = runBlocking {
        for (logout in listOf(true, false)) {
            val f = Fixture(); f.pauseForMfa = true; val wallet = f.wallet()
            val approval = async { runCatching { f.sign(wallet) } }; f.mfaReady.await(); while (wallet.mfa.value == null) yield()
            val verification = async { runCatching { wallet.submitMfa(f.mfaRequest, "123456") } }; f.verificationEntered.await()
            try {
                if (logout) f.holder.replace(null) else f.allowed = false
                f.verificationRelease.complete(Unit); assertTrue(verification.await().isFailure)
                assertFalse(f.mfaResumed); assertFalse(f.continueMfa.isCompleted); assertEquals(0, f.approvals); assertNull(f.saved)
            } finally { approval.cancelAndJoin() }
        }
    }

}
