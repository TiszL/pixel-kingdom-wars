package gg.pixelkingdomwars.nativeclient.starter

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-10-06 (dead-end audit): no saved request may block play forever on this device. An attempted starter
 * installation whose by-key receipt answers `unknown` could never clear before: its same-key retry needs current berth
 * admission that may never hold again, and archiving needed a refusal. StarterFleetRepository.reviewInstall refuses while
 * any operation is saved. Synthetic proofs (copied from StarterFleetTest), no device claim. */
class StarterFleetUnknownCloseTest {
    private val identity = StarterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val at = "2026-09-22T12:00:00.000Z"
    private val berth = StarterFleetBerth(id(3), id(4), at)
    private val installed = StarterFleetInstallation(id(5), id(1), id(3), "starter", id(4), at, at)
    private fun view() = StarterFleetView(identity.wallet, id(1), at, StarterFleetFeatures(StarterFleetFeature(1, 1)), true, null, listOf(berth))
    private fun command(key: String = id(2)) = StarterFleetCommand.review(identity, view(), key, berth.berthId)
    private fun proof(accepted: Boolean) = StarterFleetProof(identity.wallet, id(2), at, if (accepted) "accepted" else "unknown",
        if (accepted) StarterFleetReceipt(identity.wallet, command().request, installed, at) else null)
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore {
        var bytes: String? = null
        override fun read() = bytes
        override fun write(value: String) { bytes = value }
        override fun clear() { error("Must preserve saved bytes") }
    }
    /** The by-key receipt answers `unknown` until [accepted]; every POST loses its acknowledgement. */
    private inner class Port : StarterFleetPort {
        var gets = 0; var posts = 0; var accepted = false
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path); gets++
            return starterJson.encodeToJsonElement(StarterFleetProof.serializer(), proof(accepted)).jsonObject.also(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            guard(); posts++; throw IOException("acknowledgement lost")
        }
    }

    @Test fun `a saved installation the server does not know cannot block starter installation forever`() = runBlocking<Unit> {
        val memory = Memory(); val store = StarterFleetStore(memory, identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        val attempted = store.read(); assertNotNull(attempted.operation!!.attemptRevision); assertNull(attempted.operation!!.refusal)
        // Installations are paused here: the same-key retry cannot be admitted, and nothing is sent.
        rejects { runBlocking { transport.confirm(attempted, { view().copy(acceptingInstallations = false) }) {} } }
        assertEquals(1, port.posts); assertEquals(attempted, store.read())
        val gets = port.gets
        val closed = transport.archiveUnsentOrRefused(store.read()) {}
        assertEquals(gets + 1, port.gets); assertEquals(1, port.posts)
        val archive = closed.archives.single(); assertEquals("unknown", archive.reason); assertEquals("unknown", archive.evidence!!.status)
        assertEquals(attempted.operation, archive.operation)
        // StarterFleetRepository.reviewInstall checks `store.read().operation == null`: the door opens again on this device.
        assertNull(store.read().operation); assertEquals(closed, StarterFleetStore(memory, identity).read())
        transport.begin(command(id(9)), view()) {}; assertEquals(id(9), store.read().operation!!.command.key); assertEquals(1, port.posts)
    }
    @Test fun `close never forgets an accepted installation and a late acceptance stays recoverable`() = runBlocking<Unit> {
        val store = StarterFleetStore(Memory(), identity); val port = Port(); val transport = StarterFleetTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        port.accepted = true
        rejects { runBlocking { transport.archiveUnsentOrRefused(store.read()) {} } }
        assertEquals(proof(true), store.read().operation!!.proof); assertTrue(store.read().archives.isEmpty()); assertEquals(1, port.posts)

        val other = StarterFleetStore(Memory(), identity); val late = Port(); val again = StarterFleetTransport(other, late)
        val draft = again.begin(command(), view()) {}
        rejects { runBlocking { again.confirm(draft, ::view) {} } }
        again.archiveUnsentOrRefused(other.read()) {}
        late.accepted = true; again.checkArchived(command().key) {}
        val archive = other.read().archives.single()
        assertEquals("unknown", archive.reason); assertEquals(proof(true), archive.operation.proof); assertEquals(1, late.posts)
    }
    @Test fun `the unknown archive reason is valid only for an attempted unrefused installation`() = runBlocking<Unit> {
        val memory = Memory(); val store = StarterFleetStore(memory, identity); store.begin(store.read(), command())
        rejects { store.archive(store.read(), "unknown", proof(false)) }
        store.refuse(store.attempt(store.read()), StarterFleetRefusal(503, "PHASE_E_DISABLED")); val refused = memory.bytes
        rejects { store.archive(store.read(), "unknown", proof(false)) }
        assertEquals(refused, memory.bytes); assertNotNull(store.read().operation)
    }
}
