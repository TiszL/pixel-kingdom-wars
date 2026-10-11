package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.Base64

/** Generated backend preparation and public signed wire, never a persisted signing key. */
internal class MiningTaxClaimsWalletFixture {
    private val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject
    val policy = MiningTaxClaimsSigningPolicy(raw.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
    private val recovery = MiningTaxClaimsRecoveryEnvelope.from(raw.getValue("recoveries").jsonObject.getValue("combined").jsonObject)
    val preparation = requireNotNull(recovery.preparation)
    val trust = MiningTaxClaimsSigningTrust(preparation.identity.genesisHash, preparation.identity.programId, preparation.identity.configAddress,
        preparation.identity.keepMint, preparation.identity.reserveOwner, preparation.source.reviewedDeploymentSlot, preparation.source.reviewedProgramDataSha256)
    private val value = recovery.wires.single()
    val signed = SignedMiningTaxClaims(0, Base64.getEncoder().encodeToString(value.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()), value.signature, value.messageSha256, value.wireSha256)
    val wire: ByteArray get() = Base64.getDecoder().decode(signed.wire)
    val saved get() = signed
    suspend fun prepared() = MiningTaxClaimsCrypto.prepare(preparation, trust, policy)

}

class MiningTaxClaimsWalletTest {
    private class Fixture {
        val f = MiningTaxClaimsWalletFixture()
        val holder = testHolder(); val session = signedIn(holder, f.preparation.wallet)
        var embedded = true; var approvals = 0; var allowed = true; var socialCalls = 0
        var afterSign: () -> Unit = {}; var recordFails = false; var changedWire = false; var afterEvidenceFails = false
        var signerGuard: () -> Unit = {}; var repeatEvidence = false; var conflictEvidence = false; var wrongAddress = false
        var pauseForMfa = false; var mfaSubmissions = 0
        val mfaRequest = PrivyMfaRequest("fixture-user", setOf("totp"))
        val mfaReady = CompletableDeferred<Unit>(); val continueMfa = CompletableDeferred<Unit>()
        var pauseVerification = false
        val verificationEntered = CompletableDeferred<Unit>(); val verificationRelease = CompletableDeferred<Unit>()
        var saved: SignedMiningTaxClaims? = null
        val events = mutableListOf<String>()
        fun bytes() = f.wire.also { if (changedWire) it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        val signer = object : DurableWalletTransactionSigner {
            override val address get() = if (wrongAddress) f.preparation.identity.keepMint else f.preparation.wallet
            override suspend fun signMessage(message: ByteArray): ByteArray = error("No detached signing")
            override suspend fun signTransaction(serialized: ByteArray): ByteArray = error("Durable signing required")
            override suspend fun signTransactionWithEvidence(serialized: ByteArray, onSigned: (ByteArray) -> Unit): ByteArray {
                assertArrayEquals(f.prepared().unsignedTransaction(), serialized)
                approvals++; events += "sign"; val wire = bytes(); afterSign(); onSigned(wire)
                if (repeatEvidence) onSigned(wire)
                if (conflictEvidence) onSigned(wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() })
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
                assertEquals(f.preparation.wallet, wallet); assertSame(this@Fixture.session.token, session)
                requireCurrentIdentity(); signerGuard = requireCurrentIdentity
                if (pauseForMfa) { mfa.value = mfaRequest; mfaReady.complete(Unit); continueMfa.await(); requireCurrentIdentity() }
                return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String): Unit = error("Tax MFA requires the live guard")
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) {
                assertSame(mfaRequest, request); requireCurrentIdentity(); mfaSubmissions++
                if (pauseVerification) { verificationEntered.complete(Unit); verificationRelease.await() }
                requireCurrentIdentity(); continueMfa.complete(Unit)
            }
            override fun cancelMfa() {}
            override suspend fun logout(): Unit = error("unused")
        }
        var external = MiningTaxClaimsExternalSigner { prepared, cluster, onSigned, guard ->
            assertEquals(SolanaCluster.DEVNET, cluster); approvals++; events += "sign"
            val result = if (changedWire) f.signed.copy(wire = Base64.getEncoder().encodeToString(bytes())) else f.signed
            afterSign(); onSigned(result)
            if (repeatEvidence) onSigned(result)
            if (conflictEvidence) onSigned(result.copy(wireSha256 = "ab".repeat(32)))
            if (afterEvidenceFails) throw IOException("association ended")
            guard(); result
        }
        fun wallet() = MiningTaxClaimsWallet(session, holder, session.origin, SolanaCluster.DEVNET, { embedded },
            { socialCalls++; social }, external)
        suspend fun record(value: SignedMiningTaxClaims) { events += "record"; if (recordFails) throw IOException("storage unavailable"); saved = value }
        suspend fun sign(wallet: MiningTaxClaimsWallet = wallet()): SignedMiningTaxClaims = wallet.sign(f.prepared(), ::record) { check(allowed) { "admission changed" } }
    }
    private suspend fun refuses(block: suspend () -> Unit) {
        try { block(); fail("Expected refusal") } catch (error: AssertionError) { throw error } catch (_: Exception) {}
    }

