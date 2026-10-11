package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server values, not copied tuning; AUTHORED/UNRUN. */
class WorkshopTabsMoneyMapperTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val job = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-10-04T07:00:00.000Z"
    private val identity = OrdinaryCraftingIdentity("https://example.invalid", "devnet", wallet)
    private val starter = StarterIdentity(identity.origin, identity.cluster, wallet)
    private val cosmetic = BoundCosmeticIdentity(identity.origin, identity.cluster, wallet)
    private val pairs = listOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs",
        "sunstone_blocks" to "sunstone_rubble", "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism",
        "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules")
    private fun view() = OrdinaryCraftingView(wallet, base, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)),
        true, 1, 7, pairs.map { (output, input) -> OrdinaryCraftingRecipe(1, "refine_$output", 1, 17,
            listOf(OrdinaryCraftingInput("raw", input, "13")), OrdinaryCraftingOutput(output, "3")) } +
            OrdinaryCraftingRecipe(1, "craft_navigation_kit", 1, 23, listOf(OrdinaryCraftingInput("crafting", "prismstone_lens", "2"),
                OrdinaryCraftingInput("crafting", "frostglass", "4")), OrdinaryCraftingOutput("navigation_kit", "1")),
        pairs.map { OrdinaryRawStock(it.second, "100", "5", "105") },
        (pairs.map { it.first } + "navigation_kit").map { OrdinaryProtectedStock(it, "100", "0") }, emptyList(), now)
    private fun state(v: OrdinaryCraftingView = view()) = OrdinaryCraftingState(
        OrdinaryCraftingJournal(1, identity, 0, null, emptyList()), v, advertised = true)
    private fun refine(s: OrdinaryCraftingState = state(), offset: Long? = null, quantity: Int = 2) =
        workshopRefineTabUi(s, identity, base, true, true, benchCapacity = 3, quantity = quantity, serverOffsetMs = offset)
    private fun equipment(): EquipmentState {
        val recipe = EquipmentRecipe(1, "craft_route_compass", 1, 31,
            listOf(EquipmentInput("crafting", "prismstone_lens", "7"), EquipmentInput("crafting", "crownsteel", "11")),
            EquipmentOutput("route_compass", "1"))
        return EquipmentState(journal = EquipmentJournal(identity = starter), view = EquipmentView(wallet, base, now,
            EquipmentFeatures(EquipmentFeature(1, 1)), true, 1, 1, listOf(recipe), view().craftingStock,
            listOf(EquipmentStock("route_compass", "3", "0", "0")), emptyList()))
    }
    private fun tools(s: EquipmentState = equipment()) = workshopToolsTabUi(s, starter, base,
        repositoryCurrent = true, viewCurrent = true, travelling = emptyList(), travellingCurrent = true)

    @Test fun `refine is absent without explicit current identity and view`() {
        assertNull(workshopRefineTabUi(state(), identity, base, benchCapacity = 3))
        assertNull(workshopRefineTabUi(state(), identity, "other", true, true, benchCapacity = 3))
    }
    @Test fun `refine uses all server recipes and exact stock components`() {
        val ui = refine()!!; assertEquals(9, ui.recipes.size); assertEquals(7, ui.maxBatch); assertEquals(3, ui.benchCapacity)
        assertEquals(StockUi(100, 5, 105), ui.stock["frost_quartz"])
        assertNull(ui.stock.getValue("navigation_kit").reserved)
        assertEquals(13, ui.recipes.first().inputs.single().perUnit.toInt())
        assertEquals(RecipeGroup.KIT, ui.recipes.last().group)
    }
    @Test fun `refine preserves server paused flag and disables every spend`() {
        val ui = refine(state(view().copy(acceptingJobs = false)))!!
        assertFalse(ui.acceptingJobs); assertFalse(ui.actionsAllowed); assertEquals(SubmitStage.IDLE, ui.submit.stage)
        assertNotEquals(PrimaryAction.START, refinePrimary(ui, 0)!!.action)
    }
    @Test fun `accepting refine remains display only until actions are admitted`() {
        val ui = requireNotNull(refine()); assertTrue(ui.acceptingJobs)
        val primary = requireNotNull(refinePrimary(ui, 0))
        assertNotEquals(PrimaryAction.START, primary.action); assertEquals(CommandState.DISABLED, primary.state)
        // Positive control: stock, recipe and bench permit review once this one gate is open.
        assertEquals(PrimaryAction.START, refinePrimary(ui.copy(actionsAllowed = true), 0)!!.action)
    }
    @Test fun `refine does not guess a bench capacity`() {
        assertNull(workshopRefineTabUi(state(), identity, base, true, true))
    }
    @Test fun `refine clamps selection only within server batch bounds`() {
        assertEquals(7, refine(quantity = 100)!!.quantity); assertEquals(1, refine(quantity = -1)!!.quantity)
    }
    @Test fun `refine refuses overflow rather than wrap displayed ingredient costs`() {
        val v = view(); val r = v.recipes.first().copy(inputs = listOf(OrdinaryCraftingInput("raw", "frost_quartz", Long.MAX_VALUE.toString())))
        assertNull(refine(state(v.copy(recipes = listOf(r) + v.recipes.drop(1)))))
    }
    @Test fun `refine cannot turn unadmitted stale stock into zero`() {
        assertNull(refine(state().copy(busy = true))); assertNull(refine(state().copy(advertised = false)))
    }
    @Test fun `refine invalid server recipe is not silently omitted`() {
        assertNull(refine(state(view().copy(recipes = view().recipes.drop(1)))))
    }
    @Test fun `refine jobs need admitted server clock offset`() {
        val v = view(); val pending = OrdinaryCraftingPendingJob(job, v.recipes.first(), now, "2026-10-04T07:00:17.000Z")
        val s = state(v.copy(pendingJobs = listOf(pending), craftingStock = v.craftingStock.map {
            if (it.itemId == "frostglass") it.copy(pendingOutput = "3") else it }))
        assertNull(refine(s)); val ui = refine(s, offset = 31)!!
        assertEquals(job, ui.pendingJobs.single().jobId); assertEquals(31L, ui.serverOffsetMs)
    }
    @Test fun `saved refine original is delegated to original recovery instead of current stock`() {
        val c = OrdinaryCraftingCommand.review(identity, view(), job, "refine_frostglass", 1)
        val s = state().let { it.copy(journal = it.journal.copy(operation = OrdinaryCraftingOperation(c, null, null, null))) }
        assertNull(refine(s))
    }
    @Test fun `tools exposes real server recipes and owned available plus reserved`() {
        val ui = tools()!!; assertEquals(3L, ui.owned["route_compass"])
        assertEquals(31L, ui.recipes.single().durationSec); assertFalse(ui.actionsAllowed)
        assertEquals("craft_route_compass", ui.recipes.single().recipeId)
        assertNotEquals(PrimaryAction.START, toolsPrimary(ui, 0)!!.action)
    }
    @Test fun `tools never interprets missing travelling observation as empty trips`() {
        assertNull(workshopToolsTabUi(equipment(), starter, base, true, true))
    }
    @Test fun `tools require travelling rows to explain every reserved tool`() {
        val s = equipment(); assertNull(tools(s.copy(view = s.view!!.copy(equipmentStock = listOf(EquipmentStock("route_compass", "3", "1", "0"))))))
    }
    @Test fun `tools refuse ambiguous multiple jobs and stale error state`() {
        assertNull(tools(equipment().copy(error = "refresh failed"))); assertNull(tools(equipment().copy(busy = true)))
        val s = equipment(); val v = s.view!!
        val jobs = listOf(job, "00000000-0000-4000-8000-000000000003").map {
            EquipmentJob(it, v.recipes.single(), now, "2026-10-04T07:00:31.000Z") }
        val multi = v.copy(pendingJobs = jobs, equipmentStock = listOf(EquipmentStock("route_compass", "3", "0", "2")))
        multi.validate() // Valid two-job server view; only the one-job kit representation must refuse it.
        assertNull(workshopToolsTabUi(s.copy(view = multi), starter, base, true, true, emptyList(), true, serverOffsetMs = 31))
    }
    @Test fun `tools requires current journal identity`() {
        assertNull(tools(equipment().copy(journal = EquipmentJournal(identity = starter.copy(wallet = "11111111111111111111111111111113")))))
    }
    @Test fun `style requires both admitted views and an existing owner handoff`() {
        val s = styleStates(); assertNotNull(style(s))
        assertNull(workshopStyleTabUi(s.first, s.second, cosmetic, base, job, true, true, true,
            ownerHandoffReady = false, previewVerified = true, outputTier = { it.last().digitToIntOrNull() }))
    }
    @Test fun `style unavailable views cannot fabricate unowned cosmetics`() {
        val s = styleStates(); assertNotNull(style(s))
        val b = s.first.view!!.selectedBase as BoundCosmeticSelectedBase.Available
        assertNull(style(s.first.copy(view = s.first.view!!.copy(selectedBase = b.copy(
            visual = BoundCosmeticBaseRead("unavailable", null)))) to s.second))
    }
    @Test fun `style missing sibling view delegates instead of inventing ownership`() {
        val s = styleStates(); assertNotNull(style(s))
        assertNull(style(s.first.copy(view = null) to s.second))
        assertNull(style(s.first to s.second.copy(view = null)))
    }
    @Test fun `style missing sibling state is absent even with all admission flags open`() {
        val s = styleStates(); assertNotNull(style(s))
        assertNull(workshopStyleTabUi(null, s.second, cosmetic, base, job, true, true, true, true, true,
            outputTier = { it.last().digitToIntOrNull() }))
        assertNull(workshopStyleTabUi(s.first, null, cosmetic, base, job, true, true, true, true, true,
            outputTier = { it.last().digitToIntOrNull() }))
    }
    private fun styleStates(): Pair<BoundCosmeticWorkshopState, BoundCosmeticWakeWorkshopState> {
        fun row(output: String, source: String, facility: String) = BoundCosmeticCatalogueRow(
            BoundCosmeticRecipe("craft_${output}_v1", 1, output, "1", 29,
                listOf(BoundCosmeticInput("frostglass", "8")), BoundCosmeticFacility(facility, 5),
                "architect_blueprint_artisan_finishes_v1"),
            BoundCosmeticAppearance(1, output, source, "a".repeat(64), "b".repeat(64), "c".repeat(64)))
        val journal = BoundCosmeticJournal(1, cosmetic, 0, null, emptyList())
        val bp = BoundCosmeticBlueprintEligibility("not-earned", null, null)
        val facility = BoundCosmeticCompletedFacility(job, 5, "2026-10-03T07:00:00.000Z")
        val selected = BoundCosmeticSelectedBase.Available(base, view().craftingStock, emptyList(), listOf(facility),
            emptyList(), BoundCosmeticPreference(false, "0"), BoundCosmeticBaseRead("available", BoundCosmeticBaseVisual(1, emptyList())))
        val v = BoundCosmeticWorkshopView(1, wallet, now, true, true, bp,
            (1..4).map { row("artisan_market_awning_t$it", "artisan-market-t$it", "market") }, emptyList(), selected)
        val w = BoundCosmeticWakeWorkshopView(1, wallet, now, true, true, bp, row("aurora_wake", "auroraWake", "lodge"),
            null, BoundCosmeticWakePreferenceSnapshot(false, "0", BoundCosmeticWakeRead("available", BoundCosmeticWakeVisual(1, null))),
            BoundCosmeticWakeSelectedBase.Available(base, view().craftingStock, emptyList(), emptyList(), emptyList()))
        return BoundCosmeticWorkshopState(journal, v, advertised = true) to BoundCosmeticWakeWorkshopState(journal, w, advertised = true)
    }
    private fun style(s: Pair<BoundCosmeticWorkshopState, BoundCosmeticWakeWorkshopState> = styleStates(),
        tier: (String) -> Int? = { it.last().digitToIntOrNull() }) = workshopStyleTabUi(
        s.first, s.second, cosmetic, base, job, true, true, true, true, true, tier)
    @Test fun `style takes actual recipes and levels without inventing ownership`() {
        val ui = style()!!; assertEquals(4, ui.awning.tiers.size); assertEquals(5, ui.marketLevel)
        assertTrue(ui.awning.tiers.all { !it.owned && !it.craftable && it.requiredMarketLevel == 5 })
        assertEquals(29L, ui.awning.tiers.first().durationSec); assertFalse(ui.wake.owned); assertFalse(ui.wake.shown)
        assertFalse(ui.actionsAllowed); assertNull(ui.job)
        assertNotEquals(PrimaryAction.START, stylePrimary(ui, 0)!!.action)
        assertNotEquals(PrimaryAction.START, stylePrimary(ui.copy(wakeSelected = true), 0)!!.action)
    }
    @Test fun `style requires supplied catalogue tier map`() { assertNull(style(tier = { null })) }
    @Test fun `style refuses a changed base or unavailable visual`() {
        val s = styleStates(); val b = s.first.view!!.selectedBase as BoundCosmeticSelectedBase.Available
        assertNull(style(s.first.copy(view = s.first.view!!.copy(selectedBase = b.copy(baseId = job))) to s.second))
        assertNull(style(s.first.copy(view = s.first.view!!.copy(selectedBase = b.copy(visual = BoundCosmeticBaseRead("unavailable", null)))) to s.second))
    }

    @Test fun `travelling tools require an admitted clock even with an empty bench`() {
        val s = equipment(); val v = s.view!!.copy(equipmentStock = listOf(EquipmentStock("route_compass", "3", "1", "0")))
        v.validate()
        val trips = listOf(TravellingToolUi("route_compass", 1000, job))
        assertNull(workshopToolsTabUi(s.copy(view = v), starter, base, true, true, trips, true))
        val ui = workshopToolsTabUi(s.copy(view = v), starter, base, true, true, trips, true, serverOffsetMs = 31)!!
        assertEquals(31L, ui.serverOffsetMs); assertEquals(trips, ui.travelling)
    }
    @Test fun `saved tool job stays with the original receipt owner`() {
        val s = equipment(); val c = EquipmentCommand.review(starter, s.view!!, job)
        val record = EquipmentRecord("craft", job, c.request.body(), JsonObject(emptyMap()), recipe = c.recipe)
        assertNotNull(tools(s)); assertNull(tools(s.copy(journal = s.journal!!.copy(pending = listOf(record)))))
    }
    @Test fun `saved cosmetic work takes precedence over valid fresh sibling views`() {
        val s = styleStates(); val row = s.first.view!!.recipes.first()
        val request = BoundCosmeticRequest(job, base, row.recipe.recipeId, row.recipe.recipeVersion, row.appearance.bindingSha256)
        val command = BoundCosmeticCommand(request, row.recipe, row.appearance).also { it.validate() }
        val op = BoundCosmeticOperation(command, true, null)
        assertNotNull(style(s))
        assertNull(style(s.first.copy(journal = s.first.journal.copy(operation = op)) to s.second))
        val wake = s.second.view!!.recipe
        val wakeCommand = BoundCosmeticCommand(BoundCosmeticRequest(job, base, wake.recipe.recipeId,
            wake.recipe.recipeVersion, wake.appearance.bindingSha256), wake.recipe, wake.appearance).also { it.validate(BoundCosmeticMode.WAKE) }
        assertNull(style(s.first to s.second.copy(journal = s.second.journal.copy(operation = BoundCosmeticOperation(wakeCommand, true, null)))))
    }

}
