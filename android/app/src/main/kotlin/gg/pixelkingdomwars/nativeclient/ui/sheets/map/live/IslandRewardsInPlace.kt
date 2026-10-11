package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FinePrintSealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RecoveryUi

/*
 * ISLAND REWARDS MATERIALS / SHARDS claimed in place (seeker-rewards.png, frame #152; owner 2026-10-06). The claim is a
 * server order with no wallet and no price, so the designed sheet calls the existing owners (SeekerResourceClaimsViewModel,
 * SeekerShardsClaimsViewModel) directly: CLAIM opens one row's review, the map cluster's FinePrintSeal carries ONLY the
 * original dialogs' strings, and a saved claim is finished, checked or reopened from its recovery row. REALM'S CUT (KEEP to
 * the wallet) stays on MiningTaxClaimsScreen. Pure decisions only; the home composes them.
 */

private const val RESOURCE_SERVER_LINE = "The server calculates the current share when accepted. No wallet approval is needed."
private const val SHARDS_SERVER_LINE = "The server calculates your current share when accepted. No wallet approval is needed."
/** The owners' own admission refusals (SeekerResourceClaimsRepository / SeekerShardsClaimsRepository wording). */
private const val CLAIMS_PAUSED = "New claims are paused. Saved receipts remain available."
private const val ORIGINAL_KINGDOM_AGAIN = "Select the original destination kingdom again."
private const val SHARES_CHANGED = "Your shares changed. Refresh and review again."

/** Said when a tap lands while the owner's one order is still running (its view model would drop the tap silently). */
internal const val SHARE_CLAIM_WORKING_LINE = "Still working on your last request."

/** The row CLAIM reviews: the first one with something due. A server zero is shown on its row but is never claimed (the
 *  owner refuses a zero and the review would be wasted). */
internal fun <R> firstDue(rows: List<R>, due: (R) -> String): R? = rows.firstOrNull { due(it) != "0" }

/** Why a CLAIM tap opens no review (null = review the [firstDue] row): a running order first, then the owner's own
 *  admission rule at the moment of the tap (the page may have changed since it was drawn), then the drawn reason. */
internal fun shareClaimRefusal(busy: Boolean, hasDueRow: Boolean, canReview: Boolean, drawnReason: String?): String? = when {
    busy -> SHARE_CLAIM_WORKING_LINE
    hasDueRow && canReview -> null
    else -> drawnReason ?: SHARES_CHANGED
}

/** What a saved claim's recovery row does. */
internal enum class SavedClaimStep {
    /** The receipt is in: refresh the kingdom and archive it (`finish`). */
    SAVE_RECEIPT,
    /** Sent with no outcome yet: observe the original receipt (`check`); it is never submitted again. */
    CHECK,
    /** Reviewed but never sent: reopen that same review (`reviewSaved`). */
    REVIEW_DRAFT,
}

/** A receipt wins; an attempted claim without one is only ever checked, never reviewed or sent again. */
internal fun savedClaimStep(hasReceipt: Boolean, attempted: Boolean): SavedClaimStep = when {
    hasReceipt -> SavedClaimStep.SAVE_RECEIPT
    attempted -> SavedClaimStep.CHECK
    else -> SavedClaimStep.REVIEW_DRAFT
}

/** The recovery row says what its button does here (the shared mapper still names the old flow). The key is kept, so the
 *  tap reaches the same saved request. */
internal fun savedClaimRecovery(rec: RecoveryUi, step: SavedClaimStep): RecoveryUi = when (step) {
    SavedClaimStep.SAVE_RECEIPT -> rec.copy(line = "Claim received. Refresh its kingdom and save the receipt.", actionLabel = "SAVE RECEIPT")
    SavedClaimStep.CHECK -> rec.copy(actionLabel = "CHECK SAVED RECEIPT")
    SavedClaimStep.REVIEW_DRAFT -> rec.copy(actionLabel = "REVIEW SAVED CLAIM")
}

/** Why a saved, never-sent review cannot reopen now (null = it can): the owner admits it only while new claims are open and
 *  only into the kingdom it was reviewed for, as the original screen's disabled button did. */
internal fun savedDraftRefusal(allowed: Boolean, savedBase: String, selectedBase: String?): String? = when {
    !allowed -> CLAIMS_PAUSED
    savedBase != selectedBase -> ORIGINAL_KINGDOM_AGAIN
    else -> null
}

/**
 * The claim Seal, built only from the original review dialog (SeekerResourceClaimsScreen / SeekerShardsClaimsScreen): its
 * title, [item] (that dialog's card title, "Heartwood Beams · Spot 3" / "Spot 3"), "[amount] currently available", the
 * [termLine], "Destination: [destination]", the server line and its confirm label. Nothing is paid, so there is no get side
 * and no cost. [busy] is the owner's running order (the money sequence's Sending); [canConfirm] false while not busy means
 * new claims are paused, which the Seal says instead of a silent primary.
 */
internal fun shareClaimSealUi(shards: Boolean, amount: String, termLine: String?, destination: String, armedAtMs: Long, busy: Boolean,
    canConfirm: Boolean, item: String? = null): FinePrintSealUi {
    val available = if (shards) "$amount SHARDS currently available" else "$amount currently available"
    return FinePrintSealUi(
        title = if (shards) "CLAIM YOUR SHARDS SHARE" else "CLAIM RESOURCE SHARE",
        pay = PriceUi(if (shards) Currency.SHARDS else Currency.ITEM, amount, PriceStatus.OK, icon = if (shards) null else "bag",
            description = available),
        gets = null,
        lines = listOfNotNull(item, available, termLine),
        secondary = "Destination: $destination",
        finePrint = listOf(if (shards) SHARDS_SERVER_LINE else RESOURCE_SERVER_LINE),
        confirmLabel = if (shards) "CLAIM SHARDS" else "CLAIM RESOURCES",
        armedAtMs = armedAtMs,
        stage = if (busy) MoneyStage.SENDING else MoneyStage.READY,
        canArm = canConfirm && !busy,
        waitLine = if (!busy && !canConfirm) CLAIMS_PAUSED else null,
    )
}
