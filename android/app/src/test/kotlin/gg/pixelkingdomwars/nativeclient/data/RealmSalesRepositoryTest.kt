package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RealmSalesRepositoryTest {
    companion object { private val ids = java.util.concurrent.atomic.AtomicInteger() }
    private class Memory : SecretStore {
        var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() = error("Original history cannot be cleared")
    }
    private class Fixture : RealmSalesPorts, RealmSalesAuthenticatedPort {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-repository-fixture.json")).readText()).jsonObject
        val policyValue = RealmSalesSavedPolicy.from(raw.getValue("policy").jsonObject)
        val p = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, policyValue.protocol)
        val wire = RealmSaleSignedWire.from(raw.getValue("wire").jsonObject)
        val signed = Base64.getEncoder().encodeToString(wire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        override val identity = StarterIdentity("https://repository-${ids.incrementAndGet()}.test", "devnet", p.wallet)
        val disk = Memory(); val store = RealmSalesStore(disk, identity)
        override val transport = RealmSalesTransport(this)
        val repo = RealmSalesRepository(store, this)
        var allowed = true; var current = true; var provider = true; var pins = true; var now = 0L
        var prepared = false; var retained = false; var settled = false; var lostPrepare = false; var lostSubmit = false
        var cancelWallet = false; var lateWallet = false; var lateHttp = false; var malformedSettlement = false; var wrongActor = false
        var walletAvailable = true; var refusal: RealmSalePrepareRefusal? = null; var absentTimeout = false
        override suspend fun readyToSign(guard: () -> Unit) { guard(); check(walletAvailable) { "Reconnect a signing wallet" } }
        var beforePrepareGuard: (() -> Unit)? = null; var beforeSignGuard: (() -> Unit)? = null; var beforeSubmitGuard: (() -> Unit)? = null
        var signCalls = 0; var liveCalls = 0; val calls = mutableListOf<String>()
        override fun policy() = policyValue
        override fun trust() = if (pins) RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer,
            p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision) else null
        override fun key() = p.idempotencyKey
        override fun clockMs() = now
        override fun capture(newAction: Boolean): () -> Unit = {
            check(current); if (newAction) check(allowed && provider)
        }
        override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) { liveCalls++; guard() }
        override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) {
            beforeSignGuard?.invoke(); guard(); signCalls++; assertTrue(store.read().operation!!.signingStarted)
            if (cancelWallet) throw CancellationException("Unknown wallet outcome")
            if (lateWallet) current = false
            retain(prepared.verifySignedBase64(signed)); guard()
        }
        fun preparation() = buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("preparation", if (prepared) raw.getValue("preparation") else JsonNull) }
        fun saved(submit: Boolean) = buildJsonObject {
            put("wallet", if (wrongActor) p.terms.seller else p.wallet); put("idempotencyKey", p.idempotencyKey)
            if (!submit) put("preparation", if (prepared) raw.getValue("preparation") else JsonNull)
            put("wire", if (malformedSettlement) JsonPrimitive("broken") else if (retained) raw.getValue("wire") else JsonNull)
            put("settlement", if (settled) raw.getValue("settlement") else JsonNull)
            if (submit) put("delivery", if (settled) "settled" else "submitted")
        }
        fun review() = raw.getValue("review").jsonObject
        override suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, retain: suspend (JsonObject) -> Unit): JsonObject {
            if (path.endsWith("/prepare")) beforePrepareGuard?.invoke()
            if (path.endsWith("/submit")) beforeSubmitGuard?.invoke()
            guard(); calls += "$method $path"
            val result = when {
                path.endsWith("/prepare") -> {
                    assertEquals("POST", method); assertTrue(store.read().operation!!.prepareAttempted)
                    assertEquals(p.idempotencyKey, body!!.getValue("idempotencyKey").jsonPrimitive.content)
                    this.refusal?.let { if (lateHttp) current = false; requireNotNull(refusal)(it); guard(); throw IOException("Prepare refused") }; prepared = true; if (lostPrepare) throw IOException("Lost prepare response"); preparation()
                }
                path.contains("/prepare/by-key/") -> preparation()
                path.contains("/review/by-key/") -> review()
                path.contains("/failures/by-key/") -> buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("failure", JsonNull) }
                path.endsWith("/submit") -> {
                    assertTrue(store.read().operation!!.submitAttempted); assertEquals(signed, body!!.getValue("signedTransaction").jsonPrimitive.content)
                    retained = true; if (lostSubmit) throw IOException("Lost submit response"); saved(true)
                }
                else -> { if (absentTimeout) throw IOException("Saved evidence unavailable"); saved(false) }
            }
            if (lateHttp) current = false
            retain(result); guard(); return result
        }
        suspend fun begin() = repo.begin(p.spot, p.realm)
        suspend fun sign() { begin(); repo.review(); repo.sign() }
    }
    private suspend fun rejects(block: suspend () -> Unit) { assertTrue("Original ambiguous outcome must remain saved", runCatching { block() }.isFailure) }
    @Test fun `explicit paused providerless refusal archive needs both fresh original absent GETs and reserves key`() = runBlocking {
        for ((status, code) in listOf(400 to "INVALID_INPUT", 422 to "INSUFFICIENT_SOL", 503 to "PHASE_E_DISABLED",
            422 to "REALM_SALE_NO_QUOTA", 422 to "REALM_SALE_UNSOLD", 422 to "REALM_SALE_REALM_UNAVAILABLE")) {
            val f = Fixture(); f.refusal = RealmSalePrepareRefusal(status, code); rejects { f.begin() }
            assertEquals(f.refusal, f.store.read().operation!!.prepareRefusal); assertEquals(f.refusal, f.repo.state.value.journal!!.operation!!.prepareRefusal); f.allowed = false; f.provider = false; f.pins = false
            val before = f.calls.size; f.repo.archiveRefusal(); assertEquals(2, f.calls.size - before); assertTrue(f.calls.drop(before).all { it.startsWith("GET ") })
            assertNull(f.store.read().operation); val history = f.repo.archived(f.p.idempotencyKey)!!.operation
            assertTrue(history.refusalConfirmedAbsent); assertNull(history.settlement); assertEquals(0, f.signCalls)
            f.allowed = true; f.provider = true; f.pins = true; rejects { f.begin() }; assertEquals(1, f.calls.count { it.startsWith("POST ") })
        }
    }
    @Test fun `late first refusal survives stale lifecycle but unknown timeout and incomplete GETs never archive`() = runBlocking {
        val f = Fixture(); f.refusal = RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL"); f.lateHttp = true; rejects { f.begin() }
        assertNotNull(f.store.read().operation!!.prepareRefusal); f.current = true; f.lateHttp = false; f.absentTimeout = true
        rejects { f.repo.archiveRefusal() }; assertNull(f.store.archived(f.p.idempotencyKey)); assertFalse(f.store.read().operation!!.refusalConfirmedAbsent)
        val unknown = Fixture(); unknown.lostPrepare = true; rejects { unknown.begin() }; unknown.prepared = false
        unknown.repo.open(); rejects { unknown.repo.archiveRefusal() }; assertNotNull(unknown.store.read().operation)
    }
    @Test fun `contradictory preparation or positive malformed settlement prevents declined archive and wallet consent`() = runBlocking {
        for (preparation in listOf(false, true)) {
            val f = Fixture(); f.refusal = RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL"); rejects { f.begin() }
            if (preparation) f.prepared = true else { f.settled = true; f.malformedSettlement = true }
            rejects { f.repo.archiveRefusal() }; rejects { f.repo.review() }; assertNotNull(f.store.read().operation)
            assertTrue(f.store.read().settlementHeld); assertNull(f.store.archived(f.p.idempotencyKey)); assertEquals(0, f.signCalls)
        }
    }
    @Test fun `stale offer refusals preserve late delivery and require complete absence before any archive`() = runBlocking {
        for (code in listOf("REALM_SALE_NO_QUOTA", "REALM_SALE_UNSOLD", "REALM_SALE_REALM_UNAVAILABLE")) {
            val f = Fixture(); f.refusal = RealmSalePrepareRefusal(422, code); f.lateHttp = true; rejects { f.begin() }
            assertEquals(f.refusal, f.store.read().operation!!.prepareRefusal)
            f.current = true; f.lateHttp = false; f.absentTimeout = true
            rejects { f.repo.archiveRefusal() }; assertNotNull(f.store.read().operation); assertNull(f.store.archived(f.p.idempotencyKey))
            assertEquals(0, f.signCalls); assertEquals(1, f.calls.count { it.startsWith("POST ") })
        }
    }
    @Test fun `positive evidence contradicts every stale offer refusal and cannot be cleared by its original code`() = runBlocking {
        for (code in listOf("REALM_SALE_NO_QUOTA", "REALM_SALE_UNSOLD", "REALM_SALE_REALM_UNAVAILABLE")) for (preparation in listOf(false, true)) {
            val f = Fixture(); f.refusal = RealmSalePrepareRefusal(422, code); rejects { f.begin() }
            if (preparation) f.prepared = true else { f.settled = true; f.malformedSettlement = true }
            rejects { f.repo.archiveRefusal() }; rejects { f.repo.review() }
            assertTrue(f.store.read().settlementHeld); assertNotNull(f.store.read().operation); assertNull(f.store.archived(f.p.idempotencyKey))
            assertEquals(0, f.signCalls); assertEquals(1, f.calls.count { it.startsWith("POST ") })
        }
    }
    @Test fun `missing wallet refuses before permanently consuming the original sign attempt`() = runBlocking {
        val f = Fixture(); f.begin(); f.repo.review(); f.walletAvailable = false
        rejects { f.repo.sign() }
        assertFalse(f.store.read().operation!!.signingStarted); assertEquals(0, f.signCalls)
        f.walletAvailable = true; f.repo.review(); f.repo.sign()
        assertTrue(f.store.read().operation!!.signingStarted); assertEquals(1, f.signCalls)
    }
    @Test fun `explicit effects persist first and recovery archive work with provider and admission paused`() = runBlocking {
        val f = Fixture(); f.sign(); assertEquals(1, f.signCalls); f.repo.submit(); assertEquals(1, f.calls.count { it == "POST /seeker/realm-sales/submit" })
        f.allowed = false; f.provider = false; f.pins = false; f.settled = true
        val before = f.calls.size; f.repo.open(); assertTrue(f.calls.drop(before).all { it.startsWith("GET ") })
        assertNotNull(f.store.read().operation!!.settlement); f.repo.archive(); assertNull(f.store.read().operation); assertNotNull(f.store.archived(f.p.idempotencyKey))
    }
    @Test fun `lost preparation response recovers only the original key without automatic prepare or signing`() = runBlocking {
        val f = Fixture(); f.lostPrepare = true; rejects { f.begin() }; assertTrue(f.store.read().operation!!.prepareAttempted)
        f.repo.open(); assertNotNull(f.store.read().operation!!.preparation); rejects { f.begin() }
        assertEquals(1, f.calls.count { it == "POST /seeker/realm-sales/prepare" }); assertEquals(0, f.signCalls)
    }
    @Test fun `unknown wallet outcome stays held and cannot sign again`() = runBlocking {
        val f = Fixture(); f.begin(); f.repo.review(); f.cancelWallet = true; rejects { f.repo.sign() }
        f.repo.open(); rejects { f.repo.review() }; rejects { f.repo.sign() }; rejects { f.repo.archive() }
        assertTrue(f.store.read().operation!!.signingStarted); assertEquals(1, f.signCalls)
    }
    @Test fun `late wallet bytes survive stale session before return to obsolete view`() = runBlocking {
        val f = Fixture(); f.begin(); f.repo.review(); f.lateWallet = true; rejects { f.repo.sign() }
        assertEquals(f.signed, f.store.read().operation!!.signed!!.wire); assertEquals(1, f.signCalls)
        assertNull(f.repo.state.value.journal!!.operation!!.signed)
    }
    @Test fun `late authenticated preparation survives lifecycle rejection`() = runBlocking {
        val f = Fixture(); f.lateHttp = true; rejects { f.begin() }; assertNotNull(f.store.read().operation!!.preparation)
    }
    @Test fun `lost submit response never causes a second post after restart`() = runBlocking {
        val f = Fixture(); f.sign(); f.lostSubmit = true; rejects { f.repo.submit() }
        val restarted = RealmSalesRepository(f.store, f); restarted.open(); rejects { restarted.submit() }
        assertEquals(1, f.calls.count { it == "POST /seeker/realm-sales/submit" }); assertEquals(f.signed, f.store.read().operation!!.signed!!.wire)
    }
    @Test fun `positive settlement beats malformed adjacent wire and prevents submit`() = runBlocking {
        val f = Fixture(); f.sign(); f.retained = true; f.settled = true; f.malformedSettlement = true
        rejects { f.repo.open() }; assertTrue(f.store.read().settlementHeld); rejects { f.repo.submit() }; rejects { f.repo.archive() }
        assertFalse(f.calls.any { it == "POST /seeker/realm-sales/submit" })
    }
    @Test fun `another actor cannot contribute a settlement hold or evidence`() = runBlocking {
        val f = Fixture(); f.sign(); f.retained = true; f.settled = true; f.wrongActor = true
        val original = f.disk.value; rejects { f.repo.open() }; assertEquals(original, f.disk.value); assertFalse(f.store.read().settlementHeld)
    }
    @Test fun `missing independent pins and expired review prevent wallet invocation`() = runBlocking {
        val f = Fixture(); f.begin(); f.repo.review(); f.pins = false; rejects { f.repo.sign() }; assertEquals(0, f.signCalls)
        f.pins = true; f.repo.review(); f.now = (f.p.terms.validUntil.toLong() - f.p.quote.unixTimestamp.toLong()) * 1000 + 1
        rejects { f.repo.sign() }; assertEquals(0, f.signCalls); assertFalse(f.store.read().operation!!.signingStarted)
    }
    @Test fun `dismissed review requires new explicit consent`() = runBlocking {
        val f = Fixture(); f.begin(); f.repo.review(); f.repo.dismiss(); rejects { f.repo.sign() }; assertEquals(0, f.signCalls)
    }
    @Test fun `same and other key positive observations arriving after signing marker stop final wallet effect`() = runBlocking {
        for (same in listOf(false, true)) {
            val f = Fixture(); f.begin(); f.repo.review()
            f.beforeSignGuard = { f.store.observeFailureKey(if (same) f.p.idempotencyKey else "ffffffff-ffff-4fff-8fff-ffffffffffff") }
            rejects { f.repo.sign() }; assertEquals(0, f.signCalls); assertTrue(f.store.read().operation!!.signingStarted)
        }
    }
    @Test fun `same and other key positive observations after submit marker stop final HTTP effect`() = runBlocking {
        for (same in listOf(false, true)) {
            val f = Fixture(); f.sign()
            f.beforeSubmitGuard = { f.store.observeFailureKey(if (same) f.p.idempotencyKey else "ffffffff-ffff-4fff-8fff-ffffffffffff") }
            rejects { f.repo.submit() }; assertFalse(f.calls.any { it == "POST /seeker/realm-sales/submit" }); assertTrue(f.store.read().operation!!.submitAttempted)
        }
    }

    @Test fun `late contradiction after durable prepare marker stops the initial unsigned HTTP effect`() = runBlocking {
        for (same in listOf(false, true)) {
            val f = Fixture()
            f.beforePrepareGuard = { f.store.observeFailureKey(if (same) f.p.idempotencyKey else "ffffffff-ffff-4fff-8fff-ffffffffffff") }
            rejects { f.begin() }; assertFalse(f.calls.any { it.startsWith("POST ") }); assertTrue(f.store.read().operation!!.prepareAttempted)
        }
    }

}
