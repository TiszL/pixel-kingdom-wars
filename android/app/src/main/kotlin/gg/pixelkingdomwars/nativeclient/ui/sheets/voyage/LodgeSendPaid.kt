package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi

/*
 * Design component: the paid expedition (design/final/voyage/send-paid.png; SPEC "E1.2 Paid expedition", registry row 66
 * `Lodge(SEND, mode = "paid")`). SEND with a PAID_REALM route chosen: the primary reads "SEND · with a 7-day permit"
 * ([LodgeSendFooterV2]) and opens the permit Seal ([PermitSeal] → [VoyageSealV2]) over the SEND sheet's 55 % scrim:
 * "PERMIT FOR CINDERFALL", 0.01 SOL → the island + 7 DAYS, "Any of your boats may sail to Cinderfall for 7 days.", the
 * realm's cut (half to the selling Seeker spot, half to the game — the only place the split appears, never a fee line
 * on the sheet), "Paid from your wallet. You sign once. The Cutter sails as soon as it is paid.", BACK + BUY & SEND.
 * Data (ISLAND-MODEL 2026-09-20): permit 0.01 SOL, 7 days, one realm, still needs an eligible vehicle; a trip started
 * inside the permit returns even after it expires. Prices, days and the split are the server's, never client constants.
 *
 * Pointer rule: the footer is drawn inside the Lodge sheet's painted panel (only the primary takes touches). The Seal is
 * the OverlayHost's: full-screen with its 55 % scrim only while shown; a scrim tap is BACK.
 */

/** The permit Seal's state (SPEC `PermitSealUi(realm, price, days, spotNo, splitLine, vehicleName, armedAtMs)`; fields
 *  after `armedAtMs` were added). */
@Immutable data class PermitSealUi(
    /** "Cinderfall". */
    val realm: String,
    /** The SOL price; CHECKING shows "…" and does not arm; UNAVAILABLE shows the no-seller line; SHORT the Need-more line. */
    val price: PriceUi,
    /** Permit length from the server ("7"). */
    val days: Int?,
    /** The selling Seeker Island spot (for the screen reader; the split line names it). */
    val spotNo: Int?,
    /** Server-formatted split ("half to Spot 14 on Seeker Island, half to the game."). */
    val splitLine: String,
    /** "Cutter". */
    val vehicleName: String,
    /** Wall-clock ms when the quote landed (the primary arms 450 ms later). */
    val armedAtMs: Long,
    /** Added: the route whose island cutout fills the get well. */
    val route: RouteUi? = null,
    /** Added: where the purchase stands (ARMED → CHECK_WALLET → SENDING → SENT; ERROR with [error]). */
    val state: VoyageSealState = VoyageSealState.ARMED,
    /** Added: the refusal ("The permit was not sold" → "… Nothing was sent.") or the uncertain step ("Your Cutter waits at
     *  the Berth until the realm confirms" → "… Your request is being checked."; `moneyErrorLine`). */
    val error: VoyageMoneyErrorUi? = null,
    /** Added: the no-seller line ("No spot sells Cinderfall permits today"); null builds it from [realm]. */
    val unavailableLine: String? = null,
    /** Added: the spot icon (`site:seeker-active`, `pkw_ui_site_seeker_active`). */
    val spotIcon: String = "site:seeker-active",
    /** Live owner wording can distinguish a purchase from a separately confirmed departure. */
    val note: String? = null,
)

/** The permit Seal's callbacks (SPEC: onConfirm, onBack, then the money sequence's onRetry, onCheck). */
@Immutable data class PermitSealActions(
    /** BUY & SEND (armed): buy the permit and send the trip. */
    val onConfirm: () -> Unit = {},
    /** BACK / scrim / system Back (ignored while the wallet or server works). */
    val onBack: () -> Unit = {},
    /** RETRY after an authoritative refusal. */
    val onRetry: () -> Unit = {},
    /** CHECK after an uncertain result (by-key read; a saved request is never sent twice). */
    val onCheck: () -> Unit = {},
    /** GO on a SOL shortfall → Profile › WALLET. */
    val onAddSol: () -> Unit = {},
    /** SEEKER ISLAND when no spot sells this realm's permits today. */
    val onSeekerIsland: () -> Unit = {},
)

