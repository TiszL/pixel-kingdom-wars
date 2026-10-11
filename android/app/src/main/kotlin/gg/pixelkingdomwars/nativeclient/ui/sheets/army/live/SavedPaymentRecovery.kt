package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ops.InterruptedIntent
import gg.pixelkingdomwars.nativeclient.ops.ResearchSpec
import gg.pixelkingdomwars.nativeclient.ops.TrainingFinishSpec
import gg.pixelkingdomwars.nativeclient.ui.InterruptedBanner
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyViewModel
import gg.pixelkingdomwars.nativeclient.ui.army.modernTrainingFinish
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ArmyCard

/*
 * Saved-payment recovery ON the designed sheets (c-gap-army 2026-10-06). Until now the TRAIN and Alchemy Lab sheets sent
 * the player to the old ArmyScreen / ResearchScreen (behind the history icon, or the research CHECK row) to see and check a
 * saved finish payment. The rows below show the same items, split exactly the way those screens split them, with the same
 * words and the same existing owner calls: requests without saved currency terms use the kit's interrupted herald
 * (InterruptedBanner: CHECK, and RETRY / CLOSE only where the receipt observer allows them); a modern saved finish payment
 * gets CHECK ORIGINAL RECEIPT (a GET-only receipt observation) and, only where the old screen offered it, REVIEW SAME
 * PAYMENT, which asks the existing owner for its review so the existing consent (the Gems Seal or the KEEP dialog already
 * mounted on the sheet) shows the price. Nothing here submits, signs or pays.
 */

/** The interrupted items one sheet shows: [heralds] in the kit interrupted herald, [saved] as saved-payment cards. */
internal data class SavedPaymentRows(val heralds: List<InterruptedIntent>, val saved: List<InterruptedIntent>) {
    val isEmpty: Boolean get() = heralds.isEmpty() && saved.isEmpty()
}

private val TRAINING_RECOVERY_KINDS = setOf(IntentKind.TRAINING_BATCH, IntentKind.TRAINING_CANCEL, IntentKind.TRAINING_FINISH)

/** ArmyScreen's TrainingFinishPending split: this wallet's training requests; a modern saved finish is a card. */
internal fun trainingSavedPayments(state: ArmyUiState): SavedPaymentRows {
    val pending = state.interrupted.filter { it.intent.wallet == state.wallet && it.kind in TRAINING_RECOVERY_KINDS }
    return SavedPaymentRows(pending.filter { it.kind != IntentKind.TRAINING_FINISH || !modernTrainingFinish(it.intent) },
        pending.filter { it.kind == IntentKind.TRAINING_FINISH && modernTrainingFinish(it.intent) })
}

/** ResearchScreen's ResearchPending split: requests without saved currency terms are heralds; the rest are cards. */
internal fun researchSavedPayments(state: ArmyUiState): SavedPaymentRows {
    val pending = state.interrupted.filter { it.kind == IntentKind.RESEARCH }
    return SavedPaymentRows(pending.filter { it.intent.expectedCurrency == null }, pending.filter { it.intent.expectedCurrency != null })
}

/** REVIEW SAME PAYMENT is drawn only for an unproven saved payment whose exact terms still parse (the old screens' rule). */
internal fun savedPaymentReviewShown(saved: InterruptedIntent): Boolean = !saved.proven && !saved.kept && when (saved.kind) {
    IntentKind.TRAINING_FINISH -> runCatching { TrainingFinishSpec.exact(saved.intent) }.isSuccess
    IntentKind.RESEARCH -> runCatching { ResearchSpec.exact(saved.intent) }.isSuccess
    else -> false
}

/** ...and is enabled only for the same kingdom with orders allowed (ArmyScreen / ResearchScreen enable rules). */
internal fun savedPaymentReviewEnabled(state: ArmyUiState, saved: InterruptedIntent, busy: Boolean, actionsAllowed: Boolean): Boolean =
    !busy && actionsAllowed && state.baseId != null && state.baseId == saved.intent.baseId &&
        (saved.kind != IntentKind.TRAINING_FINISH || state.ordersAllowed)

/** The rows themselves, painted inside a sheet panel (kit herald + blue-rimmed cream cards, kit buttons). */
@Composable internal fun SavedPaymentRecovery(rows: SavedPaymentRows, title: String, state: ArmyUiState, busy: Boolean,
    actionsAllowed: Boolean, model: ArmyViewModel, onReview: () -> Unit) {
    if (rows.isEmpty) return
    InterruptedBanner(rows.heralds, busy, model.interrupted.check, model.interrupted.close, model.interrupted.retry)
    rows.saved.forEach { saved ->
        ArmyCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.blue.face, rimWidth = 2.dp) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwIcon("shape:info", 24.dp, tint = PkwTokens.Colors.blue.lo)
                    PkwText(title, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
                }
                PkwText(if (saved.proven) "Original payment confirmed. Refresh current army and balances."
                    else "The original payment is unresolved. Check its receipt before another finish.",
                    PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch, maxLines = 3)
                SecondaryButton(if (saved.proven) "REFRESH CURRENT STATE" else "CHECK ORIGINAL RECEIPT", { model.interrupted.check(saved.kind) },
                    Modifier.fillMaxWidth(), verb = Verb.BLUE, enabled = !busy)
                if (savedPaymentReviewShown(saved)) SecondaryButton("REVIEW SAME PAYMENT", onReview, Modifier.fillMaxWidth(),
                    enabled = savedPaymentReviewEnabled(state, saved, busy, actionsAllowed))
                // Owner 2026-10-06: once the receipt answered `unknown` for this key, the owner's CLOSE (one more GET, then
                // forgotten on this device; nothing is sent) is the way out when the same payment can no longer be reviewed.
                if (saved.closable) SecondaryButton(gg.pixelkingdomwars.nativeclient.ui.Copy.CLOSE_REQUEST.uppercase(),
                    { model.interrupted.close(saved.kind) }, Modifier.fillMaxWidth(), enabled = !busy)
            }
        }
    }
}
