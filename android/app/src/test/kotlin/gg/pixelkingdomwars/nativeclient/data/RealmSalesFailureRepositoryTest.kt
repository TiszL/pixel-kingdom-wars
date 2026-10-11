package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RealmSalesFailureRepositoryTest {
    private class Ports(val f: RealmFailureFixture, val store: RealmSalesStore) : RealmSalesPorts, RealmSalesAuthenticatedPort {
        override val identity = f.identity
        override val transport = RealmSalesTransport(this)
        var current = true; var absent = false; var foreign = false; var broken = false; var late = false; var onFailure: (() -> Unit)? = null
        val calls = mutableListOf<String>()
        override fun capture(newAction: Boolean): () -> Unit = { check(current); check(!newAction) }
        override fun policy(): RealmSalesSavedPolicy? = null
        override fun trust(): RealmSaleSigningTrust? = null
        override fun key(): String = error("GET recovery creates no key")
        override fun clockMs(): Long = error("Historical recovery needs no clock")
        override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) = error("No live source")
        override suspend fun readyToSign(guard: () -> Unit) = error("No wallet")
        override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) = error("No signing")
        override suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit,
            refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, retain: suspend (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals("GET", method); assertNull(body); calls += path
            val raw = buildJsonObject {
                put("wallet", if (foreign && path.contains("/failures/")) f.p.terms.seller else f.p.wallet); put("idempotencyKey", f.key)
                when {
                    path.contains("/failures/") -> put("failure", if (absent) JsonNull else if (broken) JsonPrimitive("bad") else f.raw.getValue("failure"))
                    path.contains("/prepare/") -> put("preparation", f.raw.getValue("preparation"))
                    else -> { put("preparation", f.raw.getValue("preparation")); put("wire", f.raw.getValue("wire")); put("settlement", JsonNull) }
                }
            }
            if (path.contains("/failures/")) { onFailure?.also { onFailure = null }?.invoke(); if (late) current = false }
            retain(raw); guard(); return raw
        }
    }
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue(runCatching { block() }.isFailure) }
    @Test fun `paused providerless recovery and explicit fresh archive use GET only and preserve exact failure`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.signed(); val ports = Ports(f, s); val r = RealmSalesRepository(s, ports)
        r.open(); assertEquals(f.failure, s.read().operation!!.failure!!.value)
        ports.calls.clear(); r.archiveFailed(); assertNull(s.read().operation)
        assertTrue(ports.calls.any { it.contains("/failures/") }); assertTrue(ports.calls.any { it.contains("/realm-sales/by-key/") })
        assertEquals(f.failure, f.cold().archived(f.key)!!.operation.failure!!.value)
    }
    @Test fun `first discovery during archive changes revision and needs another explicit action`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.signed(); val ports = Ports(f, s); val r = RealmSalesRepository(s, ports)
        ports.absent = true; r.open(); ports.absent = false
        refuses { r.archiveFailed() }; assertNotNull(s.read().operation); r.archiveFailed(); assertNull(s.read().operation)
    }
    @Test fun `null malformed and foreign failure GET never authorize archival or wrong actor holds`() = runBlocking {
        for (kind in listOf("absent", "broken", "foreign")) {
            val f = RealmFailureFixture(); val s = f.signed(); val ports = Ports(f, s); val r = RealmSalesRepository(s, ports)
            ports.absent = kind == "absent"; ports.broken = kind == "broken"; ports.foreign = kind == "foreign"
            runCatching { r.open() }; refuses { r.archiveFailed() }; assertNotNull(s.read().operation)
            assertEquals(kind == "broken", s.read().settlementHeld)
        }
    }
    @Test fun `late failed evidence survives retired caller and cannot publish its old view`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.signed(); val ports = Ports(f, s); val r = RealmSalesRepository(s, ports)
        ports.late = true; refuses { r.open() }; assertEquals(f.failure, s.read().operation!!.failure!!.value)
        assertNull(r.state.value.journal?.operation?.failure)
    }
    @Test fun `fresh GET race cannot clear contradictory observation or create replacement`() = runBlocking {
        val f = RealmFailureFixture(); val s = f.failed(); val ports = Ports(f, s); val r = RealmSalesRepository(s, ports)
        r.open(); ports.onFailure = { s.observeUnknownKey(f.key) }
        refuses { r.archiveFailed() }; assertTrue(f.cold().read().settlementHeld); assertNotNull(s.read().operation)
    }
}
