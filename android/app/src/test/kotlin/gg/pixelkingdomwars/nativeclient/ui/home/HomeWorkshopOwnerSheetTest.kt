package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.economy.workshopIngredientDestination
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftSamples
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.SavedDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.refinePrimary
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.refineShardsPrice
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.savedRequestDoor
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.stripCount
import java.io.File
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** The Workshop acts in place on its Home sheet (frames 36-43): CAST, COLLECT and START run through their existing owners
 *  on the designed sheet, with no hop to an old route and no old chrome dialog for the review. */
class HomeWorkshopOwnerSheetTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
        .replace(Regex("""/\*[\s\S]*?\*/|//[^\n]*"""), "")
    private val host get() = source("ui/home/HomeWorkshopOwnerSheet.kt")
    private val ingots get() = source("ui/economy/WorkshopScreen.kt")
    private val refine get() = source("ui/economy/OrdinaryCraftingScreen.kt")

    /** Every `LaunchedEffect(...) { ... }` block, braces balanced, so a test can say what no effect may do. */
    private fun effects(text: String): List<String> {
        val blocks = mutableListOf<String>()
        var from = text.indexOf("LaunchedEffect(")
        while (from >= 0) {
            val open = text.indexOf('{', from)
            var depth = 0
            var end = open
            for (i in open until text.length) {
                if (text[i] == '{') depth++
                if (text[i] == '}') { depth--; if (depth == 0) { end = i; break } }
            }
            blocks += text.substring(from, end + 1)
            from = text.indexOf("LaunchedEffect(", end)
        }
        return blocks
    }

    @Test fun `the Home Workshop sheet mounts the existing owners in place under one owner host`() {
        val source = host
        // Each tab's owner keeps its own read, review and receipts; the host only provides currentness and doors.
        for (call in listOf("WorkshopScreen(", "OrdinaryCraftingContent(", "WorkshopStyleOwnerScreen(", "LocalWorkshopOwnerHost provides"))
            assertTrue("Mounted in place: $call", source.contains(call))
        assertTrue(source.contains("onOpenTools()"))
        assertTrue(source.contains("WorkshopViewModel(ingotRepository)"))
        assertTrue(source.contains("OrdinaryCraftingViewModel(repository)"))
    }

    @Test fun `the Home Workshop sheet never hops to an old route or opens old chrome`() {
        val source = host
        // A route hop or an AlertDialog would take the player off the designed sheet for the main action.
        assertFalse(source.contains("navController")); assertFalse(source.contains("AlertDialog"))
        assertFalse(source.contains("WorkshopRoute")); assertFalse(source.contains("OrdinaryCraftingRoute"))
        assertFalse(source.contains("OrdinaryWorkshopScreen("))
    }

    @Test fun `an open INGOTS review stays current for its own owner on Home`() {
        // The INGOTS review is one of the reviews that close Home read controls; without this the half sheet's START
        // would be refused by the very review it confirms.
        assertTrue(host.contains("canReadNow() || ingotRepository?.state?.value?.review != null"))
        assertTrue(host.contains("lifecycle.currentState == Lifecycle.State.RESUMED && homeOwnerProjectionIdentity(graph, session) == identity"))
    }

    @Test fun `the owner screens review on the half sheet and no longer in an AlertDialog`() {
        for ((name, source) in listOf("WorkshopScreen" to ingots, "OrdinaryCraftingScreen" to refine)) {
            // The old dialogs were the second, undesigned review surface; their titles and checkbox must be gone.
            for (old in listOf("REVIEW COLLECTION", "REVIEW REFINING", "REVIEW BATCH", "START BATCH", "START REFINING",
                "COLLECT INGOTS", "CANCEL REVIEW", "Checkbox(", "    review?.let { r ->"))
                assertFalse("$name still has $old", source.contains(old))
            assertTrue(source.contains("onReviewConfirm = { review?.let { r -> if (canAct && "))
            assertTrue(source.contains("onReviewBack = { model.dismiss() }"))
        }
        assertTrue(ingots.contains("workshopIngotsReviewUi(it, busy, op?.attempted == true)"))
        assertTrue(refine.contains("ordinaryRefineReviewUi(it, busy, operation?.attemptRevision != null)"))
    }

    @Test fun `finish is a player tap only and no effect opens receipts or archives`() {
        for ((name, source) in listOf("WorkshopScreen" to ingots, "OrdinaryCraftingScreen" to refine, "HomeWorkshopOwnerSheet" to host)) {
            val blocks = effects(source)
            for (block in blocks) {
                // An automatic archive could celebrate or hide a receipt the player never chose to close.
                assertFalse("$name effect archives: $block", block.contains("finish()"))
                assertFalse("$name effect opens receipts: $block", block.contains("showReceipts = true"))
                assertFalse("$name effect opens history: $block", block.contains("RefiningPage.HISTORY"))
            }
        }
        assertTrue(effects(ingots).isNotEmpty()); assertTrue(effects(refine).isNotEmpty())
        // The explicit door is where a proven request is archived.
        assertTrue(ingots.substringAfter("SavedDoor.FINISH ->").substringBefore("SavedDoor.REVIEW ->").contains("model.finish()"))
        assertTrue(refine.substringAfter("SavedDoor.FINISH ->").substringBefore("SavedDoor.REVIEW ->").contains("model.finish()"))
    }

    @Test fun `notices are toasts and a refresh keeps the last admitted body`() {
        for (source in listOf(ingots, refine)) {
            // Raw text above the sheet pushed it down and blanked nothing useful; a toast never blanks the sheet.
            assertTrue(source.contains("LaunchedEffect(notice) { notice?.let { Toasts.post(it.message, it.error) } }"))
            assertTrue(source.contains("retained[0]?.copy(actionsAllowed = false"))
            assertTrue(source.contains("CraftHydration.Loading"))
        }
    }

    @Test fun `tab follows the sheet then the destination and never hides a saved ingot original`() {
        fun tab(destination: String?, selected: String? = null, saved: Boolean = false, ready: Boolean = false): String {
            val entry = SheetEntry(Destination.Workshop(destination), selectedTab = selected)
            return homeWorkshopReadyTab(entry, homeWorkshopOwnerTab(entry, saved), ready)
        }
        assertEquals(WorkshopTab.REFINE, tab("REFINE"))
        assertEquals(WorkshopTab.COSMETICS, tab("REFINE", selected = "COSMETICS"))
        assertEquals(WorkshopTab.EQUIPMENT, tab("EQUIPMENT"))
        // Rewritten (c-gap-craft, SPEC §2 Entry): a plain CRAFT door opens the crafting bench (REFINE), not the ingot
        // caster; only a batch of ingots waiting to be collected makes INGOTS the first thing the player sees.
        assertEquals(WorkshopTab.REFINE, tab(null))
        assertEquals(WorkshopTab.REFINE, tab("SOMETHING"))
        assertEquals(WorkshopTab.INGOTS, tab(null, ready = true))
        assertEquals(WorkshopTab.REFINE, tab("REFINE", ready = true))
        // A saved INGOTS request outranks a door's tab, so its recovery is the first thing the player sees.
        assertEquals(WorkshopTab.INGOTS, tab("REFINE", saved = true))
        // Once the player picks a tab in the sheet, that choice stands.
        assertEquals(WorkshopTab.REFINE, tab("REFINE", selected = "REFINE", saved = true))
    }

    private fun base(id: String?, vararg buildings: Building) = BaseSnapshot(id, null, PlayerSummary(keepLevel = 1), null, null, null,
        buildings.toList(), emptyList(), emptyList(), 0, JsonObject(emptyMap()))

    @Test fun `header level comes only from the selected base's completed Workshop`() {
        val workshop = Building("w1", "workshop", 5, 3, 3)
        assertEquals(5, homeWorkshopLevel(base(BASE_ID, Building("k", "keep", 7, 1, 1), workshop), BASE_ID))
        // An upgrade in progress, another base's snapshot or no Workshop draws no level or art rather than a wrong one.
        assertNull(homeWorkshopLevel(base(BASE_ID, workshop.copy(underConstruction = true)), BASE_ID))
        assertNull(homeWorkshopLevel(base("another-base", workshop), BASE_ID))
        assertNull(homeWorkshopLevel(base(BASE_ID, Building("k", "keep", 7, 1, 1)), BASE_ID))
        assertNull(homeWorkshopLevel(null, BASE_ID))
    }

    @Test fun `a missing raw input goes to the Harvester and anything else to the Market`() {
        // GO for a raw resource leads to where it is gathered; a refined input made elsewhere can only be bought.
        assertEquals(Destination.Harvester(), workshopIngredientDestination("frost_quartz", CraftSamples.refine))
        assertEquals(Destination.Market("BUY"), workshopIngredientDestination("heartwood_beams", CraftSamples.refine))
        assertEquals(Destination.Market("BUY"), workshopIngredientDestination("frost_quartz", null))
    }

    @Test fun `a saved request door archives only a proven request and sends the rest to History`() {
        // Archiving an unproven request from the main flow could hide money still in flight; History keeps those.
        assertEquals(SavedDoor.FINISH, savedRequestDoor(proven = true, declined = false, attempted = true, canReview = false))
        assertEquals(SavedDoor.REVIEW, savedRequestDoor(proven = false, declined = false, attempted = false, canReview = true))
        assertEquals(SavedDoor.HISTORY, savedRequestDoor(proven = false, declined = false, attempted = false, canReview = false))
        assertEquals(SavedDoor.HISTORY, savedRequestDoor(proven = false, declined = false, attempted = true, canReview = true))
        assertEquals(SavedDoor.HISTORY, savedRequestDoor(proven = false, declined = true, attempted = true, canReview = true))
    }

    @Test fun `the review half sheet shows a recipe's Shards while the footer behind it is closed`() {
        val reviewing = CraftSamples.refineShort.copy(actionsAllowed = false)
        // The closed footer drops its price, so the review reads the cost from the recipe itself.
        assertNull(refinePrimary(reviewing, CraftSamples.NOW)?.price)
        val price = requireNotNull(refineShardsPrice(reviewing))
        assertEquals(Currency.SHARDS, price.currency); assertEquals("1,200", price.amount)
        assertNull(refineShardsPrice(CraftSamples.refine))
    }

    @Test fun `a strip that overflows the panel names its count with the scroll hint`() {
        // workshop-refine.png: "8 ▸" over eight tiles, plain "3" over three kits.
        assertEquals("8 ▸", stripCount(8)); assertEquals("5 ▸", stripCount(5))
        assertEquals("4", stripCount(4)); assertEquals("3", stripCount(3))
    }

    @Test fun `doors to other sheets exist only when the host binds a destination opener`() {
        // A GO without an opener would do nothing; the route screens keep theirs hidden.
        assertTrue(ingots.contains("destinationsAvailable = onOpenDestination != null"))
        assertTrue(ingots.contains("Destination.GoldForge(\"SMELT\")"))
        assertTrue(refine.contains("destinationsAvailable = onOpenDestination != null"))
        assertTrue(refine.contains("workshopIngredientDestination(itemId, refine)"))
        val sheet = source("ui/sheets/craft/WorkshopSheet.kt")
        assertEquals(2, sheet.split("workshopHeaderArt(ui, host?.headerTier)").size - 1)
        assertEquals(2, sheet.split("titleTag = ui.frame.titleTag ?: host?.titleTag").size - 1)
    }
}