/**
 * The permit Seal. Compose it from the OverlayHost (with null through its exit).
 *
 * Pointer rule: full-screen with its 55 % scrim only while shown or animating out; a scrim tap is BACK, never confirm.
 */
@Composable fun PermitSeal(ui: PermitSealUi?, on: PermitSealActions, modifier: Modifier = Modifier,
    clock: () -> Long = { System.currentTimeMillis() }, onExitFinished: () -> Unit = {}) {
    VoyageSealV2(ui?.let(::permitSealV2), VoyageSealV2Actions(onConfirm = on.onConfirm, onBack = on.onBack, onRetry = on.onRetry,
        onRecover = on.onCheck, onAddSol = on.onAddSol, onUnavailableGo = on.onSeekerIsland), modifier, clock, onExitFinished)
}

/**
 * The pinned SEND, round 2: [sendLookV2] ("SEND · with a 7-day permit" on a permit route; no SOL amount on the sheet) and
 * "Can't be called back once it sails." Replaces `LodgeSendFooter` (which printed "permit about 0.03 SOL").
 */
@Composable fun ColumnScope.LodgeSendFooterV2(ui: LodgeSendUi, on: LodgeSendActions, permitDays: Int?) {
    val look = sendLookV2(ui, permitDays)
    PrimaryButton(look.label, { if (look.state == CommandState.ENABLED) on.onSend() else on.onSendRefused(look.reason) },
        Modifier.fillMaxWidth(), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason)
    PkwText("Can't be called back once it sails.", PkwTokens.Type.small, Modifier.fillMaxWidth(), color = PkwTokens.Colors.textOnParch2, textAlign = TextAlign.Center)
}

// ---------------------------------------------------------------------------------------------------------------- previews

@Composable private fun PermitPreviewHost(ui: PermitSealUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        LodgeSheetR2(VoyageR2Samples.lodgeSendPaid, LodgeSheetR2Actions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
        PermitSeal(ui, PermitSealActions(), clock = { 10_000L })
    }
}

@Preview(name = "Lodge › SEND, paid permit Seal (send-paid.png)", widthDp = 412, heightDp = 915)
@Composable private fun PermitSealPreview() = PermitPreviewHost(VoyageR2Samples.permit)

@Preview(name = "Permit Seal: price checking (does not arm)", widthDp = 412, heightDp = 915)
@Composable private fun PermitCheckingPreview() = PermitPreviewHost(VoyageR2Samples.permit.copy(price = PriceUi(Currency.SOL, null, PriceStatus.CHECKING)))

@Preview(name = "Permit Seal: no spot sells it today", widthDp = 412, heightDp = 915)
@Composable private fun PermitUnavailablePreview() = PermitPreviewHost(VoyageR2Samples.permit.copy(price = PriceUi(Currency.SOL, null, PriceStatus.UNAVAILABLE)))

@Preview(name = "Permit Seal: SOL short", widthDp = 412, heightDp = 915)
@Composable private fun PermitShortPreview() = PermitPreviewHost(VoyageR2Samples.permit.copy(price = PriceUi(Currency.SOL, "0.01", PriceStatus.SHORT)))

@Preview(name = "Permit Seal: check wallet", widthDp = 412, heightDp = 915)
@Composable private fun PermitWalletPreview() = PermitPreviewHost(VoyageR2Samples.permit.copy(state = VoyageSealState.CHECK_WALLET))

@Preview(name = "Permit Seal: uncertain (being checked, CHECK)", widthDp = 412, heightDp = 915)
@Composable private fun PermitUncertainPreview() = PermitPreviewHost(VoyageR2Samples.permit.copy(state = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("Your Cutter waits at the Berth until the realm confirms", authoritative = false)))

@Preview(name = "Permit Seal: refused (authoritative)", widthDp = 412, heightDp = 915)
@Composable private fun PermitRefusedPreview() = PermitPreviewHost(VoyageR2Samples.permit.copy(state = VoyageSealState.ERROR,
    error = VoyageMoneyErrorUi("The permit was not sold", authoritative = true)))

@Preview(name = "Lodge › SEND with a permit route (footer, no Seal)", widthDp = 412, heightDp = 915)
@Composable private fun SendPaidFooterPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        LodgeSheetR2(VoyageR2Samples.lodgeSendPaid, LodgeSheetR2Actions(), Modifier.fillMaxSize().padding(start = 4.dp, end = 4.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}
