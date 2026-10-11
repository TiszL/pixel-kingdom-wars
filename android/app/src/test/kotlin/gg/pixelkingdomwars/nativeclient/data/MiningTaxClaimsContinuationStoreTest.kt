package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsContinuationStoreTest {
    companion object { private val ids = AtomicInteger() }
    private class Disk : SecretStore {
        var value: String? = null; var fail = false; var afterWrite: () -> Unit = {}
        override fun read() = value
        override fun write(value: String) { if (fail) throw IOException("storage unavailable"); this.value = value; afterWrite() }
        override fun clear() = error("History must survive")
    }
    private class F {
        val envelope = MiningTaxClaimsContinuationEnvelope.from(Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-continuation.json")).readText()).jsonObject)
        val c = envelope.continuation!!; val p = c.parentPreparation; val key = p.idempotencyKey
        val request = MiningTaxClaimsContinuationRequest(c.childPreparation.idempotencyKey, c.childPreparation.caps)
        val setup = MiningTaxClaimsRecoveryEnvelope(p.wallet, key, p.claimId, "setup", p, listOf(c.parentWire), c.parentSetup, p.preparedAt)
        val failures = MiningTaxClaimsFailureEnvelope(setup, emptyList())
        val disk = Disk(); val identity = StarterIdentity("https://tax-cont-${ids.incrementAndGet()}.test", "devnet", p.wallet)
        val trust = MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress, p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
        val policy = MiningTaxClaimsSigningPolicy(Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
        fun store() = MiningTaxClaimsStore(disk, identity, trust, policy)
        suspend fun setup(): MiningTaxClaimsStore = store().also { s ->
            s.begin(s.read(), MiningTaxClaimsPrepareRequest(key, p.round, p.spot, p.caps), 256); s.prepareAttempt(s.read()); s.acceptPreparation(key, p)
            s.signingAttempt(s.read(), 0); s.acceptSigned(key, 0, Base64.getEncoder().encodeToString(c.parentWire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()))
            s.acceptRecovery(key, 0, Json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), setup))
        }
        suspend fun intended() = setup().also { it.beginContinuation(it.read(), request) }
        suspend fun linked() = intended().also { it.continuationAttempt(it.read()); it.acceptContinuation(key, envelope) }
        suspend fun adopt(s: MiningTaxClaimsStore, row: MiningTaxClaimsJournal? = null) = s.activateContinuation(row ?: s.read(), envelope, setup, failures)
        fun cold(): MiningTaxClaimsStore {
            val field = MiningTaxClaimsStore::class.java.getDeclaredField("identities").apply { isAccessible = true }
            synchronized(MiningTaxClaimsStore.Companion) { (field.get(null) as MutableMap<*, *>).remove(identity) }
            return store()
        }
    }
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue("Unsigned continuation must preserve original evidence", runCatching { block() }.isFailure) }
    @Test fun `distinct additional intent and attempt are durable before link while all original effects stop`() = runBlocking {
        val f = F(); val s = f.intended(); val op = s.read().operation!!
        assertEquals(f.request, op.continuation!!.request); assertFalse(op.continuation.attempted)
        refuses { s.signingAttempt(s.read(), 1) }
        val premature = F(); val pending = premature.intended(); refuses { pending.acceptContinuation(premature.key, premature.envelope) }
        s.continuationAttempt(s.read()); refuses { s.continuationAttempt(s.read()) }
        assertTrue(f.cold().read().operation!!.continuation!!.attempted)
        refuses { s.beginContinuation(s.read(), f.request.copy(idempotencyKey = f.p.claimId)) }
    }
    @Test fun `known setup link and unchanged fresh reads atomically archive unsigned predecessor and adopt distinct child`() = runBlocking {
        val f = F(); val s = f.linked(); val parent = s.read().operation!!; f.adopt(s)
        val child = s.read().operation!!; assertEquals(f.c.childPreparation, child.preparation); assertTrue(child.prepareAttempted)
        assertTrue(child.transactions.isEmpty()); assertNull(child.setup); assertNull(child.settlement); assertNull(child.failure)
        val archived = s.archived(f.key)!!.operation; assertEquals(parent, archived); assertNull(archived.settlement); assertNull(archived.failure)
        assertEquals("6", archived.setup!!.settlement!!.receipt.feeLamports); assertNotNull(archived.continuation)
        assertFalse(f.cold().read().settlementHeld); assertEquals(child, f.cold().read().operation)
    }
    @Test fun `missing split setup claim marker failure or unknown observation forbids continuation intent`() = runBlocking {
        val f = F(); val s = f.setup(); s.signingAttempt(s.read(), 1); refuses { s.beginContinuation(s.read(), f.request) }
        for (failure in listOf(false, true)) { val g = F(); val t = g.setup(); if (failure) t.observeFailureKey(g.key) else t.observeSettlementKey(g.key); refuses { t.beginContinuation(t.read(), g.request) } }
        val g = F(); val t = g.setup(); refuses { t.beginContinuation(t.read(), g.request.copy(idempotencyKey = g.key)) }
    }
    @Test fun `fresh parent failure and link must exactly retain setup and contain no claim custody`() = runBlocking {
        val f = F(); val s = f.linked(); val row = s.read()
        refuses { s.activateContinuation(row, f.envelope.copy(status = "unknown", continuation = null), f.setup, f.failures) }
        val changed = f.setup.copy(settlement = f.c.parentSetup.copy(settledAt = "2026-09-27T00:00:00.000000Z"))
        refuses { s.activateContinuation(row, f.envelope, changed, f.failures) }
        refuses { s.activateContinuation(row, f.envelope, f.setup, f.failures.copy(recovery = changed)) }
        assertEquals(f.key, s.read().operation!!.request.idempotencyKey)
    }
    @Test fun `preGET revision CAS and final live holds block adoption without rewriting parent`() = runBlocking {
        val f = F(); val s = f.linked(); val row = s.read(); s.observeSettlementKey(f.key, 1)
        refuses { f.adopt(s, row) }; assertEquals(f.key, s.read().operation!!.request.idempotencyKey)
        val g = F(); val t = g.linked(); val before = t.read(); g.disk.value = g.disk.value!!.replace("\"revision\":${before.revision}", "\"revision\":${before.revision + 1}")
        refuses { g.adopt(t, before) }
        val h = F(); val u = h.linked(); refuses { u.activateContinuation(u.read(), h.envelope, h.setup, h.failures) { u.observeSettlementKey(h.key); error("session retired") } }
        assertEquals(h.key, u.read().operation!!.request.idempotencyKey)
    }
    @Test fun `failed atomic replacement retains both pending intent and complete original setup`() = runBlocking {
        val f = F(); val s = f.linked(); val before = s.read(); val raw = f.disk.value; f.disk.fail = true
        refuses { f.adopt(s, before) }; assertEquals(raw, f.disk.value); f.disk.fail = false
        assertEquals(before.operation, f.cold().read().operation); f.adopt(s); assertNotNull(f.cold().archived(f.key))
    }
    @Test fun `late unknown failure or claim observation remains durable across completed continuation archive`() = runBlocking {
        for (tag in listOf("unknown", "failure", "claim")) {
            val f = F(); val s = f.linked(); f.disk.afterWrite = { f.disk.afterWrite = {}; when (tag) { "unknown" -> s.observeSettlementKey(f.key); "failure" -> s.observeFailureKey(f.key); else -> s.observeSettlementKey(f.key, 1) } }
            f.adopt(s); assertTrue(f.cold().read().settlementHeld); assertNotNull(f.cold().archived(f.key))
            refuses { f.cold().signingAttempt(f.cold().read(), 0) }
        }
    }
    @Test fun `explicit same intent resume increments revision but never clears marker or permits old approval`() = runBlocking {
        val f = F(); val s = f.intended(); s.continuationAttempt(s.read()); val old = s.read()
        s.resumeContinuationAttempt(old); assertTrue(s.read().revision > old.revision); assertEquals(old.operation, s.read().operation)
        refuses { s.signingAttempt(s.read(), 1) }; s.acceptContinuation(f.key, f.envelope); refuses { s.resumeContinuationAttempt(s.read()) }
    }
    @Test fun `crash after durable intent before attempt is explicitly resumable with the same child consent`() = runBlocking {
        val f = F(); f.intended(); val s = f.cold(); val before = s.read(); assertFalse(before.operation!!.continuation!!.attempted)
        s.resumeContinuationAttempt(before); assertTrue(s.read().operation!!.continuation!!.attempted)
        assertEquals(f.request, s.read().operation!!.continuation!!.request); assertTrue(s.read().revision > before.revision)
    }
}
