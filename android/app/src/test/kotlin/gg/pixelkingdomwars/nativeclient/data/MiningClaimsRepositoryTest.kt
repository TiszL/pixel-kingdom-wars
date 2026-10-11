package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.PreparedMiningClaim
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningClaimsRepositoryTest {
    private class Fixture {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/mining-claim-journal-fixture.json")).bufferedReader().use { it.readText() }).jsonObject
        val policy = MiningClaimsProtocolPolicy(9, 1, 120)
        val p = MiningClaimPreparationView.from(raw.getValue("preparation").jsonObject, policy)
        val wire = raw.getValue("signed").jsonObject.getValue("wire").jsonPrimitive.content
        val signature = raw.getValue("signed").jsonObject.getValue("signature").jsonPrimitive.content
        val pins = p.identity.let { MiningClaimSigningTrust(it.genesisHash, it.programId, it.configAddress, it.keepMint, it.reserveOwner) }
        val memory = MemoryStore(); val identity = StarterIdentity("https://game.test", "devnet", p.wallet)
        var generation = 1; var active = true; var admission = true; var trust: MiningClaimSigningTrust? = pins; var catalogue: MiningClaimsProtocolPolicy? = policy
        var milliseconds = 0L; var serverNow = p.serverNow; var root = p.rootSequence
        var prepared = false; var paid = false; var prepares = 0; var submits = 0; var signs = 0; var liveChecks = 0
        var failure: MiningClaimView? = null; var claimReads = 0; var statusReads = 0; var nextKey = p.idempotencyKey; var nextClaimId = p.claimId
        var losePrepare = false; var loseSubmit = false; var latePrepare = false; var lateSign = false; var cancelWallet = false
        fun store() = MiningClaimsStore(memory, identity)
        fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), p.wallet, "shardkeep-economy", p.identity.programId, p.identity.keepMint,
            "ready", null, root, "80", "0", "80", 9, 200, "7200", "7200", true, true, true, false, serverNow)
        fun claim() = failure ?: if (paid) MiningClaimView(1, p.wallet, p.claimId, "settled", "finalized", signature, "80",
            listOf(MiningClaimLanding(0, "combined", signature, "finalized", "80", p.serverNow, p.serverNow)), serverNow, false)
        else MiningClaimView(1, p.wallet, p.claimId, "prepared", "pending", null, null,
            listOf(MiningClaimLanding(0, "combined", null, "pending", null, null, null)), serverNow, false)
        val ports = object : MiningClaimsPorts {
            override fun capture(newAction: Boolean): () -> Unit {
                val original = generation; val originalTrust = trust
                val guard = { check(active && generation == original); if (newAction) check(admission && originalTrust != null && trust == originalTrust) }
                guard(); return guard
            }
            override fun policy() = catalogue
            override fun trust() = trust
            override fun key() = nextKey
            override fun clockMs() = milliseconds
            override suspend fun status(guard: () -> Unit) = status().also { statusReads++; guard() }
            override suspend fun prepare(request: MiningClaimPrepareRequest, guard: () -> Unit, retain: (MiningClaimPreparationView) -> Unit, refusal: (MiningClaimPrepareRefusal) -> Unit): MiningClaimPreparationView {
                assertTrue(store().read().operation!!.prepareAttempted); prepares++; prepared = true
                if (losePrepare) throw IOException("lost prepare")
                if (latePrepare) generation++
                val value = p.copy(idempotencyKey = request.idempotencyKey, claimId = nextClaimId, quoteId = nextClaimId)
                retain(value); guard(); return value
            }
            override suspend fun preparation(key: String, guard: () -> Unit, retain: (MiningClaimPreparationEnvelope) -> Unit): MiningClaimPreparationEnvelope {
                val result = MiningClaimPreparationEnvelope(p.wallet, key, if (prepared) "prepared" else "unknown", if (prepared) p.copy(serverNow = serverNow) else null, serverNow)
                retain(result); guard(); return result
            }
            override suspend fun claim(id: String, guard: () -> Unit, retain: (MiningClaimView) -> Unit): MiningClaimView = claim().also { claimReads++; retain(it); guard() }
            override suspend fun live(preparation: MiningClaimPreparationView, guard: () -> Unit) { liveChecks++; guard() }
            override suspend fun sign(prepared: PreparedMiningClaim, guard: () -> Unit, retain: (MiningClaimSavedWire) -> Unit) {
                assertTrue(store().read().operation!!.signingStarted); signs++
                if (cancelWallet) throw IOException("wallet cancelled")
                if (lateSign) generation++
                val signed = prepared.verifySignedBase64(wire); retain(MiningClaimSavedWire(signed.ordinal, signed.wire, signed.signature)); guard()
            }
            override suspend fun submit(request: MiningClaimSubmitRequest, guard: () -> Unit): MiningClaimSubmitResponse {
                assertTrue(store().read().operation!!.submitAttempted); assertEquals(wire, request.signedTransaction); submits++
                if (loseSubmit) throw IOException("lost submit")
                guard(); return MiningClaimSubmitResponse(p.claimId, signature, serverNow, "held")
            }
        }
        fun repo() = MiningClaimsRepository(store(), ports)
        suspend fun reviewed() = repo().also { it.open(); it.begin(); it.review() }
        fun failed() = MiningClaimView(1, p.wallet, p.claimId, "failed", "failed", signature, null,
            listOf(MiningClaimLanding(0, "combined", signature, "failed", null, p.serverNow, p.serverNow)), serverNow, false)
    }
    private suspend fun refuses(block: suspend () -> Unit) { try { block(); fail("Expected refusal") } catch (e: AssertionError) { throw e } catch (_: Exception) {} }
    @Test fun `lost prepare reply recovers by GET after repository and store restart without another POST`() = runBlocking {
        val f = Fixture(); f.losePrepare = true; refuses { f.repo().begin() }; val r = f.repo(); r.open()
        assertEquals(f.p, r.state.value.journal!!.operation!!.preparation); refuses { r.begin() }
        r.review(); assertEquals(1, f.prepares); assertEquals(0, f.signs); assertEquals(0, f.submits)
    }
    @Test fun `stale session saves late preparation and valid signature but cannot submit or publish from old controller`() = runBlocking {
        val f = Fixture(); f.latePrepare = true; refuses { f.repo().begin() }; assertEquals(f.p, f.store().read().operation!!.preparation)
        val r = f.repo(); r.open(); r.review(); f.lateSign = true; refuses { r.sign() }
        assertEquals(f.wire, f.store().read().operation!!.signed!!.wire); assertEquals(0, f.submits)
    }
    @Test fun `signed wire and first submit survive lost response while paused null-trust receipt finishes history`() = runBlocking {
        val f = Fixture(); val r = f.reviewed(); r.sign(); assertEquals(0, f.submits)
        f.loseSubmit = true; refuses { r.submit() }; refuses { f.repo().submit() }; assertEquals(1, f.submits)
        f.admission = false; f.trust = null; f.catalogue = null; f.paid = true
        val recovered = f.repo(); recovered.open(); assertEquals("settled", recovered.state.value.journal!!.operation!!.claim!!.state)
        recovered.finish(); assertNull(recovered.state.value.journal!!.operation); assertEquals(f.wire, f.store().read().archives.single().signed!!.wire)
        assertEquals(1, f.prepares); assertEquals(1, f.signs); assertEquals(1, f.submits)
    }
    @Test fun `wallet cancellation requires another explicit review of the same message and never automatically submits`() = runBlocking {
        val f = Fixture(); val r = f.reviewed(); f.cancelWallet = true; refuses { r.sign() }; assertNull(r.state.value.review)
        refuses { r.sign() }; assertEquals(1, f.signs); assertTrue(f.store().read().operation!!.signingStarted)
        f.cancelWallet = false; r.review(); r.sign(); assertEquals(f.wire, f.store().read().operation!!.signed!!.wire); assertEquals(2, f.signs); assertEquals(0, f.submits)
    }
    @Test fun `expired server quote and changed root refuse fresh review without wallet approval or lost evidence`() = runBlocking {
        val expired = Fixture(); val r = expired.reviewed(); expired.milliseconds = 120000
        refuses { r.sign() }; assertEquals(0, expired.signs)
        expired.serverNow = expired.p.expiresAt; refuses { r.review() }; assertNotNull(expired.store().read().operation)
        val changed = Fixture(); val c = changed.reviewed(); changed.root = "2"; refuses { c.review() }; assertEquals(0, changed.signs)
    }
    @Test fun `dismissal invalidates reviewed approval and untrusted deployment cannot start or sign`() = runBlocking {
        val f = Fixture(); val r = f.reviewed(); r.dismiss(); refuses { r.sign() }; assertEquals(0, f.signs)
        f.trust = f.pins.copy(programId = f.pins.keepMint); r.review(); refuses { r.sign() }; assertEquals(0, f.signs)
        val dark = Fixture(); dark.trust = null; refuses { dark.repo().begin() }; assertEquals(0, dark.prepares)
    }
    @Test fun `failed signed claim survives restart and paused recovery archives by fresh GET without another submit`() = runBlocking {
        val f = Fixture(); val r = f.reviewed(); r.sign(); f.loseSubmit = true; refuses { r.submit() }
        f.failure = f.failed(); f.admission = false; f.trust = null; f.catalogue = null
        val recovered = f.repo(); recovered.open(); assertEquals("failed", recovered.state.value.journal!!.operation!!.claim!!.state)
        refuses { recovered.finish() }; val before = f.claimReads; recovered.archiveFailed()
        assertEquals(before + 1, f.claimReads); assertNull(recovered.state.value.journal!!.operation)
        assertEquals(f.wire, f.store().read().archives.single().signed!!.wire)
        recovered.open(); assertEquals(1, f.prepares); assertEquals(1, f.signs); assertEquals(1, f.submits)
        f.admission = true; f.trust = f.pins; f.catalogue = f.policy; f.failure = null
        f.nextKey = java.util.UUID.randomUUID().toString(); f.nextClaimId = java.util.UUID.randomUUID().toString()
        val statusReads = f.statusReads; recovered.begin()
        assertEquals(statusReads + 1, f.statusReads); assertEquals(2, f.prepares); assertEquals(1, f.signs); assertEquals(1, f.submits)
        assertEquals("failed", f.store().read().archives.single().claim!!.state)
    }
    @Test fun `failed recovery refuses changed terminal proof and forbids resigning resubmission or time based retirement`() = runBlocking {
        val f = Fixture(); val r = f.reviewed(); r.sign(); f.failure = f.failed(); r.open()
        refuses { r.review() }; refuses { r.sign() }; refuses { r.submit() }
        assertEquals(1, f.signs); assertEquals(0, f.submits)
        val original = f.store().read(); f.failure = f.failed().copy(transactions = f.failed().transactions.map { it.copy(settledAt = "2035-01-01T00:00:01.000Z") })
        refuses { r.archiveFailed() }; assertEquals(original, f.store().read())
        val ambiguous = Fixture(); val pending = ambiguous.reviewed(); pending.sign(); ambiguous.milliseconds = Long.MAX_VALUE
        refuses { pending.archiveFailed() }; assertNotNull(ambiguous.store().read().operation); assertTrue(ambiguous.store().read().archives.isEmpty())
    }
}
