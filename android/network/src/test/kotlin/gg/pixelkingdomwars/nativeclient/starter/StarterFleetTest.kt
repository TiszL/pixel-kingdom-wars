package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server proofs. Actual authenticated HTTPS belongs to the subsequent adapter gate. */
class StarterFleetTest {
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val at = "2026-09-22T12:00:00.000Z"
    private val berth = StarterFleetBerth(id(3), id(4), at)
    private val installed = StarterFleetInstallation(id(5), id(1), id(3), "starter", id(4), at, at)
    private fun view() = StarterFleetView(identity.wallet, id(1), at, StarterFleetFeatures(StarterFleetFeature(1, 1)), true, null, listOf(berth))
    private fun command() = StarterFleetCommand.review(identity, view(), id(2), berth.berthId)
    private fun proof(accepted: Boolean = false) = StarterFleetProof(identity.wallet, id(2), at, if (accepted) "accepted" else "unknown",
        if (accepted) StarterFleetReceipt(identity.wallet, command().request, installed, at) else null)
    private inline fun <reified T> raw(value: T) = starterJson.encodeToJsonElement(value).jsonObject
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore { var bytes: String? = null; var fail = false; override fun read() = bytes; override fun write(value: String) { if (fail) throw IOException("disk full"); bytes = value }; override fun clear() { error("Must preserve saved bytes") } }
    private inner class Port : StarterFleetPort {
        var gets = 0; var posts = 0; var current = proof()
        var getAnswer: ((JsonObject) -> Unit) -> JsonObject = { retain -> raw(current).also(retain) }
        var answer: ((JsonObject) -> Unit, (ApiException) -> Unit) -> JsonObject = { retain, _ -> raw(proof(true)).also(retain) }
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path); gets++; return getAnswer(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            guard(); assertEquals("/starter-fleet/installations", path); assertEquals(command().request.body(), body); posts++; return answer(retain, refusal)
        }
    }
    @Test fun `discovery requires exact current feature scalar shapes and positive berth proof`() {
        StarterFleetView.from(raw(view()))
        rejects { StarterFleetView.from(JsonObject(raw(view()) + ("acceptingInstallations" to JsonPrimitive("true")))) }
        rejects { view().copy(features = StarterFleetFeatures(StarterFleetFeature(2, 1))).validate() }
        rejects { view().copy(eligibleBerths = listOf(berth, berth)).validate() }
        rejects { view().copy(installation = installed, eligibleBerths = emptyList()).validate() }
        rejects { view().copy(eligibleBerths = listOf(berth.copy(berthCompletedAt = "2026-09-23T12:00:00.000Z"))).validate() }
        rejects { StarterFleetView.from(JsonObject(raw(view()) - "features")) }
    }
    @Test fun `canonical scope ids and timestamp formatting cannot alias saved actors or commands`() {
        rejects { identity.copy(origin = "https://GAME.test").validate() }; rejects { identity.copy(cluster = "testnet").validate() }
        rejects { command().copy(request = command().request.copy(idempotencyKey = "ABCDEF00-0000-4000-8000-000000000002")).validate() }
        rejects { berth.copy(berthCompletedAt = "2026-09-22T12:00:00Z").validate() }
    }
    @Test fun `review freezes selected positive berth and existing installation but never invents readiness`() {
        rejects { command().admit(identity, view().copy(acceptingInstallations = false)) }
        rejects { command().admit(identity, view().copy(baseId = id(9))) }
        rejects { command().admit(identity, view().copy(installation = installed)) }
        val existing = StarterFleetCommand.review(identity, view().copy(installation = installed), id(2), id(3))
        proof(true).validate(identity, existing)
        rejects { proof(true).copy(receipt = proof(true).receipt!!.copy(installation = installed.copy(installationId = id(8)))).validate(identity, existing) }
    }
    @Test fun `accepted original binds actor body completed job and chronological installation`() {
        StarterFleetProof.from(raw(proof(true)), identity, command())
        for (changed in listOf(proof(true).copy(wallet = "11111111111111111111111111111112"), proof(true).copy(idempotencyKey = id(8)),
            proof(true).copy(receipt = proof(true).receipt!!.copy(request = command().request.copy(baseId = id(8)))),
            proof(true).copy(receipt = proof(true).receipt!!.copy(installation = installed.copy(completedBuildJobId = id(8)))))) rejects { changed.validate(identity, command()) }
        rejects { proof().copy(receipt = proof(true).receipt).validate(identity, command()) }
        rejects { StarterFleetProof.from(JsonObject(raw(proof(true)) + ("custodyWallet" to JsonPrimitive(identity.wallet))), identity, command()) }
    }
    @Test fun `intent persists before GET or POST and foreground checks never mutate`() = runBlocking {
        val memory = Memory(); val store = StarterFleetStore(memory, identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}; assertNotNull(memory.bytes); assertEquals(0, port.gets); assertEquals(0, port.posts)
        transport.check {}; transport.check {}; assertEquals(saved, store.read()); assertEquals(2, port.gets); assertEquals(0, port.posts)
        transport.confirm(saved, ::view) {}; assertEquals(1, port.posts); assertNotNull(store.read().operation!!.proof)
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertEquals(1, port.posts)
    }
    @Test fun `paused original acceptance returns before current review is evaluated`() = runBlocking {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.current = proof(true)
        transport.confirm(saved, { error("Current admission must not run for accepted original") }) {}; assertEquals(0, port.posts)
    }
    @Test fun `owned positive response survives caller cancellation and later refusal`() = runBlocking {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        port.answer = { retain, refusal -> retain(raw(proof(true))); refusal(ApiException(503, "PHASE_E_DISABLED", "paused")); throw CancellationException("retired") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        assertEquals(proof(true), store.read().operation!!.proof); assertNull(store.read().operation!!.refusal)
    }
    @Test fun `lost response permits only explicit same-original retry and stale refusal cannot mark later attempt`() = runBlocking {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.answer = { _, _ -> throw IOException("ack lost") }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; val first = store.read()
        transport.check {}; assertEquals(1, port.posts)
        port.answer = { _, refusal -> refusal(ApiException(503, "PHASE_E_DISABLED", "paused")); throw ApiException(503, "PHASE_E_DISABLED", "paused") }
        rejects { runBlocking { transport.confirm(first, ::view) {} } }; val second = store.read()
        assertTrue(second.operation!!.attemptRevision!! > first.operation!!.attemptRevision!!); assertNull(second.operation!!.refusal)
        store.refuse(first, StarterFleetRefusal(503, "PHASE_E_DISABLED")); assertEquals(second, store.read())
    }
    @Test fun `observed first refusal is retained across cancellation but positive proof takes precedence`() = runBlocking {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}; port.answer = { _, refusal -> refusal(ApiException(409, "STARTER_BERTH_UNAVAILABLE", "berth")); throw CancellationException() }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }; assertNotNull(store.read().operation!!.refusal)
        port.current = proof(true); transport.check {}; assertNotNull(store.read().operation!!.proof); assertNotNull(store.read().operation!!.refusal)
    }
    @Test fun `accepted history is immutable and failed hydration preserves current original`() = runBlocking {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}; transport.confirm(saved, ::view) {}; port.current = proof(true)
        rejects { runBlocking { transport.finish(store.read(), {}, { error("buyer snapshot refused") }) } }; assertNotNull(store.read().operation)
        transport.finish(store.read(), {}, {}); assertNull(store.read().operation); transport.checkArchived(command().key) {}; assertEquals(1, port.posts)
        rejects { store.accept(command(), proof(true).copy(receipt = proof(true).receipt!!.copy(installation = installed.copy(installationId = id(9))))) }
        port.current = proof(); rejects { runBlocking { transport.checkArchived(command().key) {} } }
    }
    @Test fun `unknown ambiguous attempts cannot archive and corrupt or wrong-scope bytes stay preserved`() = runBlocking {
        val memory = Memory(); val store = StarterFleetStore(memory, identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        transport.begin(command(), view()) {}; store.attempt(store.read())
        // Rewritten 2026-10-06 (dead-end audit): an ambiguous attempt the server answers `unknown` for now closes (owner: no
        // saved request may block play forever), only as "unknown" with that exact-key evidence and no POST.
        val closed = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
        assertEquals("unknown", closed.reason); assertEquals("unknown", closed.evidence!!.status); assertEquals(0, port.posts)
        val bytes = memory.bytes; rejects { StarterFleetStore(memory, identity.copy(cluster = "mainnet-beta")).read() }; assertEquals(bytes, memory.bytes)
        memory.bytes = "{broken"; rejects { store.read() }; assertEquals("{broken", memory.bytes)
    }
    @Test fun `actual enqueue guard failure sends nothing and does not bypass saved original`() = runBlocking {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}; var reviews = 0
        rejects { runBlocking { transport.confirm(saved, { if (++reviews > 1) view().copy(acceptingInstallations = false) else view() }) {} } }
        assertEquals(0, port.posts); assertNotNull(store.read().operation); assertNotNull(store.read().operation!!.attemptRevision)
    }
    @Test fun `failed durable intent refuses all network work and failed proof storage retains uncertainty`() = runBlocking {
        val memory = Memory(); val store = StarterFleetStore(memory, identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        memory.fail = true; rejects { runBlocking { transport.begin(command(), view()) {} } }
        assertEquals(0, port.gets); assertEquals(0, port.posts); assertNull(memory.bytes)
        memory.fail = false; val saved = transport.begin(command(), view()) {}
        port.answer = { retain, _ -> memory.fail = true; raw(proof(true)).also(retain) }
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        memory.fail = false; assertNotNull(store.read().operation!!.attemptRevision); assertNull(store.read().operation!!.proof)
        port.current = proof(true); transport.check {}; assertNotNull(store.read().operation!!.proof); assertEquals(1, port.posts)
    }
    @Test fun `only exact first-refusal status and code pairs are definitive`() {
        assertFalse(starterFleetRefusalDefinitive(500, "BASE_NOT_OWNED"))
        assertFalse(starterFleetRefusalDefinitive(409, "IDEMPOTENCY_BODY_MISMATCH"))
        assertFalse(starterFleetRefusalDefinitive(503, null))
        assertTrue(starterFleetRefusalDefinitive(404, "BASE_NOT_OWNED"))
    }
    @Test fun `draft and refused archives recover positive history by GET while preserving the newer operation`() = runBlocking {
        for (refused in listOf(false, true)) {
            val memory = Memory(); val store = StarterFleetStore(memory, identity); val port = Port(); val transport = StarterFleetTransport(store, port)
            transport.begin(command(), view()) {}
            val attempt = if (refused) store.attempt(store.read()) else null
            attempt?.let { store.refuse(it, StarterFleetRefusal(503, "PHASE_E_DISABLED")) }
            val original = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
            val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
            port.current = proof(true); transport.checkArchived(command().key) {}
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true))), store.read().archives.single())
            assertEquals(newer, store.read().operation); assertEquals(store.read(), StarterFleetStore(memory, identity).read())
            port.current = proof(true); transport.checkArchived(command().key) {}
            val completed = store.read()
            assertEquals(original.copy(operation = original.operation.copy(proof = proof(true))), completed.archives.single())
            attempt?.let { store.refuse(it, StarterFleetRefusal(503, "PHASE_E_DISABLED")) }
            assertEquals(completed, store.read())

            port.current = proof(); rejects { runBlocking { transport.checkArchived(command().key) {} } }; assertEquals(completed, store.read())
            rejects { store.accept(command(), proof(true).copy(receipt = proof(true).receipt!!.copy(installation = installed.copy(installationId = id(9))))) }
            assertEquals(completed, store.read())
            assertEquals(newer, store.read().operation); assertEquals(0, port.posts)
        }
    }
    @Test fun `accepted operations cannot initially be archived under a draft or refusal reason`() = runBlocking {
        for (refused in listOf(false, true)) {
            val memory = Memory(); val store = StarterFleetStore(memory, identity); store.begin(store.read(), command())
            if (refused) store.refuse(store.attempt(store.read()), StarterFleetRefusal(503, "PHASE_E_DISABLED"))
            store.accept(command(), proof(true)); val saved = memory.bytes
            rejects { store.archive(store.read(), if (refused) "refused" else "unattempted", proof()) }
            assertEquals(saved, memory.bytes); assertNotNull(store.read().operation)
        }
    }
    @Test fun `owned archived GET proof persists before cancellation or a retired caller guard`() = runBlocking {
        for (cancel in listOf(false, true)) {
            val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
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
        val memory = Memory(); val store = StarterFleetStore(memory, identity); val port = Port(); val transport = StarterFleetTransport(store, port)
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
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val initial = transport.begin(command(), view()) {}
        lateinit var lateAccept: (JsonObject) -> Unit; lateinit var lateRefuse: (ApiException) -> Unit
        val error = ApiException(503, "PHASE_E_DISABLED", "paused")
        port.answer = { retain, refusal -> lateAccept = retain; lateRefuse = refusal; refusal(error); throw CancellationException("retired caller") }
        rejects { runBlocking { transport.confirm(initial, ::view) {} } }; assertNotNull(store.read().operation!!.refusal)
        val archive = transport.archiveUnsentOrRefused(store.read()) {}.archives.single()
        val newer = store.begin(store.read(), command().copy(request = command().request.copy(idempotencyKey = id(9)))).operation
        lateAccept(raw(proof(true))); val retained = store.read(); lateRefuse(error)
        assertEquals(retained, store.read()); assertEquals(newer, retained.operation)
        assertEquals(archive.copy(operation = archive.operation.copy(proof = proof(true))), retained.archives.single())
        assertEquals(1, port.posts)
    }

}
