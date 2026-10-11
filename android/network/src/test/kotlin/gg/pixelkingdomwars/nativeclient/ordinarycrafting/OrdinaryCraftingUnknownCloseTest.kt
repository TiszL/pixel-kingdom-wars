package gg.pixelkingdomwars.nativeclient.ordinarycrafting

import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner 2026-10-06 (dead-end audit): no saved request may block play forever on this device. An attempted refining
 * start whose by-key receipt answers `unknown` could never clear before: its same-key retry needs the original recipe and
 * stock admission that may never hold again, and archiving needed a refusal. OrdinaryCraftingRepository.reviewStart
 * refuses while any operation is saved. Synthetic recipes (copied from OrdinaryCraftingTest), no device claim. */
class OrdinaryCraftingUnknownCloseTest {
    private val identity = OrdinaryCraftingIdentity("https://game.test", "devnet", "11111111111111111111111111111111")
    private val base = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val other = "00000000-0000-4000-8000-000000000003"
    private val start = "2026-09-22T12:00:00.000Z"
    private val recipes = listOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs",
        "sunstone_blocks" to "sunstone_rubble", "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism",
        "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules").map { (output, input) ->
        OrdinaryCraftingRecipe(1, "refine_$output", 1, 17, listOf(OrdinaryCraftingInput("raw", input, "13")), OrdinaryCraftingOutput(output, "3"))
    } + OrdinaryCraftingRecipe(1, "craft_navigation_kit", 1, 23, listOf(OrdinaryCraftingInput("crafting", "prismstone_lens", "2"),
        OrdinaryCraftingInput("crafting", "frostglass", "4")), OrdinaryCraftingOutput("navigation_kit", "1"))
    private fun view() = OrdinaryCraftingView(identity.wallet, base, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 1, 9,
        recipes, rawResourceIds.map { OrdinaryRawStock(it, "100", "5", "105") },
        craftingItemIds.map { OrdinaryProtectedStock(it, "100", "0") }, emptyList(), start)
    private fun command(key: String = this.key) = OrdinaryCraftingCommand.review(identity, view(), key, "refine_frostglass", 2)
    private fun proof(accepted: Boolean): OrdinaryCraftingProof {
        val command = command()
        val ready = java.time.Instant.parse(start).plusSeconds(command.recipe.durationSec).toString().replace("Z", ".000Z")
        val receipt = if (accepted) OrdinaryCraftingReceipt(command.key, command.recipe, start, ready, identity.wallet, command.request) else null
        return OrdinaryCraftingProof(identity.wallet, command.key, start, if (accepted) "accepted" else "unknown", receipt, null)
    }
    private fun rejects(action: () -> Unit) { assertTrue(runCatching(action).isFailure) }
    private class Memory : SecretStore {
        var bytes: String? = null
        override fun read() = bytes
        override fun write(value: String) { bytes = value }
        override fun clear() { error("Original records must never be cleared") }
    }
    /** The by-key receipt answers `unknown` until [accepted]; every POST loses its acknowledgement. */
    private inner class Port : OrdinaryCraftingPort {
        var gets = 0; var posts = 0; var accepted = false
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
            guard(); assertEquals(command().receiptPath, path); gets++
            return ordinaryJson.encodeToJsonElement(OrdinaryCraftingProof.serializer(), proof(accepted)).jsonObject.also(retain)
        }
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
            guard(); posts++; throw IOException("acknowledgement lost")
        }
    }

    @Test fun `a saved refining start the server does not know cannot block refining forever`() = runBlocking<Unit> {
        val memory = Memory(); val store = OrdinaryCraftingStore(memory, identity); val port = Port(); val transport = OrdinaryCraftingTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        val attempted = store.read(); assertNotNull(attempted.operation!!.attemptRevision); assertNull(attempted.operation!!.refusal)
        // New jobs are paused here: the same-key retry cannot be admitted, and nothing is sent.
        rejects { runBlocking { transport.confirm(attempted, { view().copy(acceptingJobs = false) }) {} } }
        assertEquals(1, port.posts); assertEquals(attempted, store.read())
        val gets = port.gets
        val closed = transport.archiveUnsentOrRefused(store.read()) {}
        assertEquals(gets + 1, port.gets); assertEquals(1, port.posts)
        val archive = closed.archives.single(); assertEquals("unknown", archive.reason); assertEquals("unknown", archive.evidence!!.status)
        assertEquals(attempted.operation, archive.operation)
        // OrdinaryCraftingRepository.reviewStart checks `store.read().operation == null`: the door opens again on this device.
        assertNull(store.read().operation); assertEquals(closed, OrdinaryCraftingStore(memory, identity).read())
        transport.begin(command(other), view()) {}; assertEquals(other, store.read().operation!!.command.key); assertEquals(1, port.posts)
    }
    @Test fun `close never forgets an accepted refining start and a late acceptance stays recoverable`() = runBlocking<Unit> {
        val store = OrdinaryCraftingStore(Memory(), identity); val port = Port(); val transport = OrdinaryCraftingTransport(store, port)
        val saved = transport.begin(command(), view()) {}
        rejects { runBlocking { transport.confirm(saved, ::view) {} } }
        port.accepted = true
        rejects { runBlocking { transport.archiveUnsentOrRefused(store.read()) {} } }
        assertEquals(proof(true), store.read().operation!!.proof); assertTrue(store.read().archives.isEmpty()); assertEquals(1, port.posts)

        val later = OrdinaryCraftingStore(Memory(), identity); val late = Port(); val again = OrdinaryCraftingTransport(later, late)
        val draft = again.begin(command(), view()) {}
        rejects { runBlocking { again.confirm(draft, ::view) {} } }
        again.archiveUnsentOrRefused(later.read()) {}
        late.accepted = true; again.checkArchived(key) {}
        val archive = later.read().archives.single()
        assertEquals("unknown", archive.reason); assertEquals(proof(true), archive.operation.proof); assertEquals(1, late.posts)
    }
    @Test fun `the unknown archive reason is valid only for an attempted unrefused refining start`() = runBlocking<Unit> {
        val memory = Memory(); val store = OrdinaryCraftingStore(memory, identity); store.begin(store.read(), command())
        rejects { store.archive(store.read(), "unknown", proof(false)) }
        store.refuse(store.attempt(store.read()), OrdinaryCraftingRefusal(400, "ORDINARY_RECIPE_INVALID")); val refused = memory.bytes
        rejects { store.archive(store.read(), "unknown", proof(false)) }
        assertEquals(refused, memory.bytes); assertNotNull(store.read().operation)
    }
}
