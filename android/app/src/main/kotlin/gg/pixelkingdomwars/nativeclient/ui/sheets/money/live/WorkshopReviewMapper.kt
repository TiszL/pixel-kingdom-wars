package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingReview
import gg.pixelkingdomwars.nativeclient.data.WorkshopReview
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.economy.ordinaryCraftingIngredientConsent
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftReviewUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.groupDigits
import java.util.Locale

/*
 * The Workshop reviews on the designed half sheet (craft/SPEC.md §2.1 "Review half sheet replaces today's AlertDialog").
 * Every sentence is the owners' existing review wording; every number is the reviewed command's own (the server's terms
 * captured in the review). The half sheet's START / COLLECT is the explicit second tap that today's consent checkbox
 * was, so the SHARDS ingredient consent is always in the line when the recipe spends SHARDS. A resend of an attempted
 * request says so. Nothing here may say that nothing was spent: only an authoritative refusal may.
 */

/** The existing resend sentence of both owners' reviews. */
private const val RESEND = "This explicitly resends the same saved request only after its original receipt is checked."

/** The INGOTS review: "CAST 4 FORGE INGOTS" (pay at start, final charge) or "COLLECT 4 FORGE INGOTS" (from the original
 *  paid job). [sending] mirrors the owner's busy state (the confirm shows dots); [resend] is true when the saved request
 *  was already attempted. */
internal fun workshopIngotsReviewUi(review: WorkshopReview, sending: Boolean, resend: Boolean): CraftReviewUi {
    val command = review.command
    val start = command.kind == "start"
    val terms = if (start) "Pay ${fmtN(command.charge())} SHARDS at start. Charge is final at start. No cancellation, refund or SOL fee."
        else "Collect from the original paid job. No new refining charge."
    return CraftReviewUi(
        title = "${if (start) "CAST" else "COLLECT"} ${groupDigits(command.ingots)} FORGE INGOTS",
        line = listOfNotNull(terms, RESEND.takeIf { resend }).joinToString(" "),
        confirmLabel = if (start) "START" else "COLLECT",
        sending = sending,
    )
}

/** The REFINE review: "REFINE 6 FROSTGLASS" for refining, "CRAFT 2 EXPEDITION KIT" for kits. The line is the owner's
 *  ingredient consent (the SHARDS sentence when the recipe spends SHARDS), then its refund and payment terms. */
internal fun ordinaryRefineReviewUi(review: OrdinaryCraftingReview, sending: Boolean, resend: Boolean): CraftReviewUi {
    val recipe = review.command.recipe
    val verb = if (recipe.recipeId.startsWith("refine_")) "REFINE" else "CRAFT"
    val output = recipe.output.itemId.split('_').joinToString(" ").uppercase(Locale.US)
    return CraftReviewUi(
        title = "$verb ${fmtN(recipe.output.quantity)} $output",
        line = listOfNotNull(ordinaryCraftingIngredientConsent(recipe), "No cancellation or refund. No SOL, KEEP or Gems payment.",
            RESEND.takeIf { resend }).joinToString(" "),
        confirmLabel = "START",
        sending = sending,
    )
}
