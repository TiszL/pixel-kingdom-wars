package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingReview
import gg.pixelkingdomwars.nativeclient.data.WorkshopReview
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.ui.economy.ordinaryCraftingIngredientConsent
import gg.pixelkingdomwars.nativeclient.workshop.*
import org.junit.Assert.*
import org.junit.Test

/** The Workshop reviews moved from AlertDialogs to the designed half sheet. Its START / COLLECT tap is now the explicit
 *  consent the checkbox used to be, so these pin that the consent, refund terms and resend notice survive the move. */
class WorkshopReviewMapperTest {
    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val job = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-10-04T07:00:00.000Z"
    private val resend = "This explicitly resends the same saved request only after its original receipt is checked."

    private fun ingotView() = WorkshopView(WorkshopFeatures(WorkshopFeature(1, 1, 1)), true, 1, 1, 17,
        WorkshopBatch(3, 9), 61, WorkshopInventory(base, 1, 1),
        WorkshopAllowance(1, "free_wallet", "2026-10-04T00:00:00.000Z", "2026-10-05T00:00:00.000Z", 2,
            WorkshopDaily(6, 2, 4), WorkshopHolding(3, 2, 0, 0, 14, 9)), 6, 1,
        WorkshopLegacyHolding(1, 0, 0, 1, 14), 2,
        listOf(WorkshopJob(job, 1, "17", 1, 1, "2026-10-04T00:00:00.000Z", "2026-10-04T00:01:01.000Z", true, null)), now)
    private fun cast(ingots: Long = 4, perIngot: Long = 2_000) = WorkshopReview(
        WorkshopCommand("start", base, "start-original", ingots, null, 1, perIngot, 1, 30, "free_wallet"), ingotView(), "40943", 0, 0, 0, 0)
    private fun collect() = WorkshopReview(
        WorkshopCommand("collect", base, "collect-original", 1, job, null, null, null, null, null), ingotView(), "40943", 0, 0, 0, 0)

    private fun ordinaryView() = OrdinaryCraftingView(wallet, base, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)),
        true, 2, 10, emptyList(), emptyList(), emptyList(), emptyList(), now)
    private val expedition = OrdinaryCraftingRecipe(2, "craft_expedition_kit", 2, 480, listOf(
        OrdinaryCraftingInput("crafting", "heartwood_beams", "8"), OrdinaryCraftingInput("crafting", "thornsilk", "4"),
        OrdinaryCraftingInput("shards", "shards", "1200")), OrdinaryCraftingOutput("expedition_kit", "2"))
    private val frostglass = OrdinaryCraftingRecipe(2, "refine_frostglass", 6, 540,
        listOf(OrdinaryCraftingInput("raw", "frost_quartz", "24")), OrdinaryCraftingOutput("frostglass", "6"))
    private fun refine(recipe: OrdinaryCraftingRecipe) = OrdinaryCraftingReview(OrdinaryCraftingCommand(
        OrdinaryCraftingRequest("00000000-0000-4000-8000-000000000003", base, recipe.recipeId, 2, recipe.quantity), recipe),
        ordinaryView(), 0, 0)

    @Test fun `a recipe that spends SHARDS carries the whole ingredient consent because START replaced the checkbox`() {
        val ui = ordinaryRefineReviewUi(refine(expedition), sending = false, resend = false)
        // Without the sentence, one tap would spend SHARDS the player never saw described as an ingredient.
        assertTrue(ui.line.contains("1200 SHARDS are consumed as an ingredient alongside the listed materials. This is not a service fee or tax."))
        assertTrue(ui.line.startsWith(ordinaryCraftingIngredientConsent(expedition)))
        assertTrue(ui.line.contains("No cancellation or refund. No SOL, KEEP or Gems payment."))
        assertEquals("CRAFT 2 EXPEDITION KIT", ui.title); assertEquals("START", ui.confirmLabel)
    }

    @Test fun `a recipe without SHARDS states only its material consumption and terms`() {
        val ui = ordinaryRefineReviewUi(refine(frostglass), sending = false, resend = false)
        // A raw-only batch must not borrow the SHARDS sentence: it would claim a spend that does not happen.
        assertFalse(ui.line.contains("SHARDS are consumed"))
        assertEquals("The listed materials are consumed at the start. No cancellation or refund. No SOL, KEEP or Gems payment.", ui.line)
        assertEquals("REFINE 6 FROSTGLASS", ui.title)
    }

    @Test fun `the resend notice appears only when the saved request was already attempted`() {
        // Re-confirming an attempted request resends it; a fresh review must not frighten, an attempted one must warn.
        assertTrue(ordinaryRefineReviewUi(refine(frostglass), false, resend = true).line.endsWith(resend))
        assertFalse(ordinaryRefineReviewUi(refine(frostglass), false, resend = false).line.contains(resend))
        assertTrue(workshopIngotsReviewUi(cast(), false, resend = true).line.endsWith(resend))
        assertFalse(workshopIngotsReviewUi(cast(), false, resend = false).line.contains(resend))
        assertTrue(workshopIngotsReviewUi(collect(), false, resend = true).line.endsWith(resend))
    }

    @Test fun `sending mirrors the owner busy state so a second START cannot be sent`() {
        // The half sheet's confirm ignores taps while sending; a stale false would allow a double submission.
        assertTrue(workshopIngotsReviewUi(cast(), sending = true, resend = false).sending)
        assertFalse(workshopIngotsReviewUi(cast(), sending = false, resend = false).sending)
        assertTrue(ordinaryRefineReviewUi(refine(expedition), sending = true, resend = false).sending)
        assertFalse(ordinaryRefineReviewUi(refine(expedition), sending = false, resend = false).sending)
    }

    @Test fun `ingot reviews state the server charge for a cast and no new charge for a collect`() {
        val cast = workshopIngotsReviewUi(cast(), false, false)
        // The charge is the reviewed command's own terms: 4 ingots at 2,000 SHARDS each.
        assertEquals("CAST 4 FORGE INGOTS", cast.title); assertEquals("START", cast.confirmLabel)
        assertEquals("Pay 8,000 SHARDS at start. Charge is final at start. No cancellation, refund or SOL fee.", cast.line)
        val collect = workshopIngotsReviewUi(collect(), false, false)
        assertEquals("COLLECT 1 FORGE INGOTS", collect.title); assertEquals("COLLECT", collect.confirmLabel)
        assertEquals("Collect from the original paid job. No new refining charge.", collect.line)
        assertFalse(collect.line.contains("SHARDS"))
    }

    @Test fun `no review line ever claims that nothing was spent`() {
        // Only an authoritative refusal may say so; a review is before the request and an uncertain result is unknown.
        val lines = listOf(true, false).flatMap { resend ->
            listOf(workshopIngotsReviewUi(cast(), false, resend), workshopIngotsReviewUi(collect(), false, resend),
                ordinaryRefineReviewUi(refine(expedition), false, resend), ordinaryRefineReviewUi(refine(frostglass), false, resend))
        }.map { it.line }
        for (line in lines) assertFalse(line, line.contains("nothing was spent", ignoreCase = true))
    }
}
