package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic route amounts differ from game tuning; no chain or HTTPS acceptance claim. */
class StarterExpeditionTest {
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val at = "2026-09-22T12:00:00.000Z"
    private val ready = "2026-09-22T12:00:17.000Z"
    private val installed = StarterFleetInstallation(id(5), id(1), id(3), "starter", id(4), at, at)
    private fun route(id: String): StarterExpeditionRoute {
        val common = id.startsWith("common_")
        val realm = if (common) id.removePrefix("common_").replace('_', '-') else "crownlands"
        return StarterExpeditionRoute(2, 2, id, realm, starterResourceRealms.entries.single { it.value == realm }.key,
            "starter", 17, "101", "77", "24", if (common) StarterExpeditionAccess("starter_common", 1) else null)
    }
    private fun view() = StarterExpeditionView(identity.wallet, id(1), at, StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), starterRouteIds.map(::route), installed, null, at,
        starterResourceRealms.keys.map { OrdinaryRawStock(it, "9", "1", "10") })
    private fun command() = StarterExpeditionCommand.review(identity, view(), id(2), "coastal_survey")
    private fun proof(accepted: Boolean = false, returned: Boolean = false) = StarterExpeditionProof(identity.wallet, id(2), if (returned) ready else at,
        if (accepted) "accepted" else "unknown", if (accepted) StarterExpeditionReceipt(identity.wallet, command().request, id(2), id(5),
            command().route, at, ready, id(6), "ab".repeat(32)) else null, if (returned) StarterExpeditionReturn(id(7), ready) else null)
    private inline fun <reified T> raw(value: T) = starterJson.encodeToJsonElement(value).jsonObject
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore { var bytes: String? = null; var fail = false; override fun read() = bytes; override fun write(value: String) { if (fail) throw IOException("disk full"); bytes = value }; override fun clear() { error("Must preserve saved bytes") } }
    private inner class Port : StarterExpeditionPort {
        var gets = 0; var posts = 0; var current = proof()
        var getAnswer: ((JsonObject) -> Unit) -> JsonObject = { retain -> raw(current).also(retain) }
        var answer: ((JsonObject) -> Unit, (ApiException) -> Unit) -> JsonObject = { retain, _ -> raw(proof(true)).also(retain) }
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path); gets++; return getAnswer(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            guard(); assertEquals("/starter-expeditions", path); assertEquals(command().request.body(), body); posts++; return answer(retain, refusal)
        }
    }
    @Test fun `current discovery validates feature scalar types all eleven routes and exact raw conservation`() {
        StarterExpeditionView.from(raw(view()))
        rejects { StarterExpeditionView.from(JsonObject(raw(view()) + ("acceptingDepartures" to JsonPrimitive("true")))) }
        rejects { StarterExpeditionView.from(JsonObject(raw(view()) - "features")) }
        rejects { view().copy(features = StarterExpeditionFeatures(StarterExpeditionFeature(2, 1))).validate() }
        rejects { view().copy(routes = view().routes.dropLast(1)).validate() }
        rejects { view().copy(rawStock = view().rawStock.dropLast(1)).validate() }
        rejects { view().copy(rawStock = view().rawStock.map { it.copy(total = "9") }).validate() }
        view().copy(home = null, routes = emptyList()).validate()
        rejects { view().copy(home = null).validate() }
    }
    @Test fun `route quantities preserve int64 precision and reject unsafe durations or malformed common markers`() {
        val original = command().route
        original.copy(grossQuantity = Long.MAX_VALUE.toString(), netQuantity = (Long.MAX_VALUE - 1).toString(), islandPoolQuantity = "1").validate()
        for (bad in listOf("01", "-1", "1.0", "1e2", "9223372036854775808")) rejects { original.copy(grossQuantity = bad).validate() }
        rejects { original.copy(netQuantity = "78").validate() }; rejects { original.copy(durationSec = Long.MAX_VALUE).validate() }
        rejects { route("common_frostveil").copy(access = null).validate() }
        rejects { route("common_frostveil").copy(resourceId = "heartwood_logs").validate() }
        val routes = raw(view()).getValue("routes").jsonArray
        val bad = JsonObject(routes.first().jsonObject + ("durationSec" to JsonPrimitive("17")))
        rejects { StarterExpeditionView.from(JsonObject(raw(view()) + ("routes" to JsonArray(listOf(bad) + routes.drop(1))))) }
        val nullAccess = JsonObject(routes.first().jsonObject + ("access" to JsonNull))
        rejects { StarterExpeditionView.from(JsonObject(raw(view()) + ("routes" to JsonArray(listOf(nullAccess) + routes.drop(1))))) }
    }
    @Test fun `departure review uses complete server route and actual completed facilities without inferred readiness`() {
        val c = command()
        for (changed in listOf(view().copy(acceptingDepartures = false), view().copy(lodgeCompletedAt = null), view().copy(installation = null),
            view().copy(baseId = id(9)), view().copy(routes = view().routes.map { it.copy(durationSec = 19) }))) rejects { c.admit(identity, changed) }
        val flight = proof(true).receipt!!.flight(); rejects { c.admit(identity, view().copy(flight = flight)) }
        rejects { view().copy(lodgeCompletedAt = ready).validate() }
        rejects { view().copy(flight = flight.copy(installationId = id(9))).validate() }
    }
    @Test fun `receipt binds whole original review but accepted historical rewards ignore current route policy`() {
        StarterExpeditionProof.from(raw(proof(true)), identity, command())
        val oldRoute = command().route.copy(routeCatalogueVersion = 7, rewardTableVersion = 8, grossQuantity = "103", netQuantity = "79")
        val old = command().copy(request = command().request.copy(routeVersion = 7, rewardVersion = 8), route = oldRoute)
        proof(true).copy(receipt = proof(true).receipt!!.copy(request = old.request, route = oldRoute)).validate(identity, old)
        rejects { old.admit(identity, view()) }
        rejects { proof(true).copy(wallet = "11111111111111111111111111111112").validate(identity, command()) }
        rejects { proof(true).copy(receipt = proof(true).receipt!!.copy(request = command().request.copy(baseId = id(9)))).validate(identity, command()) }
        rejects { proof(true).copy(receipt = proof(true).receipt!!.copy(route = command().route.copy(durationSec = 19))).validate(identity, command()) }
        rejects { proof().copy(returned = StarterExpeditionReturn(id(7), ready)).validate(identity, command()) }
    }
    @Test fun `automatic return is separate monotonic history and never a Collect command`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; transport.confirm(saved, ::view) {}; port.current = proof(true)
        transport.finish(store.read(), {}, {}); val original = store.read().archives.single().operation.proof!!.receipt
        port.current = proof(true, true); transport.checkArchived(command().key) {}
        assertEquals(original, store.read().archives.single().operation.proof!!.receipt)
        assertEquals(proof(true, true).returned, store.read().archives.single().operation.proof!!.returned); assertEquals(1, port.posts)
        port.current = proof(true); rejects { runBlocking { transport.checkArchived(command().key) {} } }
        rejects { store.accept(command(), proof(true, true).copy(returned = StarterExpeditionReturn(id(8), ready))) }
    }
    @Test fun `intent persists before GET or POST and foreground checks never mutate`() = runBlocking {
        val memory = Memory(); val store = StarterExpeditionStore(memory, identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; assertNotNull(memory.bytes); assertEquals(0, port.gets); assertEquals(0, port.posts)
        transport.check {}; transport.check {}; assertEquals(saved, store.read()); assertEquals(2, port.gets); assertEquals(0, port.posts)
        transport.confirm(saved, ::view) {}; assertEquals(1, port.posts); assertNotNull(store.read().operation!!.proof)
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertEquals(1, port.posts)
    }
    @Test fun `paused original acceptance returns before current review is evaluated`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.current = proof(true)
        transport.confirm(saved, { error("Current admission must not run for accepted original") }) {}; assertEquals(0, port.posts)
    }
    @Test fun `owned positive response survives caller cancellation and later refusal`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        port.answer = { retain, refusal -> retain(raw(proof(true))); refusal(ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "paused")); throw CancellationException("retired") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        assertEquals(proof(true), store.read().operation!!.proof); assertNull(store.read().operation!!.refusal)
    }
    @Test fun `lost response permits only explicit same-original retry and stale refusal cannot mark later attempt`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.answer = { _, _ -> throw IOException("ack lost") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; val first = store.read()
        transport.check {}; assertEquals(1, port.posts)
        port.answer = { _, refusal -> refusal(ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "paused")); throw ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "paused") }
        rejects { runBlocking { transport.confirm(first, ::view) {} } }; val second = store.read()
        assertTrue(second.operation!!.attemptRevision!! > first.operation!!.attemptRevision!!); assertNull(second.operation!!.refusal)
        store.refuse(first, StarterExpeditionRefusal(503, "STARTER_EXPEDITIONS_DISABLED")); assertEquals(second, store.read())
    }
    @Test fun `observed first refusal is retained across cancellation but positive proof takes precedence`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.answer = { _, refusal -> refusal(ApiException(409, "EXPEDITION_LODGE_UNAVAILABLE", "berth")); throw CancellationException() }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertNotNull(store.read().operation!!.refusal)
        port.current = proof(true); transport.check {}; assertNotNull(store.read().operation!!.proof); assertNotNull(store.read().operation!!.refusal)
    }
    @Test fun `accepted history is immutable and failed hydration preserves current original`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; transport.confirm(saved, ::view) {}; port.current = proof(true)
        rejects { runBlocking { transport.finish(store.read(), {}, { error("buyer snapshot refused") }) } }; assertNotNull(store.read().operation)
        transport.finish(store.read(), {}, {}); assertNull(store.read().operation); transport.checkArchived(command().key) {}; assertEquals(1, port.posts)
        rejects { store.accept(command(), proof(true).copy(receipt = proof(true).receipt!!.copy(termHash = "cd".repeat(32)))) }
        port.current = proof(); rejects { runBlocking { transport.checkArchived(command().key) {} } }
    }
    @Test fun `unknown ambiguous attempts cannot archive and corrupt or wrong-scope bytes stay preserved`() = runBlocking {
        val memory = Memory(); val store = StarterExpeditionStore(memory, identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        transport.begin(command(), view()) {}; store.attempt(store.read())
        // Rewritten 2026-10-06 (dead-end audit): an ambiguous attempt the server answers `unknown` for now closes (owner: no
        // saved request may block play forever), only as "unknown" with that exact-key evidence and no POST.
        val closed = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
        assertEquals("unknown", closed.reason); assertEquals("unknown", closed.evidence!!.status); assertEquals(0, port.posts)
        val bytes = memory.bytes; rejects { StarterExpeditionStore(memory, identity.copy(cluster = "mainnet-beta")).read() }; assertEquals(bytes, memory.bytes)
        memory.bytes = "{broken"; rejects { store.read() }; assertEquals("{broken", memory.bytes)
    }
    @Test fun `actual enqueue guard failure sends nothing and does not bypass saved original`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val saved = transport.begin(command(), view()) {}; var reviews = 0
        rejects { runBlocking { transport.confirm(saved, { if (++reviews > 1) view().copy(acceptingDepartures = false) else view() }) {} } }
        assertEquals(0, port.posts); assertNotNull(store.read().operation); assertNotNull(store.read().operation!!.attemptRevision)
    }
    @Test fun `failed durable intent refuses all network work and failed proof storage retains uncertainty`() = runBlocking {
        val memory = Memory(); val store = StarterExpeditionStore(memory, identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        memory.fail = true; rejects { runBlocking { transport.begin(command(), view()) {} } }
        assertEquals(0, port.gets); assertEquals(0, port.posts); assertNull(memory.bytes)
        memory.fail = false; val saved = transport.begin(command(), view()) {}
        port.answer = { retain, _ -> memory.fail = true; raw(proof(true)).also(retain) }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        memory.fail = false; assertNotNull(store.read().operation!!.attemptRevision); assertNull(store.read().operation!!.proof)
        port.current = proof(true); transport.check {}; assertNotNull(store.read().operation!!.proof); assertEquals(1, port.posts)
    }
    @Test fun `only exact first-refusal status and code pairs are definitive`() {
        assertFalse(starterExpeditionRefusalDefinitive(500, "BASE_NOT_OWNED"))
        assertFalse(starterExpeditionRefusalDefinitive(409, "IDEMPOTENCY_BODY_MISMATCH"))
        assertFalse(starterExpeditionRefusalDefinitive(503, null))
        assertTrue(starterExpeditionRefusalDefinitive(404, "BASE_NOT_OWNED"))
    }
    @Test fun `draft and refused archives recover positive history by GET while preserving the newer operation`() = runBlocking {
        for (refused in listOf(false, true)) {
            val memory = Memory(); val store = StarterExpeditionStore(memory, identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
            transport.begin(command(), view()) {}
            val attempt = if (refused) store.attempt(store.read()) else null
            attempt?.let { store.refuse(it, StarterExpeditionRefusal(503, "STARTER_EXPEDITIONS_DISABLED")) }
            val original = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
            val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
            port.current = proof(true); transport.checkArchived(command().key) {}
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true))), store.read().archives.single())
            assertEquals(newer, store.read().operation); assertEquals(store.read(), StarterExpeditionStore(memory, identity).read())
            port.current = proof(true, true); transport.checkArchived(command().key) {}
            val completed = store.read()
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true, true))), completed.archives.single())
            attempt?.let { store.refuse(it, StarterExpeditionRefusal(503, "STARTER_EXPEDITIONS_DISABLED")) }
            assertEquals(completed, store.read())

            for (older in listOf(proof(), proof(true))) {
                port.current = older; rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(completed, store.read())
            }
            rejects { store.accept(command(), proof(true, true).copy(returned = StarterExpeditionReturn(id(8), ready))) }
            assertEquals(completed, store.read())
            assertEquals(newer, store.read().operation); assertEquals(0, port.posts)
        }
    }
    @Test fun `accepted operations cannot initially be archived under a draft or refusal reason`() = runBlocking {
        for (refused in listOf(false, true)) {
            val memory = Memory(); val store = StarterExpeditionStore(memory, identity); store.begin(store.read(), command())
            if (refused) store.refuse(store.attempt(store.read()), StarterExpeditionRefusal(503, "STARTER_EXPEDITIONS_DISABLED"))
            store.accept(command(), proof(true)); val saved = memory.bytes
            rejects { store.archive(store.read(), if (refused) "refused" else "unattempted", proof()) }
            assertEquals(saved, memory.bytes); assertNotNull(store.read().operation)
        }
    }
    @Test fun `owned archived GET proof persists before cancellation or a retired caller guard`() = runBlocking {
        for (cancel in listOf(false, true)) {
            val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
            transport.begin(command(), view()) {}; transport.archiveUnsentOrRefused(store.read()) {}
            val original = store.read().archives.single()
            val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
            var active = true
            port.getAnswer = { retain -> raw(proof(true)).also { retain(it); active = false; if (cancel) throw CancellationException("owned historical response") } }
            rejects { runBlocking { transport.checkArchived(command().key) { check(active) } } }
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true))), store.read().archives.single())
            assertEquals(newer, store.read().operation); assertEquals(0, port.posts)
        }
    }
    @Test fun `negative mismatched and unpersisted archived replies cannot rewrite history`() = runBlocking {
        val memory = Memory(); val store = StarterExpeditionStore(memory, identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        transport.begin(command(), view()) {}; transport.archiveUnsentOrRefused(store.read()) {}
        val original = memory.bytes; transport.checkArchived(command().key) {}; assertEquals(original, memory.bytes)
        for (bad in listOf(JsonObject(emptyMap()), raw(proof(true).copy(idempotencyKey = id(8))),
            raw(proof(true).copy(wallet = "11111111111111111111111111111112")))) {
            port.getAnswer = { retain -> bad.also(retain) }
            rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(original, memory.bytes)
        }
        port.getAnswer = { retain -> raw(proof(true)).also(retain) }; memory.fail = true
        rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(original, memory.bytes)
        memory.fail = false; transport.checkArchived(command().key) {}; assertNotNull(store.read().archives.single().operation.proof)
        assertEquals(0, port.posts)
    }

    @Test fun `late owned acceptance recovers its refused archive without touching a newer intent or honoring stale refusal`() = runBlocking {
        val store = StarterExpeditionStore(Memory(), identity); val port = Port(); val transport = StarterExpeditionTransport(store, port)
        val initial = transport.begin(command(), view()) {}
        lateinit var lateAccept: (JsonObject) -> Unit; lateinit var lateRefuse: (ApiException) -> Unit
        val error = ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "paused")
        port.answer = { retain, refusal -> lateAccept = retain; lateRefuse = refusal; refusal(error); throw CancellationException("retired caller") }
        rejects { runBlocking { transport.confirm(initial, ::view) {} } }; assertNotNull(store.read().operation!!.refusal)
        val archive = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
        val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
        lateAccept(raw(proof(true, true))); val retained = store.read(); lateRefuse(error)
        assertEquals(retained, store.read()); assertEquals(newer, retained.operation)
        assertEquals(archive.copy(operation = archive.operation.copy(proof = proof(true, true))), retained.archives.single())
        assertEquals(1, port.posts)
    }

}