    @Test fun `availability preflight never prompts and missing tracks refuse before an approval`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            f.wallet().requireAvailable { check(f.allowed) }; assertEquals(0, f.approvals)
            val missing = MiningTaxClaimsWallet(f.session, f.holder, f.session.origin, SolanaCluster.DEVNET, { embedded }, { null }, null)
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
        f.external = MiningTaxClaimsExternalSigner { _, _, retain, guard -> entered.complete(Unit); release.await(); retain(f.f.signed); guard(); f.f.signed }
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

    @Test fun `duplicate callbacks share one durable write while conflicting callbacks retain only the first valid wire`() = runBlocking {
        for (embedded in listOf(true, false)) for (conflict in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded; f.repeatEvidence = true; f.conflictEvidence = conflict
            if (conflict) refuses { f.sign() } else assertEquals(f.f.saved, f.sign())
            assertEquals(f.f.saved, f.saved); assertEquals(listOf("sign", "record"), f.events)
        }
    }
    @Test fun `a cancelled suspended availability lookup cannot reach a later approval`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            val wallet = MiningTaxClaimsWallet(f.session, f.holder, f.session.origin, SolanaCluster.DEVNET,
                { entered.complete(Unit); withContext(NonCancellable) { release.await() }; embedded }, { f.social }, f.external)
            val job = launch { f.sign(wallet) }; entered.await(); job.cancel(); release.complete(Unit); job.join()
            assertEquals(0, f.approvals); assertNull(f.saved)
        }
    }
    @Test fun `a different embedded signer address or origin cannot open approval`() = runBlocking {
        val f = Fixture(); f.wrongAddress = true; refuses { f.sign() }; assertEquals(0, f.approvals)
        val wallet = MiningTaxClaimsWallet(f.session, f.holder, "https://other.example", SolanaCluster.DEVNET, { false }, { f.social }, f.external)
        refuses { wallet.requireAvailable {} }; refuses { f.sign(wallet) }; assertEquals(0, f.approvals)
    }
    @Test fun `MFA remains attached to the one active original approval and rechecks admission before code submission`() = runBlocking {
        val f = Fixture(); f.pauseForMfa = true; val wallet = f.wallet()
        val approval = async { f.sign(wallet) }; f.mfaReady.await()
        while (wallet.mfa.value == null) yield()
        refuses { wallet.submitMfa(PrivyMfaRequest("fixture-user", setOf("totp")), "123456") }
        f.allowed = false; refuses { wallet.submitMfa(f.mfaRequest, "123456") }; assertEquals(0, f.mfaSubmissions); assertEquals(0, f.approvals)
        f.allowed = true; wallet.submitMfa(f.mfaRequest, "123456"); assertEquals(f.f.saved, approval.await())
        assertEquals(1, f.mfaSubmissions); assertEquals(1, f.approvals); assertNull(wallet.mfa.value)
        refuses { wallet.submitMfa(f.mfaRequest, "123456") }; assertEquals(1, f.mfaSubmissions)
    }
    @Test fun `a session or admission change during MFA verification cannot resume blocked signing`() = runBlocking {
        for (logout in listOf(true, false)) {
            val f = Fixture(); f.pauseForMfa = true; f.pauseVerification = true; val wallet = f.wallet()
            val approval = async { f.sign(wallet) }; f.mfaReady.await(); while (wallet.mfa.value == null) yield()
            val verification = async { runCatching { wallet.submitMfa(f.mfaRequest, "123456") } }; f.verificationEntered.await()
            if (logout) f.holder.replace(null) else f.allowed = false
            f.verificationRelease.complete(Unit); assertTrue(verification.await().isFailure)
            assertFalse(f.continueMfa.isCompleted); assertEquals(0, f.approvals); assertNull(f.saved)
            approval.cancelAndJoin()
        }
    }

}
