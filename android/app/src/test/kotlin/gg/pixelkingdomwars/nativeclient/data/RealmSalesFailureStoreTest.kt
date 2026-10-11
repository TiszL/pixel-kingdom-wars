package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal class RealmFailureFixture {
    companion object { private val ids = java.util.concurrent.atomic.AtomicInteger() }
    class Memory : SecretStore {
        var value: String? = null; var failWrite = false; var failRead = false; var afterWrite: (() -> Unit)? = null
        override fun read(): String? { if (failRead) throw IOException("locked"); return value }
        override fun write(value: String) { if (failWrite) throw IOException("full"); this.value = value; afterWrite?.also { afterWrite = null }?.invoke() }
        override fun clear() = error("Never clear original history")
    }
    private fun raw(path: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource(path)).readText()).jsonObject
    val raw = raw("/realm-sale-failure.json")
    val policy = RealmSalesSavedPolicy.from(raw("/realm-sale-journal-fixture.json").getValue("policy").jsonObject)
    val p = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, policy.protocol)
    val w = RealmSaleSignedWire.from(raw.getValue("wire").jsonObject)
    val failure = RealmSaleFailure.from(p, w, raw.getValue("failure").jsonObject, policy.protocol)
    val trust = RealmSaleFailureTrust(RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer,
        p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision), failure.receipt.source.upgradeAuthority)
    val disk = Memory(); val identity = StarterIdentity("https://realm-failure-${ids.incrementAndGet()}.test", "devnet", p.wallet)
    val key get() = p.idempotencyKey
    val request = RealmSalePrepareRequest(key, p.spot, p.realm)
    val signed = Base64.getEncoder().encodeToString(w.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
    fun store(trust: RealmSaleFailureTrust? = this.trust) = RealmSalesStore(disk, identity, trust)
    fun cold(): RealmSalesStore {
        // A true empty process-lock roster, without changing document actor identity.
        val field = RealmSalesStore::class.java.getDeclaredField("identities").also { it.isAccessible = true }
        @Suppress("UNCHECKED_CAST") (field.get(null) as MutableMap<StarterIdentity, *>).remove(identity)
        return store()
    }
    suspend fun started(): RealmSalesStore = store().also { it.begin(it.read(), request, policy); it.prepareAttempt(it.read()); it.acceptPreparation(key, p); it.signingAttempt(it.read()) }
    suspend fun signed(): RealmSalesStore = started().also { it.acceptSigned(key, signed) }
    suspend fun failed(): RealmSalesStore = signed().also { it.acceptFailure(key, raw.getValue("wire"), raw.getValue("failure")) }
}
class RealmSalesFailureStoreTest {
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue(runCatching { block() }.isFailure) }
    @Test fun `bound historical failure survives restart and archives exact wire fees and original policy atomically`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.failed(); val before = s.read(); assertNotNull(before.operation!!.failure)
        assertTrue(before.settlementHeld); s.archiveFailed(before, f.failure)
        val cold = f.cold(); assertNull(cold.read().operation); assertFalse(cold.read().settlementHeld)
        val archived = cold.archived(f.key)!!.operation; assertEquals(f.failure, archived.failure!!.value)
        assertEquals(f.signed, archived.signed!!.wire); assertNull(archived.settlement); assertEquals(f.policy, archived.policy)
        refuses { cold.begin(cold.read(), f.request, f.policy) }
    }
    @Test fun `unknown malformed and missing independently pinned evidence remain held without clearing`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.signed()
        refuses { s.acceptFailure(f.key, f.raw.getValue("wire"), JsonPrimitive("malformed")) }
        assertTrue(f.cold().read().settlementHeld); refuses { s.archive(s.read()) }; refuses { s.submitAttempt(s.read()) }
        val g = RealmFailureFixture(); val unpinned = g.signed()
        refuses { g.store(null).acceptFailure(g.key, g.raw.getValue("wire"), g.raw.getValue("failure")) }
        assertNull(unpinned.read().operation!!.failure); assertTrue(unpinned.read().settlementHeld)
    }
    @Test fun `late original signed wire retained before malformed adjacent failure`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.started()
        refuses { s.acceptFailure(f.key, f.raw.getValue("wire"), JsonPrimitive("broken")) }
        assertEquals(f.signed, f.cold().read().operation!!.signed!!.wire)
    }
    @Test fun `failed archival requires prior bound evidence exact fresh proof and unchanged revision`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.signed(); val old = s.read()
        s.acceptFailure(f.key, f.raw.getValue("wire"), f.raw.getValue("failure")); refuses { s.archiveFailed(old, f.failure) }
        val current = s.read(); refuses { s.archiveFailed(current, f.failure.copy(verifiedAt = "2020-01-01T00:00:00.000000Z")) }
        f.disk.failWrite = true; val bytes = f.disk.value; refuses { s.archiveFailed(current, f.failure) }; assertEquals(bytes, f.disk.value)
        f.disk.failWrite = false; assertNotNull(s.read().operation); s.archiveFailed(s.read(), f.failure); Unit
    }
    @Test fun `contradictory paid and unknown holds block failed archive and all subsequent effects`() = runBlocking {
        for (unknown in listOf(false, true)) {
            val f = RealmFailureFixture(); val s = f.failed()
            if (unknown) s.observeUnknownKey(f.key) else s.observeSettlementKey(f.key)
            val held = s.read(); refuses { s.archiveFailed(held, f.failure) }; refuses { s.submitAttempt(held) }
            assertTrue(f.cold().read().settlementHeld)
        }
    }
    @Test fun `post archive contradiction survives cold process and cannot modify immutable history`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.failed(); s.archiveFailed(s.read(), f.failure)
        val history = s.archived(f.key); s.observeSettlementKey(f.key); s.read()
        val cold = f.cold(); assertTrue(cold.read().settlementHeld); assertEquals(history, cold.archived(f.key))
        refuses { cold.begin(cold.read(), f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), f.policy) }
    }
    @Test fun `observation arriving during archive completion is flushed before return and remains after cold restart`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.failed(); val before = s.read()
        f.disk.afterWrite = { s.observeUnknownKey(f.key) }
        s.archiveFailed(before, f.failure)
        val cold = f.cold(); assertTrue(cold.read().settlementHeld); assertNotNull(cold.archived(f.key))
    }
    @Test fun `storage failure keeps synchronous refusal guard until durable observations flush`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.started(); val guard = s.effectGuard(s.read())
        f.disk.failRead = true; refuses { s.observeFailure(f.key) }; refuses { guard() }
        f.disk.failRead = false; f.disk.failWrite = true; refuses { s.read() }; refuses { guard() }
        f.disk.failWrite = false; s.read(); assertTrue(f.cold().read().settlementHeld)
    }
    @Test fun `foreign or changed persisted failure pins cannot be treated as saved historical authority`() = runBlocking {
        val f = RealmFailureFixture(); f.failed()
        refuses { f.store(f.trust.copy(upgradeAuthority = null)).read() }; refuses { f.store(null).read() }
        val original = f.disk.value!!; f.disk.value = original.replace(f.trust.signing.reviewedProgramDataSha256, "ab".repeat(32))
        refuses { f.store().read() }
    }
    @Test fun `a changed failure attestation cannot be ignored by subsequently replaying older accepted evidence`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.failed()
        val changed = f.failure.copy(verifiedAt = "2020-01-01T00:00:00.000000Z")
        refuses { s.acceptFailure(f.key, f.raw.getValue("wire"), Json.encodeToJsonElement(RealmSaleFailure.serializer(), changed)) }
        refuses { s.archiveFailed(s.read(), f.failure) }; assertNotNull(f.cold().read().operation)
    }

}
