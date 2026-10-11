package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.workshop.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic accepted receipts and stock snapshots; authored before implementation, not executed. */
class WorkshopCompletionMapperTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val job = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-10-04T07:00:00.000Z"
    private val ready = "2026-10-04T07:00:34.000Z"
    private val identity = OrdinaryCraftingIdentity("https://example.invalid", "devnet", wallet)
    private val pairs = listOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs",
        "sunstone_blocks" to "sunstone_rubble", "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism",
        "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules")
    private fun ordinaryView() = OrdinaryCraftingView(wallet, base, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)),
        true, 1, 7, pairs.map { (out, input) -> OrdinaryCraftingRecipe(1, "refine_$out", 1, 17,
            listOf(OrdinaryCraftingInput("raw", input, "13")), OrdinaryCraftingOutput(out, "3")) } +
            OrdinaryCraftingRecipe(1, "craft_navigation_kit", 1, 23, listOf(OrdinaryCraftingInput("crafting", "prismstone_lens", "2"),
                OrdinaryCraftingInput("crafting", "frostglass", "4")), OrdinaryCraftingOutput("navigation_kit", "1")),
        pairs.map { OrdinaryRawStock(it.second, "100", "5", "105") },
        (pairs.map { it.first } + "navigation_kit").map { OrdinaryProtectedStock(it, "100", "0") }, emptyList(), now)
    private fun ordinary(): Pair<OrdinaryCraftingState, OrdinaryCraftingState> {
        val view = ordinaryView()
        val command = OrdinaryCraftingCommand.review(identity, view, job, "refine_frostglass", 2)
        val receipt = OrdinaryCraftingReceipt(job, command.recipe, now, ready, wallet, command.request)
        val proof = OrdinaryCraftingProof(wallet, job, ready, "accepted", receipt, OrdinaryCraftingCompletion(ready))
        val operation = OrdinaryCraftingOperation(command, 2, proof, null)
        val before = OrdinaryCraftingState(OrdinaryCraftingJournal(1, identity, 3, operation, emptyList()), view, advertised = true)
        return before to before.copy(journal = before.journal.copy(revision = 4, operation = null,
            archives = listOf(OrdinaryCraftingArchive(operation, "accepted", null))), view = view.copy(serverNow = ready),
            hydration = OrdinaryCraftingHydration.CURRENT_ORIGINAL_BASE)
    }
    private fun ingotView() = WorkshopView(WorkshopFeatures(WorkshopFeature(1, 1, 1)), true, 1, 1, 17,
        WorkshopBatch(3, 9), 61, WorkshopInventory(base, 1, 1),
        WorkshopAllowance(1, "free_wallet", "2026-10-04T00:00:00.000Z", "2026-10-05T00:00:00.000Z", 2,
            WorkshopDaily(6, 2, 4), WorkshopHolding(3, 2, 0, 0, 14, 9)), 6, 1,
        WorkshopLegacyHolding(1, 0, 0, 1, 14), 2,
        listOf(WorkshopJob(job, 1, "17", 1, 1, "2026-10-04T00:00:00.000Z", "2026-10-04T00:01:01.000Z", true, null)), now)
    private fun ingots(): Pair<WorkshopState, WorkshopState> {
        val view = ingotView(); val workshopIdentity = WorkshopIdentity(identity.origin, identity.cluster, wallet)
        val command = WorkshopCommand.collect(view, "collect-original", job)
        val proof = WorkshopProof(wallet, command.key, "accepted", buildJsonObject {
            put("version", 1); put("status", "accepted"); put("wallet", wallet); put("baseId", base)
            put("jobId", job); put("receiptId", job); put("ingotsCredited", 1); put("collectedAt", now)
        }, now)
        val operation = WorkshopOperation(command, true, proof, null)
        val before = WorkshopState(WorkshopJournal(1, workshopIdentity, 3, operation, emptyList()), view, "100", advertised = true)
        return before to before.copy(journal = before.journal.copy(revision = 4, operation = null,
            archives = listOf(WorkshopArchive(operation, "accepted", null))),
            view = view.copy(jobs = view.jobs.map { it.copy(collectedAt = now) }), hydration = WorkshopHydration.CURRENT_ORIGINAL_BASE)
    }

    @Test fun `ordinary exact completed output becomes local BATCH DONE after new hydrated archive`() {
        val (before, after) = ordinary(); val event = requireNotNull(ordinaryWorkshopCompletion(before, after))
        assertEquals(base, event.token.baseId); assertEquals(job, event.token.requestKey)
        assertEquals(job, event.ui.jobId); assertEquals("BATCH DONE", event.ui.title)
        assertEquals("+6 FROSTGLASS", event.ui.ribbon); assertSame(after.view, event.view)
        // Rewritten (fix-crafting-fidelity): the line now follows the workshop-done frame instead of the earlier
        // "Delivered to your stores."; the fixture's hydrated view has no other job, so the bench is said to be free.
        assertTrue(after.view!!.pendingJobs.isEmpty())
        assertEquals("In your stores. The bench is free.", event.ui.line)
    }
    @Test fun `accepted start without completion cannot celebrate even with hydrated archive`() {
        val (before, after) = ordinary(); val row = after.journal.archives.single()
        val changed = row.copy(operation = row.operation.copy(proof = row.operation.proof!!.copy(completion = null)))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(changed)))))
    }
    @Test fun `job disappearance and elapsed readyAt cannot replace completed receipt`() {
        val (before, after) = ordinary()
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = emptyList()))))
        val row = after.journal.archives.single().let { it.copy(operation = it.operation.copy(proof = null)) }
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(row)))))
    }
    @Test fun `historical complete archive alone is never a newly delivered event`() {
        val (_, after) = ordinary(); assertNull(ordinaryWorkshopCompletion(after, after.copy(view = after.view!!.copy())))
    }
    @Test fun `ordinary requires new current-base hydration rather than sticky enum or retained view`() {
        val (before, after) = ordinary()
        assertNull(ordinaryWorkshopCompletion(before, after.copy(view = before.view)))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(view = null)))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(hydration = null)))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(hydration = OrdinaryCraftingHydration.ORIGINAL_BASE_UNAVAILABLE)))
    }
    @Test fun `ordinary rejects foreign identity base wallet and unavailable final state`() {
        val (before, after) = ordinary()
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(identity = identity.copy(cluster = "mainnet-beta")))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(view = after.view!!.copy(wallet = "11111111111111111111111111111111"))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(view = after.view!!.copy(baseId = job))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(busy = true)))
    }
    @Test fun `ordinary rejects snapshot older than accepted completion proof`() {
        val (before, after) = ordinary(); assertNull(ordinaryWorkshopCompletion(before, after.copy(view = after.view!!.copy(serverNow = now))))
    }
    @Test fun `ordinary invalid output and contradictory receipt cannot enter celebration`() {
        val (before, after) = ordinary(); val row = after.journal.archives.single(); val proof = row.operation.proof!!
        val receipt = requireNotNull(proof.receipt)
        val bad = proof.copy(receipt = receipt.copy(recipe = receipt.recipe.copy(output = OrdinaryCraftingOutput("frostglass", "9223372036854775808"))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(row.copy(operation = row.operation.copy(proof = bad)))))))
    }
    @Test fun `ordinary requires one new exact archive and increasing journal revision`() {
        val (before, after) = ordinary(); val row = after.journal.archives.single()
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(revision = before.journal.revision))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(row, row)))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(operation = before.journal.operation))))
        assertNull(ordinaryWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(row.copy(reason = "unattempted"))))))
    }
    @Test fun `different saved recipe cannot be substituted into completed archive`() {
        val (before, after) = ordinary(); val operation = before.journal.operation!!
        val other = OrdinaryCraftingCommand.review(identity, ordinaryView(), job, "refine_heartwood_beams", 2)
        assertNull(ordinaryWorkshopCompletion(before.copy(journal = before.journal.copy(operation = operation.copy(command = other))), after))
    }
    @Test fun `collected ingots use exact accepted credits and existing delivered job`() {
        val (before, after) = ingots(); val event = requireNotNull(ingotWorkshopCompletion(before, after))
        assertEquals("+1 FORGE INGOTS", event.ui.ribbon); assertEquals("craft:inv_forge_ingot", event.ui.icon)
        assertEquals(job, event.ui.jobId); assertSame(after.view, event.view)
    }
    @Test fun `ingot start accepted is never a delivered output`() {
        val (before, after) = ingots(); val operation = before.journal.operation!!
        val start = WorkshopCommand.start(ingotView(), "start-original", 1)
        assertNull(ingotWorkshopCompletion(before.copy(journal = before.journal.copy(operation = operation.copy(command = start))), after))
    }
    @Test fun `ingot collect needs accepted proof beyond ready job or POST acknowledgement`() {
        val (before, after) = ingots(); val row = after.journal.archives.single()
        assertNull(ingotWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(row.copy(operation = row.operation.copy(proof = null)))))))
        assertNull(ingotWorkshopCompletion(before, after.copy(view = after.view!!.copy(jobs = emptyList()))))
        assertNull(ingotWorkshopCompletion(before, after.copy(view = after.view!!.copy(jobs = before.view!!.jobs))))
    }
    @Test fun `ingot stale foreign unavailable and unhydrated states stay closed`() {
        val (before, after) = ingots()
        assertNull(ingotWorkshopCompletion(before, after.copy(view = before.view)))
        assertNull(ingotWorkshopCompletion(before, after.copy(view = null)))
        assertNull(ingotWorkshopCompletion(before, after.copy(hydration = WorkshopHydration.ORIGINAL_BASE_UNAVAILABLE)))
        assertNull(ingotWorkshopCompletion(before, after.copy(journal = after.journal.copy(identity = after.journal.identity.copy(wallet = "11111111111111111111111111111111")))))
        assertNull(ingotWorkshopCompletion(before, after.copy(view = after.view!!.copy(inventory = after.view!!.inventory.copy(baseId = job)))))
    }
    @Test fun `ingot receipt mismatched credits are rejected`() {
        val (before, after) = ingots(); val row = after.journal.archives.single(); val proof = row.operation.proof!!
        val bad = proof.copy(receipt = JsonObject(proof.receipt!! + ("ingotsCredited" to JsonPrimitive(2))))
        assertNull(ingotWorkshopCompletion(before, after.copy(journal = after.journal.copy(archives = listOf(row.copy(operation = row.operation.copy(proof = bad)))))))
    }
    @Test fun `ingot copied old archive never becomes a second event`() {
        val (_, after) = ingots(); assertNull(ingotWorkshopCompletion(after, after.copy(view = after.view!!.copy())))
    }
    @Test fun `one shot retains exact token and stale callback cannot acknowledge another receipt`() {
        val (before, after) = ordinary(); val event = requireNotNull(ordinaryWorkshopCompletion(before, after))
        val events = WorkshopCompletionEvents(); assertTrue(events.offer(event)); assertSame(event, events.state.value)
        events.acknowledge(event.token.copy(requestKey = "other")); assertSame(event, events.state.value)
        events.acknowledge(event.token); assertNull(events.state.value)
        assertFalse(events.offer(event)); assertNull(events.state.value)
    }
    @Test fun `duplicate offer cannot reset displayed animation or bypass acknowledgement`() {
        val (before, after) = ingots(); val event = requireNotNull(ingotWorkshopCompletion(before, after))
        val events = WorkshopCompletionEvents(); assertTrue(events.offer(event)); assertFalse(events.offer(event.copy()))
        assertSame(event, events.state.value)
    }
    @Test fun `completion identities include origin cluster wallet base and saved request`() {
        val (before, after) = ordinary(); val event = requireNotNull(ordinaryWorkshopCompletion(before, after))
        assertEquals(identity.origin, event.token.origin); assertEquals(identity.cluster, event.token.cluster)
        assertEquals(wallet, event.token.wallet); assertEquals(base, event.token.baseId); assertEquals(job, event.token.requestKey)
    }

    @Test fun `unseen events stay with producing base and acknowledgement preserves other bases`() {
        val (before, after) = ordinary(); val first = requireNotNull(ordinaryWorkshopCompletion(before, after))
        val other = first.copy(token = first.token.copy(baseId = job, requestKey = "other-base"))
        val events = WorkshopCompletionEvents(); events.selectBase(base)
        assertTrue(events.offer(first)); assertTrue(events.offer(other)); assertSame(first, events.state.value)
        events.selectBase(job); assertSame(other, events.state.value)
        events.acknowledge(first.token); assertSame(other, events.state.value)
        events.acknowledge(other.token); assertNull(events.state.value)
        events.selectBase(base); assertSame(first, events.state.value)
        events.selectBase(null); assertNull(events.state.value)
    }


    @Test fun `same accepted delivery cannot replay under another saved request key`() {
        val (before, after) = ingots(); val event = requireNotNull(ingotWorkshopCompletion(before, after))
        val events = WorkshopCompletionEvents(); assertTrue(events.offer(event)); events.acknowledge(event.token)
        assertFalse(events.offer(event.copy(token = event.token.copy(requestKey = "different-request"))))
        assertNull(events.state.value)
    }

}
