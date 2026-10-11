package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimPreparationView
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimsProtocolPolicy
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
internal class MiningClaimsWalletFixture {
    private val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/mining-claim-journal-fixture.json"))
        .bufferedReader().use { it.readText() }).jsonObject
    val policy = MiningClaimsProtocolPolicy(9, 1, 120)
    val preparation = MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject, policy)
    val trust = preparation.identity.let { MiningClaimSigningTrust(it.genesisHash, it.programId, it.configAddress, it.keepMint, it.reserveOwner) }
    val signed = raw.getValue("signed").jsonObject.let { SignedMiningClaim(it.getValue("wire").jsonPrimitive.content, it.getValue("signature").jsonPrimitive.content) }
    val wire: ByteArray get() = Base64.getDecoder().decode(signed.wire)
    val saved = MiningClaimSavedWire(0, signed.wire, signed.signature)
    suspend fun prepared() = prepareMiningClaimsSigning(preparation, policy, trust)
}

class MiningClaimsWalletTest {
    private class Fixture {
        val f = MiningClaimsWalletFixture()
        val holder = testHolder(); val session = signedIn(holder, f.preparation.wallet)
        var embedded = true; var approvals = 0; var allowed = true; var socialCalls = 0
        var afterSign: () -> Unit = {}; var recordFails = false; var changedWire = false; var afterEvidenceFails = false
        var signerGuard: () -> Unit = {}
        var pauseForMfa = false; var mfaResumed = false
        val mfaRequest = PrivyMfaRequest("fixture-user", setOf("totp"))
        val mfaReady = CompletableDeferred<Unit>(); val continueMfa = CompletableDeferred<Unit>()
        val verificationEntered = CompletableDeferred<Unit>(); val verificationRelease = CompletableDeferred<Unit>()
        suspend fun verifyMfa(guard: () -> Unit) { guard(); verificationEntered.complete(Unit); verificationRelease.await(); guard(); mfaResumed = true; continueMfa.complete(Unit) }
        var saved: MiningClaimSavedWire? = null
        val events = mutableListOf<String>()
        fun bytes() = f.wire.also { if (changedWire) it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        val signer = object : DurableWalletTransactionSigner {
            override val address = f.preparation.wallet
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
                assertEquals(f.preparation.wallet, wallet); assertSame(this@Fixture.session.token, session)
                requireCurrentIdentity(); signerGuard = requireCurrentIdentity
                if (pauseForMfa) { mfa.value = mfaRequest; mfaReady.complete(Unit); continueMfa.await(); requireCurrentIdentity() }
                return signer
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) = verifyMfa {}
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) = verifyMfa(requireCurrentIdentity)
            override fun cancelMfa() {}
            override suspend fun logout(): Unit = error("unused")
        }
        var external = MiningClaimsExternalSigner { prepared, cluster, onSigned, guard ->
            assertEquals(SolanaCluster.DEVNET, cluster); approvals++; events += "sign"
            val result = if (changedWire) f.signed.copy(wire = Base64.getEncoder().encodeToString(bytes())) else f.signed
            afterSign(); onSigned(result)
            if (afterEvidenceFails) throw IOException("association ended")
            guard(); result
        }
        fun wallet() = MiningClaimsWallet(session, holder, session.origin, SolanaCluster.DEVNET, { embedded },
            { socialCalls++; social }, external)
        fun record(value: MiningClaimSavedWire) { events += "record"; if (recordFails) throw IOException("storage unavailable"); saved = value }
        suspend fun sign(wallet: MiningClaimsWallet = wallet()): MiningClaimSavedWire = wallet.sign(f.prepared(), ::record) { check(allowed) { "admission changed" } }
    }
    private suspend fun refuses(block: suspend () -> Unit) {
        try { block(); fail("Expected refusal") } catch (error: AssertionError) { throw error } catch (_: Exception) {}
    }

    @Test fun `protocol mapping enforces independently supplied deployment pins before wallet approval`() = runBlocking {
        val f = MiningClaimsWalletFixture()
        assertEquals(f.preparation.wallet, f.prepared().wallet)
        refuses { prepareMiningClaimsSigning(f.preparation, f.policy, f.trust.copy(reserveOwner = f.preparation.wallet)) }
        refuses { prepareMiningClaimsSigning(f.preparation.copy(needsAta = false), f.policy, f.trust) }
    }
    @Test fun `synchronous recovery validates exact bytes Ed25519 and signature without current trust or PDA work`() {
        val f = MiningClaimsWalletFixture()
        assertEquals(f.saved, verifyMiningClaimSavedWire(f.preparation, f.signed.wire))
        // Historical identity is not a source of current signing permission.
        assertEquals(f.saved, verifyMiningClaimSavedWire(f.preparation.copy(identity = f.preparation.identity.copy(reserveOwner = f.preparation.wallet)), f.signed.wire))
        for (wire in listOf(f.signed.wire + "\n", "A".repeat(1648), Base64.getEncoder().encodeToString(f.wire.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }),
            Base64.getEncoder().encodeToString(f.wire.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }))) {
            assertThrows(IllegalArgumentException::class.java) { verifyMiningClaimSavedWire(f.preparation, wire) }
        }
        assertThrows(IllegalArgumentException::class.java) { verifyMiningClaimSavedWire(f.preparation.copy(wallet = f.trust.reserveOwner), f.signed.wire) }
        assertThrows(IllegalArgumentException::class.java) { verifyMiningClaimSavedWire(f.preparation.copy(transactions = f.preparation.transactions + f.preparation.transactions), f.signed.wire) }
    }
    @Test fun `both wallet tracks retain exact full wire once without a broadcast interface`() = runBlocking {
        for (embedded in listOf(true, false)) {
            val f = Fixture(); f.embedded = embedded
            assertEquals(f.f.saved, f.sign()); assertEquals(f.f.saved, f.saved)
            assertEquals(1, f.approvals); assertEquals(listOf("sign", "record"), f.events)
            assertEquals(if (embedded) 1 else 0, f.socialCalls)
        }
    }
    @Test fun `historical recovery refuses unbounded collection prefixes and inconsistent blockhash before generic parsing`() {
        val f = MiningClaimsWalletFixture(); val tx = f.preparation.transactions.single()
        val message = Base64.getDecoder().decode(tx.message)
        val instructionOffset = 4 + (message[3].toInt() and 255) * 32 + 32
        val hostile = message.copyOfRange(0, instructionOffset) + byteArrayOf(255.toByte(), 255.toByte(), 3)
        val preparation = f.preparation.copy(transactions = listOf(tx.copy(message = Base64.getEncoder().encodeToString(hostile))))
        val wire = byteArrayOf(1) + f.wire.copyOfRange(1, 65) + hostile
        val count = assertThrows(IllegalArgumentException::class.java) { verifyMiningClaimSavedWire(preparation, Base64.getEncoder().encodeToString(wire)) }
        assertEquals("Invalid mining instruction count", count.message)
        val hash = assertThrows(IllegalArgumentException::class.java) {
            verifyMiningClaimSavedWire(f.preparation.copy(transactions = listOf(tx.copy(blockhash = f.preparation.wallet))), f.signed.wire)
        }
        assertEquals("Mining blockhash changed", hash.message)
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
        f.external = MiningClaimsExternalSigner { _, _, retain, guard -> entered.complete(Unit); release.await(); retain(f.f.signed); guard(); f.f.signed }
        val wallet = f.wallet()
        val first = async { f.sign(wallet) }; entered.await()
        refuses { f.sign(wallet) }
        release.complete(Unit); assertEquals(f.f.saved, first.await()); assertEquals(f.f.saved, f.saved)
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
