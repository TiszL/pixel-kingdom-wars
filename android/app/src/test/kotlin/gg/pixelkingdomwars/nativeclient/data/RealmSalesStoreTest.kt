package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RealmSalesStoreTest {
    companion object { private val fixtureIds = java.util.concurrent.atomic.AtomicInteger() }
    private class Memory : SecretStore {
        var value: String? = null; var failWrite = false; var failRead = false; var writes = 0
        override fun read(): String? { if (failRead) throw IOException("locked"); return value }
        override fun write(value: String) { if (failWrite) throw IOException("full"); this.value = value; writes++ }
        override fun clear() { error("Permanent history cannot be cleared") }
    }
    private class Fixture {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-journal-fixture.json")).readText()).jsonObject
        val policy = RealmSalesSavedPolicy.from(raw.getValue("policy").jsonObject)
        val preparation = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, policy.protocol)
        val wireRaw = raw.getValue("wire").jsonObject; val settlementRaw = raw.getValue("settlement").jsonObject
        val wire = RealmSaleSignedWire.from(wireRaw)
        val signed = Base64.getEncoder().encodeToString(wire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        val identity = StarterIdentity("https://game-${fixtureIds.incrementAndGet()}.test", "devnet", preparation.wallet)
        val key = preparation.idempotencyKey; val request = RealmSalePrepareRequest(key, preparation.spot, preparation.realm)
        val disk = Memory()
        fun store() = RealmSalesStore(disk, identity)
        suspend fun prepared(): RealmSalesStore = store().also { s -> s.begin(s.read(), request, policy); s.prepareAttempt(s.read()); s.acceptPreparation(key, preparation) }
        suspend fun signed(): RealmSalesStore = prepared().also { s -> s.signingAttempt(s.read()); s.acceptSigned(key, signed) }
        suspend fun settled(): RealmSalesStore = signed().also { it.acceptSettlement(key, wireRaw, settlementRaw) }
    }
    private suspend fun rejects(block: suspend () -> Unit) { assertTrue("Uncertain evidence must preserve the original", runCatching { block() }.isFailure) }
    private fun evidenceUnchanged(before: String?, after: String?) {
        // Recovery now persists document-level observations after a failed write;
        // original intent and immutable archive bytes must still be unchanged.
        fun facts(value: String?) = Json.parseToJsonElement(requireNotNull(value)).jsonObject.let { JsonObject(it - "revision" - "observations") }
        assertEquals(facts(before), facts(after)); assertNotEquals(before, after)
    }
    private suspend fun refused(f: Fixture): RealmSalesStore = f.store().also {
        it.begin(it.read(), f.request, f.policy); it.prepareAttempt(it.read())
        it.acceptPrepareRefusal(f.key, RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL"))
    }
    @Test fun `only first unsigned exact prepare refusal can be confirmed and atomically archived`() = runBlocking {
        val f = Fixture(); val s = f.store(); s.begin(s.read(), f.request, f.policy)
        rejects { s.acceptPrepareRefusal(f.key, RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL")) }
        s.prepareAttempt(s.read()); rejects { s.acceptPrepareRefusal(f.key, RealmSalePrepareRefusal(503, "INSUFFICIENT_SOL")) }
        s.acceptPrepareRefusal(f.key, RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL")); val refused = s.read()
        rejects { s.archive(refused) }; rejects { s.acceptPrepareRefusal(f.key, RealmSalePrepareRefusal(400, "INVALID_INPUT")) }
        s.confirmRefusalAbsent(refused); val confirmed = s.read(); val text = f.disk.value; f.disk.failWrite = true
        rejects { s.archive(confirmed) }; assertEquals(text, f.disk.value); assertNull(s.archived(f.key)); f.disk.failWrite = false
        val writes = f.disk.writes; s.archive(confirmed); assertEquals(writes + 1, f.disk.writes); assertNull(s.read().operation)
        val history = f.store().archived(f.key)!!.operation
        assertTrue(history.refusalConfirmedAbsent); assertNull(history.settlement); assertEquals(f.request, history.request)
        rejects { s.begin(s.read(), f.request, f.policy) }
        val prepared = Fixture(); rejects { prepared.prepared().acceptPrepareRefusal(prepared.key, RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL")) }
    }
    @Test fun `positive or contradictory evidence holds refused intent through failed storage and remount`() = runBlocking {
        for (readFailure in listOf(false, true)) for (preparation in listOf(false, true)) {
            val f = Fixture(); val s = refused(f); val original = f.disk.value
            f.disk.failRead = readFailure; f.disk.failWrite = !readFailure
            rejects { if (preparation) s.observePreparation(f.key) else s.observeSettlement(f.key) }
            f.disk.failRead = false; f.disk.failWrite = false
            val restored = f.store().read(); assertTrue(restored.settlementHeld); evidenceUnchanged(original, f.disk.value)
            rejects { f.store().confirmRefusalAbsent(restored) }; rejects { f.store().archive(restored) }
            if (preparation) { s.acceptPreparation(f.key, f.preparation); assertTrue(s.read().operation!!.refusalContradicted); rejects { s.signingAttempt(s.read()) } }
        }
    }
    @Test fun `late evidence for declined history holds identity without changing history or newer intent`() = runBlocking {
        for (positive in listOf(false, true)) {
            val f = Fixture(); val s = refused(f); s.confirmRefusalAbsent(s.read()); s.archive(s.read()); val history = s.archived(f.key)
            s.begin(s.read(), f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), f.policy)
            val original = f.disk.value; f.disk.failRead = true
            rejects { if (positive) s.observeSettlement(f.key) else s.observePreparation(f.key) }
            f.disk.failRead = false; val restored = f.store().read(); assertTrue(restored.settlementHeld)
            rejects { s.prepareAttempt(restored) }; evidenceUnchanged(original, f.disk.value); assertEquals(history, s.archived(f.key))
        }
    }
    @Test fun `old settled documents and archive records decode without additive refusal fields`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read())
        f.disk.value = f.disk.value!!.replace(",\"prepareRefusal\":null", "").replace(",\"refusalConfirmedAbsent\":false", "").replace(",\"refusalContradicted\":false", "")
            .replace(",\\\"prepareRefusal\\\":null", "").replace(",\\\"refusalConfirmedAbsent\\\":false", "").replace(",\\\"refusalContradicted\\\":false", "")
        assertNotNull(f.store().archived(f.key)!!.operation.settlement); assertNull(f.store().read().operation)
    }
    @Test fun `each effect needs its own durable marker and stale CAS cannot reset intent`() = runBlocking {
        val f = Fixture(); val s = f.store(); val empty = s.read(); s.begin(empty, f.request, f.policy)
        rejects { s.begin(empty, f.request, f.policy) }; rejects { s.acceptPreparation(f.key, f.preparation) }
        rejects { s.signingAttempt(s.read()) }; rejects { s.submitAttempt(s.read()) }
        val draft = s.read(); s.prepareAttempt(draft); rejects { s.prepareAttempt(s.read()) }; s.acceptPreparation(f.key, f.preparation)
        rejects { s.acceptSigned(f.key, f.signed) }; s.signingAttempt(s.read()); rejects { s.signingAttempt(s.read()) }
        s.acceptSigned(f.key, f.signed); s.submitAttempt(s.read()); rejects { s.submitAttempt(s.read()) }; rejects { s.signingAttempt(draft) }
        assertEquals(f.signed, f.store().read().operation!!.signed!!.wire)
    }
    @Test fun `positive settlement holds before malformed wire and survives restart without resubmit or archive`() = runBlocking {
        val f = Fixture(); val s = f.signed()
        rejects { s.acceptSettlement(f.key, JsonPrimitive("malformed wire"), f.settlementRaw) }
        val saved = f.store().read(); assertTrue(saved.operation!!.settlementObserved); assertNull(saved.operation.settlement)
        rejects { s.signingAttempt(saved) }; rejects { s.submitAttempt(saved) }; rejects { s.archive(saved) }
        assertEquals(f.signed, saved.operation.signed!!.wire)
    }
    @Test fun `valid late wire persists before bad adjacent receipt without depending on the old view`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read())
        rejects { f.store().acceptSettlement(f.key, f.wireRaw, JsonPrimitive("malformed receipt")) }
        val saved = s.read(); assertTrue(saved.operation!!.settlementObserved); assertEquals(f.signed, saved.operation.signed!!.wire)
        assertNull(saved.operation.settlement)
        f.store().acceptSettlement(f.key, f.wireRaw, f.settlementRaw); assertNotNull(s.read().operation!!.settlement)
    }
    @Test fun `archive retains full verified history and clears active in exactly one atomic replacement`() = runBlocking {
        val f = Fixture(); val s = f.settled(); val before = s.read(); val count = f.disk.writes
        s.archive(before); assertEquals(count + 1, f.disk.writes)
        val restarted = f.store(); val after = restarted.read(); assertNull(after.operation); assertEquals(listOf(f.key), after.archiveKeys)
        val archive = restarted.archived(f.key)!!; assertEquals(before.operation, archive.operation)
        assertEquals(f.identity, archive.identity); assertEquals(f.key, after.lastArchivedKey)
        rejects { restarted.begin(after, f.request, f.policy) }
        assertEquals(before.operation, restarted.archived(f.key)!!.operation)
    }
    @Test fun `failed archive write preserves complete active evidence and original history together`() = runBlocking {
        val f = Fixture(); val s = f.settled(); val original = f.disk.value; val before = s.read(); f.disk.failWrite = true
        rejects { s.archive(before) }; assertEquals(original, f.disk.value); assertEquals(before, s.read()); assertNull(s.archived(f.key))
        f.disk.failWrite = false; s.archive(before); assertNull(s.read().operation); assertNotNull(s.archived(f.key))
    }
    @Test fun `forged or changed settlement never authorizes archive but cannot erase positive hold`() = runBlocking {
        val f = Fixture(); val s = f.signed()
        val receipt = f.settlementRaw.getValue("receipt").jsonObject
        val forged = JsonObject(f.settlementRaw + ("receipt" to JsonObject(receipt + ("receiptAccountHex" to JsonPrimitive("ab".repeat(294))))))
        rejects { s.acceptSettlement(f.key, f.wireRaw, forged) }; assertTrue(s.read().operation!!.settlementObserved); rejects { s.archive(s.read()) }
        s.acceptSettlement(f.key, f.wireRaw, f.settlementRaw); val accepted = s.read()
        val changed = JsonObject(f.settlementRaw + ("settledAt" to JsonPrimitive("2026-09-25T12:34:57.123456Z")))
        rejects { s.acceptSettlement(f.key, f.wireRaw, changed) }; assertEquals(accepted, s.read())
    }
    @Test fun `identity isolation strict corruption and failed storage never invent an empty journal`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); val original = f.disk.value
        for (identity in listOf(f.identity.copy(origin = "https://elsewhere.test"), f.identity.copy(cluster = "mainnet-beta"), f.identity.copy(wallet = f.preparation.terms.seller)))
            rejects { RealmSalesStore(f.disk, identity).read() }
        f.disk.failRead = true; rejects { s.read() }; f.disk.failRead = false
        for (bad in listOf("{}", "broken", original!!.replace("\"prepareAttempted\":true", "\"prepareAttempted\":\"true\""))) {
            f.disk.value = bad; rejects { s.read() }; assertEquals(bad, f.disk.value)
        }
        f.disk.value = original; f.disk.failWrite = true; rejects { s.signingAttempt(s.read()) }; assertFalse(s.read().operation!!.signingStarted)
    }
    @Test fun `all instances share identity serialization and a racing stale marker cannot win`() = runBlocking {
        val f = Fixture(); val s = f.store(); s.begin(s.read(), f.request, f.policy); val snapshot = s.read()
        assertSame(s.requests, f.store().requests)
        val results = listOf(s, f.store()).map { store -> async(Dispatchers.Default) { runCatching { store.prepareAttempt(snapshot) }.isSuccess } }.awaitAll()
        assertEquals(1, results.count { it }); assertTrue(s.read().operation!!.prepareAttempted)
        assertEquals(snapshot.revision + 1, s.read().revision)
    }
    @Test fun `archive index reserves older keys and corruption is checked only when selected history is requested`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read())
        val document = Json.parseToJsonElement(f.disk.value!!).jsonObject
        val archives = document.getValue("archives").jsonObject
        val newer = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        f.disk.value = JsonObject(document + ("archives" to JsonObject(archives + (f.key to JsonPrimitive("broken archive")) + (newer to JsonPrimitive("another bounded archive")))) + ("lastArchivedKey" to JsonPrimitive(newer))).toString()
        val current = s.read(); assertNull(current.operation); assertEquals(listOf(f.key, newer).sorted(), current.archiveKeys)
        assertNotEquals(f.key, current.lastArchivedKey)
        rejects { s.archived(f.key) }; rejects { s.begin(current, f.request, f.policy) }
        assertEquals("broken archive", Json.parseToJsonElement(f.disk.value!!).jsonObject.getValue("archives").jsonObject.getValue(f.key).jsonPrimitive.content)
    }
    @Test fun `storage capacity refuses new intent without trimming any reserved history`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val raw = Json.parseToJsonElement(f.disk.value!!).jsonObject
        val records = buildJsonObject { repeat(64) { i -> put("00000000-0000-4000-8000-${i.toString().padStart(12, '0')}", "retained") } }
        f.disk.value = JsonObject(raw + ("archives" to records) + ("lastArchivedKey" to JsonPrimitive(records.keys.last())) + ("revision" to JsonPrimitive(128))).toString()
        val prior = f.disk.value; val current = s.read()
        rejects { s.begin(current, f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), f.policy) }
        assertEquals(prior, f.disk.value); assertEquals(64, s.read().archiveKeys.size)
    }
    @Test fun `failed positive hold write still blocks same process signing and submit until retained recovery`() = runBlocking {
        val f = Fixture(); val s = f.signed(); val original = f.disk.value; f.disk.failWrite = true
        rejects { s.acceptSettlement(f.key, JsonNull, JsonNull) }; assertEquals(original, f.disk.value)
        f.disk.failWrite = false; val next = f.store().read(); assertTrue(next.settlementHeld); assertFalse(next.operation!!.settlementObserved)
        rejects { f.store().submitAttempt(next) }; rejects { f.store().signingAttempt(next) }
        s.acceptSettlement(f.key, f.wireRaw, f.settlementRaw); s.archive(s.read()); assertFalse(s.read().settlementHeld)
    }
    @Test fun `positive observation survives failed encrypted read and blocks submission when storage returns`() = runBlocking {
        val f = Fixture(); val s = f.signed(); val original = f.disk.value; f.disk.failRead = true
        rejects { s.observeSettlement(f.key) }; assertEquals(original, f.disk.value)
        f.disk.failRead = false; val restored = f.store().read()
        assertTrue(restored.settlementHeld); assertFalse(restored.operation!!.settlementObserved)
        rejects { f.store().submitAttempt(restored) }; evidenceUnchanged(original, f.disk.value)
        s.observeSettlement(f.key); assertTrue(s.read().operation!!.settlementObserved)
    }
    @Test fun `positive receipt survives failed encrypted read before adjacent evidence can be inspected`() = runBlocking {
        val f = Fixture(); val s = f.signed(); val original = f.disk.value; f.disk.failRead = true
        rejects { s.acceptSettlement(f.key, JsonNull, JsonNull) }; assertEquals(original, f.disk.value)
        f.disk.failRead = false; val restored = f.store().read()
        assertTrue(restored.settlementHeld); assertFalse(restored.operation!!.settlementObserved)
        rejects { f.store().submitAttempt(restored) }; evidenceUnchanged(original, f.disk.value)
        s.acceptSettlement(f.key, f.wireRaw, f.settlementRaw); s.archive(s.read()); assertFalse(s.read().settlementHeld)
    }
    @Test fun `already owned late signature is durably retained even after caller coroutine cancellation`() = runBlocking {
        val f = Fixture(); val s = f.prepared(); s.signingAttempt(s.read())
        val obsolete = launch { cancel("old view"); f.store().acceptSigned(f.key, f.signed) }; obsolete.join()
        assertEquals(f.signed, s.read().operation!!.signed!!.wire)
    }
    @Test fun `late archived evidence cannot replace a newer active request or change permanent history`() = runBlocking {
        val f = Fixture(); val s = f.settled(); s.archive(s.read()); val history = s.archived(f.key)
        s.begin(s.read(), f.request.copy(idempotencyKey = "ffffffff-ffff-4fff-8fff-ffffffffffff"), f.policy)
        val current = s.read(); val disk = f.disk.value
        f.disk.failRead = true
        rejects { f.store().observeSettlement(f.key) }; rejects { f.store().acceptSettlement(f.key, JsonNull, JsonNull) }
        f.disk.failRead = false; assertEquals(current, s.read()); assertFalse(s.read().settlementHeld)
        f.store().acceptPreparation(f.key, f.preparation); f.store().acceptSigned(f.key, f.signed)
        f.store().acceptSettlement(f.key, f.wireRaw, f.settlementRaw)
        assertEquals(current, s.read()); assertEquals(disk, f.disk.value); assertEquals(history, s.archived(f.key)); assertFalse(s.read().settlementHeld)
        rejects { s.acceptPreparation(f.key, f.preparation.copy(terms = f.preparation.terms.copy(round = "2"))) }
        assertEquals(current, s.read()); assertEquals(history, s.archived(f.key))
    }
}
