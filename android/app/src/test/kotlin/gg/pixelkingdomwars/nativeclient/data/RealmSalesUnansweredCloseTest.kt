package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Dead-end audit 2026-10-06 (shape A). The single realm-sale slot held a prepare whose reply was lost with no
 * refusal; archiveRefusal requires a refusal, so every new permit purchase was blocked forever. The request may be
 * archived only after this same action's two by-key GETs both answered absence for exactly its key. */
class RealmSalesUnansweredCloseTest {
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
        override val identity = StarterIdentity("https://unanswered-${ids.incrementAndGet()}.test", "devnet", p.wallet)
        val disk = Memory(); val store = RealmSalesStore(disk, identity)
        override val transport = RealmSalesTransport(this)
        val repo = RealmSalesRepository(store, this)
        var prepared = false; var nextKey = p.idempotencyKey; val calls = mutableListOf<String>()
        override fun policy() = policyValue
        override fun trust() = RealmSaleSigningTrust(p.source.genesisHash, p.source.programId, p.terms.developer,
            p.source.programDataSha256, p.source.reviewedDeploymentSlot, p.source.revision)
        override fun key() = nextKey
        override fun clockMs() = 0L
        override fun capture(newAction: Boolean): () -> Unit = {}
        override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) = guard()
        override suspend fun readyToSign(guard: () -> Unit) = guard()
        override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) { error("No wallet in this test") }
        private fun absentOr(value: JsonElement) = if (prepared) value else JsonNull
        override suspend fun request(method: String, path: String, body: JsonObject?, guard: () -> Unit, refusal: (suspend (RealmSalePrepareRefusal) -> Unit)?, retain: suspend (JsonObject) -> Unit): JsonObject {
            guard(); calls += "$method $path"
            // The prepare POST loses its reply; the server may or may not have stored a preparation.
            if (path.endsWith("/prepare")) throw IOException("Lost prepare response")
            val result = when {
                path.contains("/prepare/by-key/") -> buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("preparation", absentOr(raw.getValue("preparation"))) }
                path.contains("/failures/by-key/") -> buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("failure", JsonNull) }
                else -> buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("preparation", absentOr(raw.getValue("preparation"))); put("wire", JsonNull); put("settlement", JsonNull) }
            }
            retain(result); guard(); return result
        }
        suspend fun begin() = runCatching { repo.begin(p.spot, p.realm) }
    }

    @Test fun `an unanswered quote request both by-key reads call absent is archived and a new purchase may begin`() = runBlocking {
        val f = Fixture(); assertTrue(f.begin().isFailure); val op = f.store.read().operation!!
        assertTrue(op.prepareAttempted); assertNull(op.preparation); assertNull(op.prepareRefusal)
        // The old door: a refusal archive needs a refusal, and a new purchase needs an empty slot.
        assertTrue(runCatching { f.repo.archiveRefusal() }.isFailure); assertTrue(f.begin().isFailure)
        assertEquals(1, f.calls.count { it.startsWith("POST ") })
        val before = f.calls.size; f.repo.archiveUnanswered()
        assertTrue("closing reads only", f.calls.drop(before).all { it.startsWith("GET ") }); assertTrue(f.calls.drop(before).isNotEmpty())
        assertNull(f.store.read().operation)
        val history = requireNotNull(f.repo.archived(f.p.idempotencyKey)).operation
        assertTrue(history.attemptConfirmedAbsent); assertNull(history.preparation); assertNull(history.prepareRefusal)
        // The slot is free: a new request with a new key reaches the prepare route.
        f.nextKey = "11111111-1111-4111-8111-111111111111"; assertTrue(f.begin().isFailure)
        assertEquals(2, f.calls.count { it.startsWith("POST ") }); assertEquals(f.nextKey, f.store.read().operation!!.request.idempotencyKey)
    }
    @Test fun `close is refused when the by-key read shows a preparation and the request stays active`() = runBlocking {
        val f = Fixture(); assertTrue(f.begin().isFailure); f.prepared = true
        assertTrue(runCatching { f.repo.archiveUnanswered() }.isFailure)
        val op = requireNotNull(f.store.read().operation); assertNotNull("the shown preparation is retained", op.preparation); assertFalse(op.attemptConfirmedAbsent)
        assertNull(f.store.archived(f.p.idempotencyKey)); assertTrue(f.begin().isFailure); assertEquals(1, f.calls.count { it.startsWith("POST ") })
    }
}
