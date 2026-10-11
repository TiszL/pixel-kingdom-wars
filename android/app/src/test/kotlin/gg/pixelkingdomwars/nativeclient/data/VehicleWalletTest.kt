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

/** Public vehicle vectors exercise both existing sign-only wallet tracks. */
internal class VehicleWalletFixture {
    val actor=VehicleFixtures.wallet
    val wire:ByteArray get()=VehicleFixtures.wire.charterText("signedTransactionHex").chunked(2).map{it.toInt(16).toByte()}.toByteArray()
    fun prepared()=VehicleTransaction.prepare(VehicleFixtures.client,VehicleFixtures.pins,VehicleFixtures.policy)
    val signed:JsonObject get()=prepared().verifySigned(wire)
    val saved get()=signed
}

class VehicleWalletTest {
    private class Fixture {
        val f = VehicleWalletFixture()
        val holder = testHolder(); val session = signedIn(holder, f.actor)
        var embedded = true; var approvals = 0; var allowed = true; var socialCalls = 0
        var afterSign: () -> Unit = {}; var recordFails = false; var changedWire = false; var afterEvidenceFails = false
        var signerGuard: () -> Unit = {};var setupFails=false;var invocationFails=false;var markers=0;var markerFails=false;var afterMarker:()->Unit={}
        suspend fun mark(){check(markers==0);if(markerFails)throw IOException("journal unavailable");markers++;events+="mark";afterMarker()}
        var pauseForMfa = false; var mfaResumed = false
        val mfaRequest = PrivyMfaRequest("fixture-user", setOf("totp"))
        val mfaReady = CompletableDeferred<Unit>(); val continueMfa = CompletableDeferred<Unit>()
        val verificationEntered = CompletableDeferred<Unit>(); val verificationRelease = CompletableDeferred<Unit>()
        suspend fun verifyMfa(guard: () -> Unit) { guard(); verificationEntered.complete(Unit); verificationRelease.await(); guard(); mfaResumed = true; continueMfa.complete(Unit) }
        var saved: JsonObject? = null
        val events = mutableListOf<String>()
        fun bytes() = f.wire.also { if (changedWire) it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        val signer = object : DurableWalletTransactionSigner {
            override val address = f.actor
            override suspend fun signMessage(message: ByteArray): ByteArray = error("No detached signing")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray = error("Durable signing required")
            override suspend fun signTransactionWithEvidence(serialized: ByteArray, onSigned: (ByteArray) -> Unit): ByteArray {
                assertArrayEquals(f.prepared().unsignedTransaction(), serialized)
                approvals++; events += "sign";if(invocationFails)throw IOException("invoked outcome unknown"); val wire = bytes(); afterSign(); onSigned(wire)
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
                assertEquals(f.actor, wallet); assertSame(this@Fixture.session.token, session)
                requireCurrentIdentity();if(setupFails)throw IOException("restore unavailable"); signerGuard = requireCurrentIdentity
                if (pauseForMfa) { mfa.value = mfaRequest; mfaReady.complete(Unit); continueMfa.await(); requireCurrentIdentity() }
                return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) = verifyMfa {}
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) = verifyMfa(requireCurrentIdentity)
            override fun cancelMfa() {}
            override suspend fun logout(): Unit = error("unused")
        }
        var external = VehicleExternalSigner { prepared, cluster, onSigned, beforeWallet, guard ->
            assertEquals(SolanaCluster.DEVNET, cluster);guard();if(setupFails)throw IOException("association unavailable");beforeWallet();guard(); approvals++; events += "sign";if(invocationFails)throw IOException("invoked outcome unknown")
            val result = if (changedWire) JsonObject(f.signed+("signedTransactionHex" to JsonPrimitive(bytes().joinToString(""){"%02x".format(it.toInt() and 255)}))) else f.signed
            afterSign(); onSigned(result)
            if (afterEvidenceFails) throw IOException("association ended")
            guard(); result
        }
        fun wallet() = VehicleWallet(session, holder, session.origin, SolanaCluster.DEVNET, { embedded },
            { socialCalls++; social }, external)
        suspend fun record(value: JsonObject) { events += "record"; if (recordFails) throw IOException("storage unavailable"); saved = value }
        suspend fun sign(wallet: VehicleWallet = wallet()): JsonObject = wallet.sign(f.prepared(), ::record, ::mark) { check(allowed) { "admission changed" } }
    }
    private suspend fun refuses(block: suspend () -> Unit) {
        try { block(); fail("Expected refusal") } catch (error: AssertionError) { throw error } catch (_: Exception) {}
    }

    @Test fun `failed embedded restore or external setup leaves same original retryable before invocation`()=runBlocking {
        for(embedded in listOf(true,false)){val f=Fixture();f.embedded=embedded;f.setupFails=true;refuses{f.sign()};assertEquals(0,f.markers);assertEquals(0,f.approvals);assertNull(f.saved);f.setupFails=false;assertEquals(f.f.saved,f.sign());assertEquals(1,f.markers);assertEquals(1,f.approvals)}
    }
    @Test fun `failure after signing invocation keeps uncertainty and prevents a second prompt`()=runBlocking {
        for(embedded in listOf(true,false)){val f=Fixture();f.embedded=embedded;f.invocationFails=true;refuses{f.sign()};assertEquals(1,f.markers);assertEquals(1,f.approvals);assertNull(f.saved);f.invocationFails=false;refuses{f.sign()};assertEquals(1,f.approvals)}
    }
    @Test fun `failed durable marker or expired review after its write never invokes the concrete signer`()=runBlocking {
        for(embedded in listOf(true,false))for(expired in listOf(true,false)){val f=Fixture();f.embedded=embedded;if(expired)f.afterMarker={f.allowed=false}else f.markerFails=true;refuses{f.sign()};assertEquals(if(expired)1 else 0,f.markers);assertEquals(0,f.approvals);assertNull(f.saved)}
    }
    @Test fun `external success cannot bypass the required signing boundary`()=runBlocking {
        val f=Fixture();f.embedded=false;f.external=VehicleExternalSigner{_,_,_,_,_->f.f.signed};refuses{f.sign()};assertEquals(0,f.markers);assertNull(f.saved)
    }
    @Test fun `availability preflight never prompts and missing tracks refuse before an approval`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            f.wallet().requireAvailable { check(f.allowed) }; assertEquals(0, f.approvals)
            val missing = VehicleWallet(f.session, f.holder, f.session.origin, SolanaCluster.DEVNET, { embedded }, { null }, null)
            refuses { missing.requireAvailable {} }; assertEquals(0, f.approvals)
        }
    }
    @Test fun `both wallet tracks retain exact full wire once without a broadcast interface`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            assertEquals(f.f.saved, f.sign()); assertEquals(f.f.saved, f.saved)
            assertEquals(1, f.approvals); assertEquals(listOf("mark", "sign", "record"), f.events)
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
        f.external = VehicleExternalSigner { _, _, retain, beforeWallet, guard -> entered.complete(Unit); release.await();beforeWallet();guard(); retain(f.f.signed); guard(); f.f.signed }
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
                f.wallet().sign(f.f.prepared(), { value -> entered.complete(Unit); release.await(); f.record(value) }, f::mark) { check(f.allowed) }
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
                runCatching { f.wallet().sign(f.f.prepared(), { entered.complete(Unit); release.await(); throw IOException("journal write failed") }, f::mark) { check(f.allowed) } }
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
