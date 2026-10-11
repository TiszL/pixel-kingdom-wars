package gg.pixelkingdomwars.nativeclient.harvester

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-10-06 (dead-end audit): no saved request may block play forever on this device. An attempted Harvester
 * selection whose by-key receipt answers `unknown` could never clear before: its same-key retry needs current admission
 * (facility, policy, wallet head) that may never hold again, and archiving needed a refusal. HarvesterRepository's
 * selection door refuses while any operation is saved. Synthetic server terms (copied from HarvesterTest), no device claim. */
class HarvesterUnknownCloseTest {
    private val identity = HarvesterIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val at = "2026-09-22T12:00:00.000Z"
    private val format = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun after(seconds: Long) = format.format(Instant.parse(at).plusSeconds(seconds))
    private val policy = HarvesterPolicy(1, 1, "99", "7", 17, 255, 1, 100, 30)
    private val facility = HarvesterFacility(id(1), id(3), id(4), after(-1))
    private fun view() = HarvesterView(identity.wallet, id(1), at, HarvesterFeatures(HarvesterFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), listOf(facility), null, null, policy,
        starterResourceRealms.keys.map { OrdinaryRawStock(it, "9", "1", "10") })
    private fun command(key: String = id(2)) = HarvesterCommand.review(identity, view(), key, facility.harvesterId)
    private fun source() = HarvesterSource(id(2), id(1), id(3), policy.policyVersion, "crownlands", "crown_iron_ore",
        at, after(policy.maxLeaseSec), id(4), facility.harvesterCompletedAt,
        HarvesterTerm(id(6), "ab".repeat(32), after(-60), after(3_600)), policy)
    private fun proof(accepted: Boolean) = HarvesterProof(identity.wallet, id(2), after(policy.maxLeaseSec + 30),
        if (accepted) "accepted" else "unknown", if (accepted) HarvesterReceipt(identity.wallet, command().request, source()) else null,
        if (accepted) HarvesterSettlement(emptyList(), null, null) else null)
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore {
        var bytes: String? = null
        override fun read() = bytes
        override fun write(value: String) { bytes = value }
        override fun clear() { error("Original bytes must survive") }
    }
    /** The by-key receipt answers `unknown` until [accepted]; every POST loses its acknowledgement. */
    private inner class Port : HarvesterPort {
        var gets = 0; var posts = 0; var accepted = false
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path); gets++
            return harvesterJson.encodeToJsonElement(HarvesterProof.serializer(), proof(accepted)).jsonObject.also(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            guard(); posts++; throw IOException("acknowledgement lost")
        }
    }

    @Test fun `a saved selection the server does not know cannot block new Harvester selection forever`() = runBlocking<Unit> {
        val memory = Memory(); val store = HarvesterStore(memory, identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        val attempted = store.read(); assertNotNull(attempted.operation!!.attemptRevision); assertNull(attempted.operation!!.refusal)
        // The completed Harvester is gone: the same-key retry can never be admitted again, and nothing is sent.
        rejects { runBlocking { transport.confirm(attempted, { view().copy(facilities = emptyList()) }) {} } }
        assertEquals(1, port.posts); assertEquals(attempted, store.read())
        val gets = port.gets
        val closed = transport.archiveUnsentOrRefused(store.read()) {}
        assertEquals(gets + 1, port.gets); assertEquals(1, port.posts)
        val archive = closed.archives.single(); assertEquals("unknown", archive.reason); assertEquals("unknown", archive.evidence!!.status)
        assertEquals(attempted.operation, archive.operation)
        // HarvesterRepository.reviewSelection checks `store.read().operation == null`: the door opens again on this device.
        assertNull(store.read().operation); assertEquals(closed, HarvesterStore(memory, identity).read())
        transport.begin(command(id(9)), view()) {}; assertEquals(id(9), store.read().operation!!.command.key); assertEquals(1, port.posts)
    }
    @Test fun `close never forgets an accepted selection and a late acceptance stays recoverable`() = runBlocking<Unit> {
        val store = HarvesterStore(Memory(), identity); val port = Port(); val transport = HarvesterTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        port.accepted = true
        rejects { runBlocking { transport.archiveUnsentOrRefused(store.read()) {} } }
        assertEquals(proof(true), store.read().operation!!.proof); assertTrue(store.read().archives.isEmpty()); assertEquals(1, port.posts)

        val other = HarvesterStore(Memory(), identity); val late = Port(); val again = HarvesterTransport(other, late)
        val draft = again.begin(command(), view()) {}
        rejects { runBlocking { again.confirm(draft, ::view) {} } }
        again.archiveUnsentOrRefused(other.read()) {}
        late.accepted = true; again.checkArchived(command().key) {}
        val archive = other.read().archives.single()
        assertEquals("unknown", archive.reason); assertEquals(proof(true), archive.operation.proof); assertEquals(1, late.posts)
    }
    @Test fun `the unknown archive reason is valid only for an attempted unrefused selection`() = runBlocking<Unit> {
        val memory = Memory(); val store = HarvesterStore(memory, identity); store.begin(store.read(), command())
        rejects { store.archive(store.read(), "unknown", proof(false)) }
        store.refuse(store.attempt(store.read()), HarvesterRefusal(503, "HARVESTERS_DISABLED")); val refused = memory.bytes
        rejects { store.archive(store.read(), "unknown", proof(false)) }
        assertEquals(refused, memory.bytes); assertNotNull(store.read().operation)
    }
}
