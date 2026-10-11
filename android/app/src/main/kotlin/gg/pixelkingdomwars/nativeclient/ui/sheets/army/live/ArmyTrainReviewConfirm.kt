package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.zIndex
import gg.pixelkingdomwars.nativeclient.data.ReviewedQuote
import gg.pixelkingdomwars.nativeclient.model.TrainingQuote
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.armyDuration
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubConfirmDialog
import java.math.RoundingMode

/*
 * The Army sheet's TRAIN review in the designed ConfirmDialog (night plan decision 1). The server quote step stays: the
 * server may trim the draft and only its quote knows the real cost, so TRAIN still asks for the quote and this dialog
 * shows it. Only the look changed (it replaces the Material `ReviewTrainingDialog` on this sheet). Every figure is the
 * SERVER quote's (queueable units, costShards, completionSec), never the draft estimate; the words are
 * ReviewTrainingDialog's own. Confirm calls the existing owner (`ArmyViewModel.confirmTraining`); nothing new is sent.
 */

private const val REVIEW_TITLE = "REVIEW TRAINING"
private const val ADD_TO_QUEUE = "ADD TO QUEUE"
/** ReviewTrainingDialog's remainder sentence, in its two halves: the dialog's sub line holds two lines, so the first
 *  half rides the consequence line and neither half is cut off. */
private const val REMAINDER_FIRST = "The remainder will not train automatically."
private const val REMAINDER_NEXT = "Preview it again when you have room or SHARDS."
internal const val NOTHING_TO_QUEUE = "NO TROOPS AVAILABLE TO QUEUE"

/** The quote's "all ready" time in whole seconds (rounded up, like ReviewTrainingDialog); null when the server sent none. */
private fun quoteCompletionSec(quote: TrainingQuote): Long? =
    quote.completionSec?.toBigDecimalOrNull()?.setScale(0, RoundingMode.CEILING)
        ?.let { runCatching { it.longValueExact() }.getOrNull() }?.takeIf { it >= 0 }

/**
 * The reviewed quote as the designed ConfirmDialog: "ADD TO QUEUE · n TROOPS · c SHARDS" from the server quote, the
 * remainder sentence only when the server trimmed the draft (otherwise "All ready in …" when the quote states it), and the
 * gold ADD TO QUEUE. A quote with nothing queueable says so and its primary only closes (CLOSE, stone).
 */
internal fun trainReviewConfirmUi(reviewed: ReviewedQuote): ConfirmUi {
    val quote = reviewed.quote
    if (quote.queueable.isEmpty()) return ConfirmUi(REVIEW_TITLE, null, null, NOTHING_TO_QUEUE, REMAINDER_NEXT, "CLOSE", tone = Verb.STONE)
    val order = "$ADD_TO_QUEUE · ${quote.unitCount} TROOPS · ${fmtN(quote.costShards)} SHARDS"
    return if (quote.remaining.isNotEmpty()) ConfirmUi(REVIEW_TITLE, null, null, "$order. $REMAINDER_FIRST", REMAINDER_NEXT, ADD_TO_QUEUE,
        tone = Verb.GOLD)
    else ConfirmUi(REVIEW_TITLE, null, null, order, quoteCompletionSec(quote)?.let { "All ready in ${armyDuration(it)}" }, ADD_TO_QUEUE,
        tone = Verb.GOLD)
}

/**
 * Mounts the TRAIN review over the Army sheet while [reviewed] is set (and animates it out when it clears). Confirm while
 * [busy] is ignored (nothing is sent twice); with nothing queueable confirm posts nothing: [onNothingToQueue] then
 * [onDismiss]. BACK and a scrim tap dismiss, except while busy, as the old dialog did.
 */
@Composable internal fun TrainReviewConfirm(reviewed: ReviewedQuote?, busy: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit,
    onNothingToQueue: () -> Unit = {}) {
    HubConfirmDialog(reviewed?.let(::trainReviewConfirmUi),
        onConfirm = {
            when {
                busy || reviewed == null -> Unit
                reviewed.quote.queueable.isEmpty() -> { onNothingToQueue(); onDismiss() }
                else -> onConfirm()
            }
        },
        onBack = { if (!busy) onDismiss() },
        modifier = Modifier.fillMaxSize().zIndex(PkwTokens.Z.SEAL))
}
