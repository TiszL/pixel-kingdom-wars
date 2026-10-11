package gg.pixelkingdomwars.nativeclient.workshop

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-10-06 (dead-end audit): no saved request may block play forever on this device. An attempted Forge Ingots
 * request whose by-key receipt answers `unknown` could never clear before: its same-key retry needs current admission
 * (recipe, allowance, SHARDS) that may never hold again, and archiving needed a refusal. WorkshopRepository.reviewStart
 * and reviewCollect refuse while any operation is saved. Synthetic terms (copied from WorkshopTest), no device claim. */
class WorkshopUnknownCloseTest {
    private val identity = WorkshopIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val base = "00000000-0000-4000-8000-000000000001"
    private val job = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-21T12:00:00.000Z"
    private fun view() = WorkshopView(WorkshopFeatures(WorkshopFeature(1,1,1)), true, 1, 1, 17,
        WorkshopBatch(3,9), 61, WorkshopInventory(base,1,1),
        WorkshopAllowance(1,"free_wallet","2026-09-21T00:00:00.000Z","2026-09-22T00:00:00.000Z",2,
            WorkshopDaily(6,2,4),WorkshopHolding(3,2,0,0,14,9)),6,1,WorkshopLegacyHolding(1,0,0,1,14),2,
        listOf(WorkshopJob(job,1,"17",1,1,"2026-09-21T00:00:00.000Z","2026-09-21T00:01:01.000Z",true,null)),now)
    private fun start(key: String = "original-start") = WorkshopCommand.start(view(),key,1)
    private fun proof(c: WorkshopCommand, accepted: Boolean): WorkshopProof {
        val receipt = if (!accepted) null else buildJsonObject {
            put("version",1); put("status","accepted"); put("wallet",identity.wallet); put("baseId",base); put("jobId",job); put("receiptId",job)
            put("ingots",c.ingots); put("shardsCharged",c.charge()); put("recipeVersion",c.recipeVersion!!); put("workshopLevelAtStart",1)
            put("capacityScopeAtStart","free_wallet"); put("startedAt",view().jobs[0].startedAt); put("readyAt",view().jobs[0].readyAt); put("acceptedAt",view().jobs[0].startedAt)
        }
        return WorkshopProof(identity.wallet,c.key,if(accepted) "accepted" else "unknown",receipt,now)
    }
    private class Memory : SecretStore {
        var data: String? = null
        override fun read() = data
        override fun write(value: String) { data = value }
        override fun clear() { error("Never discard") }
    }
    /** The by-key receipt answers `unknown` until [accepted]; every POST loses its acknowledgement. */
    private inner class Port(val command: WorkshopCommand) : WorkshopPort {
        var gets = 0; var posts = 0; var accepted = false
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            gets++; guard(); assertEquals(command.receiptPath, path)
            return workshopJson.encodeToJsonElement(WorkshopProof.serializer(), proof(command, accepted)).jsonObject
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, refusal: (ApiException) -> Unit) {
            guard(); posts++; throw IOException("acknowledgement lost")
        }
    }

    @Test fun `a saved ingot request the server does not know cannot block Forge Ingots forever`() = runBlocking<Unit> {
        val memory = Memory(); val store = WorkshopStore(memory, identity); val port = Port(start()); val engine = WorkshopTransport(store, port)
        val saved = engine.begin(start()) {}
        assertThrows(IOException::class.java) { runBlocking { engine.confirm(saved) {} } }
        val attempted = store.read(); assertTrue(attempted.operation!!.attempted); assertNull(attempted.operation!!.refusal)
        // The recipe changed: the repository's admission (this guard) refuses the same-key retry before any read or POST.
        assertThrows(IllegalStateException::class.java) { runBlocking { engine.confirm(attempted) { error("Workshop terms changed") } } }
        assertEquals(1, port.posts); assertEquals(attempted, store.read())
        val gets = port.gets
        val closed = engine.archiveUnsentOrRefused(store.read()) {}
        assertEquals(gets + 1, port.gets); assertEquals(1, port.posts)
        val archive = closed.archives.single(); assertEquals("unknown", archive.reason); assertEquals("unknown", archive.evidence!!.status)
        assertEquals(attempted.operation, archive.operation)
        // reviewStart and reviewCollect check `store.read().operation == null`: the door opens again on this device.
        assertNull(store.read().operation); assertEquals(closed, WorkshopStore(memory, identity).read())
        store.begin(store.read(), start("next-start")); assertEquals("next-start", store.read().operation!!.command.key); assertEquals(1, port.posts)
    }
    @Test fun `close never forgets an accepted ingot request`() = runBlocking<Unit> {
        val store = WorkshopStore(Memory(), identity); val port = Port(start()); val engine = WorkshopTransport(store, port)
        val saved = engine.begin(start()) {}
        assertThrows(IOException::class.java) { runBlocking { engine.confirm(saved) {} } }
        port.accepted = true
        assertThrows(IllegalStateException::class.java) { runBlocking { engine.archiveUnsentOrRefused(store.read()) {} } }
        assertEquals("accepted", store.read().operation!!.proof!!.status); assertTrue(store.read().archives.isEmpty()); assertEquals(1, port.posts)
        // This journal has no archived-receipt recovery: once closed, a later acceptance shows only as the server's own job,
        // charge or credit in the current Workshop view and balances. That is why an accepted receipt must never be closed.
    }
    @Test fun `the unknown archive reason is valid only for an attempted unrefused unproven ingot request`() = runBlocking<Unit> {
        val memory = Memory(); val store = WorkshopStore(memory, identity); store.begin(store.read(), start())
        assertThrows(IllegalArgumentException::class.java) { store.archive(store.read(), "unknown", proof(start(), false)) }
        val attempted = store.attempt(store.read())
        store.accept(attempted, proof(start(), true)); val accepted = memory.data
        assertThrows(IllegalArgumentException::class.java) { store.archive(store.read(), "unknown", proof(start(), false)) }
        assertEquals(accepted, memory.data)
        val other = WorkshopStore(Memory(), identity); other.begin(other.read(), start())
        other.refuse(other.attempt(other.read()), WorkshopRefusal(422, "INSUFFICIENT_SHARDS"))
        assertThrows(IllegalArgumentException::class.java) { other.archive(other.read(), "unknown", proof(start(), false)) }
        assertNotNull(other.read().operation)
    }
}
